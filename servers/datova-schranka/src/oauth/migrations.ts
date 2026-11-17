import type { Migrations } from "@mcps/core/migrations.js";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * Grant settings columns on core's oauth_grants (app range 0106–0149): the
 * delivery-consent wording version the user ticked and when. Both stay null
 * on grants without isds:read.
 */
export const OAUTH_APP_MIGRATIONS: Migrations = {
  "0106_grant_delivery_consent": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE oauth_grants ADD COLUMN delivery_consent_version TEXT`;
    yield* sql`ALTER TABLE oauth_grants ADD COLUMN delivery_consented_at TEXT`;
  }),
};
