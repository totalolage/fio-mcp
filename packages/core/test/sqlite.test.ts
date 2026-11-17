import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, type FileSystem, type Layer, Ref, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { type Migrations, runMigrations } from "../src/migrations.js";
import { prepareDatabaseFile, type SqliteOperation, sqliteDatabase } from "../src/sqlite.js";

const freshDir = () => mkdtempSync(join(tmpdir(), "core-sqlite-"));
const mode = (path: string) => statSync(path).mode & 0o777;

const TABLE = "demo_app_migrations";

/** The app's error for a failed step (what `onFailure` maps to). */
class DemoDbFailed extends Schema.TaggedError<DemoDbFailed>()("DemoDbFailed", { operation: Schema.String }) {}

const demoFailure =
  (operation: SqliteOperation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, DemoDbFailed, R> =>
    Effect.mapError(effect, () => new DemoDbFailed({ operation }));

/** Migrations that append their id to `log` when they run. */
const logged = (log: Ref.Ref<ReadonlyArray<string>>, ids: ReadonlyArray<string>): Migrations =>
  Object.fromEntries(
    ids.map((id) => [
      id,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE TABLE t_${id} (x INTEGER)`);
        yield* Ref.update(log, (entries) => [...entries, id]);
      }),
    ]),
  );

const recorded = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{ migration_id: number; name: string }>`SELECT migration_id, name FROM ${sql(TABLE)} ORDER BY migration_id`,
).pipe(Effect.map((rows) => rows.map((row) => `${String(row.migration_id).padStart(4, "0")}_${row.name}`)));

const memory = SqliteClient.layer({ filename: ":memory:" });

describe("prepareDatabaseFile", () => {
  it.effect("creates the directory 0700 and an empty file 0600", () =>
    Effect.gen(function* () {
      const dir = join(freshDir(), "nested", "data");
      const file = join(dir, "app.sqlite");
      yield* prepareDatabaseFile(file);
      assert.strictEqual(mode(dir), 0o700);
      assert.strictEqual(mode(file), 0o600);
      assert.strictEqual(readFileSync(file, "utf8"), "");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("keeps an existing directory's mode and file's contents, and tightens the file to 0600", () =>
    Effect.gen(function* () {
      const dir = join(freshDir(), "data");
      mkdirSync(dir, { mode: 0o755 });
      chmodSync(dir, 0o755);
      const file = join(dir, "app.sqlite");
      writeFileSync(file, "existing", { mode: 0o644 });
      chmodSync(file, 0o644);
      yield* prepareDatabaseFile(file);
      assert.strictEqual(mode(dir), 0o755);
      assert.strictEqual(mode(file), 0o600);
      assert.strictEqual(readFileSync(file, "utf8"), "existing");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("fails when the parent path is a file", () =>
    Effect.gen(function* () {
      const blocker = join(freshDir(), "blocker");
      writeFileSync(blocker, "");
      const exit = yield* Effect.exit(prepareDatabaseFile(join(blocker, "app.sqlite")));
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

describe("runMigrations", () => {
  it.effect("runs in id order, records each id in the app's table, and is a no-op on rerun", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      // Declared out of order: the migrator orders by id.
      const migrations = logged(log, ["0003_third", "0001_first", "0002_second"]);
      const applied = yield* runMigrations({ table: TABLE, migrations });
      assert.deepStrictEqual(
        applied.map(([id, name]) => [id, name]),
        [
          [1, "first"],
          [2, "second"],
          [3, "third"],
        ],
      );
      assert.deepStrictEqual(yield* Ref.get(log), ["0001_first", "0002_second", "0003_third"]);
      assert.deepStrictEqual(yield* recorded, ["0001_first", "0002_second", "0003_third"]);

      const again = yield* runMigrations({ table: TABLE, migrations });
      assert.deepStrictEqual(again, []);
      assert.deepStrictEqual(yield* Ref.get(log), ["0001_first", "0002_second", "0003_third"]);

      // Only ids above the latest applied one run later.
      const more = { ...migrations, ...logged(log, ["0000_too_low", "0004_fourth"]) };
      const later = yield* runMigrations({ table: TABLE, migrations: more });
      assert.deepStrictEqual(
        later.map(([id]) => id),
        [4],
      );
      assert.deepStrictEqual(yield* recorded, ["0001_first", "0002_second", "0003_third", "0004_fourth"]);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("keeps separate histories per table name", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* runMigrations({ table: TABLE, migrations: logged(log, ["0001_a"]) });
      const other = yield* runMigrations({ table: "other_app_migrations", migrations: logged(log, ["0001_b"]) });
      assert.deepStrictEqual(
        other.map(([id, name]) => [id, name]),
        [[1, "b"]],
      );
    }).pipe(Effect.provide(memory)),
  );

  it.effect("a failing migration is a MigrationError failure (not a defect) and is rolled back", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrations: Migrations = {
        "0001_ok": Effect.asVoid(sql`CREATE TABLE ok (x INTEGER)`),
        "0002_broken": Effect.gen(function* () {
          yield* sql`CREATE TABLE half (x INTEGER)`;
          yield* sql`INSERT INTO missing_table VALUES (1)`;
        }),
      };
      const exit = yield* Effect.exit(runMigrations({ table: TABLE, migrations }));
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined;
      assert.instanceOf(error?._tag === "Fail" ? error.error : undefined, Migrator.MigrationError);
      const half = yield* sql`SELECT name FROM sqlite_master WHERE name = 'half'`;
      assert.deepStrictEqual(half, []);
    }).pipe(Effect.provide(memory)),
  );
  it.effect("any other defect in a migration stays a defect", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(runMigrations({ table: TABLE, migrations: { "0001_dies": Effect.die("boom") } }));
      assert.isTrue(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die"));
      assert.isFalse(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Fail"));
    }).pipe(Effect.provide(memory)),
  );
});

describe("sqliteDatabase", () => {
  it.effect("prepares, opens and migrates a file database with the app's migrations table", () =>
    Effect.gen(function* () {
      const dir = join(freshDir(), "data");
      const file = join(dir, "app.sqlite");
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      const database = sqliteDatabase({
        filename: file,
        table: TABLE,
        migrations: logged(log, ["0001_first"]),
        onFailure: demoFailure,
      });
      yield* Effect.gen(function* () {
        assert.deepStrictEqual(yield* recorded, ["0001_first"]);
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ temp_store: number }>`PRAGMA temp_store`;
        assert.strictEqual(row?.temp_store, 2); // MEMORY
      }).pipe(Effect.provide(database));
      assert.strictEqual(mode(dir), 0o700);
      assert.strictEqual(mode(file), 0o600);
      // Reopening applies nothing again.
      yield* Effect.provide(recorded, database);
      assert.deepStrictEqual(yield* Ref.get(log), ["0001_first"]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect('":memory:" creates no file', () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.provide(
        recorded,
        sqliteDatabase({ filename: ":memory:", table: TABLE, migrations: logged(log, ["0001_first"]), onFailure: demoFailure }),
      );
      assert.isFalse(existsSync(":memory:"));
      assert.deepStrictEqual(yield* Ref.get(log), ["0001_first"]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  const failedOperation = (layer: Layer.Layer<SqlClient.SqlClient, DemoDbFailed, FileSystem.FileSystem>) =>
    Effect.flip(Effect.provide(Effect.void, layer)).pipe(Effect.map((error) => error.operation));

  it.effect("onFailure receives the step's original error", () =>
    Effect.gen(function* () {
      const seen: Array<[SqliteOperation, unknown]> = [];
      const capture =
        (operation: SqliteOperation) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, DemoDbFailed, R> =>
          Effect.mapError(effect, (cause) => {
            seen.push([operation, cause]);
            return new DemoDbFailed({ operation });
          });
      const broken: Migrations = { "0001_broken": Effect.die(new Migrator.MigrationError({ kind: "Failed", message: "demo" })) };
      yield* failedOperation(sqliteDatabase({ filename: ":memory:", table: TABLE, migrations: broken, onFailure: capture }));
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0]?.[0], "migrate the database");
      assert.instanceOf(seen[0]?.[1], Migrator.MigrationError);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("maps each failed step through onFailure", () =>
    Effect.gen(function* () {
      const blocker = join(freshDir(), "blocker");
      writeFileSync(blocker, "");
      assert.strictEqual(
        yield* failedOperation(
          sqliteDatabase({ filename: join(blocker, "app.sqlite"), table: TABLE, migrations: {}, onFailure: demoFailure }),
        ),
        "create the database file",
      );

      const notDb = join(freshDir(), "garbage.sqlite");
      writeFileSync(notDb, "this is not a sqlite database, only some text that fills the header page");
      const garbage = yield* failedOperation(
        sqliteDatabase({ filename: notDb, table: TABLE, migrations: {}, onFailure: demoFailure }),
      );
      // The client reads the file when it opens it.
      assert.strictEqual(garbage, "open the database");

      const broken: Migrations = {
        "0001_broken": Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.asVoid(sql`INSERT INTO missing_table VALUES (1)`)),
      };
      assert.strictEqual(
        yield* failedOperation(sqliteDatabase({ filename: ":memory:", table: TABLE, migrations: broken, onFailure: demoFailure })),
        "migrate the database",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
