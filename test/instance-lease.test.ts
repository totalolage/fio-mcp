import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Clock, ConfigProvider, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { backup } from "../src/app.js";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import {
  InstanceLease,
  InstanceLeaseHeld,
  InstanceLeaseLost,
  LEASE_KEY,
  type LeaseTimings,
  opensDatabase,
  runLeased,
  serveLeased,
} from "../src/instance-lease.js";
import { loadConfigFrom } from "./fixtures.js";
import { testDatabase } from "./support/database.js";
import { FIO_TOKEN } from "./support/transport.js";

const freshDir = () => mkdtempSync(join(tmpdir(), "fio-lease-"));

/** The environment of a stdio server with the cache (and so the database) at `dbPath`. */
const serverEnv = (dir: string, extra: Record<string, string> = {}) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({ env: { HOME: dir, FIO_TOKEN, FIO_DB_PATH: join(dir, "fio.sqlite"), ...extra } }),
  );

/** A stand-in for the app layer that signals when it was built. */
const stubApp = (started: Deferred.Deferred<void>) => Layer.effectDiscard(Deferred.succeed(started, undefined));

/** Runs `effect` on its own connection to the database file (as another process would). */
const onFile = <A, E>(dir: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(testDatabase(join(dir, "fio.sqlite"), SERVER_MIGRATIONS)));

const leaseRow = (dir: string) =>
  onFile(
    dir,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly value: string; readonly updated_at: number }>`
        SELECT value, updated_at FROM server_settings WHERE key = ${LEASE_KEY}
      `;
      return rows[0];
    }),
  );

/** Writes another (absent) instance's lease with its last heartbeat `ageMs` ago. */
const writeForeignLease = (dir: string, ageMs: number) =>
  onFile(
    dir,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = yield* Clock.currentTimeMillis;
      const value = JSON.stringify({ instanceId: "someone-else", pid: 4242, hostname: "elsewhere" });
      yield* sql`
        INSERT INTO server_settings (key, value, updated_at) VALUES (${LEASE_KEY}, ${value}, ${now - ageMs})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `;
    }),
  );

/** Starts the production entrypoint composition on `dir`; resolves once its app is built. */
const startServer = (dir: string) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(serveLeased(stubApp(started)).pipe(Effect.provide(serverEnv(dir))));
    yield* Deferred.await(started);
    return fiber;
  });

/** Runs the production entrypoint composition on `dir` until its app is built, then stops it. */
const startAndStop = (dir: string, extra: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(serveLeased(stubApp(started)).pipe(Effect.provide(serverEnv(dir, extra))));
    const exit = yield* Effect.raceFirst(
      Deferred.await(started).pipe(Effect.as(Exit.void)),
      Fiber.await(fiber).pipe(Effect.map(Exit.asVoid)),
    );
    yield* Fiber.interrupt(fiber);
    return { exit, started: yield* Deferred.isDone(started) };
  });

const assertHeld = (exit: Exit.Exit<unknown, unknown>) => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined;
  assert.instanceOf(error?._tag === "Fail" ? error.error : undefined, InstanceLeaseHeld);
  return error?._tag === "Fail" ? (error.error as InstanceLeaseHeld) : undefined;
};

/** Short timings for tests that wait on heartbeats or expiry. */
const FAST: LeaseTimings = { heartbeat: Duration.millis(100), stale: Duration.millis(1500) };

/** The lease layer alone on `dir` with `timings`, as its own process would build it. */
const leaseOn = (dir: string, timings: LeaseTimings) =>
  InstanceLease.layer(timings).pipe(Layer.provide(testDatabase(join(dir, "fio.sqlite"), SERVER_MIGRATIONS)));

describe("instance lease", () => {
  it.live("a second server on the same database fails with the lease error; after the first stops it starts", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const first = yield* startServer(dir);
      const held = yield* leaseRow(dir);
      assert.isDefined(held);

      const blocked = yield* startAndStop(dir);
      const error = assertHeld(blocked.exit);
      // The lease is taken before the app is built: the second app never started.
      assert.isFalse(blocked.started);
      assert.isTrue((error?.expiresInSeconds ?? 0) > 0 && (error?.expiresInSeconds ?? 0) <= 90);
      assert.include(error?.message ?? "", `pid ${process.pid}`);
      assert.include(error?.message ?? "", "expires in");
      // The failed starter left the first server's lease alone.
      assert.deepStrictEqual(yield* leaseRow(dir), held);

      // A clean stop releases the lease, so the next server starts at once.
      yield* Fiber.interrupt(first);
      assert.isUndefined(yield* leaseRow(dir));
      const second = yield* startAndStop(dir);
      assert.isTrue(Exit.isSuccess(second.exit));
      assert.isTrue(second.started);
      assert.isUndefined(yield* leaseRow(dir));
    }),
  );

  it.live("a lease whose heartbeat is older than 90 s (a killed server) does not block startup", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      yield* writeForeignLease(dir, 60_000);
      const blocked = yield* startAndStop(dir);
      const error = assertHeld(blocked.exit);
      assert.include(error?.message ?? "", "pid 4242 on elsewhere");
      assert.isTrue((error?.expiresInSeconds ?? 0) > 25 && (error?.expiresInSeconds ?? 0) <= 30);

      yield* writeForeignLease(dir, 91_000);
      const started = yield* startAndStop(dir);
      assert.isTrue(Exit.isSuccess(started.exit));
      assert.isTrue(started.started);
    }),
  );

  it.live("heartbeats keep the lease live past the stale period", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const first = yield* Effect.forkChild(Layer.launch(leaseOn(dir, FAST)));
      // Over two stale periods later the holder still blocks: its heartbeats refresh the row.
      yield* Effect.sleep(Duration.millis(2500));
      assertHeld(yield* Effect.exit(Layer.build(leaseOn(dir, FAST)).pipe(Effect.scoped)));
      yield* Fiber.interrupt(first);
    }),
  );

  it.live("a killed holder's lease (no release, no heartbeats) expires after the stale period", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      yield* writeForeignLease(dir, 0);
      assertHeld(yield* Effect.exit(Layer.build(leaseOn(dir, FAST)).pipe(Effect.scoped)));
      yield* Effect.sleep(Duration.millis(1700));
      const second = yield* Effect.exit(Layer.build(leaseOn(dir, FAST)).pipe(Effect.scoped));
      assert.isTrue(Exit.isSuccess(second));
    }),
  );

  it.live("a server whose lease is taken over or deleted stops with InstanceLeaseLost and leaves the row alone", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const started = yield* Deferred.make<void>();
      const server = yield* Effect.forkChild(runLeased(stubApp(started), leaseOn(dir, FAST)));
      yield* Deferred.await(started);
      yield* writeForeignLease(dir, 0);
      const exit = yield* Fiber.await(server).pipe(Effect.timeout(Duration.seconds(5)));
      assert.isTrue(Exit.isFailure(exit));
      const reason = Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === "Fail") : undefined;
      assert.instanceOf(reason?._tag === "Fail" ? reason.error : undefined, InstanceLeaseLost);
      // The release on shutdown deletes only our own row.
      assert.include((yield* leaseRow(dir))?.value ?? "", "someone-else");

      // Once that lease goes stale a new server takes it; deleting its row stops it too.
      yield* Effect.sleep(Duration.millis(1700));
      const again = yield* Deferred.make<void>();
      const restarted = yield* Effect.forkChild(runLeased(stubApp(again), leaseOn(dir, FAST)));
      yield* Deferred.await(again);
      yield* onFile(
        dir,
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM server_settings WHERE key = ${LEASE_KEY}`),
      );
      const deleted = yield* Fiber.await(restarted).pipe(Effect.timeout(Duration.seconds(5)));
      assert.isTrue(Exit.isFailure(deleted));
    }),
  );

  it.live("CLI commands neither take nor need the lease", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const server = yield* startServer(dir);
      const held = yield* leaseRow(dir);
      const copied = yield* backup(join(dir, "copy.sqlite")).pipe(Effect.provide(serverEnv(dir)));
      assert.isTrue(copied.bytes > 0);
      assert.deepStrictEqual(yield* leaseRow(dir), held);
      yield* Fiber.interrupt(server);
    }),
  );

  it.live("a server that opens no database takes no lease", () =>
    Effect.gen(function* () {
      const dir = freshDir();
      const server = yield* startServer(dir);
      const free = yield* startAndStop(dir, { FIO_CACHE_ENABLED: "false" });
      assert.isTrue(Exit.isSuccess(free.exit));
      assert.isTrue(free.started);
      yield* Fiber.interrupt(server);

      assert.isTrue(opensDatabase(yield* loadConfigFrom({ FIO_TOKEN })));
      assert.isFalse(opensDatabase(yield* loadConfigFrom({ FIO_TOKEN, FIO_CACHE_ENABLED: "false" })));
    }),
  );
});
