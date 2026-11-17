import { statSync } from "node:fs";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import { ConfigError } from "@mcps/core/config/env.js";
import { makeRedactor, Redactor } from "@mcps/core/redaction.js";
import { Effect, Layer, Logger } from "effect";
import { SqlClient } from "effect/sql";
import {
  CheckedDatabaseLive,
  DATA_KEY_CHECK_SETTING,
  DatabaseLive,
  ISDS_ENVIRONMENT_SETTING,
} from "../../src/app/database.js";
import { DomainLive } from "../../src/config.js";
import { BoxLocks } from "../../src/domain/box-locks.js";
import { BoxCredentialsUnreadable, BoxRegistry } from "../../src/domain/boxes.js";
import { appConfigFrom, OTHER_DATA_KEY_HEX, requiredEnv, secretFile, tempDir } from "../config/support.js";
import { fakeIsdsTransports, loginResponder } from "../domain/support/fake-isds.js";

const settingsRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly key: string; readonly value: string }>`SELECT key, value FROM server_settings
    WHERE key = ${ISDS_ENVIRONMENT_SETTING} OR key = ${DATA_KEY_CHECK_SETTING} ORDER BY key`;
});

/** A database file of its own and the variables a start needs. */
const freshEnv = Effect.gen(function* () {
  const env = yield* requiredEnv;
  return { ...env, DATOVA_SCHRANKA_DB_PATH: join(tempDir(), "db", "datova-schranka.sqlite") };
});

const checked = (env: Record<string, string>) =>
  CheckedDatabaseLive.pipe(
    Layer.provide(DomainLive),
    Layer.provideMerge(appConfigFrom(env)),
    Layer.provide(NodeFileSystem.layer),
  );

/** One server start: the checked database, then the settings it holds. */
const start = (env: Record<string, string>) => Effect.provide(settingsRows, checked(env));

/** The settings as they are, without running the checks. */
const stored = (env: Record<string, string>) =>
  Effect.provide(
    settingsRows,
    DatabaseLive.pipe(Layer.provide(appConfigFrom(env)), Layer.provide(NodeFileSystem.layer)),
  );

/** Runs `effect` on the database `env` names, without the checks. */
const onDatabase = <A, E>(env: Record<string, string>, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.provide(effect, DatabaseLive.pipe(Layer.provide(appConfigFrom(env)), Layer.provide(NodeFileSystem.layer)));

describe("DatabaseLive", () => {
  it.effect("creates a private database file at DATOVA_SCHRANKA_DB_PATH with every app migration", () =>
    Effect.gen(function* () {
      const env = yield* freshEnv;
      const tables = yield* Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
        }),
        DatabaseLive.pipe(Layer.provide(appConfigFrom(env)), Layer.provide(NodeFileSystem.layer)),
      );
      const names = tables.map((table) => table.name);
      for (const table of ["datova_schranka_migrations", "server_settings", "boxes", "audit_log", "oauth_clients"]) {
        assert.include(names, table);
      }
      const path = env.DATOVA_SCHRANKA_DB_PATH ?? "";
      assert.strictEqual(statSync(path).mode & 0o777, 0o600);
      assert.strictEqual(statSync(join(path, "..")).mode & 0o777, 0o700);
    }),
  );
});

describe("CheckedDatabaseLive", () => {
  it.effect("first start stores the ISDS environment and a sealed data key check value", () =>
    Effect.gen(function* () {
      const env = yield* freshEnv;
      const rows = yield* start({ ...env, DATOVA_SCHRANKA_ISDS_ENVIRONMENT: "test" });
      assert.deepStrictEqual(
        rows.map((row) => row.key),
        [DATA_KEY_CHECK_SETTING, ISDS_ENVIRONMENT_SETTING],
      );
      assert.strictEqual(rows[1]?.value, "test");
      assert.match(rows[0]?.value ?? "", /^v1\./);
    }),
  );

  it.effect("a restart with the same environment and key passes and changes nothing", () =>
    Effect.gen(function* () {
      const env = yield* freshEnv;
      const first = yield* start(env);
      const second = yield* start(env);
      assert.deepStrictEqual(second, first);
      assert.strictEqual(second.find((row) => row.key === ISDS_ENVIRONMENT_SETTING)?.value, "production");
    }),
  );

  it.effect("refuses another ISDS environment, naming the variable and both environments", () =>
    Effect.gen(function* () {
      const env = yield* freshEnv;
      const first = yield* start(env);
      const error = yield* Effect.flip(start({ ...env, DATOVA_SCHRANKA_ISDS_ENVIRONMENT: "test" }));
      assert.instanceOf(error, ConfigError);
      assert.include(
        error.message,
        "DATOVA_SCHRANKA_ISDS_ENVIRONMENT is test but this database belongs to production",
      );
      assert.deepStrictEqual(yield* stored(env), first);
    }),
  );

  it.effect("refuses a data key that does not open the check value, without writing anything", () =>
    Effect.gen(function* () {
      const env = yield* freshEnv;
      const first = yield* start(env);
      const otherKey = { ...env, DATOVA_SCHRANKA_DATA_KEY_FILE: secretFile(OTHER_DATA_KEY_HEX) };
      const error = yield* Effect.flip(start(otherKey));
      assert.instanceOf(error, ConfigError);
      assert.include(error.message, "DATOVA_SCHRANKA_DATA_KEY_FILE: the data key does not match this database");
      assert.notInclude(error.message, OTHER_DATA_KEY_HEX);
      assert.deepStrictEqual(yield* stored(env), first);
    }),
  );

  it.effect("writes both settings or neither: a refused start leaves a missing environment missing", () =>
    Effect.gen(function* () {
      const env = yield* freshEnv;
      yield* start(env);
      yield* Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM server_settings WHERE key = ${ISDS_ENVIRONMENT_SETTING}`;
        }),
        DatabaseLive.pipe(Layer.provide(appConfigFrom(env)), Layer.provide(NodeFileSystem.layer)),
      );
      const otherKey = { ...env, DATOVA_SCHRANKA_DATA_KEY_FILE: secretFile(OTHER_DATA_KEY_HEX) };
      yield* Effect.flip(start(otherKey));
      const rows = yield* stored(env);
      assert.deepStrictEqual(
        rows.map((row) => row.key),
        [DATA_KEY_CHECK_SETTING],
      );
    }),
  );

  it.effect("names an unexpected stored environment without echoing it", () =>
    Effect.gen(function* () {
      const env = yield* freshEnv;
      yield* start(env);
      yield* Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE server_settings SET value = 'tampered-x9' WHERE key = ${ISDS_ENVIRONMENT_SETTING}`;
        }),
        DatabaseLive.pipe(Layer.provide(appConfigFrom(env)), Layer.provide(NodeFileSystem.layer)),
      );
      const error = yield* Effect.flip(start(env));
      assert.include(error.message, "belongs to an unknown environment");
      assert.notInclude(error.message, "tampered-x9");
    }),
  );
});

/** A stored box whose sealed credentials no key opens. */
const insertBox = (id: string, dbId: string, label: string, environment: "production" | "test") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO boxes ${sql.insert({
      id,
      db_id: dbId,
      label,
      label_key: label.toLowerCase(),
      environment,
      box_type: null,
      auth_kind: "password",
      owner_json: "{}",
      credentials_sealed: "v1.not.sealed.here",
      created_at: 1,
      updated_at: 1,
    })}`;
  });

/** A server start up to the BoxRegistry, built on the checked database, with what it logged. */
const startRegistry = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const logs: Array<string> = [];
    const capture = Logger.make<unknown, void>((entry) => void logs.push(Logger.formatLogFmt.log(entry)));
    const layer = BoxRegistry.Default.pipe(
      Layer.provide(fakeIsdsTransports(loginResponder({})).layer),
      Layer.provide(Layer.succeed(Redactor, Redactor.of(makeRedactor([])))),
      Layer.provide(BoxLocks.Default),
      Layer.provide(DomainLive),
      Layer.provide(checked(env)),
      Layer.provide(appConfigFrom(env)),
    );
    const skipped = yield* Effect.gen(function* () {
      return yield* (yield* BoxRegistry).skipped;
    }).pipe(Effect.provide(layer.pipe(Layer.provide(Logger.layer([capture])))));
    return { skipped, warnings: logs.filter((line) => line.includes("level=WARN")) };
  });

describe("startup with the BoxRegistry", () => {
  it.effect("reports boxes of the other environment in one warning, through the registry", () =>
    Effect.gen(function* () {
      const env = yield* freshEnv;
      yield* start(env);
      yield* onDatabase(env, insertBox("box_t", "abc1234", "Firma", "test"));
      const { skipped, warnings } = yield* startRegistry(env);
      assert.deepStrictEqual(
        skipped.map((box) => [box.id, box.environment]),
        [["box_t", "test"]],
      );
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0] ?? "", "are not loaded");
      assert.include(warnings[0] ?? "", "box_t (abc1234, test)");
    }),
  );

  it.effect("refuses a wrong data key before the registry tries to open box credentials", () =>
    Effect.gen(function* () {
      const env = yield* freshEnv;
      yield* start(env);
      yield* onDatabase(env, insertBox("box_p", "abc1234", "Firma", "production"));
      // The registry alone fails on credentials it cannot open, naming no cause.
      const unreadable = yield* Effect.flip(startRegistry(env));
      assert.instanceOf(unreadable, BoxCredentialsUnreadable);
      const otherKey = { ...env, DATOVA_SCHRANKA_DATA_KEY_FILE: secretFile(OTHER_DATA_KEY_HEX) };
      const error = yield* Effect.flip(startRegistry(otherKey));
      assert.instanceOf(error, ConfigError);
      assert.include(error.message, "the data key does not match this database");
    }),
  );
});
