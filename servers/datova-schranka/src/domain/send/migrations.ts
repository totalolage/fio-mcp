import type { Migrations } from "@mcps/core/migrations.js";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * The send flow's schema changes, ids 02xx. They apply on top of
 * DOMAIN_MIGRATIONS (01xx), which already create the filings and
 * approval_nonces tables; the app merges both maps into one.
 */
export const SEND_MIGRATIONS: Migrations = {
  /**
   * Why a filing was refused, rejected by an admin or left unresolved, in
   * plain words for the caller and the admin tab. NULL when there is none.
   */
  "0201_filing_reason": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE filings ADD COLUMN reason TEXT`;
  }),
};
