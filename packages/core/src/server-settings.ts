import { Clock, Effect, Option } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/**
 * `server_settings`: one key/value table for a server's small persistent
 * values (the changed admin password hash, the instance lease row, check
 * values, markers). Values are text and not secret; `updated_at` is the
 * epoch milliseconds of the last write.
 *
 * Core adds no migration: the app creates the table in one of its own
 * migrations, with `createServerSettings` (id and order are the app's).
 * `InstanceLease` (instance-lease.ts) and `settingsPasswordStore`
 * (admin/password.ts) use this same table and need exactly these columns.
 */

/**
 * The table's DDL. Frozen: an app's migration runs it once, and the text is
 * kept in the database's schema, so changing it would make new databases
 * differ from existing ones.
 */
export const SERVER_SETTINGS_DDL =
  "CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)";

/** A migration step creating the table, for the app's `Migrations`. */
export const createServerSettings: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => Effect.asVoid(sql.unsafe(SERVER_SETTINGS_DDL)),
);

/**
 * Inserts or replaces a setting written at `updatedAt` (epoch ms), with no
 * error mapping: for a write inside the app's own transaction.
 */
export const putSetting = (
  key: string,
  value: string,
  updatedAt: number,
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.asVoid(sql`
    INSERT INTO server_settings ${sql.insert({ key, value, updated_at: updatedAt })}
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `),
  );

/** What a failure was doing; the app's `onFailure` receives it. */
export type SettingsOperation = "read a setting" | "store a setting" | "delete a setting";

/**
 * Maps a failed statement to the app's error, given what was being done.
 * It should log the cause (the logger redacts) and fail with a value-free error.
 */
export type SettingsFailure<F> = (
  operation: SettingsOperation,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, F, R>;

export interface ServerSettings<F> {
  /** The setting's value, if it is set. */
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, F>;
  /** Sets the value; `updated_at` is the current clock time. */
  readonly put: (key: string, value: string) => Effect.Effect<void, F>;
  /** Deletes the setting; true when it existed. */
  readonly remove: (key: string) => Effect.Effect<boolean, F>;
}

/** The settings store on the SqlClient in context, which must have the table. */
export const makeServerSettings = <F>(
  onFailure: SettingsFailure<F>,
): Effect.Effect<ServerSettings<F>, never, SqlClient.SqlClient> =>
  Effect.map(SqlClient.SqlClient, (sql) => {
    const provide = Effect.provideService(SqlClient.SqlClient, sql);

    const get = (key: string) =>
      sql<{ value: string }>`SELECT value FROM server_settings WHERE key = ${key}`.pipe(
        Effect.map(([row]) => Option.map(Option.fromNullishOr(row), (r) => r.value)),
        onFailure("read a setting"),
      );

    const put = (key: string, value: string) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => putSetting(key, value, now)).pipe(
        provide,
        onFailure("store a setting"),
      );

    const remove = (key: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const [row] = yield* sql<{ key: string }>`SELECT key FROM server_settings WHERE key = ${key}`;
            yield* sql`DELETE FROM server_settings WHERE key = ${key}`;
            return row !== undefined;
          }),
        )
        .pipe(onFailure("delete a setting"));

    return { get, put, remove } satisfies ServerSettings<F>;
  });
