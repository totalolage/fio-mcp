/**
 * The send service (SendServiceShape in ./api.ts): send_message, get_filing_status and the
 * admin decisions on filings, over the filing store, the box permit and ISDS.
 *
 * Binding design: ds-send-plan.md "Council resolutions" C1–C6, phase3-design.md R3/R6/D4 and
 * ds-send-core-design.md D-a..D-k. In short:
 * - Every dispatch is one compare-and-set claim (the full tier's INSERT 'dispatching', a nonce
 *   confirmation's claimWithNonce, an admin approval's pending_admin → dispatching); only its
 *   winner calls CreateMessage, and from the claim to the persisted outcome nothing can
 *   interrupt it (D-d).
 * - Before a claim, one box permit (BoxClients.use) covers the CheckDataBox preflight, the DB
 *   rechecks (authority, box, expiry, tier), the claim, CreateMessage and the outcome write
 *   (C4, C5). A follow-up reconcile after an unknown outcome takes a second permit afterwards.
 * - Stored results (same key and content) are answered from the DB alone (D-b).
 *
 * "Sent" means ISDS accepted the submission and assigned a dmID, not that it was delivered.
 */
import { createHash, randomBytes } from "node:crypto";
import { Cause, Clock, DateTime, Duration, Effect, Exit, Layer, Option, Redacted, Ref, Result, Schedule } from "effect";
import { SqlClient } from "effect/sql";
import type { IsdsClientShape } from "../../isds/client.js";
import type { CreateMessageInput } from "../../isds/create-message.js";
import { classifyStatus } from "../../isds/errors.js";
import { type AuditActor, AuditLog } from "../audit-log.js";
import { BoxClients } from "../box-clients.js";
import { BoxRegistry } from "../boxes.js";
import { DataKey, DomainConfig } from "../config.js";
import { DomainStoreError } from "../errors.js";
import { newRowId } from "../ids.js";
import type { FilingState } from "../migrations.js";
import { type RecipientTier, RecipientTiers } from "../recipient-tiers.js";
import { approvalNonceAad, filingPayloadAad, openText, sealText } from "../sealed.js";
import {
  type Filing,
  type FilingListQuery,
  FilingNotFound,
  type FilingRef,
  FilingStateConflict,
  type FilingStatus,
  ReconcileOutcome,
  type SendCaller,
  type SendMessageRequest,
  SendResult,
  SendService,
  type SendServiceShape,
  SendUnavailable,
} from "./api.js";
import { auditedSend, type ClaimSignal, type SendDetail, sendDetail, sendResultOutcome } from "./audit.js";
import { type AuthorityVerdict, SendAuthority } from "./authority.js";
import {
  type CorruptPayload,
  decodePayload,
  encodePayload,
  type InvalidSendRequest,
  type NormalisedMessage,
  normaliseRequest,
  reconcileHintsOf,
  reconcileInputOf,
} from "./content.js";
import { type FilingPatch, type FilingStore, makeFilingStore, type NewNonce } from "./store.js";

// Constants -------------------------------------------------------------------

/** filingStatus reconciles an outcome_unknown filing at most this often (C5, D-e). */
export const STATUS_RECONCILE_INTERVAL_MS = 60_000;
/** Other in-flight filings to the same recipient within this window make a reconcile match ambiguous (D-e). */
export const RECONCILE_COMPETITOR_WINDOW_MS = 15 * 60_000;
/** The bounded retry of a dispatch outcome write; CreateMessage itself is never retried (D-d). */
const OUTCOME_WRITE_RETRY = { schedule: Schedule.exponential("50 millis"), times: 4 } as const;

const OPEN_STATES: ReadonlyArray<FilingState> = ["awaiting_approval", "pending_admin"];

const AUTHORITY_REASONS: Record<Exclude<AuthorityVerdict, "ok">, string> = {
  grant_inactive: "the authorization (grant) is no longer active",
  scope_missing: "the authorization lacks the isds:send scope",
  box_not_granted: "the authorization does not cover this data box",
};

const DATA_BOX_STATES: Record<number, string> = {
  2: "temporarily inaccessible",
  3: "not yet made accessible",
  4: "permanently inaccessible",
  5: "deleted",
};

// Pure helpers ----------------------------------------------------------------

const isOpen = (state: FilingState): boolean => OPEN_STATES.includes(state);

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A filing's answer when nothing more is to be done (every state except awaiting_approval's nonce replay). */
export const storedResult = (filing: Filing): SendResult => {
  const filingId = filing.id;
  switch (filing.state) {
    case "awaiting_approval":
      // Only reached when a concurrent change kept the nonce from being replayed.
      return SendResult.Refused({
        filingId,
        reason: "the filing awaits confirmation; call again without approvalNonce for the approval nonce",
      });
    case "pending_admin":
      return SendResult.Queued({ filingId });
    case "dispatching":
      return SendResult.InProgress({ filingId });
    case "sent":
      return SendResult.Sent({ filingId, dmID: filing.dmId ?? "" });
    case "isds_rejected":
      return SendResult.IsdsRejected({
        filingId,
        status: filing.isdsStatus ?? { code: "", message: "ISDS refused the message", classification: "Other" },
      });
    case "refused":
      return SendResult.Refused({ filingId, reason: filing.reason ?? "refused before anything was sent" });
    case "admin_rejected":
      return SendResult.Refused({
        filingId,
        reason: `an administrator rejected the message${filing.reason === undefined ? "" : `: ${filing.reason}`}`,
      });
    case "expired":
      return SendResult.Expired({ filingId });
    case "outcome_unknown":
      return SendResult.OutcomeUnknown({ filingId });
    case "not_sent":
      return SendResult.NotSent({ filingId });
  }
};

/** What the caller should do next (D-k). */
export const guidanceOf = (filing: Filing): string => {
  switch (filing.state) {
    case "awaiting_approval":
      return "Waiting for your confirmation: call send_message again with the same content and the approvalNonce. Call without approvalNonce for a fresh one. Nothing has been sent.";
    case "pending_admin":
      return "Queued for an administrator's approval. Nothing has been sent yet.";
    case "dispatching":
      return "Being submitted to ISDS right now. Do not resend; check the status again shortly.";
    case "sent":
      return `Sent: ISDS accepted the submission and assigned dmID ${filing.dmId ?? "?"}. This does not mean it was delivered to the recipient.`;
    case "isds_rejected":
      return "ISDS refused the message, so it was not sent. Fix the problem and use a new idempotencyKey to send again.";
    case "refused":
      return "Refused before anything was sent. Use a new idempotencyKey to send again once the reason is resolved.";
    case "admin_rejected":
      return "An administrator rejected the message; it was not sent. Use a new idempotencyKey to send again.";
    case "expired":
      return "Expired before it was confirmed or approved; it was not sent. Use a new idempotencyKey to send again.";
    case "outcome_unknown":
      return "ISDS may or may not have received the message. Do not resend; an administrator decides if it stays unknown.";
    case "not_sent":
      return "An administrator confirmed it was not sent. Use a new idempotencyKey to send again.";
  }
};

/** CreateMessage failures that prove nothing reached ISDS (C4); everything else may have. */
const isPreSendFailure = (error: { readonly _tag: string; readonly requestSent?: boolean }): boolean =>
  error._tag === "IsdsInvalidRequest" ||
  error._tag === "IsdsMessageTooLarge" ||
  error._tag === "IsdsConfigError" ||
  error._tag === "IsdsCredentialsError" ||
  (error._tag === "IsdsTimeoutError" && error.requestSent === false);


/** A step of a dispatch: done with a result, or the filing moved on before the claim. */
type Step =
  | { readonly _tag: "Done"; readonly result: SendResult; readonly followUp: boolean }
  | { readonly _tag: "Moved"; readonly current: Option.Option<Filing> };

const done = (result: SendResult, followUp = false): Step => ({ _tag: "Done", result, followUp });
const moved = (current: Option.Option<Filing>): Step => ({ _tag: "Moved", current });

/** What a claim transaction decided: the claim won, or another answer. */
type Decision = { readonly _tag: "Claimed"; readonly filingId: string } | { readonly _tag: "Decided"; readonly step: Step };
const claimed = (filingId: string): Decision => ({ _tag: "Claimed", filingId });
const decided = (step: Step): Decision => ({ _tag: "Decided", step });

/** A send_message answer plus what its audit detail is built from. */
interface Answer {
  readonly result: SendResult;
  readonly preview?: Filing["preview"] | undefined;
}

// The service -----------------------------------------------------------------

/**
 * Builds the service. Startup recovery runs first (C4, D-i): every 'dispatching' filing →
 * outcome_unknown with its payload cleared, and one system "filing.recover" audit row each, in
 * one transaction. A failure fails construction, so no dispatch can start before recovery.
 */
export const makeSendService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { key } = yield* DataKey;
  const config = yield* DomainConfig;
  const audit = yield* AuditLog;
  const registry = yield* BoxRegistry;
  const clients = yield* BoxClients;
  const tiers = yield* RecipientTiers;
  const authority = yield* SendAuthority;
  const store: FilingStore = yield* makeFilingStore;

  // Startup recovery -----------------------------------------------------------

  const recovered = yield* sql.withTransaction(
    Effect.gen(function* () {
      const ids = yield* store.recover;
      for (const filingId of ids) {
        const filing = yield* store.byId(filingId);
        yield* audit.record({
          actor: { kind: "system" },
          action: "filing.recover",
          outcome: "uncertain",
          boxId: Option.match(filing, { onNone: () => undefined, onSome: (f) => f.boxId }),
          detail: { filingId },
        });
      }
      return ids;
    }),
  );
  /** Ids recovered at construction, for reconcileRecovered (phase B). */
  const recoveredIds = yield* Ref.make<ReadonlyArray<string>>(recovered);

  // Small effects --------------------------------------------------------------

  const now = Clock.currentTimeMillis;
  const pendingExpiry = Effect.map(now, (at) => at + Duration.toMillis(config.pendingTtl));

  const tierOf = (boxId: string, recipient: string): Effect.Effect<RecipientTier, DomainStoreError> =>
    tiers.tier(boxId, recipient).pipe(Effect.catchTag("InvalidIdentifier", (error) => Effect.die(error)));

  const sealPayload = (filingId: string, createInput: CreateMessageInput): Effect.Effect<string> =>
    sealText(key, encodePayload(createInput), filingPayloadAad(filingId));

  /** A fresh nonce (D-f): 32 random bytes base64url, stored hashed and sealed; never past `filingExpiry`. */
  const freshNonce = Effect.fn("SendService.freshNonce")(function* (filingExpiry: number | undefined) {
    const nonce = randomBytes(32).toString("base64url");
    const nonceHash = sha256Hex(nonce);
    const nonceSealed = yield* sealText(key, nonce, approvalNonceAad(nonceHash));
    const ttlEnd = (yield* now) + Duration.toMillis(config.approvalNonceTtl);
    const expiresAt = filingExpiry === undefined ? ttlEnd : Math.min(ttlEnd, filingExpiry);
    const row: NewNonce = { nonceHash, nonceSealed, expiresAt };
    return { nonce, row };
  });

  /** Opens a stored nonce; none when the sealed text no longer opens. */
  const openNonce = (nonceHash: string, sealed: string): Option.Option<string> => {
    const opened = openText(key, sealed, approvalNonceAad(nonceHash));
    return Result.isSuccess(opened) ? Option.some(Redacted.value(opened.success)) : Option.none();
  };

  /**
   * Obligation (1), D-f: an open filing past its expires_at is expired on the spot with the
   * sweep's CAS (payload cleared, nonces burned). Returns the filing as it now stands.
   */
  const expireIfDue = Effect.fn("SendService.expireIfDue")(function* (filing: Filing) {
    if (!isOpen(filing.state) || filing.expiresAt === undefined || filing.expiresAt > (yield* now)) {
      return filing;
    }
    const write = yield* store.transition(filing.id, [filing.state], "expired", {
      clearPayload: true,
      burnNonces: true,
    });
    if (write._tag === "Won") return write.filing;
    const current = yield* store.byId(filing.id);
    return Option.getOrElse(current, () => filing);
  });

  /** The filing as it stands now (expired on the spot when due). */
  const reread = Effect.fn("SendService.reread")(function* (filingId: string) {
    const current = yield* store.byId(filingId);
    return Option.isNone(current) ? current : Option.some(yield* expireIfDue(current.value));
  });

  /** The CheckDataBox preflight (C3, D-c): undefined when the recipient can receive, else the refusal reason. */
  const preflight = (client: IsdsClientShape, recipient: string): Effect.Effect<string | undefined, SendUnavailable> =>
    client.checkDataBox({ dbID: recipient }).pipe(
      Effect.map((checked) =>
        checked.dbState === 1
          ? undefined
          : `the recipient data box ${recipient} cannot receive messages (ISDS state ${checked.dbState}: ${
              DATA_BOX_STATES[checked.dbState] ?? "unknown"
            })`,
      ),
      Effect.catch((error) =>
        error._tag === "IsdsStatusError"
          ? Effect.succeed(
              `ISDS refused the recipient check for ${recipient} (${error.code}: ${error.statusMessage}); it cannot receive messages`,
            )
          : Effect.fail(new SendUnavailable({ detail: `the recipient ${recipient} could not be checked: ${error.message}` })),
      ),
    );

  /** Runs `f` under the box permit; a client that cannot be acquired is a SendUnavailable (D-c). */
  const withClient = <A, E>(
    boxId: string,
    f: (client: IsdsClientShape) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | SendUnavailable> =>
    // The callback's own outcome travels as a value, so only acquisition errors are mapped here.
    clients.use(boxId, (client) => Effect.result(f(client))).pipe(
      Effect.mapError((error) => new SendUnavailable({ detail: error.message })),
      Effect.flatMap((result) => (Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure))),
    );

  /** Hard recheck failure (C4): CAS `from` → refused, reason stored, payload cleared, nonces burned. */
  const hardRefuse = Effect.fn("SendService.hardRefuse")(function* (
    filingId: string,
    from: FilingState,
    reason: string,
  ) {
    const write = yield* store.transition(filingId, [from], "refused", {
      reason,
      clearPayload: true,
      burnNonces: true,
    });
    return write._tag === "Won"
      ? done(SendResult.Refused({ filingId, reason }))
      : moved(write._tag === "Lost" ? write.current : yield* store.byId(filingId));
  });

  // Dispatch core ----------------------------------------------------------------

  /**
   * Persists a dispatch outcome, retrying only the DB write (D-d, C4). If it still fails the
   * filing stays 'dispatching' (startup recovery turns it unknown) and the call fails.
   */
  const persist = <A>(write: Effect.Effect<A, DomainStoreError>): Effect.Effect<A, DomainStoreError> =>
    Effect.retry(write, OUTCOME_WRITE_RETRY);

  /**
   * CreateMessage for a claimed ('dispatching') filing and the outcome write, per C4 exactly:
   * success → sent (a dmID already on another filing → outcome_unknown); IsdsStatusError →
   * isds_rejected; a proven pre-send failure → refused; anything else, defects included →
   * outcome_unknown with a follow-up reconcile. Run it only inside the claim's
   * uninterruptible region, under `claim.whileClaimed`.
   */
  const sendClaimed = Effect.fn("SendService.sendClaimed")(function* (
    client: IsdsClientShape,
    filingId: string,
    createInput: CreateMessageInput,
  ) {
    const exit = yield* Effect.exit(client.createMessage(createInput));
    if (exit._tag === "Success") {
      const { dmID, status } = exit.value;
      const isdsStatus = { code: status.code, message: status.message, classification: classifyStatus("dm", status.code) };
      const write = yield* persist(store.transition(filingId, ["dispatching"], "sent", { dmId: dmID, isdsStatus })).pipe(
        Effect.tapError(() =>
          Effect.logError("datova-schranka: ISDS accepted a message but its filing could not be updated").pipe(
            Effect.annotateLogs({ filingId, dmID }),
          ),
        ),
      );
      if (write._tag === "Won") return done(SendResult.Sent({ filingId, dmID }));
      if (write._tag === "DmIdTaken") {
        const at = yield* now;
        yield* persist(
          store.transition(filingId, ["dispatching"], "outcome_unknown", {
            isdsStatus,
            reason: `ISDS accepted the message as dmID ${dmID}, which is already linked to filing ${write.filingId}`,
            reconcile: { at, result: "dmid_linked", dmID, linkedTo: write.filingId },
          }),
        );
        return done(SendResult.OutcomeUnknown({ filingId }));
      }
      // Nothing else moves a dispatching filing while its claim runs; report what is stored.
      return done(Option.match(write.current, { onNone: () => SendResult.OutcomeUnknown({ filingId }), onSome: storedResult }));
    }
    const failure = Cause.findError(exit.cause);
    const error = Result.isSuccess(failure) ? failure.success : undefined;
    if (error !== undefined && error._tag === "IsdsStatusError") {
      const isdsStatus = { code: error.code, message: error.statusMessage, classification: error.classification };
      yield* persist(store.transition(filingId, ["dispatching"], "isds_rejected", { isdsStatus }));
      return done(SendResult.IsdsRejected({ filingId, status: isdsStatus }));
    }
    if (error !== undefined && isPreSendFailure(error)) {
      const reason = `nothing was sent: ${error.message}; call again with a new idempotencyKey`;
      yield* persist(store.transition(filingId, ["dispatching"], "refused", { reason }));
      return done(SendResult.Refused({ filingId, reason }));
    }
    const detail = error === undefined ? "the send failed unexpectedly" : error.message;
    yield* persist(
      store.transition(filingId, ["dispatching"], "outcome_unknown", {
        reason: `ISDS may have received the message: ${detail}`,
      }),
    );
    return done(SendResult.OutcomeUnknown({ filingId }), true);
  });

  /** Runs `effect` in one transaction; a failure to begin or commit it is a DomainStoreError. */
  const inTransaction = <A, E>(operation: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E | DomainStoreError> =>
    sql.withTransaction(effect).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.logError(`datova-schranka: failed to ${operation}`, cause).pipe(
          Effect.andThen(Effect.fail(new DomainStoreError({ operation }))),
        ),
      ),
    );

  /**
   * Whether the box row still exists. Read inside the claim's transaction: BoxRegistry.remove
   * expires open filings and deletes the row in one transaction without the box permit, so only
   * this read, serialised with the claim, keeps a removal from racing in before it (C4).
   */
  const boxRowExists = (boxId: string): Effect.Effect<boolean, DomainStoreError> =>
    sql<{ readonly id: string }>`SELECT id FROM boxes WHERE id = ${boxId}`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.catchTag("SqlError", (cause) =>
        Effect.logError("datova-schranka: failed to read the data box row", cause).pipe(
          Effect.andThen(Effect.fail(new DomainStoreError({ operation: "read the data box row" }))),
        ),
      ),
    );

  /**
   * The claim and its dispatch as one uninterruptible region (D-d, obligation 3). `decide` runs
   * in one transaction (box row, tier and expiry read together with the claim's write, so a
   * removal or tier edit lands before or after it, never between) and returns either the
   * claimed filing id or the step to answer instead. The audit window opens right after the
   * claim commits.
   */
  const claimAndSend = <E>(
    claim: ClaimSignal,
    client: IsdsClientShape,
    decide: Effect.Effect<Decision, E>,
    createInput: CreateMessageInput,
  ): Effect.Effect<Step, E | DomainStoreError> =>
    Effect.uninterruptible(
      Effect.flatMap(inTransaction("claim a filing for dispatch", decide), (decision) =>
        decision._tag === "Claimed"
          ? claim.whileClaimed(sendClaimed(client, decision.filingId, createInput))
          : Effect.succeed(decision.step),
      ),
    );

  /** Opens and validates a filing's sealed payload before its claim (C1); none when it is gone or corrupt. */
  const openPayload = Effect.fn("SendService.openPayload")(function* (filingId: string) {
    const sealed = yield* store.payload(filingId);
    if (Option.isNone(sealed)) return Result.fail("the stored payload is missing");
    const opened = openText(key, sealed.value, filingPayloadAad(filingId));
    if (Result.isFailure(opened)) return Result.fail("the stored payload could not be decrypted");
    return yield* decodePayload(Redacted.value(opened.success)).pipe(
      Effect.map((input) => Result.succeed(input)),
      Effect.catchTag("CorruptPayload", (error: CorruptPayload) => Effect.succeed(Result.fail(error.message))),
    );
  });

  interface ExistingDispatch {
    readonly filing: Filing;
    /** The state the claim moves from: a nonce confirmation's awaiting_approval or an approval's pending_admin. */
    readonly from: "awaiting_approval" | "pending_admin";
    /** The confirming nonce (confirm path only). */
    readonly nonceHash?: string | undefined;
  }

  /**
   * Dispatch of a stored filing (nonce confirmation, admin approval) under its box permit, in
   * C4 order: CheckDataBox preflight, then authority, box exists, expiry, effective tier (confirm
   * only, D-g), payload (C1), claim. Hard failures refuse the filing; a filing that moved on is
   * reported Moved for the caller to answer.
   */
  const dispatchUnderPermit = Effect.fn("SendService.dispatchUnderPermit")(function* (
    client: IsdsClientShape,
    plan: ExistingDispatch,
    claim: ClaimSignal,
  ) {
        const { filing, from } = plan;
        // Skip the network call when another caller already moved the filing on.
        const before = yield* reread(filing.id);
        if (Option.isNone(before) || before.value.state !== from) return moved(before);

        const refusal = yield* preflight(client, filing.recipientDbId);
        if (refusal !== undefined) return yield* hardRefuse(filing.id, from, refusal);
        const verdict = yield* authority.check(filing.grantKey, filing.boxId);
        if (verdict !== "ok") return yield* hardRefuse(filing.id, from, `${AUTHORITY_REASONS[verdict]}`);
        const box = yield* Effect.option(registry.get(filing.boxId));
        if (Option.isNone(box)) return yield* hardRefuse(filing.id, from, "the data box was removed");
        // C1: open and validate the payload before the claim clears it.
        const payload = yield* openPayload(filing.id);
        if (Result.isFailure(payload)) return yield* hardRefuse(filing.id, from, payload.failure);

        const nonceHash = plan.nonceHash;
        // Box row, expiry and tier are read in the claim's transaction (C4 order: box, expiry, tier, claim).
        const decide = Effect.gen(function* () {
          if (!(yield* boxRowExists(filing.boxId))) {
            return decided(yield* hardRefuse(filing.id, from, "the data box was removed"));
          }
          const current = yield* reread(filing.id);
          if (Option.isNone(current) || current.value.state !== from) return decided(moved(current));
          if (nonceHash !== undefined && (yield* tierOf(filing.boxId, filing.recipientDbId)) === "none") {
            // The recipient's tier was lowered to none: the stricter flow wins (D-g).
            const write = yield* store.transition(filing.id, ["awaiting_approval"], "pending_admin", {
              burnNonces: true,
              expiresAt: yield* pendingExpiry,
            });
            return decided(
              write._tag === "Won"
                ? done(SendResult.Queued({ filingId: filing.id }))
                : moved(write._tag === "Lost" ? write.current : yield* store.byId(filing.id)),
            );
          }
          const submittedAt = yield* now;
          const write =
            nonceHash !== undefined
              ? yield* store.claimWithNonce(filing.id, nonceHash, submittedAt)
              : yield* store.transition(filing.id, ["pending_admin"], "dispatching", { submittedAt, clearPayload: true });
          return write._tag === "Won" ? claimed(filing.id) : decided(moved(yield* store.byId(filing.id)));
        });
        return yield* claimAndSend(claim, client, decide, payload.success);
  });

  const dispatchExisting = (
    plan: ExistingDispatch,
    claim: ClaimSignal,
  ): Effect.Effect<Step, SendUnavailable | DomainStoreError> =>
    withClient(plan.filing.boxId, (client) => dispatchUnderPermit(client, plan, claim));

  // Reconcile --------------------------------------------------------------------

  /** Records a reconcile attempt on a filing that stays outcome_unknown (obligation 2, C5). */
  const recordAttempt = Effect.fn("SendService.recordAttempt")(function* (filingId: string, record: object) {
    const at = yield* now;
    const patch: FilingPatch = { reconcile: { at, ...record }, reconciledAt: at };
    yield* store.transition(filingId, ["outcome_unknown"], "outcome_unknown", patch);
  });

  /**
   * Reconciles one outcome_unknown filing against the box's sent messages (D-e, C5). Found →
   * sent, only when the dmID is on no other filing and no competing in-flight filing exists
   * (checked with the CAS in one transaction); anything else stays outcome_unknown. Every attempt,
   * failed ones included, sets reconciled_at. A removed box reports "box removed" (D4); a failed
   * listing is a SendUnavailable with the state unchanged. Takes its own box permit: never call
   * it inside BoxClients.use.
   */
  const reconcile = Effect.fn("SendService.reconcile")(function* (filingId: string) {
    const found = yield* store.byId(filingId);
    if (Option.isNone(found)) return yield* new FilingNotFound({ filingId });
    const filing = found.value;
    if (filing.state !== "outcome_unknown") return ReconcileOutcome.NotApplicable({ state: filing.state });

    const boxRemoved = Effect.gen(function* () {
      yield* recordAttempt(filingId, { result: "box_removed" });
      return ReconcileOutcome.StillUnknown({
        detail: "the data box was removed, so its sent messages cannot be checked (box removed)",
      });
    });
    if (Option.isNone(yield* Effect.option(registry.get(filing.boxId)))) return yield* boxRemoved;

    const submittedAt = DateTime.makeUnsafe(filing.submittedAt ?? filing.createdAt);
    const input = reconcileInputOf(reconcileHintsOf(filing.preview), submittedAt);
    const listed = yield* clients
      .use(filing.boxId, (client) => client.reconcileSentMessage(input))
      .pipe(Effect.result);
    if (Result.isFailure(listed)) {
      if (listed.failure._tag === "BoxNotFound") return yield* boxRemoved;
      const detail = listed.failure.message;
      yield* recordAttempt(filingId, { result: "error", error: detail });
      return yield* new SendUnavailable({ detail: `the sent messages could not be checked: ${detail}` });
    }

    const match = listed.success;
    if (match._tag === "NotFound") {
      yield* recordAttempt(filingId, { result: "not_found" });
      return ReconcileOutcome.StillUnknown({ detail: "no matching sent message was found (yet)" });
    }
    if (match._tag === "Ambiguous") {
      const dmIDs = match.matches.map((m) => m.dmID);
      yield* recordAttempt(filingId, { result: "ambiguous", dmIDs });
      return ReconcileOutcome.StillUnknown({ detail: `several sent messages match: ${dmIDs.join(", ")}` });
    }
    const dmID = match.dmID;
    const at = yield* now;
    const write = yield* store.resolveReconciled(filingId, dmID, RECONCILE_COMPETITOR_WINDOW_MS, {
      reconcile: { at, result: "found", dmID },
      reconciledAt: at,
    });
    switch (write._tag) {
      case "Won":
        return ReconcileOutcome.Sent({ dmID });
      case "DmIdTaken":
        yield* recordAttempt(filingId, { result: "dmid_linked", dmID, linkedTo: write.filingId });
        return ReconcileOutcome.StillUnknown({
          detail: `the matching message ${dmID} is already linked to filing ${write.filingId}`,
        });
      case "Competing":
        yield* recordAttempt(filingId, { result: "competing", dmID, competitors: write.filingIds });
        return ReconcileOutcome.StillUnknown({
          detail: `message ${dmID} matches, but other in-flight filings could be it too: ${write.filingIds.join(", ")}`,
        });
      case "Lost":
        return Option.match(write.current, {
          onNone: () => ReconcileOutcome.NotApplicable({ state: filing.state }),
          onSome: (current) => ReconcileOutcome.NotApplicable({ state: current.state }),
        });
    }
  });

  /**
   * The follow-up reconcile after an unknown dispatch outcome (C5): outside the claim's
   * uninterruptible region and in its own permit. Its errors leave the filing unknown.
   *
   * Obligation (4): it runs inside `claim.whileClaimed`. The outcome is persisted by then, but
   * whether ISDS has the message is still unknown, so an interruption or defect here is audited
   * "uncertain" (R6: a send that ended without an answer is uncertain), not "error".
   */
  const followUp = (claim: ClaimSignal, filingId: string): Effect.Effect<SendResult> =>
    claim.whileClaimed(
      reconcile(filingId).pipe(
        Effect.map((outcome) =>
          outcome._tag === "Sent"
            ? SendResult.Sent({ filingId, dmID: outcome.dmID })
            : SendResult.OutcomeUnknown({ filingId }),
        ),
        Effect.catch((error) =>
          Effect.as(
            Effect.logWarning("datova-schranka: the follow-up reconcile failed", error).pipe(
              Effect.annotateLogs({ filingId }),
            ),
            SendResult.OutcomeUnknown({ filingId }),
          ),
        ),
      ),
    );

  /** A finished step's result, after its follow-up reconcile when the outcome is unknown. */
  const finish = (claim: ClaimSignal, step: Extract<Step, { _tag: "Done" }>): Effect.Effect<SendResult> =>
    step.followUp && step.result._tag === "OutcomeUnknown"
      ? followUp(claim, step.result.filingId)
      : Effect.succeed(step.result);

  // send_message -----------------------------------------------------------------

  /** awaiting_approval without a nonce (lost response, D-f): the live nonce again, else a fresh one. */
  const approvalAgain = Effect.fn("SendService.approvalAgain")(function* (filing: Filing) {
    const live = yield* store.liveNonce(filing.id);
    if (Option.isSome(live)) {
      const nonce = openNonce(live.value.nonceHash, live.value.nonceSealed);
      if (Option.isSome(nonce)) {
        return SendResult.ApprovalRequired({
          filingId: filing.id,
          nonce: nonce.value,
          preview: filing.preview,
          expiresAt: live.value.expiresAt,
        });
      }
    }
    const fresh = yield* freshNonce(filing.expiresAt);
    if (yield* store.replaceNonce(filing.id, fresh.row)) {
      return SendResult.ApprovalRequired({
        filingId: filing.id,
        nonce: fresh.nonce,
        preview: filing.preview,
        expiresAt: fresh.row.expiresAt,
      });
    }
    const current = yield* store.byId(filing.id);
    return Option.match(current, {
      onNone: () => SendResult.Refused({ reason: "the filing disappeared; call again" }),
      onSome: storedResult,
    });
  });

  /** Idempotency (plan step 4, D-b): an existing filing for the key, answered from the DB. */
  const replay = Effect.fn("SendService.replay")(function* (existing: Filing, contentHash: string) {
    const filing = yield* expireIfDue(existing);
    if (filing.contentHash !== contentHash) {
      return {
        result: SendResult.Refused({
          reason: "this idempotencyKey was already used for a different message; use a new idempotencyKey",
        }),
      } satisfies Answer;
    }
    const result = filing.state === "awaiting_approval" ? yield* approvalAgain(filing) : storedResult(filing);
    return { result, preview: filing.preview } satisfies Answer;
  });

  /** A new filing (plan step 6, C1, C3) under the box permit. */
  const newUnderPermit = Effect.fn("SendService.newUnderPermit")(function* (
    client: IsdsClientShape,
    caller: SendCaller,
    request: SendMessageRequest,
    message: NormalisedMessage,
    claim: ClaimSignal,
  ) {
          // A concurrent call with the same key may have created it while this one waited.
          const raced = yield* store.byKey(caller.grantId, request.boxId, request.idempotencyKey);
          if (Option.isSome(raced)) return moved(raced);

          const refusal = yield* preflight(client, request.recipient);
          const verdict = yield* authority.check(caller.grantId, request.boxId);
          if (verdict !== "ok") return done(SendResult.Refused({ reason: AUTHORITY_REASONS[verdict] }));
          const id = newRowId("fil");
          // Box row, tier and insert in one transaction: a removal or tier edit lands before or after it (C4).
          const decide = Effect.gen(function* () {
          if (!(yield* boxRowExists(request.boxId))) {
            return decided(done(SendResult.Refused({ reason: `no data box ${request.boxId} is configured` })));
          }
          const tier = yield* tierOf(request.boxId, request.recipient);
          const fields = {
            id,
            grantKey: caller.grantId,
            boxId: request.boxId,
            idempotencyKey: request.idempotencyKey,
            contentHash: message.contentHash,
            tier,
            recipientDbId: request.recipient,
            preview: message.preview,
          };
          const inserted = (
            write: { readonly _tag: "Inserted" } | { readonly _tag: "KeyTaken"; readonly existing: Filing },
            result: () => SendResult,
          ): Step => (write._tag === "Inserted" ? done(result()) : moved(Option.some(write.existing)));

          if (refusal !== undefined) {
            // C3: an authoritative "cannot receive" reserves the key with a terminal refusal.
            const write = yield* store.insert({ ...fields, state: "refused", reason: refusal });
            return decided(inserted(write, () => SendResult.Refused({ filingId: id, reason: refusal })));
          }
          switch (tier) {
            case "none": {
              const write = yield* store.insert({
                ...fields,
                state: "pending_admin",
                payloadSealed: yield* sealPayload(id, message.createInput),
                expiresAt: yield* pendingExpiry,
              });
              return decided(inserted(write, () => SendResult.Queued({ filingId: id })));
            }
            case "approve": {
              const expiresAt = yield* pendingExpiry;
              const fresh = yield* freshNonce(expiresAt);
              const write = yield* store.insert({
                ...fields,
                state: "awaiting_approval",
                payloadSealed: yield* sealPayload(id, message.createInput),
                expiresAt,
                nonce: fresh.row,
              });
              return decided(
                inserted(write, () =>
                  SendResult.ApprovalRequired({
                    filingId: id,
                    nonce: fresh.nonce,
                    preview: message.preview,
                    expiresAt: fresh.row.expiresAt,
                  }),
                ),
              );
            }
            case "full": {
              // C1: the INSERT … 'dispatching' is the atomic claim; only its winner sends.
              const write = yield* store.insert({ ...fields, state: "dispatching", submittedAt: yield* now });
              return write._tag === "Inserted" ? claimed(id) : decided(moved(Option.some(write.existing)));
            }
          }
          });
          // One uninterruptible transaction for every tier; only a full-tier claim goes on to send.
          return yield* claimAndSend(claim, client, decide, message.createInput);
  });

  const newFiling = Effect.fn("SendService.newFiling")(function* (
    caller: SendCaller,
    request: SendMessageRequest,
    message: NormalisedMessage,
    claim: ClaimSignal,
  ) {
    const step = yield* withClient(request.boxId, (client) => newUnderPermit(client, caller, request, message, claim));
    if (step._tag === "Done") return { result: yield* finish(claim, step), preview: message.preview } satisfies Answer;
    return yield* Option.match(step.current, {
      onNone: () => Effect.succeed<Answer>({ result: SendResult.Refused({ reason: "the filing disappeared; call again" }) }),
      onSome: (current) => replay(current, message.contentHash),
    });
  });

  /** The confirm path (plan step 5, D-g): a valid nonce for an awaiting_approval filing. */
  const confirm = Effect.fn("SendService.confirm")(function* (
    filing: Filing,
    nonceHash: string,
    message: NormalisedMessage,
    claim: ClaimSignal,
  ) {
    const step = yield* dispatchExisting({ filing, from: "awaiting_approval", nonceHash }, claim);
    if (step._tag === "Done") return { result: yield* finish(claim, step), preview: filing.preview } satisfies Answer;
    return yield* Option.match(step.current, {
      onNone: () => Effect.succeed<Answer>({ result: SendResult.Refused({ reason: "the filing disappeared" }) }),
      onSome: (current) => replay(current, message.contentHash),
    });
  });

  const refused = (reason: string): Answer => ({ result: SendResult.Refused({ reason }) });

  /** send_message without its audit row (plan steps 1–6 as amended by C2, C3, D-a, D-f). */
  const sendFlow = Effect.fn("SendService.sendFlow")(function* (
    caller: SendCaller,
    request: SendMessageRequest,
    claim: ClaimSignal,
  ) {
    // D-a: authorise before touching anything, nonce state included.
    const verdict = yield* authority.check(caller.grantId, request.boxId);
    if (verdict !== "ok") return refused(AUTHORITY_REASONS[verdict]);
    const box = yield* Effect.option(registry.get(request.boxId));
    if (Option.isNone(box)) return refused(`no data box ${request.boxId} is configured`);

    const normalised = yield* Effect.result(normaliseRequest(request, box.value));
    // Structurally invalid: refused with no row, so the key stays unused (C3).
    if (Result.isFailure(normalised)) return refused((normalised.failure satisfies InvalidSendRequest).reason);
    const message = normalised.success;

    // The nonce row is read BEFORE the filing: a nonce consumed by a concurrent claim then
    // always comes with the filing's moved state, so a nonce error never hides a stored
    // same-content result (C2).
    const nonceHash = request.approvalNonce === undefined ? undefined : sha256Hex(request.approvalNonce);
    const nonce = nonceHash === undefined ? Option.none() : yield* store.nonceByHash(nonceHash);
    const loaded = yield* store.byKey(caller.grantId, request.boxId, request.idempotencyKey);
    // Obligation (1): a due open filing is expired before any nonce use or replacement.
    const existing = Option.isSome(loaded) ? Option.some(yield* expireIfDue(loaded.value)) : loaded;
    const sameContent = Option.isSome(existing) && existing.value.contentHash === message.contentHash;

    if (nonceHash !== undefined) {
      // C2: a same-content filing past awaiting_approval answers its stored result, nonce unread.
      if (sameContent && existing.value.state !== "awaiting_approval") return yield* replay(existing.value, message.contentHash);
      if (Option.isNone(nonce)) return refused("unknown approvalNonce; call again without approvalNonce for a fresh one");
      const row = nonce.value;
      if (row.grantKey !== caller.grantId) return refused("the approvalNonce was not issued to this authorization");
      if (row.usedAt !== undefined) {
        return refused("the approvalNonce was already used; call again without approvalNonce for a fresh one");
      }
      if (
        Option.isNone(existing) ||
        row.filingId !== existing.value.id ||
        row.contentHash !== message.contentHash ||
        row.boxId !== request.boxId
      ) {
        yield* store.burnNonce(nonceHash);
        return refused("the approvalNonce does not match this message; it is now used up");
      }
      if (row.expiresAt <= (yield* now)) {
        return refused("the approvalNonce expired; call again without approvalNonce for a fresh one");
      }
      return yield* confirm(existing.value, nonceHash, message, claim);
    }

    if (Option.isSome(existing)) return yield* replay(existing.value, message.contentHash);
    return yield* newFiling(caller, request, message, claim);
  });

  /** The audit outcome of a failure outside a claimed window: refusals are "refused". */
  const refusalOutcome = (error: { readonly _tag: string }) =>
    error._tag === "FilingNotFound" || error._tag === "FilingStateConflict" ? ("refused" as const) : ("error" as const);

  // get_filing_status ----------------------------------------------------------------

  const statusFlow = Effect.fn("SendService.statusFlow")(function* (caller: SendCaller, boxId: string, ref: FilingRef) {
    const wanted = "filingId" in ref ? ref.filingId : ref.idempotencyKey;
    const found =
      "filingId" in ref ? yield* store.byId(ref.filingId) : yield* store.byKey(caller.grantId, boxId, ref.idempotencyKey);
    // Only the caller grant's filings on this box exist for it.
    if (Option.isNone(found) || found.value.grantKey !== caller.grantId || found.value.boxId !== boxId) {
      return yield* new FilingNotFound({ filingId: wanted });
    }
    let filing = yield* expireIfDue(found.value);
    const at = yield* now;
    if (
      filing.state === "outcome_unknown" &&
      (filing.reconciledAt === undefined || filing.reconciledAt <= at - STATUS_RECONCILE_INTERVAL_MS)
    ) {
      // A failed attempt is recorded too and counts toward the throttle (C5); the filing is reported as it stands.
      yield* reconcile(filing.id).pipe(
        Effect.catchTag("SendUnavailable", (error) =>
          Effect.logInfo("datova-schranka: a status reconcile failed", error).pipe(Effect.annotateLogs({ filingId: filing.id })),
        ),
      );
      filing = Option.getOrElse(yield* store.byId(filing.id), () => filing);
    }
    return { filing, guidance: guidanceOf(filing) } satisfies FilingStatus;
  });

  // Admin approval ----------------------------------------------------------------------

  const approveFlow = Effect.fn("SendService.approveFlow")(function* (
    found: Option.Option<Filing>,
    filingId: string,
    claim: ClaimSignal,
  ) {
    if (Option.isNone(found)) return yield* new FilingNotFound({ filingId });
    const conflict = (current: Option.Option<Filing>) =>
      Option.match(current, {
        onNone: () => new FilingNotFound({ filingId }),
        onSome: (filing) => new FilingStateConflict({ filingId, state: filing.state, expected: "pending_admin" }),
      });
    const filing = yield* expireIfDue(found.value);
    if (filing.state !== "pending_admin") return yield* conflict(Option.some(filing));
    // D-h: admin approval proceeds whatever the tier is now (it is the strictest flow).
    const step = yield* dispatchExisting({ filing, from: "pending_admin" }, claim);
    if (step._tag === "Moved") return yield* conflict(step.current);
    return { result: yield* finish(claim, step), preview: filing.preview } satisfies Answer;
  });

  /**
   * Keeps a call "claimed" from its first winning claim to its end. `whileClaimed` windows close
   * when their effect succeeds, which leaves a gap between the dispatch window and the follow-up
   * reconcile's (and after the last one) where an interruption would be audited "error" although
   * ISDS may have the message. Once a claim has won, a call that ends without a value reopens a
   * window that never closes, so its audit outcome is "uncertain" (R6).
   */
  const trackClaims = <A, E>(claim: ClaimSignal, body: (claim: ClaimSignal) => Effect.Effect<A, E>) =>
    Effect.flatMap(Ref.make(false), (won) => {
      const tracked: ClaimSignal = {
        whileClaimed: (effect) => Effect.andThen(Ref.set(won, true), claim.whileClaimed(effect)),
      };
      return body(tracked).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.flatMap(Ref.get(won), (claimedInCall) =>
                claimedInCall ? Effect.asVoid(Effect.exit(claim.whileClaimed(Effect.fail("unsettled" as const)))) : Effect.void,
              ),
        ),
      );
    });

  // The shape -------------------------------------------------------------------------------

  const phaseB = (operation: string) => Effect.die(`SendService.${operation}: implemented in phase B`);

  const audited = <A, E>(
    input: Parameters<typeof auditedSend>[0],
    run: (claim: ClaimSignal) => Effect.Effect<A, E>,
    options: Parameters<typeof auditedSend<A, E, never>>[2],
  ): Effect.Effect<A, E | DomainStoreError> => auditedSend(input, run, options).pipe(Effect.provideService(AuditLog, audit));

  const service: SendServiceShape = {
    sendMessage: (caller, request) => {
      const start = sendDetail({ idempotencyKey: request.idempotencyKey, recipient: request.recipient });
      return audited(
        {
          actor: { kind: "tool", grantId: caller.grantId, clientId: caller.clientId, subject: caller.subject },
          action: "send_message",
          boxId: request.boxId,
          detail: start,
        },
        (claim) => trackClaims(claim, (tracked) => sendFlow(caller, request, tracked)),
        {
          outcomeOf: (answer: Answer) => sendResultOutcome(answer.result),
          okDetail: (answer: Answer): SendDetail =>
            sendDetail({
              idempotencyKey: request.idempotencyKey,
              recipient: request.recipient,
              preview: answer.preview,
              result: answer.result,
            }),
        },
      ).pipe(Effect.map((answer) => answer.result));
    },

    filingStatus: (caller, boxId, ref) =>
      audited(
        {
          actor: { kind: "tool", grantId: caller.grantId, clientId: caller.clientId, subject: caller.subject },
          action: "get_filing_status",
          boxId,
          detail: "filingId" in ref ? { filingId: ref.filingId } : { idempotencyKey: ref.idempotencyKey },
        },
        () => statusFlow(caller, boxId, ref),
        {
          outcomeOf: () => "ok",
          okDetail: (status: FilingStatus) => ({
            filingId: status.filing.id,
            idempotencyKey: status.filing.idempotencyKey,
            state: status.filing.state,
          }),
          classify: refusalOutcome,
        },
      ),

    listFilings: (query?: FilingListQuery) => store.list(query),

    getFiling: (filingId) =>
      Effect.flatMap(store.byId(filingId), (found) =>
        Option.isSome(found) ? Effect.succeed(found.value) : Effect.fail(new FilingNotFound({ filingId })),
      ),

    approve: (admin: AuditActor, filingId) =>
      Effect.flatMap(store.byId(filingId), (found) =>
        audited(
          {
            actor: admin,
            action: "filing.approve",
            boxId: Option.isSome(found) ? found.value.boxId : undefined,
            detail: { filingId },
          },
          (claim) => trackClaims(claim, (tracked) => approveFlow(found, filingId, tracked)),
          {
            outcomeOf: (answer: Answer) => sendResultOutcome(answer.result),
            okDetail: (answer: Answer): SendDetail =>
              sendDetail({ filingId, preview: answer.preview, result: answer.result }),
            classify: refusalOutcome,
          },
        ).pipe(Effect.map((answer) => answer.result)),
      ),

    // TODO(phase B): reject, reconcileNow, markSent, confirmNotSent, reconcileRecovered, expireDue.
    reject: () => phaseB("reject"),
    reconcileNow: () => phaseB("reconcileNow"),
    markSent: () => phaseB("markSent"),
    confirmNotSent: () => phaseB("confirmNotSent"),
    reconcileRecovered: phaseB("reconcileRecovered"),
    expireDue: phaseB("expireDue"),
  };
  void recoveredIds;
  return service;
});

/** The SendService layer. Needs SqlClient, DataKey, DomainConfig, AuditLog, BoxRegistry, BoxClients, RecipientTiers, SendAuthority. */
export const sendServiceLayer = Layer.effect(SendService, makeSendService);
