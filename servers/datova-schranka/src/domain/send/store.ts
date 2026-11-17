import { Clock, Data, Effect, Option, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { FileMetaType } from "../../isds/create-message.js";
import { IsdsStatusClassification } from "../../isds/errors.js";
import type { DomainStoreError } from "../errors.js";
import { storeFailure } from "../errors.js";
import { FILING_STATES, type FilingState, OPEN_FILING_STATES } from "../migrations.js";
import type { RecipientTier } from "../recipient-tiers.js";
import type { Filing, FilingListQuery, FilingPreview, IsdsStatusSummary } from "./api.js";

/**
 * Persistence of filings and approval nonces (tables 0104/0105 plus
 * 0201_filing_reason). Only the send service uses it, so it is a plain
 * constructor (`makeFilingStore`) rather than a Context.Service.
 *
 * Every state change is a compare-and-set: `UPDATE … WHERE id = ? AND state
 * IN (…) RETURNING …`, reported as Won or Lost rather than as an error.
 * Writes of more than one statement run in one transaction and roll back
 * unless every statement hit its row. Times are epoch milliseconds from
 * Clock; the store keeps `updated_at`. Every database or decode failure is
 * a DomainStoreError (storeFailure).
 */

// Row decoding ---------------------------------------------------------------

const Millis = Schema.Finite;

const PreviewSchema = Schema.Struct({
  senderBox: Schema.Struct({ id: Schema.String, dbId: Schema.String, label: Schema.String }),
  recipient: Schema.String,
  annotation: Schema.String,
  envelope: Schema.Struct({
    toHands: Schema.optional(Schema.String),
    recipientRefNumber: Schema.optional(Schema.String),
    senderRefNumber: Schema.optional(Schema.String),
    recipientIdent: Schema.optional(Schema.String),
    senderIdent: Schema.optional(Schema.String),
    personalDelivery: Schema.optional(Schema.Boolean),
    allowSubstDelivery: Schema.optional(Schema.Boolean),
    legalTitleLaw: Schema.optional(Schema.Finite),
    legalTitleYear: Schema.optional(Schema.Finite),
    legalTitleSect: Schema.optional(Schema.String),
    legalTitlePar: Schema.optional(Schema.String),
    legalTitlePoint: Schema.optional(Schema.String),
  }),
  attachments: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
      mimeType: Schema.String,
      metaType: FileMetaType,
      size: Schema.Finite,
      sha256: Schema.String,
    }),
  ),
  totalBytes: Schema.Finite,
  contentHash: Schema.String,
});

const StatusSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  classification: IsdsStatusClassification,
});

const PreviewJson = Schema.fromJsonString(PreviewSchema);
const StatusJson = Schema.fromJsonString(StatusSchema);
const AnyJson = Schema.fromJsonString(Schema.Unknown);

const FilingRow = Schema.Struct({
  id: Schema.String,
  grant_key: Schema.String,
  box_id: Schema.String,
  idempotency_key: Schema.String,
  content_hash: Schema.String,
  tier: Schema.Literals(["none", "approve", "full"]),
  state: Schema.Literals(FILING_STATES),
  recipient_db_id: Schema.String,
  preview_json: PreviewJson,
  dm_id: Schema.NullOr(Schema.String),
  isds_status_json: Schema.NullOr(StatusJson),
  reason: Schema.NullOr(Schema.String),
  reconcile_json: Schema.NullOr(AnyJson),
  submitted_at: Schema.NullOr(Millis),
  reconciled_at: Schema.NullOr(Millis),
  created_at: Millis,
  updated_at: Millis,
  expires_at: Schema.NullOr(Millis),
});

/** The filings columns a Filing is decoded from; never payload_sealed. */
const FILING_COLUMNS = Object.keys(FilingRow.fields).join(", ");

const NonceRow = Schema.Struct({
  nonce_hash: Schema.String,
  nonce_sealed: Schema.String,
  filing_id: Schema.String,
  content_hash: Schema.String,
  box_id: Schema.String,
  grant_key: Schema.String,
  created_at: Millis,
  expires_at: Millis,
  used_at: Schema.NullOr(Millis),
});

const NONCE_COLUMNS = Object.keys(NonceRow.fields).join(", ");

const decodeFilingRow = Schema.decodeUnknownEffect(FilingRow);
const decodeNonceRow = Schema.decodeUnknownEffect(NonceRow);
const encodePreview = Schema.encodeEffect(PreviewJson);
const encodeStatus = Schema.encodeEffect(StatusJson);
const encodeJson = Schema.encodeEffect(AnyJson);

const decodeFiling = (row: unknown) =>
  Effect.map(
    decodeFilingRow(row),
    (decoded): Filing => ({
      id: decoded.id,
      grantKey: decoded.grant_key,
      boxId: decoded.box_id,
      idempotencyKey: decoded.idempotency_key,
      contentHash: decoded.content_hash,
      tier: decoded.tier,
      state: decoded.state,
      recipientDbId: decoded.recipient_db_id,
      preview: decoded.preview_json,
      dmId: decoded.dm_id ?? undefined,
      isdsStatus: decoded.isds_status_json ?? undefined,
      reason: decoded.reason ?? undefined,
      reconcile: decoded.reconcile_json ?? undefined,
      submittedAt: decoded.submitted_at ?? undefined,
      reconciledAt: decoded.reconciled_at ?? undefined,
      createdAt: decoded.created_at,
      updatedAt: decoded.updated_at,
      expiresAt: decoded.expires_at ?? undefined,
    }),
  );

const decodeNonce = (row: unknown) =>
  Effect.map(
    decodeNonceRow(row),
    (decoded): ApprovalNonce => ({
      nonceHash: decoded.nonce_hash,
      nonceSealed: decoded.nonce_sealed,
      filingId: decoded.filing_id,
      contentHash: decoded.content_hash,
      boxId: decoded.box_id,
      grantKey: decoded.grant_key,
      createdAt: decoded.created_at,
      expiresAt: decoded.expires_at,
      usedAt: decoded.used_at ?? undefined,
    }),
  );

/** The first row decoded, or none. */
const firstOf = <A, E>(rows: ReadonlyArray<unknown>, decode: (row: unknown) => Effect.Effect<A, E>) =>
  rows[0] === undefined ? Effect.succeedNone : Effect.asSome(decode(rows[0]));

// Public types ---------------------------------------------------------------

/** The columns every new filing has. `id` is the caller's (newRowId): the payload AAD binds it. */
export interface NewFilingFields {
  readonly id: string;
  readonly grantKey: string;
  readonly boxId: string;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly tier: RecipientTier;
  readonly recipientDbId: string;
  readonly preview: FilingPreview;
}

/** A fresh approval nonce; its filing_id, content_hash, box_id and grant_key are copied from the filing. */
export interface NewNonce {
  readonly nonceHash: string;
  readonly nonceSealed: string;
  readonly expiresAt: number;
}

/** The four states a filing is born in. */
export type NewFiling = NewFilingFields &
  (
    | {
        readonly state: "awaiting_approval";
        readonly payloadSealed: string;
        readonly expiresAt: number;
        readonly nonce: NewNonce;
      }
    | { readonly state: "pending_admin"; readonly payloadSealed: string; readonly expiresAt: number }
    | { readonly state: "refused"; readonly reason: string }
    /** The full tier's atomic claim (C1): the payload is never stored. */
    | { readonly state: "dispatching"; readonly submittedAt: number }
  );

/** An approval_nonces row, decoded. */
export interface ApprovalNonce {
  readonly nonceHash: string;
  readonly nonceSealed: string;
  readonly filingId: string;
  readonly contentHash: string;
  readonly boxId: string;
  readonly grantKey: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt: number | undefined;
}

/**
 * Columns a transition sets besides `state` and `updated_at`. An absent (or
 * undefined) field leaves its column as stored.
 */
export interface FilingPatch {
  readonly reason?: string | undefined;
  readonly dmId?: string | undefined;
  readonly isdsStatus?: IsdsStatusSummary | undefined;
  /** Stored as JSON in reconcile_json. */
  readonly reconcile?: unknown;
  readonly reconciledAt?: number | undefined;
  readonly submittedAt?: number | undefined;
  readonly expiresAt?: number | undefined;
  /** Sets payload_sealed to NULL. */
  readonly clearPayload?: boolean | undefined;
  /** Marks the filing's unused nonces used, in the same transaction, when the transition wins. */
  readonly burnNonces?: boolean | undefined;
}

/** What a store write did. Each operation returns the subset below its signature names. */
export type FilingWrite = Data.TaggedEnum<{
  /** The row was inserted as given. */
  Inserted: { readonly filing: Filing };
  /** Another filing has this grant, box and idempotency key; nothing was written. */
  KeyTaken: { readonly existing: Filing };
  /** The compare-and-set hit its row. */
  Won: { readonly filing: Filing };
  /** The filing is missing or not in an expected state (any more); nothing was written. */
  Lost: { readonly current: Option.Option<Filing> };
  /** Another filing already holds this dmID; nothing was written. */
  DmIdTaken: { readonly dmId: string; readonly filingId: string };
  /** In-flight filings to the same recipient make a reconcile match ambiguous; nothing was written. */
  Competing: { readonly filingIds: ReadonlyArray<string> };
}>;
export const FilingWrite = Data.taggedEnum<FilingWrite>();

type Variant<T extends FilingWrite["_tag"]> = Extract<FilingWrite, { readonly _tag: T }>;
export type InsertResult = Variant<"Inserted" | "KeyTaken">;
export type CasResult = Variant<"Won" | "Lost">;
export type TransitionResult = Variant<"Won" | "Lost" | "DmIdTaken">;
export type ResolveResult = Variant<"Won" | "Lost" | "DmIdTaken" | "Competing">;

export interface FilingStore {
  readonly byId: (id: string) => Effect.Effect<Option.Option<Filing>, DomainStoreError>;
  readonly byKey: (
    grantKey: string,
    boxId: string,
    idempotencyKey: string,
  ) => Effect.Effect<Option.Option<Filing>, DomainStoreError>;
  /**
   * Newest `updated_at` first. `states` undefined means every state, empty
   * means none. `limit` defaults to 100 and is clamped to 1..500.
   */
  readonly list: (query?: FilingListQuery) => Effect.Effect<ReadonlyArray<Filing>, DomainStoreError>;
  /** The sealed payload; none once cleared or for a filing that never had one. */
  readonly payload: (id: string) => Effect.Effect<Option.Option<string>, DomainStoreError>;
  /** Inserts a filing (and, for awaiting_approval, its nonce) in one transaction. */
  readonly insert: (filing: NewFiling) => Effect.Effect<InsertResult, DomainStoreError>;
  /** Compare-and-set `from` → `to` with `patch`; `from` empty always loses. */
  readonly transition: (
    id: string,
    from: ReadonlyArray<FilingState>,
    to: FilingState,
    patch?: FilingPatch,
  ) => Effect.Effect<TransitionResult, DomainStoreError>;
  /**
   * One transaction: burn this filing's live nonce `nonceHash` (unused,
   * expires_at > now) and CAS awaiting_approval → dispatching with
   * `submittedAt`, payload cleared. Both hit or neither is written.
   */
  readonly claimWithNonce: (
    id: string,
    nonceHash: string,
    submittedAt: number,
  ) => Effect.Effect<CasResult, DomainStoreError>;
  /**
   * One transaction: when `dmId` is on no other filing and no competitor
   * (see `competitors`, around this filing's submitted_at) exists, CAS
   * outcome_unknown → sent with `dmId` and `patch`. A filing without
   * submitted_at treats every in-flight filing to its recipient as a competitor.
   */
  readonly resolveReconciled: (
    id: string,
    dmId: string,
    windowMs: number,
    patch?: FilingPatch,
  ) => Effect.Effect<ResolveResult, DomainStoreError>;
  /** The filing that holds this dmID. */
  readonly dmIdOwner: (dmId: string) => Effect.Effect<Option.Option<string>, DomainStoreError>;
  /**
   * Ids (sorted) of other filings on `boxId` to `recipientDbId`, in
   * dispatching or outcome_unknown, with submitted_at in
   * [submittedAt − windowMs, submittedAt + windowMs] (both edges included).
   */
  readonly competitors: (
    boxId: string,
    recipientDbId: string,
    submittedAt: number,
    windowMs: number,
    excludeId: string,
  ) => Effect.Effect<ReadonlyArray<string>, DomainStoreError>;
  /** Adds a nonce to an awaiting_approval filing; false (nothing written) otherwise. */
  readonly insertNonce: (filingId: string, nonce: NewNonce) => Effect.Effect<boolean, DomainStoreError>;
  /** One transaction: burn the filing's unused nonces and add `nonce`; false (nothing written) unless awaiting_approval. */
  readonly replaceNonce: (filingId: string, nonce: NewNonce) => Effect.Effect<boolean, DomainStoreError>;
  readonly nonceByHash: (nonceHash: string) => Effect.Effect<Option.Option<ApprovalNonce>, DomainStoreError>;
  /** The filing's unused nonce with expires_at > now (the latest-expiring if several). */
  readonly liveNonce: (filingId: string) => Effect.Effect<Option.Option<ApprovalNonce>, DomainStoreError>;
  /** Marks an unused nonce used; false when it was missing or already used. */
  readonly burnNonce: (nonceHash: string) => Effect.Effect<boolean, DomainStoreError>;
  /** Marks every unused nonce of the filing used; returns how many. */
  readonly burnNonces: (filingId: string) => Effect.Effect<number, DomainStoreError>;
  /** Startup recovery (D-i): every dispatching filing → outcome_unknown, payload cleared; their ids, sorted. */
  readonly recover: Effect.Effect<ReadonlyArray<string>, DomainStoreError>;
  /**
   * The expiry sweep (D-j): open filings with expires_at ≤ now → expired,
   * payload cleared, their nonces burned, in one transaction; their ids, sorted.
   */
  readonly expireDue: Effect.Effect<ReadonlyArray<string>, DomainStoreError>;
}

// Implementation -------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

const listLimit = (limit: number | undefined): number =>
  limit === undefined || !Number.isFinite(limit)
    ? DEFAULT_LIST_LIMIT
    : Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(limit)));

const isUniqueViolation = (error: unknown): error is SqlError.SqlError =>
  error instanceof SqlError.SqlError && error.reason._tag === "UniqueViolation";

/** A write that cannot miss did; storeFailure turns it into a DomainStoreError. */
class StoreInvariant extends Data.TaggedError("StoreInvariant")<{ readonly detail: string }> {}

/** Ends a transaction early with `result`, rolling back what it wrote. */
class Rollback<A> extends Data.TaggedError("Rollback")<{ readonly result: A }> {}

const IN_FLIGHT_STATES = ["dispatching", "outcome_unknown"] as const satisfies ReadonlyArray<FilingState>;

const sortedIds = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id).sort();

export const makeFilingStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(FILING_COLUMNS);

  /** Runs `body` in a transaction; a Rollback undoes its writes and yields its result. */
  const atomically = <A, B, E, R>(body: Effect.Effect<A, E | Rollback<B>, R>) =>
    sql.withTransaction(body).pipe(
      Effect.catchIf(
        (error): error is Rollback<B> => error instanceof Rollback,
        (rollback) => Effect.succeed(rollback.result),
      ),
    );

  const selectById = (id: string) =>
    sql<Record<string, unknown>>`SELECT ${columns} FROM filings WHERE id = ${id}`.pipe(
      Effect.flatMap((rows) => firstOf(rows, decodeFiling)),
    );

  const selectByKey = (grantKey: string, boxId: string, idempotencyKey: string) =>
    sql<Record<string, unknown>>`
      SELECT ${columns} FROM filings
      WHERE grant_key = ${grantKey} AND box_id = ${boxId} AND idempotency_key = ${idempotencyKey}
    `.pipe(Effect.flatMap((rows) => firstOf(rows, decodeFiling)));

  const lost = (id: string) => Effect.map(selectById(id), (current) => FilingWrite.Lost({ current }));

  /** The filing other than `exceptId` holding `dmId`. */
  const ownerOf = (dmId: string, exceptId: string) =>
    Effect.map(
      sql<{ id: string }>`SELECT id FROM filings WHERE dm_id = ${dmId} AND id <> ${exceptId}`,
      (rows) => Option.fromNullishOr(rows[0]?.id),
    );

  const burnFilingNonces = (filingId: string, now: number) =>
    Effect.map(
      sql<{ nonce_hash: string }>`
        UPDATE approval_nonces SET used_at = ${now}
        WHERE filing_id = ${filingId} AND used_at IS NULL
        RETURNING nonce_hash
      `,
      (rows) => rows.length,
    );

  /** Inserts a nonce bound to an awaiting_approval filing; whether a row was written. */
  const addNonce = (filingId: string, nonce: NewNonce, now: number) =>
    Effect.map(
      sql<{ nonce_hash: string }>`
        INSERT INTO approval_nonces
          (nonce_hash, nonce_sealed, filing_id, content_hash, box_id, grant_key, created_at, expires_at)
        SELECT ${nonce.nonceHash}, ${nonce.nonceSealed}, id, content_hash, box_id, grant_key, ${now}, ${nonce.expiresAt}
        FROM filings WHERE id = ${filingId} AND state = 'awaiting_approval'
        RETURNING nonce_hash
      `,
      (rows) => rows.length === 1,
    );

  /** The column values a patch sets (state and updated_at excluded). */
  const patchColumns = Effect.fnUntraced(function* (patch: FilingPatch) {
    const set: Record<string, unknown> = {};
    if (patch.reason !== undefined) set.reason = patch.reason;
    if (patch.dmId !== undefined) set.dm_id = patch.dmId;
    if (patch.isdsStatus !== undefined) set.isds_status_json = yield* encodeStatus(patch.isdsStatus);
    if (patch.reconcile !== undefined) set.reconcile_json = yield* encodeJson(patch.reconcile);
    if (patch.reconciledAt !== undefined) set.reconciled_at = patch.reconciledAt;
    if (patch.submittedAt !== undefined) set.submitted_at = patch.submittedAt;
    if (patch.expiresAt !== undefined) set.expires_at = patch.expiresAt;
    if (patch.clearPayload === true) set.payload_sealed = null;
    return set;
  });

  /**
   * The body of a transition, to run inside a transaction: dmID check, CAS,
   * then the nonce burn. Fails with Rollback when it must not commit.
   */
  const transitionBody = Effect.fnUntraced(function* (
    id: string,
    from: ReadonlyArray<FilingState>,
    to: FilingState,
    patch: FilingPatch,
    now: number,
  ) {
    if (from.length === 0) {
      return yield* lost(id);
    }
    if (patch.dmId !== undefined) {
      const owner = yield* ownerOf(patch.dmId, id);
      if (Option.isSome(owner)) {
        return FilingWrite.DmIdTaken({ dmId: patch.dmId, filingId: owner.value });
      }
    }
    const set = { ...(yield* patchColumns(patch)), state: to, updated_at: now };
    const [row] = yield* sql<Record<string, unknown>>`
      UPDATE filings SET ${sql.update(set)}
      WHERE id = ${id} AND state IN ${sql.in(from)}
      RETURNING ${columns}
    `;
    if (row === undefined) {
      return yield* lost(id);
    }
    if (patch.burnNonces === true) {
      yield* burnFilingNonces(id, now);
    }
    return FilingWrite.Won({ filing: yield* decodeFiling(row) });
  });

  /** A dmID UNIQUE violation the pre-check missed becomes DmIdTaken (or stays the error if no owner is found). */
  const dmIdConflict =
    (id: string, dmId: string | undefined) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.catchIf(effect, isUniqueViolation, (error) =>
        dmId === undefined
          ? Effect.fail(error)
          : Effect.flatMap(ownerOf(dmId, id), (owner) =>
              Option.isSome(owner)
                ? Effect.succeed(FilingWrite.DmIdTaken({ dmId, filingId: owner.value }))
                : Effect.fail(error),
            ),
      );

  const byId = Effect.fn("FilingStore.byId")(function* (id: string) {
    return yield* selectById(id);
  }, storeFailure("read a filing"));

  const byKey = Effect.fn("FilingStore.byKey")(function* (grantKey: string, boxId: string, idempotencyKey: string) {
    return yield* selectByKey(grantKey, boxId, idempotencyKey);
  }, storeFailure("read a filing"));

  const list = Effect.fn("FilingStore.list")(function* (query: FilingListQuery = {}) {
    if (query.states !== undefined && query.states.length === 0) {
      return [];
    }
    const where = query.states === undefined ? sql`` : sql`WHERE state IN ${sql.in(query.states)}`;
    const rows = yield* sql<Record<string, unknown>>`
      SELECT ${columns} FROM filings ${where}
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT ${listLimit(query.limit)}
    `;
    return yield* Effect.forEach(rows, decodeFiling);
  }, storeFailure("list filings"));

  const payload = Effect.fn("FilingStore.payload")(function* (id: string) {
    const [row] = yield* sql<{ payload_sealed: string | null }>`SELECT payload_sealed FROM filings WHERE id = ${id}`;
    return Option.fromNullishOr(row?.payload_sealed);
  }, storeFailure("read a filing payload"));

  const insert = Effect.fn("FilingStore.insert")(function* (filing: NewFiling) {
    const now = yield* Clock.currentTimeMillis;
    const row = {
      id: filing.id,
      grant_key: filing.grantKey,
      box_id: filing.boxId,
      idempotency_key: filing.idempotencyKey,
      content_hash: filing.contentHash,
      tier: filing.tier,
      state: filing.state,
      recipient_db_id: filing.recipientDbId,
      preview_json: yield* encodePreview(filing.preview),
      payload_sealed: filing.state === "awaiting_approval" || filing.state === "pending_admin" ? filing.payloadSealed : null,
      reason: filing.state === "refused" ? filing.reason : null,
      submitted_at: filing.state === "dispatching" ? filing.submittedAt : null,
      expires_at: filing.state === "awaiting_approval" || filing.state === "pending_admin" ? filing.expiresAt : null,
      created_at: now,
      updated_at: now,
    };
    const write = Effect.gen(function* () {
      const [inserted] = yield* sql<Record<string, unknown>>`INSERT INTO filings ${sql.insert(row)} RETURNING ${columns}`;
      if (inserted === undefined) {
        return yield* new StoreInvariant({ detail: "a filing insert returned no row" });
      }
      if (filing.state === "awaiting_approval" && !(yield* addNonce(filing.id, filing.nonce, now))) {
        return yield* new StoreInvariant({ detail: "a new filing's nonce found no awaiting filing" });
      }
      return FilingWrite.Inserted({ filing: yield* decodeFiling(inserted) });
    });
    const result: InsertResult = yield* sql.withTransaction(write).pipe(
      Effect.catchIf(isUniqueViolation, (error) =>
        Effect.flatMap(selectByKey(filing.grantKey, filing.boxId, filing.idempotencyKey), (existing) =>
          Option.isSome(existing) ? Effect.succeed(FilingWrite.KeyTaken({ existing: existing.value })) : Effect.fail(error),
        ),
      ),
    );
    return result;
  }, storeFailure("store a filing"));

  const transition = Effect.fn("FilingStore.transition")(function* (
    id: string,
    from: ReadonlyArray<FilingState>,
    to: FilingState,
    patch: FilingPatch = {},
  ) {
    const now = yield* Clock.currentTimeMillis;
    const result: TransitionResult = yield* sql
      .withTransaction(transitionBody(id, from, to, patch, now))
      .pipe(dmIdConflict(id, patch.dmId));
    return result;
  }, storeFailure("change a filing's state"));

  const claimWithNonce = Effect.fn("FilingStore.claimWithNonce")(function* (
    id: string,
    nonceHash: string,
    submittedAt: number,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const write = Effect.gen(function* () {
      const burned = yield* sql<{ nonce_hash: string }>`
        UPDATE approval_nonces SET used_at = ${now}
        WHERE nonce_hash = ${nonceHash} AND filing_id = ${id} AND used_at IS NULL AND expires_at > ${now}
        RETURNING nonce_hash
      `;
      if (burned.length !== 1) {
        return yield* new Rollback({ result: yield* lost(id) });
      }
      const [row] = yield* sql<Record<string, unknown>>`
        UPDATE filings SET state = 'dispatching', submitted_at = ${submittedAt}, payload_sealed = NULL, updated_at = ${now}
        WHERE id = ${id} AND state = 'awaiting_approval'
        RETURNING ${columns}
      `;
      if (row === undefined) {
        return yield* new Rollback({ result: yield* lost(id) });
      }
      return FilingWrite.Won({ filing: yield* decodeFiling(row) });
    });
    const result: CasResult = yield* atomically(write);
    return result;
  }, storeFailure("claim a filing"));

  const competitorsOf = (
    boxId: string,
    recipientDbId: string,
    submittedAt: number | undefined,
    windowMs: number,
    excludeId: string,
  ) => {
    const within =
      submittedAt === undefined
        ? sql``
        : sql`AND submitted_at BETWEEN ${submittedAt - windowMs} AND ${submittedAt + windowMs}`;
    return Effect.map(
      sql<{ id: string }>`
        SELECT id FROM filings
        WHERE box_id = ${boxId} AND recipient_db_id = ${recipientDbId} AND state IN ${sql.in(IN_FLIGHT_STATES)}
          AND id <> ${excludeId} ${within}
      `,
      sortedIds,
    );
  };

  const resolveReconciled = Effect.fn("FilingStore.resolveReconciled")(function* (
    id: string,
    dmId: string,
    windowMs: number,
    patch: FilingPatch = {},
  ) {
    const now = yield* Clock.currentTimeMillis;
    const resolve = Effect.gen(function* () {
      const current = yield* selectById(id);
      if (Option.isNone(current) || current.value.state !== "outcome_unknown") {
        return FilingWrite.Lost({ current });
      }
      const filing = current.value;
      const owner = yield* ownerOf(dmId, id);
      if (Option.isSome(owner)) {
        return FilingWrite.DmIdTaken({ dmId, filingId: owner.value });
      }
      const rivals = yield* competitorsOf(filing.boxId, filing.recipientDbId, filing.submittedAt, windowMs, id);
      if (rivals.length > 0) {
        return FilingWrite.Competing({ filingIds: rivals });
      }
      return yield* transitionBody(id, ["outcome_unknown"], "sent", { ...patch, dmId }, now);
    });
    const result: ResolveResult = yield* sql.withTransaction(resolve).pipe(dmIdConflict(id, dmId));
    return result;
  }, storeFailure("resolve a reconciled filing"));

  const dmIdOwner = Effect.fn("FilingStore.dmIdOwner")(function* (dmId: string) {
    return yield* ownerOf(dmId, "");
  }, storeFailure("look up a dmID"));

  const competitors = Effect.fn("FilingStore.competitors")(function* (
    boxId: string,
    recipientDbId: string,
    submittedAt: number,
    windowMs: number,
    excludeId: string,
  ) {
    return yield* competitorsOf(boxId, recipientDbId, submittedAt, windowMs, excludeId);
  }, storeFailure("look up competing filings"));

  const insertNonce = Effect.fn("FilingStore.insertNonce")(function* (filingId: string, nonce: NewNonce) {
    const now = yield* Clock.currentTimeMillis;
    return yield* addNonce(filingId, nonce, now);
  }, storeFailure("store an approval nonce"));

  const replaceNonce = Effect.fn("FilingStore.replaceNonce")(function* (filingId: string, nonce: NewNonce) {
    const now = yield* Clock.currentTimeMillis;
    const write = Effect.gen(function* () {
      yield* burnFilingNonces(filingId, now);
      if (!(yield* addNonce(filingId, nonce, now))) {
        return yield* new Rollback({ result: false });
      }
      return true;
    });
    return yield* atomically(write);
  }, storeFailure("replace an approval nonce"));

  const nonceByHash = Effect.fn("FilingStore.nonceByHash")(function* (nonceHash: string) {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT ${sql.literal(NONCE_COLUMNS)} FROM approval_nonces WHERE nonce_hash = ${nonceHash}
    `;
    return yield* firstOf(rows, decodeNonce);
  }, storeFailure("read an approval nonce"));

  const liveNonce = Effect.fn("FilingStore.liveNonce")(function* (filingId: string) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql<Record<string, unknown>>`
      SELECT ${sql.literal(NONCE_COLUMNS)} FROM approval_nonces
      WHERE filing_id = ${filingId} AND used_at IS NULL AND expires_at > ${now}
      ORDER BY expires_at DESC, created_at DESC, nonce_hash
      LIMIT 1
    `;
    return yield* firstOf(rows, decodeNonce);
  }, storeFailure("read an approval nonce"));

  const burnNonce = Effect.fn("FilingStore.burnNonce")(function* (nonceHash: string) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql<{ nonce_hash: string }>`
      UPDATE approval_nonces SET used_at = ${now} WHERE nonce_hash = ${nonceHash} AND used_at IS NULL
      RETURNING nonce_hash
    `;
    return rows.length === 1;
  }, storeFailure("burn an approval nonce"));

  const burnNonces = Effect.fn("FilingStore.burnNonces")(function* (filingId: string) {
    const now = yield* Clock.currentTimeMillis;
    return yield* burnFilingNonces(filingId, now);
  }, storeFailure("burn approval nonces"));

  const recover = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql.withTransaction(
      sql<{ id: string }>`
        UPDATE filings SET state = 'outcome_unknown', payload_sealed = NULL, updated_at = ${now}
        WHERE state = 'dispatching'
        RETURNING id
      `,
    );
    return sortedIds(rows);
  }).pipe(storeFailure("recover dispatching filings"), Effect.withSpan("FilingStore.recover"));

  const expireDue = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const open = sql.in(OPEN_FILING_STATES);
    const sweep = Effect.gen(function* () {
      yield* sql`
        UPDATE approval_nonces SET used_at = ${now}
        WHERE used_at IS NULL AND filing_id IN (
          SELECT id FROM filings WHERE state IN ${open} AND expires_at <= ${now}
        )
      `;
      return yield* sql<{ id: string }>`
        UPDATE filings SET state = 'expired', payload_sealed = NULL, updated_at = ${now}
        WHERE state IN ${open} AND expires_at <= ${now}
        RETURNING id
      `;
    });
    return sortedIds(yield* sql.withTransaction(sweep));
  }).pipe(storeFailure("expire due filings"), Effect.withSpan("FilingStore.expireDue"));

  return {
    byId,
    byKey,
    list,
    payload,
    insert,
    transition,
    claimWithNonce,
    resolveReconciled,
    dmIdOwner,
    competitors,
    insertNonce,
    replaceNonce,
    nonceByHash,
    liveNonce,
    burnNonce,
    burnNonces,
    recover,
    expireDue,
  } satisfies FilingStore;
});
