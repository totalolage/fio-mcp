import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Cause, Clock, Context, Deferred, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

/**
 * The single-instance guard, for a server whose in-memory state (a per-token
 * rate limiter, say) must not be split across two running processes on one
 * database. A server takes the lease row
 * `server_settings.instance_lease` at startup, heartbeats it, and deletes it
 * on a clean shutdown; a second server finds a live lease and refuses to
 * start.
 *
 * Contract with the app: core adds no migration. The SqlClient the lease
 * layer gets must already have the table
 * `server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`
 * (the app's own migrations create it), and it should be the same database
 * the app serves from. The app decides which configurations take the lease
 * (`InstanceLease.layer` or `InstanceLease.None`) and keeps its one-shot
 * commands off it.
 */

/** The `server_settings` key of the lease row. */
export const LEASE_KEY = "instance_lease";

/** How often the holder refreshes the lease, and how old a heartbeat may get before the lease is free. */
export interface LeaseTimings {
  readonly heartbeat: Duration.Duration;
  readonly stale: Duration.Duration;
}

/** Production timings: a killed server blocks a new one for at most 90 s. */
export const LEASE_TIMINGS: LeaseTimings = { heartbeat: Duration.seconds(30), stale: Duration.seconds(90) };

/** The lease row's value. Its heartbeat time is the row's `updated_at` (epoch milliseconds). */
const LeaseHolder = Schema.Struct({ instanceId: Schema.String, pid: Schema.Int, hostname: Schema.String });
type LeaseHolder = typeof LeaseHolder.Type;
const encodeHolder = Schema.encodeSync(Schema.fromJsonString(LeaseHolder));
const decodeHolder = Schema.decodeUnknownOption(Schema.fromJsonString(LeaseHolder));

/** Startup found another server's live lease. */
export class InstanceLeaseHeld extends Schema.TaggedError<InstanceLeaseHeld>()("InstanceLeaseHeld", {
  /** The server's product name (`InstanceLeaseOptions.appName`), as in "another <app> server". */
  app: Schema.String,
  /** The holder's process id and host, when its row is readable. */
  holder: Schema.optional(Schema.String),
  heartbeatAgeSeconds: Schema.Int,
  expiresInSeconds: Schema.Int,
}) {
  override get message(): string {
    const who = this.holder === undefined ? `another ${this.app} server` : `another ${this.app} server (${this.holder})`;
    return (
      `instance lease: ${who} is using this database (last heartbeat ${this.heartbeatAgeSeconds} s ago). ` +
      `Only one server may run on it. Stop the other server; if it is already gone, its lease expires in ` +
      `${this.expiresInSeconds} s.`
    );
  }
}

/** A running server stopped holding its lease: it was taken over or deleted, or heartbeats kept failing. */
export class InstanceLeaseLost extends Schema.TaggedError<InstanceLeaseLost>()("InstanceLeaseLost", {
  reason: Schema.Literals(["taken", "heartbeat"]),
}) {
  override get message(): string {
    return this.reason === "taken"
      ? "instance lease: another server took over this database's lease (or the row was deleted); stopping"
      : "instance lease: heartbeats kept failing, so another server could take the lease; stopping";
  }
}

export interface InstanceLeaseShape {
  /** This process's random lease id; null when the server opens no database and takes no lease. */
  readonly instanceId: string | null;
  /** Fails once a heartbeat finds the lease no longer ours; never completes otherwise. */
  readonly lost: Effect.Effect<never, InstanceLeaseLost>;
}

/** How an app takes its lease. */
export interface InstanceLeaseOptions<F> {
  /** The product name in the held-lease message ("another <appName> server"), e.g. `AppIdentity.name`. */
  readonly appName: string;
  /**
   * Maps a failed startup statement (taking the lease) to the app's error,
   * given what was being done ("take the instance lease"). It should log the
   * cause; heartbeat and release failures are only logged and never reach it.
   */
  readonly onSqlFailure: (operation: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, F, R>;
  /** Defaults to `LEASE_TIMINGS` (30 s heartbeat, 90 s stale). */
  readonly timings?: LeaseTimings;
}

const describeHolder = (value: string): string | undefined =>
  Option.match(decodeHolder(value), {
    onNone: () => undefined,
    onSome: (holder) => `pid ${holder.pid} on ${holder.hostname}`,
  });

/** Takes the lease atomically, heartbeats it in the layer's scope, and releases it when the scope closes. */
const acquire = Effect.fn("InstanceLease.acquire")(function* <F>(options: InstanceLeaseOptions<F>) {
  const { appName: app, timings = LEASE_TIMINGS } = options;
  const sql = yield* SqlClient.SqlClient;
  const staleMs = Duration.toMillis(timings.stale);
  const holder: LeaseHolder = { instanceId: randomUUID(), pid: process.pid, hostname: hostname() };
  // The row is ours while it holds exactly this value (the instance id is random per process).
  const value = encodeHolder(holder);
  const failed = options.onSqlFailure("take the instance lease");

  // One statement, so two racing starters cannot both win: the insert, or
  // the takeover of a row whose heartbeat is older than `stale`, happens
  // under SQLite's write lock. Resolves false when the row vanished between
  // the statements (its holder released it), to try again.
  const take = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const taken = yield* sql<{ readonly key: string }>`
      INSERT INTO server_settings (key, value, updated_at) VALUES (${LEASE_KEY}, ${value}, ${now})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE server_settings.updated_at <= ${now - staleMs}
      RETURNING key
    `.pipe(failed);
    if (taken.length > 0) return true;
    const rows = yield* sql<{ readonly value: string; readonly updated_at: number }>`
      SELECT value, updated_at FROM server_settings WHERE key = ${LEASE_KEY}
    `.pipe(failed);
    const row = rows[0];
    if (row === undefined) return false;
    // A heartbeat from the future means the clock stepped back. Count the
    // lease from now (if the row is unchanged): a dead holder's lease then
    // expires `stale` from now, and a live holder's next beat refreshes it.
    const future = row.updated_at > now;
    if (future) {
      yield* sql`
        UPDATE server_settings SET updated_at = ${now}
        WHERE key = ${LEASE_KEY} AND value = ${row.value} AND updated_at = ${row.updated_at}
      `.pipe(failed);
    }
    const age = future ? 0 : now - row.updated_at;
    return yield* new InstanceLeaseHeld({
      app,
      holder: describeHolder(row.value),
      heartbeatAgeSeconds: Math.floor(age / 1000),
      expiresInSeconds: Math.ceil(Math.max(0, staleMs - age) / 1000),
    });
  });

  // Release on scope close (a clean shutdown, SIGTERM included), only while
  // the row is still ours. acquireRelease registers it uninterruptibly with the take.
  const release = sql<{ readonly key: string }>`
    DELETE FROM server_settings WHERE key = ${LEASE_KEY} AND value = ${value} RETURNING key
  `.pipe(
    Effect.flatMap((rows) => (rows.length > 0 ? Effect.logInfo("instance lease released") : Effect.void)),
    Effect.catch((cause) => Effect.logWarning("instance lease: failed to release; it expires on its own", cause)),
  );
  yield* Effect.acquireRelease(
    take.pipe(
      Effect.repeat({ until: (won) => won, times: 2 }),
      Effect.flatMap((won) =>
        won
          ? Effect.void
          : Effect.fail(new InstanceLeaseHeld({ app, heartbeatAgeSeconds: 0, expiresInSeconds: Math.ceil(staleMs / 1000) })),
      ),
    ),
    () => release,
  );
  yield* Effect.logInfo(`instance lease taken (instance ${holder.instanceId}, pid ${holder.pid} on ${holder.hostname})`);

  const lost = yield* Deferred.make<never, InstanceLeaseLost>();
  const stop = (reason: InstanceLeaseLost["reason"]) =>
    Effect.logError(
      reason === "taken"
        ? "instance lease: lost to another server; stopping this one"
        : "instance lease: heartbeats kept failing; stopping this one before another server can take the lease",
    ).pipe(Effect.andThen(Deferred.fail(lost, new InstanceLeaseLost({ reason }))));
  // A failed beat (say, the database busy) is retried at the next one, until
  // the last good beat is `stale - heartbeat` old: the beat after that could
  // come after another server took the lease, so the server stops first. A
  // beat that finds the row gone or another instance's stops it at once.
  const deadlineMs = staleMs - Duration.toMillis(timings.heartbeat);
  const beat = (now: number) =>
    sql<{ readonly key: string }>`
      UPDATE server_settings SET updated_at = ${now} WHERE key = ${LEASE_KEY} AND value = ${value} RETURNING key
    `.pipe(
      Effect.map((rows) => (rows.length > 0 ? ("held" as const) : ("taken" as const))),
      Effect.catch((cause) => Effect.logWarning("instance lease: heartbeat failed", cause).pipe(Effect.as("failed" as const))),
    );
  const heartbeats = Effect.gen(function* () {
    let lastBeat = yield* Clock.currentTimeMillis;
    for (;;) {
      yield* Effect.sleep(timings.heartbeat);
      const now = yield* Clock.currentTimeMillis;
      const outcome = yield* beat(now);
      if (outcome === "taken") return yield* stop("taken");
      if (outcome === "held") lastBeat = now;
      else if (now - lastBeat >= deadlineMs) return yield* stop("heartbeat");
    }
  });
  // A heartbeat fiber that ends any other way than by interruption (a defect) stops the server too.
  yield* Effect.forkScoped(
    heartbeats.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logError("instance lease: heartbeat crashed", cause).pipe(Effect.andThen(stop("heartbeat"))),
      ),
    ),
  );
  return { instanceId: holder.instanceId, lost: Deferred.await(lost) } satisfies InstanceLeaseShape;
});

export class InstanceLease extends Context.Service<InstanceLease, InstanceLeaseShape>()("mcps/InstanceLease") {
  /**
   * The lease on the SqlClient in context, which must already have
   * `server_settings` (see the module comment). Fails with
   * `InstanceLeaseHeld` when another server holds it, or with the app's
   * error from `onSqlFailure` when taking it fails.
   */
  static readonly layer = <F>(options: InstanceLeaseOptions<F>) => Layer.effect(InstanceLease, acquire(options));

  /** No lease: for a server that opens no database. */
  static readonly None = Layer.succeed(InstanceLease, InstanceLease.of({ instanceId: null, lost: Effect.never }));
}

/**
 * Runs the server `app` under `lease`: the lease is taken before `app` is
 * built, and the server runs until interrupted (SIGTERM, SIGINT) or until it
 * loses the lease, which fails with `InstanceLeaseLost`. Either way the
 * scope closes: `app` shuts down, then the lease is released.
 */
export const runLeased = <A, E, R, E2, R2>(app: Layer.Layer<A, E, R>, lease: Layer.Layer<InstanceLease, E2, R2>) =>
  Effect.gen(function* () {
    const { lost } = yield* InstanceLease;
    return yield* lost;
  }).pipe(Effect.provide(app.pipe(Layer.provideMerge(lease))));
