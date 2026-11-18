import { randomBytes } from "node:crypto";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { pragueDateOf } from "./cache/dates.js";
import type { Migrations } from "./cache/db.js";
import { PaymentAuditError, PermissionDenied } from "./errors.js";
import type { PayeeRecord } from "./payment-details.js";

/** Payment migrations share the cache and OAuth migration sequence. */
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
  "0012_retire_held_payments": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    const failure = new PermissionDenied({
      detail: "This batch was held for local approval and retired during an upgrade. Nothing was sent to FIO. Preview a fresh batch and use a new idempotencyKey if you still want to submit it.",
    });
    const encoded = yield* Schema.encodeEffect(PermissionDenied)(failure).pipe(Effect.orDie);
    const responseJson = JSON.stringify({ failure: encoded });
    // Keep the audit entries and their key ownership, including any held row
    // whose XML is no longer present.
    yield* sql`
      UPDATE payment_audit
      SET outcome = 'refused', updated_at = ${now}, reason = 'local approval removed during upgrade',
          response_json = ${responseJson}
      WHERE outcome = 'pending-confirmation'
    `;
    yield* sql`DROP TABLE payment_pending`;
  }),
};

/** The durable outcomes of payment submissions. */
export type AuditOutcome = "refused" | "accepted" | "rejected" | "unknown";

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
  /** Large totals use decimal strings to preserve exact cents. */
  readonly totals: Readonly<Record<string, number | string>>;
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

/**
 * A position in the audit log's newest-first order (`created_at DESC, id DESC`): the last row of
 * the previous page. Rows can share a millisecond, so the id breaks ties.
 */
export interface AuditCursor {
  readonly createdAt: number;
  readonly id: string;
}

export interface AuditQuery {
  readonly grantId?: string;
  readonly limit: number;
  /** Only rows that come after this cursor in newest-first order (paging). */
  readonly before?: AuditCursor;
}

/** `<epoch millis>_<audit id>`, the `?before=` value of /admin/payments. */
export const formatAuditCursor = (cursor: AuditCursor): string => `${cursor.createdAt}_${cursor.id}`;

const auditCursorPattern = /^(\d{1,15})_(pay_[0-9a-f]{1,64})$/;

/** Parses {@link formatAuditCursor}'s output; anything else is `undefined`. */
export const parseAuditCursor = (text: string): AuditCursor | undefined => {
  const match = auditCursorPattern.exec(text);
  return match?.[1] === undefined || match[2] === undefined ? undefined : { createdAt: Number(match[1]), id: match[2] };
};

export interface PaymentLedgerShape {
  /** Writes a new audit row and returns its id (`pay_<hex>`). */
  readonly insert: (row: NewAuditRow) => Effect.Effect<string, PaymentAuditError>;
  /** Updates a row's outcome and details. True when a row changed. */
  readonly update: (
    id: string,
    patch: AuditPatch,
    now: number,
  ) => Effect.Effect<boolean, PaymentAuditError>;
  /** The row that owns `(grantId, key)`, if any. */
  readonly findByKey: (grantId: string, key: string) => Effect.Effect<Option.Option<AuditRow>, PaymentAuditError>;
  /** Rows newest first. */
  readonly list: (query: AuditQuery) => Effect.Effect<ReadonlyArray<AuditRow>, PaymentAuditError>;
  /** Deletes audit rows whose Prague day is before `pragueDay` (YYYY-MM-DD); returns how many. */
  readonly purgeBefore: (pragueDay: string) => Effect.Effect<number, PaymentAuditError>;
}

const ExactCents = Schema.Union([Schema.Int, Schema.String.check(Schema.isPattern(/^\d+$/))]);
const Totals = Schema.fromJsonString(Schema.Record(Schema.String, ExactCents));
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
  Schema.Literals(["refused", "accepted", "rejected", "unknown"]),
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

  const update = Effect.fnUntraced(function* (id: string, patch: AuditPatch, now: number) {
      const values: Record<string, string | number | null> = { outcome: patch.outcome, updated_at: now };
      if (patch.batchIds !== undefined) values.batch_ids = patch.batchIds.length === 0 ? null : patch.batchIds.join(",");
      if (patch.fioErrorCode !== undefined) values.fio_error_code = patch.fioErrorCode;
      if (patch.reason !== undefined) values.reason = patch.reason;
      if (patch.responseJson !== undefined) values.response_json = patch.responseJson;
      const rows = yield* sql<{ grant_id: string; order_count: number; totals_json: string }>`
        UPDATE payment_audit SET ${sql.update(values)}
        WHERE id = ${id}
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

  const list: PaymentLedgerShape["list"] = (query) =>
    sql<AuditDbRow>`
      SELECT * FROM payment_audit
      WHERE ${query.grantId === undefined ? sql`1 = 1` : sql`grant_id = ${query.grantId}`}
        AND ${
          query.before === undefined
            ? sql`1 = 1`
            : sql`(created_at < ${query.before.createdAt} OR (created_at = ${query.before.createdAt} AND id < ${query.before.id}))`
        }
      ORDER BY created_at DESC, id DESC
      LIMIT ${query.limit}
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, toAuditRow)),
      failure("list the payment audit log"),
    );

  const purgeBefore: PaymentLedgerShape["purgeBefore"] = (pragueDay) =>
    sql<{ id: string }>`DELETE FROM payment_audit WHERE prague_day < ${pragueDay} RETURNING id`.pipe(
      Effect.map((rows) => rows.length),
      failure("purge the payment audit log"),
    );

  return {
    insert,
    update,
    findByKey,
    list,
    purgeBefore,
  } satisfies PaymentLedgerShape;
});

export class PaymentLedger extends Context.Service<PaymentLedger, PaymentLedgerShape>()("fio-mcp/PaymentLedger") {
  /** Needs the database (SqlClient) with PAYMENT_MIGRATIONS applied. */
  static readonly Default = Layer.effect(PaymentLedger, Effect.map(makePaymentLedger, PaymentLedger.of));
}
