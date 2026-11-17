import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { Migrations } from "./cache/db.js";

/**
 * The account store's tables (src/account-store.ts). A module of its own,
 * with no imports from the app, so src/cache/db.ts can gather it without an
 * import cycle through src/accounts.ts.
 */

/** Ids continue the shared sequence (src/cache/db.ts); 0004 and 0006 are src/oauth/store.ts's. */
export const ACCOUNT_MIGRATIONS: Migrations = {
  "0005_create_accounts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE fio_accounts (
        account_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        token_sealed TEXT NOT NULL,
        token_fingerprint TEXT NOT NULL,
        account_number TEXT,
        currency TEXT,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        token_updated_at INTEGER NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE server_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
  }),
  /**
   * Every token each account has had (its current one included), so a purge
   * finds what earlier tokens cached. Bindings made before this migration
   * by tokens that are no account's current token cannot be attributed and
   * are left out.
   */
  "0007_account_token_history": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE fio_account_tokens (
        account_id TEXT NOT NULL,
        token_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, token_fingerprint)
      ) WITHOUT ROWID
    `;
    yield* sql`
      INSERT INTO fio_account_tokens (account_id, token_fingerprint, created_at)
      SELECT account_id, token_fingerprint, token_updated_at FROM fio_accounts
    `;
  }),
};
