import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { ADMIN_PASSWORD_HASH_KEY, settingsPasswordStore } from "../src/admin/password.js";
import { InstanceLease, LEASE_KEY } from "../src/instance-lease.js";
import {
  createServerSettings,
  makeServerSettings,
  putSetting,
  SERVER_SETTINGS_DDL,
} from "../src/server-settings.js";

/** The app's error for a failed statement (what `onFailure` maps to). */
class DemoStoreFailed extends Schema.TaggedError<DemoStoreFailed>()("DemoStoreFailed", { operation: Schema.String }) {
  override get message(): string {
    return `failed to ${this.operation}`;
  }
}

const demoFailure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, DemoStoreFailed, R> =>
    Effect.mapError(effect, () => new DemoStoreFailed({ operation }));

const memory = SqliteClient.layer({ filename: ":memory:" });
/** A database whose migrations created the table with core's step. */
const withTable = Layer.effectDiscard(Effect.orDie(createServerSettings)).pipe(Layer.provideMerge(memory));

const row = (key: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ value: string; updated_at: number }>`SELECT value, updated_at FROM server_settings WHERE key = ${key}`,
  ).pipe(Effect.map(([found]) => found));

describe("server_settings table", () => {
  it.effect("createServerSettings creates exactly the DDL's table and columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [master] = yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'server_settings'`;
      assert.strictEqual(master?.sql, SERVER_SETTINGS_DDL);
      const columns = yield* sql<{ name: string; type: string; notnull: number; pk: number }>`
        SELECT name, type, "notnull", pk FROM pragma_table_info('server_settings') ORDER BY cid
      `;
      assert.deepStrictEqual(
        columns.map((c) => [c.name, c.type, c.notnull, c.pk]),
        [
          ["key", "TEXT", 0, 1],
          ["value", "TEXT", 1, 0],
          ["updated_at", "INTEGER", 1, 0],
        ],
      );
    }).pipe(Effect.provide(withTable)),
  );

  it.effect("holds the instance lease row next to the app's settings", () =>
    Effect.gen(function* () {
      const settings = yield* makeServerSettings(demoFailure);
      yield* settings.put("other", "kept");
      const leased = yield* Effect.provide(
        settings.get(LEASE_KEY),
        InstanceLease.layer({ appName: "demo", onSqlFailure: demoFailure }),
      );
      assert.isTrue(Option.isSome(leased));
      // Released on shutdown; the other setting stays.
      assert.isTrue(Option.isNone(yield* settings.get(LEASE_KEY)));
      assert.deepStrictEqual(yield* settings.get("other"), Option.some("kept"));
    }).pipe(Effect.provide(withTable)),
  );
});

describe("makeServerSettings", () => {
  it.effect("get is none for a missing key; put stores the value at the clock time; put overwrites", () =>
    Effect.gen(function* () {
      const settings = yield* makeServerSettings(demoFailure);
      assert.isTrue(Option.isNone(yield* settings.get("marker")));

      yield* TestClock.adjust("1 second");
      yield* settings.put("marker", "one");
      assert.deepStrictEqual(yield* settings.get("marker"), Option.some("one"));
      assert.deepStrictEqual(yield* row("marker"), { value: "one", updated_at: 1000 });

      yield* TestClock.adjust("1 second");
      yield* settings.put("marker", "two");
      assert.deepStrictEqual(yield* settings.get("marker"), Option.some("two"));
      assert.deepStrictEqual(yield* row("marker"), { value: "two", updated_at: 2000 });

      const sql = yield* SqlClient.SqlClient;
      const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM server_settings`;
      assert.strictEqual(count?.n, 1);
    }).pipe(Effect.provide(withTable)),
  );

  it.effect("remove is true when the key existed, false otherwise", () =>
    Effect.gen(function* () {
      const settings = yield* makeServerSettings(demoFailure);
      yield* settings.put("marker", "set");
      assert.isTrue(yield* settings.remove("marker"));
      assert.isTrue(Option.isNone(yield* settings.get("marker")));
      assert.isFalse(yield* settings.remove("marker"));
    }).pipe(Effect.provide(withTable)),
  );

  it.effect("each statement's failure goes through onFailure with its operation", () =>
    Effect.gen(function* () {
      // No table: every statement fails.
      const settings = yield* makeServerSettings(demoFailure);
      assert.strictEqual((yield* Effect.flip(settings.get("k"))).operation, "read a setting");
      assert.strictEqual((yield* Effect.flip(settings.put("k", "v"))).operation, "store a setting");
      assert.strictEqual((yield* Effect.flip(settings.remove("k"))).operation, "delete a setting");
    }).pipe(Effect.provide(memory)),
  );
});

describe("putSetting", () => {
  it.effect("writes the given time and joins the caller's transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* putSetting("marker", "first", 5);
      assert.deepStrictEqual(yield* row("marker"), { value: "first", updated_at: 5 });

      const rolledBack = sql.withTransaction(
        Effect.andThen(putSetting("marker", "second", 6), Effect.fail("abort" as const)),
      );
      assert.strictEqual(yield* Effect.flip(rolledBack), "abort");
      assert.deepStrictEqual(yield* row("marker"), { value: "first", updated_at: 5 });

      // As an app store does it: the client it captured, provided inside its transaction.
      const viaCaptured = (value: string, at: number) =>
        putSetting("marker", value, at).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      assert.strictEqual(
        yield* Effect.flip(sql.withTransaction(Effect.andThen(viaCaptured("third", 7), Effect.fail("abort" as const)))),
        "abort",
      );
      assert.deepStrictEqual(yield* row("marker"), { value: "first", updated_at: 5 });
      yield* sql.withTransaction(viaCaptured("fourth", 8));
      assert.deepStrictEqual(yield* row("marker"), { value: "fourth", updated_at: 8 });
    }).pipe(Effect.provide(withTable)),
  );
});

describe("settingsPasswordStore", () => {
  it.effect("is empty until a hash is put, then returns it from the admin_password_hash row", () =>
    Effect.gen(function* () {
      const store = settingsPasswordStore(yield* makeServerSettings(demoFailure));
      assert.isTrue(Option.isNone(yield* store.get));
      yield* store.put("$scrypt$line-one");
      assert.deepStrictEqual(yield* store.get, Option.some("$scrypt$line-one"));
      assert.strictEqual(ADMIN_PASSWORD_HASH_KEY, "admin_password_hash");
      assert.strictEqual((yield* row("admin_password_hash"))?.value, "$scrypt$line-one");
      yield* store.put("$scrypt$line-two");
      assert.deepStrictEqual(yield* store.get, Option.some("$scrypt$line-two"));

      // A reset removes the row, so the bootstrap hash applies again.
      const settings = yield* makeServerSettings(demoFailure);
      assert.isTrue(yield* settings.remove(ADMIN_PASSWORD_HASH_KEY));
      assert.isTrue(Option.isNone(yield* store.get));
    }).pipe(Effect.provide(withTable)),
  );

  it.effect("passes the settings error (with its message) through", () =>
    Effect.gen(function* () {
      const store = settingsPasswordStore(yield* makeServerSettings(demoFailure));
      assert.strictEqual((yield* Effect.flip(store.get)).message, "failed to read a setting");
      assert.strictEqual((yield* Effect.flip(store.put("line"))).message, "failed to store a setting");
    }).pipe(Effect.provide(memory)),
  );
});
