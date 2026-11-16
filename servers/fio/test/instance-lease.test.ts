import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Clock, ConfigProvider, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { backup } from "../src/app.js";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import {
  InstanceLease,
  InstanceLeaseHeld,
  InstanceLeaseLost,
  LEASE_KEY,
  LEASE_TIMINGS,
  opensDatabase,
  runLeased,
  serveLeased,
} from "../src/instance-lease.js";
import { loadConfigFrom } from "./fixtures.js";
import { testDatabase } from "./support/database.js";
import { FIO_TOKEN } from "./support/transport.js";

const freshDir = () => mkdtempSync(join(tmpdir(), "fio-lease-"));

/** The environment of a stdio server with the cache (and so the database) in `dir`. */
const serverEnv = (dir: string, extra: Record<string, string> = {}) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({ env: { HOME: dir, FIO_TOKEN, FIO_DB_PATH: join(dir, "fio.sqlite"), ...extra } }),
  );

/** A stand-in for the app layer that signals when it was built. */
const stubApp = (started: Deferred.Deferred<void>) => Layer.effectDiscard(Deferred.succeed(started, undefined));

/** Runs `run` on its own connection to the database file (as another process would). */
const sqlOn = <A, E>(dir: string, run: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.flatMap(SqlClient.SqlClient, run).pipe(
    Effect.provide(testDatabase(join(dir, "fio.sqlite"), SERVER_MIGRATIONS)),
  );

const leaseRow = (dir: string) =>
  sqlOn(dir, (sql) =>
    sql<{ readonly value: string; readonly updated_at: number }>`
      SELECT value, updated_at FROM server_settings WHERE key = ${LEASE_KEY}
    `.pipe(Effect.map((rows) => rows[0])),
  );

/** Writes another (absent) instance's lease with its last heartbeat `ageMs` ago (negative: in the future). */
const writeForeignLease = (dir: string, ageMs: number) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    sqlOn(dir, (sql) => {
      const value = JSON.stringify({ instanceId: "someone-else", pid: 4242, hostname: "elsewhere" });
      return sql`
        INSERT INTO server_settings (key, value, updated_at) VALUES (${LEASE_KEY}, ${value}, ${now - ageMs})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `;
    }),
  );

/**
 * Forks `serve(app)` and waits until its app is built or it exits first.
 * Returns the fiber, whether the app started, and the exit when it did not.
 */
const start = <E>(serve: (app: Layer.Layer<never>) => Effect.Effect<never, E>) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(serve(stubApp(started)));
    const exit = yield* Effect.raceFirst(
      Deferred.await(started).pipe(Effect.as(undefined)),
      Fiber.await(fiber).pipe(Effect.map((exit): Exit.Exit<never, E> | undefined => exit)),
    );
    return { fiber, started: yield* Deferred.isDone(started), exit };
  });

/** The production entrypoint composition (`serveLeased`, lease from configuration) on `dir`. */
const production =
  (dir: string, extra: Record<string, string> = {}) =>
  (app: Layer.Layer<never>) =>
    serveLeased(app).pipe(Effect.provide(serverEnv(dir, extra)));

/** The lease layer with the production timings on its own connection to `dir`, as its own process would build it. */
const leased = (dir: string) => (app: Layer.Layer<never>) =>
  runLeased(
    app,
    InstanceLease.layer(LEASE_TIMINGS).pipe(Layer.provide(testDatabase(join(dir, "fio.sqlite"), SERVER_MIGRATIONS))),
  );

const failureOf = (exit: Exit.Exit<unknown, unknown> | undefined): unknown => {
  const reason =
    exit !== undefined && Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === "Fail") : undefined;
  return reason?._tag === "Fail" ? reason.error : undefined;
};

const assertHeld = (exit: Exit.Exit<unknown, unknown> | undefined): InstanceLeaseHeld => {
  const error = failureOf(exit);
  assert.instanceOf(error, InstanceLeaseHeld);
  return error as InstanceLeaseHeld;
};

const lostReason = (exit: Exit.Exit<unknown, unknown>) => {
  const error = failureOf(exit);
  assert.instanceOf(error, InstanceLeaseLost);
  return (error as InstanceLeaseLost).reason;
};

/** Moves the test clock by `ms` in heartbeat-sized steps, letting the forked heartbeats run after each. */
const advance = (ms: number) =>
  Effect.gen(function* () {
    for (let left = ms; left > 0; left -= 30_000) {
      yield* TestClock.adjust(Math.min(left, 30_000));
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    }
  });

describe("instance lease: server entrypoint", () => {
  it.live("a second server on the same database fails with the lease error; after the first stops it starts", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const first = yield* start(production(dir));
      assert.isTrue(first.started);
      const held = yield* leaseRow(dir);
      assert.isDefined(held);

      const blocked = yield* start(production(dir));
      const error = assertHeld(blocked.exit);
      // The lease is taken before the app is built: the second app never started.
      assert.isFalse(blocked.started);
      assert.isTrue(error.expiresInSeconds > 85 && error.expiresInSeconds <= 90);
      assert.include(error.message, `pid ${process.pid}`);
      assert.include(error.message, "expires in");
      // The failed starter left the first server's lease alone.
      assert.deepStrictEqual(yield* leaseRow(dir), held);

      // A clean stop releases the lease, so the next server starts at once.
      yield* Fiber.interrupt(first.fiber);
      assert.isUndefined(yield* leaseRow(dir));
      const second = yield* start(production(dir));
      assert.isTrue(second.started);
      yield* Fiber.interrupt(second.fiber);
      assert.isUndefined(yield* leaseRow(dir));
    }),
  );

  it.live("a lease whose heartbeat is older than 90 s (a killed server) does not block startup", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      yield* writeForeignLease(dir, 60_000);
      const error = assertHeld((yield* start(production(dir))).exit);
      assert.include(error.message, "pid 4242 on elsewhere");
      assert.isTrue(error.expiresInSeconds > 25 && error.expiresInSeconds <= 30);

      yield* writeForeignLease(dir, 91_000);
      const started = yield* start(production(dir));
      assert.isTrue(started.started);
      yield* Fiber.interrupt(started.fiber);
    }),
  );

  it.live("CLI commands neither take nor need the lease", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const server = yield* start(production(dir));
      const held = yield* leaseRow(dir);
      const copied = yield* backup(join(dir, "copy.sqlite")).pipe(Effect.provide(serverEnv(dir)));
      assert.isTrue(copied.bytes > 0);
      assert.deepStrictEqual(yield* leaseRow(dir), held);
      yield* Fiber.interrupt(server.fiber);
    }),
  );

  it.live("a server that opens no database takes no lease", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const server = yield* start(production(dir));
      const free = yield* start(production(dir, { FIO_CACHE_ENABLED: "false" }));
      assert.isTrue(free.started);
      yield* Fiber.interrupt(free.fiber);
      yield* Fiber.interrupt(server.fiber);

      assert.isTrue(opensDatabase(yield* loadConfigFrom({ FIO_TOKEN })));
      assert.isFalse(opensDatabase(yield* loadConfigFrom({ FIO_TOKEN, FIO_CACHE_ENABLED: "false" })));
    }),
  );
});

// The test clock drives the production timings (30 s heartbeat, 90 s stale).
describe("instance lease: heartbeats and expiry", () => {
  it.effect("heartbeats keep the lease live well past 90 s", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const first = yield* start(leased(dir));
      const ours = yield* leaseRow(dir);
      yield* advance(300_000);
      assertHeld((yield* start(leased(dir))).exit);
      assert.isUndefined(first.fiber.pollUnsafe());
      const now = yield* leaseRow(dir);
      assert.strictEqual(now?.value, ours?.value);
      assert.strictEqual(now?.updated_at, (ours?.updated_at ?? 0) + 300_000);
      yield* Fiber.interrupt(first.fiber);
    }),
  );

  it.effect("a killed holder's lease (no release, no heartbeats) blocks for 90 s, then a new server takes it", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      yield* writeForeignLease(dir, 0);
      yield* advance(60_000);
      assert.strictEqual(assertHeld((yield* start(leased(dir))).exit).expiresInSeconds, 30);
      yield* advance(30_000);
      const second = yield* start(leased(dir));
      assert.isTrue(second.started);
      yield* Fiber.interrupt(second.fiber);
    }),
  );

  it.effect("a server whose lease is taken over stops with InstanceLeaseLost and leaves the new row alone", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const server = yield* start(leased(dir));
      yield* writeForeignLease(dir, 0);
      yield* advance(30_000);
      assert.strictEqual(lostReason(yield* Fiber.await(server.fiber)), "taken");
      // The release on shutdown deletes only our own row.
      assert.include((yield* leaseRow(dir))?.value ?? "", "someone-else");
    }),
  );

  it.effect("a server whose lease row is deleted stops with InstanceLeaseLost", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const server = yield* start(leased(dir));
      yield* sqlOn(dir, (sql) => sql`DELETE FROM server_settings WHERE key = ${LEASE_KEY}`);
      yield* advance(30_000);
      assert.strictEqual(lostReason(yield* Fiber.await(server.fiber)), "taken");
    }),
  );

  it.effect("a server whose heartbeats keep failing stops before its lease could expire", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const server = yield* start(leased(dir));
      yield* sqlOn(dir, (sql) => sql`ALTER TABLE server_settings RENAME TO server_settings_away`);
      // One failed beat is tolerated.
      yield* advance(30_000);
      assert.isUndefined(server.fiber.pollUnsafe());
      // After the second the last good beat is 60 s old; the next could come after the lease expired.
      yield* advance(30_000);
      assert.strictEqual(lostReason(yield* Fiber.await(server.fiber)), "heartbeat");
    }),
  );

  it.effect("after the clock steps back, a live holder keeps its lease and a dead one expires 90 s later", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      // A live holder whose last heartbeat reads 10 minutes in the future.
      const live = yield* start(leased(dir));
      const ours = yield* leaseRow(dir);
      yield* sqlOn(
        dir,
        (sql) => sql`UPDATE server_settings SET updated_at = updated_at + 600000 WHERE key = ${LEASE_KEY}`,
      );
      assert.strictEqual(assertHeld((yield* start(leased(dir))).exit).expiresInSeconds, 90);
      yield* advance(120_000);
      assertHeld((yield* start(leased(dir))).exit);
      assert.isUndefined(live.fiber.pollUnsafe());
      assert.strictEqual((yield* leaseRow(dir))?.value, ours?.value);
      yield* Fiber.interrupt(live.fiber);

      // A dead holder with a future heartbeat: refused now, taken 90 s later.
      yield* writeForeignLease(dir, -600_000);
      assert.strictEqual(assertHeld((yield* start(leased(dir))).exit).expiresInSeconds, 90);
      yield* advance(90_000);
      const taker = yield* start(leased(dir));
      assert.isTrue(taker.started);
      yield* Fiber.interrupt(taker.fiber);
    }),
  );
});
