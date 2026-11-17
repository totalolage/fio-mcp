import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { DOMAIN_MIGRATIONS } from "../../../../src/domain/migrations.js";
import { SEND_MIGRATIONS } from "../../../../src/domain/send/migrations.js";
import { memoryDatabase } from "../../support/database.js";

/** A fresh in-memory database with the domain and the send migrations applied. */
export const sendDatabase = () => memoryDatabase({ ...DOMAIN_MIGRATIONS, ...SEND_MIGRATIONS });

/** A filings row exactly as stored (snake_case columns, JSON as text, NULLs as null). */
export type RawFilingRow = Readonly<Record<string, unknown>>;

/** An approval_nonces row exactly as stored. */
export interface RawNonceRow {
  readonly nonce_hash: string;
  readonly nonce_sealed: string;
  readonly filing_id: string;
  readonly content_hash: string;
  readonly box_id: string;
  readonly grant_key: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly used_at: number | null;
}

/** The stored filings row with this id, bypassing the store. */
export const rawFiling = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<RawFilingRow>`SELECT * FROM filings WHERE id = ${id}`;
    return Option.fromNullishOr(row);
  });

/** Every stored filings row, by id. */
export const rawFilings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<RawFilingRow>`SELECT * FROM filings ORDER BY id`;
});

/** Every stored approval_nonces row (all filings), by hash. */
export const rawNonces = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<RawNonceRow>`SELECT * FROM approval_nonces ORDER BY nonce_hash`;
});

/** Overwrites columns of a stored filing, bypassing the store (to plant states or corrupt rows). */
export const patchRawFiling = (id: string, columns: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE filings SET ${sql.update(columns)} WHERE id = ${id}`;
  });
