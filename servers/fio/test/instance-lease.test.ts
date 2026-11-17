import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { InstanceLeaseHeld, LEASE_KEY } from "@mcps/core/instance-lease.js";
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { backup } from "../src/app.js";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import { opensDatabase, serveLeased } from "../src/instance-lease.js";
import { loadConfigFrom } from "./fixtures.js";
import { testDatabase } from "./support/database.js";
import { FIO_TOKEN } from "./support/transport.js";

// The lease's timing, expiry, takeover and failure behaviour is tested in
// packages/core/test/instance-lease.test.ts; these cover Fio's entrypoint:
// the lease on the app's own database, config activation and the CLI bypass.

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
      assert.isTrue(error.message.startsWith(`instance lease: another fio-mcp server (pid ${process.pid} on `));
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
