import { Effect } from "effect";
import { Migrator, type SqlClient, type SqlError } from "effect/sql";

/**
 * Schema migrations keyed by id. Core modules that persist state export
 * theirs; the app merges every set into one map and runs it with its own
 * migrator and migrations table, so ids from different modules must not
 * collide and their order is the app's.
 */
export type Migrations = Record<string, Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>>;

export interface MigrateOptions {
  /** The app's migrations table, e.g. `<app>_migrations`. */
  readonly table: string;
  /** Keyed `<id>_<name>`: run once each, in id order. */
  readonly migrations: Migrations;
}

// The SQLite migrator (`SqliteMigrator.run` is this same value) has no schema dump.
const migrator = Migrator.make({});

/**
 * Runs pending migrations, recording each in `table`, and returns the ones
 * it applied; a no-op on an up-to-date database. Ids form one increasing
 * sequence: the migrator skips every id at or below the latest applied one,
 * so a new migration takes the next id after the highest existing one.
 * Effect 4's migrator dies with a `MigrationError` when a migration fails
 * (after rolling back), so that defect becomes a failure like the
 * migrator's other errors.
 */
export const runMigrations = (
  options: MigrateOptions,
): Effect.Effect<ReadonlyArray<readonly [id: number, name: string]>, Migrator.MigrationError | SqlError.SqlError, SqlClient.SqlClient> =>
  migrator({ loader: Migrator.fromRecord(options.migrations), table: options.table }).pipe(
    Effect.catchDefect((defect) =>
      defect instanceof Migrator.MigrationError ? Effect.fail(defect) : Effect.die(defect),
    ),
  );
