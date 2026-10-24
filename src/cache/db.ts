import { dirname } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer } from "effect";
import { Migrator, SqlClient, type SqlError } from "effect/sql";
import { AppConfig } from "../config.js";
import { CacheError, InvalidInput } from "../errors.js";
import { OAUTH_MIGRATIONS } from "../oauth/store.js";

/**
 * The server's SQLite file (FIO_DB_PATH). It holds the transaction cache and
 * the OAuth state (clients, grants, token hashes), so the layer does not
 * depend on cache.enabled. One connection per process (the
 * HTTP transport serves several MCP sessions from it). The file is
 * private to the user: the directory is created 0700 and the file 0600
 * before SQLite opens it, and SQLite gives its WAL and SHM files the
 * database file's mode. Temporary data stays in memory so the database
 * directory is the only path that must be writable.
 */

/** Logs the cause (the logger redacts) and replaces it with a value-free CacheError. */
export const cacheFailure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, CacheError, R> =>
    Effect.catch(effect, (cause) =>
      Effect.logError(`cache: failed to ${operation}`, cause).pipe(
        Effect.andThen(Effect.fail(new CacheError({ operation }))),
      ),
    );

/** A migration: an Effect keyed `<id>_<name>`, run once in id order. */
export type Migrations = Record<string, Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>>;

/**
 * Cache migrations. Other modules contribute their own record, merged as
 * `{ ...CACHE_MIGRATIONS, ...others }`. Ids form ONE increasing sequence
 * across all modules: the migrator skips every id at or below the latest
 * applied one, so a new migration from any module takes the next id after
 * the highest existing id (never a reserved lower range).
 */
export const CACHE_MIGRATIONS: Migrations = {
  "0001_create_cache": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE accounts (
        account_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        bank_id TEXT NOT NULL,
        iban TEXT,
        bic TEXT,
        currency TEXT,
        balance REAL,
        balance_date TEXT,
        updated_at INTEGER NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE bindings (
        token_fingerprint TEXT PRIMARY KEY,
        account_key TEXT NOT NULL,
        account_name TEXT NOT NULL,
        verified_at INTEGER NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE transactions (
        account_key TEXT NOT NULL,
        movement_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        amount REAL,
        currency TEXT,
        counterparty_account TEXT,
        counterparty_bank_code TEXT,
        counterparty_bank_name TEXT,
        counterparty_name TEXT,
        counterparty_bic TEXT,
        constant_symbol TEXT,
        variable_symbol TEXT,
        specific_symbol TEXT,
        user_identification TEXT,
        message TEXT,
        type TEXT,
        executed_by TEXT,
        details TEXT,
        comment TEXT,
        instruction_id INTEGER,
        payer_reference TEXT,
        raw_json TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_key, movement_id)
      )
    `;
    yield* sql`CREATE INDEX transactions_by_date ON transactions (account_key, date)`;
    yield* sql`CREATE INDEX transactions_by_counterparty ON transactions (account_key, counterparty_account)`;
    yield* sql`
      CREATE TABLE coverage_days (
        account_key TEXT NOT NULL,
        day TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (account_key, day)
      ) WITHOUT ROWID
    `;
    yield* sql`
      CREATE TABLE sync_state (
        token_fingerprint TEXT PRIMARY KEY,
        account_key TEXT,
        mode TEXT,
        pending_json TEXT NOT NULL DEFAULT '[]',
        blocked_json TEXT NOT NULL DEFAULT '[]',
        failed_days_json TEXT NOT NULL DEFAULT '[]',
        history_limited INTEGER NOT NULL DEFAULT 0,
        history_limited_since INTEGER,
        backfill_target TEXT,
        last_success_at INTEGER,
        last_attempt_at INTEGER,
        last_error TEXT,
        rows_written INTEGER NOT NULL DEFAULT 0
      )
    `;
  }),
  // Legacy pending ranges do not identify which ranges were explicitly refreshed, so resume all as upserts.
  "0003_pending_range_replace": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE sync_state SET pending_json = (
        SELECT json_group_array(json_set(value, '$.replace', json('false')))
        FROM (SELECT value FROM json_each(sync_state.pending_json) ORDER BY key)
      )
    `;
  }),
};

const MIGRATIONS_TABLE = "fio_mcp_migrations";

/**
 * Runs pending migrations; a no-op on an up-to-date database. Effect 4.0.5's
 * migrator dies with a MigrationError when a migration fails (after rolling
 * back), so that defect becomes a failure like the migrator's other errors.
 */
export const migrate = (migrations: Migrations = CACHE_MIGRATIONS) =>
  SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations), table: MIGRATIONS_TABLE }).pipe(
    Effect.catchDefect((defect) =>
      defect instanceof Migrator.MigrationError ? Effect.fail(defect) : Effect.die(defect),
    ),
    cacheFailure("migrate the database"),
  );

/** Creates the parent directory (0700) and an empty database file (0600) unless they exist. */
export const prepareDatabaseFile = Effect.fn("Cache.prepareFile")(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(filename), { recursive: true, mode: 0o700 });
  // "a" creates the file without truncating an existing database.
  yield* fs.writeFileString(filename, "", { flag: "a", mode: 0o600 });
  yield* fs.chmod(filename, 0o600);
}, cacheFailure("create the database file"));

const configure = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA temp_store = MEMORY`;
}).pipe(cacheFailure("configure the database"));

/**
 * SqlClient (and SqliteClient) for `filename`, migrated. ":memory:" skips the
 * file preparation; tests use it.
 */
const layer = (
  filename: string,
  migrations: Migrations = CACHE_MIGRATIONS,
): Layer.Layer<SqlClient.SqlClient | SqliteClient.SqliteClient, CacheError, FileSystem.FileSystem> => {
  const client = SqliteClient.layer({ filename }).pipe(
    Layer.catch((cause) =>
      Layer.effectContext<SqlClient.SqlClient | SqliteClient.SqliteClient, CacheError, never>(
        Effect.logError("cache: failed to open the database", cause).pipe(
          Effect.andThen(Effect.fail(new CacheError({ operation: "open the database" }))),
        ),
      ),
    ),
  );
  const ready = Layer.effectDiscard(Effect.andThen(configure, migrate(migrations))).pipe(Layer.provideMerge(client));
  return filename === ":memory:"
    ? ready
    : ready.pipe(Layer.provideMerge(Layer.effectDiscard(prepareDatabaseFile(filename))));
};

/** Every module's migrations, in one id sequence. */
export const SERVER_MIGRATIONS: Migrations = { ...CACHE_MIGRATIONS, ...OAUTH_MIGRATIONS };

/**
 * The server's database (`SqlClient`). Not a `Context.Service`: `SqlClient`
 * is the capability, and this is its only adapter.
 */
export const Database = {
  layer,
  /**
   * The database at `AppConfig.cache.dbPath` (FIO_DB_PATH) with all
   * migrations. Every user provides this same value, so one build (one
   * connection) is shared: layers are memoized by reference.
   */
  Live: Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      if (config.cache.dbPath === "") {
        return yield* new CacheError({ operation: "locate the database (set FIO_DB_PATH)" });
      }
      return layer(config.cache.dbPath, SERVER_MIGRATIONS);
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer), Layer.provide(AppConfig.Live)),
};

/**
 * Writes a consistent copy of the live database to `destination` with
 * `VACUUM INTO` (safe while the server writes through WAL). The destination
 * must not exist; it is created 0600.
 */
export const backupDatabase = Effect.fn("Cache.backup")(function* (destination: string) {
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const exists = yield* fs.exists(destination).pipe(cacheFailure("check the backup destination"));
  if (exists) return yield* new InvalidInput({ detail: `Backup destination ${destination} already exists.` });
  yield* fs.writeFileString(destination, "", { flag: "wx", mode: 0o600 }).pipe(cacheFailure("create the backup file"));
  yield* sql`VACUUM INTO ${destination}`.pipe(cacheFailure("write the backup"));
  yield* fs.chmod(destination, 0o600).pipe(cacheFailure("restrict the backup file"));
  const info = yield* fs.stat(destination).pipe(cacheFailure("read the backup file"));
  return { destination, bytes: Number(info.size) };
});
