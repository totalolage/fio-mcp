import { dirname } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { type MigrateOptions, runMigrations } from "./migrations.js";

/**
 * An app's SQLite database: one file, private to the user, migrated at
 * start-up with the app's own migrations table. The directory is created
 * 0700 and the file 0600 before SQLite opens it, and SQLite gives its WAL
 * and SHM files the database file's mode. Temporary data stays in memory,
 * so the database directory is the only path that must be writable.
 * ":memory:" skips the file preparation (tests use it).
 */

/** What a failure was doing; the app's `onFailure` receives it. */
export type SqliteOperation = "create the database file" | "open the database" | "configure the database" | "migrate the database";

/**
 * Maps a failed step to the app's error, given what was being done. It
 * should log the cause (the logger redacts) and fail with a value-free error.
 */
export type SqliteFailure<F> = (
  operation: SqliteOperation,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, F, R>;

/**
 * Creates the parent directory (0700) and an empty database file (0600)
 * unless they exist. An existing directory keeps its mode; an existing file
 * keeps its contents and is tightened to 0600.
 */
export const prepareDatabaseFile = Effect.fn("Sqlite.prepareFile")(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(filename), { recursive: true, mode: 0o700 });
  // "a" creates the file without truncating an existing database.
  yield* fs.writeFileString(filename, "", { flag: "a", mode: 0o600 });
  yield* fs.chmod(filename, 0o600);
});

export interface SqliteDatabaseOptions<F> extends MigrateOptions {
  /** A file path, or ":memory:". */
  readonly filename: string;
  readonly onFailure: SqliteFailure<F>;
}

/**
 * `SqlClient` (and `SqliteClient`) for `filename`, prepared, configured and
 * migrated. One connection; layers are memoized by reference, so an app
 * that provides the same value everywhere shares it.
 */
export const sqliteDatabase = <F>(
  options: SqliteDatabaseOptions<F>,
): Layer.Layer<SqlClient.SqlClient | SqliteClient.SqliteClient, F, FileSystem.FileSystem> => {
  const { filename, onFailure } = options;
  const client = SqliteClient.layer({ filename }).pipe(
    Layer.catch((cause) =>
      Layer.effectContext<SqlClient.SqlClient | SqliteClient.SqliteClient, F, never>(
        onFailure("open the database")(Effect.fail(cause)),
      ),
    ),
  );
  const configure = Effect.flatMap(SqlClient.SqlClient, (sql) => sql`PRAGMA temp_store = MEMORY`).pipe(
    onFailure("configure the database"),
  );
  const migrate = runMigrations(options).pipe(onFailure("migrate the database"));
  const ready = Layer.effectDiscard(Effect.andThen(configure, migrate)).pipe(Layer.provideMerge(client));
  return filename === ":memory:"
    ? ready
    : ready.pipe(Layer.provideMerge(Layer.effectDiscard(prepareDatabaseFile(filename).pipe(onFailure("create the database file")))));
};
