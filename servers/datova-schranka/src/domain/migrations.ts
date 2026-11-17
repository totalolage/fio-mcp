import type { Migrations } from "@mcps/core/migrations.js";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * The domain's tables, ids 01xx (foundation). The app merges them after
 * core's OAuth and server_settings migrations into one map and runs it with
 * the migrations table `datova_schranka_migrations`. Fresh databases only:
 * there is no installed base to upgrade.
 *
 * No table has a foreign key to the OAuth tables: audit rows and filings
 * outlive the grants and boxes they name.
 */

/** Send-flow states (design §9 R3). Terminal: sent, isds_rejected, refused, admin_rejected, expired, not_sent. */
export const FILING_STATES = [
  "awaiting_approval",
  "pending_admin",
  "dispatching",
  "sent",
  "isds_rejected",
  "refused",
  "admin_rejected",
  "expired",
  "outcome_unknown",
  "not_sent",
] as const;
export type FilingState = (typeof FILING_STATES)[number];

/** A box's filings still waiting for approval; removing the box expires them. */
export const OPEN_FILING_STATES = ["awaiting_approval", "pending_admin"] as const satisfies ReadonlyArray<FilingState>;

export const DOMAIN_MIGRATIONS: Migrations = {
  /**
   * Stored data boxes. `id` is our opaque grant key (random per add);
   * `db_id` the ISDS box id, unique among stored boxes. `label_key` is the
   * trimmed, lower-cased label. `credentials_sealed` holds the PKCS#12 and
   * passphrase or username and password, sealed with AAD
   * datova-schranka:box-credentials:v1:<id>.
   */
  "0101_boxes": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE boxes (
        id TEXT PRIMARY KEY,
        db_id TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        label_key TEXT NOT NULL UNIQUE,
        environment TEXT NOT NULL CHECK (environment IN ('production', 'test')),
        box_type TEXT,
        auth_kind TEXT NOT NULL CHECK (auth_kind IN ('certificate', 'password')),
        owner_json TEXT NOT NULL,
        credentials_sealed TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
  }),
  /** Per sending box: recipients with a tier above the default `none`. Unlisted recipients are `none`. */
  "0102_recipient_tiers": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE recipient_tiers (
        box_id TEXT NOT NULL,
        recipient_db_id TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('approve', 'full')),
        note TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (box_id, recipient_db_id)
      )
    `;
  }),
  /**
   * Every tool call, admin action, consent and system event. Rows are
   * written with outcome 'started' before a call with legal effect and
   * updated after. `detail_json` is redacted: no credentials, no
   * attachment bytes (hashes and sizes only).
   */
  "0103_audit_log": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('tool', 'admin', 'consent', 'system')),
        grant_id TEXT,
        client_id TEXT,
        subject TEXT,
        action TEXT NOT NULL,
        box_id TEXT,
        outcome TEXT NOT NULL,
        detail_json TEXT NOT NULL
      )
    `;
    yield* sql`CREATE INDEX audit_log_at ON audit_log (at, id)`;
    yield* sql`CREATE INDEX audit_log_grant ON audit_log (grant_id, at, id)`;
    yield* sql`CREATE INDEX audit_log_box ON audit_log (box_id, at, id)`;
  }),
  /**
   * The send ledger (design §9 R3). `grant_key` is the grant id. One
   * filing per (grant, box, idempotency key); `content_hash` is the
   * SHA-256 of the canonical message. `payload_sealed` (AAD
   * datova-schranka:filing:v1:<id>) holds the full message and is cleared
   * on terminal states; `preview_json` (envelope and attachment
   * names/sizes/hashes) is plaintext. A dmID belongs to one filing at most.
   */
  "0104_filings": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The state list repeats FILING_STATES (test/domain/migrations.test.ts checks they agree).
    yield* sql`
      CREATE TABLE filings (
        id TEXT PRIMARY KEY,
        grant_key TEXT NOT NULL,
        box_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('none', 'approve', 'full')),
        state TEXT NOT NULL CHECK (state IN ('awaiting_approval', 'pending_admin', 'dispatching', 'sent',
          'isds_rejected', 'refused', 'admin_rejected', 'expired', 'outcome_unknown', 'not_sent')),
        recipient_db_id TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        payload_sealed TEXT,
        dm_id TEXT UNIQUE,
        isds_status_json TEXT,
        submitted_at INTEGER,
        reconcile_json TEXT,
        reconciled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        UNIQUE (grant_key, box_id, idempotency_key)
      )
    `;
    yield* sql`CREATE INDEX filings_box_state ON filings (box_id, state)`;
    yield* sql`CREATE INDEX filings_state_expires ON filings (state, expires_at)`;
  }),
  /**
   * Approval nonces (send tier `approve`). Looked up by hash; the nonce
   * itself is also kept sealed (AAD datova-schranka:approval-nonce:v1:<hash>)
   * so a lost approval_required response can be replayed until expiry.
   * Single use: `used_at` is set when consumed or burnt.
   */
  "0105_approval_nonces": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE approval_nonces (
        nonce_hash TEXT PRIMARY KEY,
        nonce_sealed TEXT NOT NULL,
        filing_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        box_id TEXT NOT NULL,
        grant_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      )
    `;
    yield* sql`CREATE INDEX approval_nonces_filing ON approval_nonces (filing_id)`;
  }),
};
