import type { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

/**
 * Schema migrations keyed by id. Core modules that persist state export
 * theirs; the app merges every set into one map and runs it with its own
 * migrator and migrations table, so ids from different modules must not
 * collide and their order is the app's.
 */
export type Migrations = Record<string, Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>>;
