import { randomBytes } from "node:crypto";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { pragueDateOf } from "./cache/dates.js";
import type { Migrations } from "./cache/db.js";
import { PaymentAuditError } from "./errors.js";
import type { PayeeRecord, Usage } from "./payment-limits.js";

/**
 * The durable record of payment submissions (SEC-29) and the batches held
 * for admin confirmation (SEC-27). The audit table is also the source of the
 * daily limit totals (SEC-26) and the idempotency keys (SEC-28). Neither
 * table ever holds a token: accounts appear as their token fingerprint.
 *
 * Every SqlError (and a stored value that no longer decodes) is logged and
 * becomes a value-free PaymentAuditError.
 */

/**
 * Ids continue the shared sequence after the grants' 0008. They are spread
 * into OAUTH_MIGRATIONS (src/oauth/store.ts), so the database module's
 * merged map picks them up.
 */
export const PAYMENT_MIGRATIONS: Migrations = {
  "0009_payment_audit": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE payment_audit (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        prague_day TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        client_id TEXT,
        account_id TEXT,
        account_name TEXT,
        idempotency_key TEXT,
        key_owner INTEGER NOT NULL DEFAULT 0,
        xml_sha256 TEXT,
        order_count INTEGER NOT NULL,
        totals_json TEXT NOT NULL,
        payees_json TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('refused', 'pending-confirmation', 'accepted', 'rejected', 'unknown')),
        batch_ids TEXT,
        fio_error_code TEXT,
        reason TEXT,
        response_json TEXT
      )
    `;
    yield* sql`CREATE INDEX payment_audit_grant_day ON payment_audit (grant_id, prague_day)`;
    yield* sql`CREATE INDEX payment_audit_created ON payment_audit (created_at)`;
    // The first validated attempt owns its key for good (refused included).
    yield* sql`
      CREATE UNIQUE INDEX payment_audit_key_owner ON payment_audit (grant_id, idempotency_key) WHERE key_owner = 1
    `;
  }),
  "0010_payment_pending": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE payment_pending (
        pending_id TEXT PRIMARY KEY,
        audit_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_name TEXT,
        xml TEXT NOT NULL,
        xml_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `;
    yield* sql`CREATE INDEX payment_pending_expires ON payment_pending (expires_at)`;
  }),
};

export type AuditOutcome = "refused" | "pending-confirmation" | "accepted" | "rejected" | "unknown";

/** Outcomes that count towards the daily limits (D8). */
export const COUNTED_OUTCOMES: ReadonlyArray<AuditOutcome> = ["accepted", "unknown", "pending-confirmation"];

/** One submission attempt as stored. Totals are integer cents per currency. */
export interface AuditRow {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Europe/Prague calendar day of createdAt (YYYY-MM-DD). */
  readonly pragueDay: string;
  readonly grantId: string;
  readonly clientId: string | null;
  /** Token fingerprint of the account (Account.tokenFingerprint), never the token. */
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly idempotencyKey: string | null;
  readonly keyOwner: boolean;
  readonly xmlSha256: string | null;
  readonly orderCount: number;
  readonly totals: Readonly<Record<string, number>>;
  readonly payees: ReadonlyArray<PayeeRecord>;
  readonly outcome: AuditOutcome;
  readonly batchIds: ReadonlyArray<string>;
  readonly fioErrorCode: string | null;
  readonly reason: string | null;
  /** The recorded tool response for idempotent replay (D12), or null. */
  readonly responseJson: string | null;
}

/** What `insert` needs; id, updatedAt and pragueDay are derived. */
export type NewAuditRow = Omit<AuditRow, "id" | "updatedAt" | "pragueDay">;

export interface AuditPatch {
  readonly outcome: AuditOutcome;
  readonly batchIds?: ReadonlyArray<string>;
  readonly fioErrorCode?: string | null;
  readonly reason?: string | null;
  readonly responseJson?: string | null;
}

/** A batch held for admin confirmation, with the exact XML to upload. */
export interface PendingBatch {
  readonly pendingId: string;
  readonly auditId: string;
  readonly grantId: string;
  readonly accountId: string;
  readonly accountName: string | null;
  readonly xml: string;
  readonly xmlSha256: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface AuditQuery {
  readonly grantId?: string;
  readonly limit: number;
  /** Only rows created strictly before this epoch-millis (paging). */
  readonly before?: number;
}

export interface PaymentLedgerShape {
  /** Writes a new audit row and returns its id (`pay_<hex>`). */
  readonly insert: (row: NewAuditRow) => Effect.Effect<string, PaymentAuditError>;
  /**
   * Updates a row's outcome and details; with `expect`, only while the row
   * still has that outcome. True when a row changed.
   */
  readonly update: (
    id: string,
    patch: AuditPatch,
    now: number,
    expect?: AuditOutcome,
  ) => Effect.Effect<boolean, PaymentAuditError>;
  /** The row that owns `(grantId, key)`, if any. */
  readonly findByKey: (grantId: string, key: string) => Effect.Effect<Option.Option<AuditRow>, PaymentAuditError>;
  readonly get: (id: string) => Effect.Effect<Option.Option<AuditRow>, PaymentAuditError>;
  /** The grant's counted totals (cents) and orders on that Prague day (R1). */
  readonly usage: (grantId: string, pragueDay: string) => Effect.Effect<Usage, PaymentAuditError>;
  /** Rows newest first. */
  readonly list: (query: AuditQuery) => Effect.Effect<ReadonlyArray<AuditRow>, PaymentAuditError>;
  /**
   * In one transaction, writes the audit row (normally outcome
   * "pending-confirmation") and the held batch that points at it.
   * `response` builds the recorded tool response from the new pending id.
   */
  readonly hold: (
    row: NewAuditRow,
    batch: Omit<PendingBatch, "pendingId" | "auditId" | "grantId" | "createdAt">,
    response: (pendingId: string) => string,
  ) => Effect.Effect<{ readonly auditId: string; readonly pendingId: string }, PaymentAuditError>;
  /** Held batches not yet expired at `now`, oldest first. */
  readonly pending: (now: number) => Effect.Effect<ReadonlyArray<PendingBatch>, PaymentAuditError>;
  readonly getPending: (pendingId: string) => Effect.Effect<Option.Option<PendingBatch>, PaymentAuditError>;
  /**
   * Atomically removes an unexpired held batch and returns it; None when it
   * is gone or expired, so only one caller can ever take it (R2).
   */
  readonly takePending: (
    pendingId: string,
    now: number,
  ) => Effect.Effect<Option.Option<PendingBatch>, PaymentAuditError>;
  /**
   * Removes the batches expired at `now` and marks their audit rows refused
   * (reason "confirmation expired", recording `responseJson` for replay).
   */
  readonly expirePending: (
    now: number,
    responseJson: string,
  ) => Effect.Effect<ReadonlyArray<PendingBatch>, PaymentAuditError>;
  /** Deletes audit rows whose Prague day is before `pragueDay` (YYYY-MM-DD); returns how many. */
  readonly purgeBefore: (pragueDay: string) => Effect.Effect<number, PaymentAuditError>;
}

const Totals = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Int));
const Payees = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      payee: Schema.String,
      bankCode: Schema.NullOr(Schema.String),
      bic: Schema.NullOr(Schema.String),
      amount: Schema.Number,
      currency: Schema.String,
      vs: Schema.NullOr(Schema.String),
    }),
  ),
);
const encodeTotals = Schema.encodeSync(Totals);
const encodePayees = Schema.encodeSync(Payees);
const decodeTotals = Schema.decodeUnknownEffect(Totals);
const decodePayees = Schema.decodeUnknownEffect(Payees);
const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.Literals(["refused", "pending-confirmation", "accepted", "rejected", "unknown"]),
);

interface AuditDbRow {
  readonly id: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly prague_day: string;
  readonly grant_id: string;
  readonly client_id: string | null;
  readonly account_id: string | null;
  readonly account_name: string | null;
  readonly idempotency_key: string | null;
  readonly key_owner: number;
  readonly xml_sha256: string | null;
  readonly order_count: number;
  readonly totals_json: string;
  readonly payees_json: string;
  readonly outcome: string;
  readonly batch_ids: string | null;
  readonly fio_error_code: string | null;
  readonly reason: string | null;
  readonly response_json: string | null;
}

interface PendingDbRow {
  readonly pending_id: string;
  readonly audit_id: string;
  readonly grant_id: string;
  readonly account_id: string;
  readonly account_name: string | null;
  readonly xml: string;
  readonly xml_sha256: string;
  readonly created_at: number;
  readonly expires_at: number;
}

const toAuditRow = Effect.fnUntraced(function* (row: AuditDbRow) {
  const outcome = yield* decodeOutcome(row.outcome);
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pragueDay: row.prague_day,
    grantId: row.grant_id,
    clientId: row.client_id,
    accountId: row.account_id,
    accountName: row.account_name,
    idempotencyKey: row.idempotency_key,
    keyOwner: row.key_owner === 1,
    xmlSha256: row.xml_sha256,
    orderCount: row.order_count,
    totals: yield* decodeTotals(row.totals_json),
    payees: yield* decodePayees(row.payees_json),
    outcome,
    batchIds: row.batch_ids === null || row.batch_ids === "" ? [] : row.batch_ids.split(","),
    fioErrorCode: row.fio_error_code,
    reason: row.reason,
    responseJson: row.response_json,
  } satisfies AuditRow;
});

const toPending = (row: PendingDbRow): PendingBatch => ({
  pendingId: row.pending_id,
  auditId: row.audit_id,
  grantId: row.grant_id,
  accountId: row.account_id,
  accountName: row.account_name,
  xml: row.xml,
  xmlSha256: row.xml_sha256,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

const newId = (prefix: string) => Effect.sync(() => `${prefix}${randomBytes(12).toString("hex")}`);

const failure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PaymentAuditError, R> =>
    Effect.catch(effect, (cause) =>
      Effect.logError(`payments: failed to ${operation}`, cause).pipe(
        Effect.andThen(Effect.fail(new PaymentAuditError({ operation }))),
      ),
    );

/** D17: one line per audit write, without payees, XML or tokens. */
const logAudit = (grantId: string, outcome: string, orderCount: number, totals: string) =>
  Effect.logInfo("payment audit").pipe(
    Effect.annotateLogs({ grantId, outcome, orderCount, totals }),
  );

export const makePaymentLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = Effect.fnUntraced(function* (row: NewAuditRow) {
      const id = yield* newId("pay_");
      const totals = encodeTotals(row.totals);
      yield* sql`
        INSERT INTO payment_audit ${sql.insert({
          id,
          created_at: row.createdAt,
          updated_at: row.createdAt,
          prague_day: pragueDateOf(row.createdAt),
          grant_id: row.grantId,
          client_id: row.clientId,
          account_id: row.accountId,
          account_name: row.accountName,
          idempotency_key: row.idempotencyKey,
          key_owner: row.keyOwner ? 1 : 0,
          xml_sha256: row.xmlSha256,
          order_count: row.orderCount,
          totals_json: totals,
          payees_json: encodePayees(row.payees),
          outcome: row.outcome,
          batch_ids: row.batchIds.length === 0 ? null : row.batchIds.join(","),
          fio_error_code: row.fioErrorCode,
          reason: row.reason,
          response_json: row.responseJson,
        })}
      `;
      yield* logAudit(row.grantId, row.outcome, row.orderCount, totals);
      return id;
  });

  const insert: PaymentLedgerShape["insert"] = (row) => insertRow(row).pipe(failure("write the payment audit row"));

  const update = Effect.fnUntraced(function* (id: string, patch: AuditPatch, now: number, expect?: AuditOutcome) {
      const values: Record<string, string | number | null> = { outcome: patch.outcome, updated_at: now };
      if (patch.batchIds !== undefined) values.batch_ids = patch.batchIds.length === 0 ? null : patch.batchIds.join(",");
      if (patch.fioErrorCode !== undefined) values.fio_error_code = patch.fioErrorCode;
      if (patch.reason !== undefined) values.reason = patch.reason;
      if (patch.responseJson !== undefined) values.response_json = patch.responseJson;
      const rows = yield* sql<{ grant_id: string; order_count: number; totals_json: string }>`
        UPDATE payment_audit SET ${sql.update(values)}
        WHERE id = ${id} ${expect === undefined ? sql`` : sql`AND outcome = ${expect}`}
        RETURNING grant_id, order_count, totals_json
      `;
      for (const row of rows) yield* logAudit(row.grant_id, patch.outcome, row.order_count, row.totals_json);
      return rows.length > 0;
  }, failure("update the payment audit row"));

  const findByKey: PaymentLedgerShape["findByKey"] = (grantId, key) =>
    sql<AuditDbRow>`
      SELECT * FROM payment_audit WHERE grant_id = ${grantId} AND idempotency_key = ${key} AND key_owner = 1
    `.pipe(
      Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : Effect.map(toAuditRow(row), Option.some))),
      failure("look up the idempotency key"),
    );

  const get: PaymentLedgerShape["get"] = (id) =>
    sql<AuditDbRow>`SELECT * FROM payment_audit WHERE id = ${id}`.pipe(
      Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : Effect.map(toAuditRow(row), Option.some))),
      failure("read the payment audit row"),
    );

  const usage = Effect.fnUntraced(function* (grantId: string, pragueDay: string) {
      const rows = yield* sql<{ order_count: number; totals_json: string }>`
        SELECT order_count, totals_json FROM payment_audit
        WHERE grant_id = ${grantId} AND prague_day = ${pragueDay} AND outcome IN ${sql.in(COUNTED_OUTCOMES)}
      `;
      const totals: Record<string, number> = {};
      let orders = 0;
      for (const row of rows) {
        orders += row.order_count;
        for (const [currency, cents] of Object.entries(yield* decodeTotals(row.totals_json))) {
          totals[currency] = (totals[currency] ?? 0) + cents;
        }
      }
      return { totals, orders } satisfies Usage;
  }, failure("read today's payment totals"));

  const list: PaymentLedgerShape["list"] = (query) =>
    sql<AuditDbRow>`
      SELECT * FROM payment_audit
      WHERE ${query.grantId === undefined ? sql`1 = 1` : sql`grant_id = ${query.grantId}`}
        AND ${query.before === undefined ? sql`1 = 1` : sql`created_at < ${query.before}`}
      ORDER BY created_at DESC, id DESC
      LIMIT ${query.limit}
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, toAuditRow)),
      failure("list the payment audit log"),
    );

  const hold: PaymentLedgerShape["hold"] = (row, batch, response) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const pendingId = yield* newId("pend_");
          const auditId = yield* insertRow({ ...row, responseJson: response(pendingId) });
          yield* sql`
        INSERT INTO payment_pending ${sql.insert({
          pending_id: pendingId,
          audit_id: auditId,
          grant_id: row.grantId,
          account_id: batch.accountId,
          account_name: batch.accountName,
          xml: batch.xml,
          xml_sha256: batch.xmlSha256,
          created_at: row.createdAt,
          expires_at: batch.expiresAt,
        })}
      `;
          return { auditId, pendingId };
        }),
      )
      .pipe(failure("hold the payment batch"));

  const pending: PaymentLedgerShape["pending"] = (now) =>
    sql<PendingDbRow>`SELECT * FROM payment_pending WHERE expires_at > ${now} ORDER BY created_at, pending_id`.pipe(
      Effect.map((rows) => rows.map(toPending)),
      failure("list the held payment batches"),
    );

  const getPending: PaymentLedgerShape["getPending"] = (pendingId) =>
    sql<PendingDbRow>`SELECT * FROM payment_pending WHERE pending_id = ${pendingId}`.pipe(
      Effect.map(([row]) => Option.map(Option.fromNullishOr(row), toPending)),
      failure("read the held payment batch"),
    );

  const takePending: PaymentLedgerShape["takePending"] = (pendingId, now) =>
    sql<PendingDbRow>`
      DELETE FROM payment_pending WHERE pending_id = ${pendingId} AND expires_at > ${now} RETURNING *
    `.pipe(
      Effect.map(([row]) => Option.map(Option.fromNullishOr(row), toPending)),
      failure("take the held payment batch"),
    );

  const expirePending: PaymentLedgerShape["expirePending"] = (now, responseJson) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<PendingDbRow>`DELETE FROM payment_pending WHERE expires_at <= ${now} RETURNING *`;
          const expired = rows.map(toPending);
          for (const batch of expired) {
            yield* update(
              batch.auditId,
              { outcome: "refused", reason: "confirmation expired", responseJson },
              now,
              "pending-confirmation",
            );
          }
          return expired;
        }),
      )
      .pipe(failure("expire held payment batches"));

  const purgeBefore: PaymentLedgerShape["purgeBefore"] = (pragueDay) =>
    sql<{ id: string }>`DELETE FROM payment_audit WHERE prague_day < ${pragueDay} RETURNING id`.pipe(
      Effect.map((rows) => rows.length),
      failure("purge the payment audit log"),
    );

  return {
    insert,
    update,
    findByKey,
    get,
    usage,
    list,
    hold,
    pending,
    getPending,
    takePending,
    expirePending,
    purgeBefore,
  } satisfies PaymentLedgerShape;
});

export class PaymentLedger extends Context.Service<PaymentLedger, PaymentLedgerShape>()("fio-mcp/PaymentLedger") {
  /** Needs the database (SqlClient) with PAYMENT_MIGRATIONS applied. */
  static readonly Default = Layer.effect(PaymentLedger, Effect.map(makePaymentLedger, PaymentLedger.of));
}
