import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Raw rows of the tables a box removal touches, written the way the later services will. */

export const insertFiling = Effect.fn("insertFiling")(function* (filing: {
  readonly id: string;
  readonly boxId: string;
  readonly state: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO filings ${sql.insert({
    id: filing.id,
    grant_key: "grant-1",
    box_id: filing.boxId,
    idempotency_key: filing.id,
    content_hash: `hash-${filing.id}`,
    tier: "approve",
    state: filing.state,
    recipient_db_id: "rcp1234",
    preview_json: "{}",
    payload_sealed: `sealed-${filing.id}`,
    created_at: 1,
    updated_at: 1,
    expires_at: 1_000_000,
  })}`;
});

export const insertNonce = Effect.fn("insertNonce")(function* (nonce: {
  readonly hash: string;
  readonly filingId: string;
  readonly boxId: string;
  readonly usedAt?: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO approval_nonces ${sql.insert({
    nonce_hash: nonce.hash,
    nonce_sealed: `sealed-${nonce.hash}`,
    filing_id: nonce.filingId,
    content_hash: `hash-${nonce.filingId}`,
    box_id: nonce.boxId,
    grant_key: "grant-1",
    created_at: 1,
    expires_at: 1_000_000,
    used_at: nonce.usedAt ?? null,
  })}`;
});

export const insertTier = Effect.fn("insertTier")(function* (boxId: string, recipientDbId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO recipient_tiers ${sql.insert({
    box_id: boxId,
    recipient_db_id: recipientDbId,
    tier: "full",
    note: null,
    updated_at: 1,
  })}`;
});

export const insertAudit = Effect.fn("insertAudit")(function* (id: string, boxId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO audit_log ${sql.insert({
    id,
    at: 1,
    updated_at: 1,
    actor_kind: "admin",
    grant_id: null,
    client_id: null,
    subject: null,
    action: "box.add",
    box_id: boxId,
    outcome: "ok",
    detail_json: "{}",
  })}`;
});

export const filingRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly id: string;
    readonly state: string;
    readonly payload_sealed: string | null;
    readonly updated_at: number;
  }>`SELECT id, state, payload_sealed, updated_at FROM filings ORDER BY id`;
});

export const nonceRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly nonce_hash: string;
    readonly used_at: number | null;
  }>`SELECT nonce_hash, used_at FROM approval_nonces ORDER BY nonce_hash`;
});

export const countRows = Effect.fn("countRows")(function* (table: "recipient_tiers" | "audit_log" | "boxes") {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`;
  return rows[0]?.n ?? 0;
});
