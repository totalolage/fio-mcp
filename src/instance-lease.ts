import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Clock, Context, Deferred, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { cacheFailure, Database } from "./cache/db.js";
import { AppConfig, type AppConfigShape } from "./config.js";

/**
 * The single-instance guard. The per-token rate limiter lives in process
 * memory, so two servers on one FIO token each send their own requests and
 * FIO answers 409. A server that opens the database takes the lease row
 * `server_settings.instance_lease` at startup, heartbeats it, and deletes
 * it on a clean shutdown; a second server finds a live lease and refuses to
 * start. CLI subcommands never take it.
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
  /** The holder's process id and host, when its row is readable. */
  holder: Schema.optional(Schema.String),
  heartbeatAgeSeconds: Schema.Int,
  expiresInSeconds: Schema.Int,
}) {
  override get message(): string {
    const who = this.holder === undefined ? "another fio-mcp server" : `another fio-mcp server (${this.holder})`;
    return (
      `instance lease: ${who} is using this database (last heartbeat ${this.heartbeatAgeSeconds} s ago). ` +
      `Only one server may run on it. Stop the other server; if it is already gone, its lease expires in ` +
      `${this.expiresInSeconds} s.`
    );
  }
}

/** A running server found its lease taken over or deleted. */
export class InstanceLeaseLost extends Schema.TaggedError<InstanceLeaseLost>()("InstanceLeaseLost", {}) {
  override get message(): string {
    return "instance lease: another server took over this database's lease (or the row was deleted); stopping";
  }
}

export interface InstanceLeaseShape {
  /** This process's random lease id; null when the server opens no database and takes no lease. */
  readonly instanceId: string | null;
  /** Fails once a heartbeat finds the lease no longer ours; never completes otherwise. */
  readonly lost: Effect.Effect<never, InstanceLeaseLost>;
}

const describeHolder = (value: string): string | undefined =>
  Option.match(decodeHolder(value), {
    onNone: () => undefined,
    onSome: (holder) => `pid ${holder.pid} on ${holder.hostname}`,
  });

/** Takes the lease atomically, heartbeats it in the layer's scope, and releases it when the scope closes. */
const acquire = Effect.fn("InstanceLease.acquire")(function* (timings: LeaseTimings) {
  const sql = yield* SqlClient.SqlClient;
  const staleMs = Duration.toMillis(timings.stale);
  const holder: LeaseHolder = { instanceId: randomUUID(), pid: process.pid, hostname: hostname() };
  const value = encodeHolder(holder);

  // One statement, so two racing starters cannot both win: the insert, or
  // the takeover of a stale row (heartbeat older than `stale`, or from the
  // future after the clock stepped back), happens under SQLite's write lock.
  const failed = cacheFailure("take the instance lease");
  const take = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const taken = yield* sql<{ readonly key: string }>`
      INSERT INTO server_settings (key, value, updated_at) VALUES (${LEASE_KEY}, ${value}, ${now})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE server_settings.updated_at <= ${now - staleMs} OR server_settings.updated_at > ${now + staleMs}
      RETURNING key
    `.pipe(failed);
    if (taken.length > 0) return true;
    const rows = yield* sql<{ readonly value: string; readonly updated_at: number }>`
      SELECT value, updated_at FROM server_settings WHERE key = ${LEASE_KEY}
    `.pipe(failed);
    const row = rows[0];
    // Released between the two statements: try again.
    if (row === undefined) return false;
    const age = Math.max(0, now - row.updated_at);
    return yield* new InstanceLeaseHeld({
      holder: describeHolder(row.value),
      heartbeatAgeSeconds: Math.floor(age / 1000),
      expiresInSeconds: Math.ceil(Math.max(0, staleMs - age) / 1000),
    });
  });
  const taken = yield* take.pipe(Effect.repeat({ until: (won) => won, times: 2 }));
  if (!taken) return yield* new InstanceLeaseHeld({ heartbeatAgeSeconds: 0, expiresInSeconds: Math.ceil(staleMs / 1000) });
  yield* Effect.logInfo(`instance lease taken (instance ${holder.instanceId}, pid ${holder.pid} on ${holder.hostname})`);

  // Release on scope close (a clean shutdown, SIGTERM included), only while the row is still ours.
  yield* Effect.addFinalizer(() =>
    sql`DELETE FROM server_settings
      WHERE key = ${LEASE_KEY} AND json_extract(value, '$.instanceId') = ${holder.instanceId}`.pipe(
      Effect.andThen(Effect.logInfo("instance lease released")),
      Effect.catch((cause) => Effect.logWarning("instance lease: failed to release; it expires on its own", cause)),
    ),
  );

  const lost = yield* Deferred.make<never, InstanceLeaseLost>();
  // A failed beat (say, the database busy) is retried at the next one; a
  // beat that finds the row gone or another instance's ends the lease.
  const beat = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql`
      UPDATE server_settings SET updated_at = ${now}
      WHERE key = ${LEASE_KEY} AND json_extract(value, '$.instanceId') = ${holder.instanceId}
      RETURNING key
    `;
    return rows.length > 0;
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("instance lease: heartbeat failed", cause).pipe(Effect.as(true))),
  );
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      while (yield* Effect.andThen(Effect.sleep(timings.heartbeat), beat)) {}
      yield* Effect.logError("instance lease: lost to another server; stopping this one");
      yield* Deferred.fail(lost, new InstanceLeaseLost());
    }),
  );
  return { instanceId: holder.instanceId, lost: Deferred.await(lost) } satisfies InstanceLeaseShape;
});

/** True when the served app opens the database (FIO_DB_PATH): the cache is enabled, or HTTP with OAuth. */
export const opensDatabase = (config: AppConfigShape): boolean =>
  config.cache.enabled || (config.transport.kind === "http" && config.transport.auth.kind === "oauth");

export class InstanceLease extends Context.Service<InstanceLease, InstanceLeaseShape>()("fio-mcp/InstanceLease") {
  /** The lease on the SqlClient in context (which must have `server_settings`), with `timings`. */
  static readonly layer = (timings: LeaseTimings = LEASE_TIMINGS) => Layer.effect(InstanceLease, acquire(timings));

  /** No lease: for a server that opens no database. */
  static readonly None = Layer.succeed(InstanceLease, InstanceLease.of({ instanceId: null, lost: Effect.never }));

  /**
   * The server's lease from configuration, on the server's database
   * (`Database.Live`, the same connection the app uses) with the production
   * timings, when the served app opens the database; otherwise `None`.
   */
  static readonly Live = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return opensDatabase(config) ? InstanceLease.layer().pipe(Layer.provide(Database.Live)) : InstanceLease.None;
    }),
  ).pipe(Layer.provide(AppConfig.Live));
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

/** The server entrypoint: `app` under the lease from configuration (`InstanceLease.Live`). */
export const serveLeased = <A, E, R>(app: Layer.Layer<A, E, R>) => runLeased(app, InstanceLease.Live);
