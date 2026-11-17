import { Cause, Data, Effect, Exit, Ref, Result } from "effect";
import {
  type AuditEventInput,
  type AuditFinalOutcome,
  AuditLog,
  type AuditLogShape,
  defaultFailureOutcome,
} from "../audit-log.js";
import type { FilingPreview, IsdsStatusSummary, SendResult } from "./api.js";

/**
 * The audit wrapper of the send side (C6): like the domain's `audited`, but the outcome
 * comes from the returned value, and a failure while a dispatch is claimed is "uncertain".
 */

/**
 * Handed to the audited work so it can say when ISDS may have received the message.
 * `whileClaimed(effect)` marks the window from a winning claim through the persisted
 * outcome: wrap exactly that section (D-d), starting right after the claim wins. A failure,
 * defect or interruption while any window is open is audited as "uncertain"; a window closes
 * only when its effect succeeds, so the mark cannot be left set by mistake or cleared early.
 *
 * `whileClaimed` does not mask interruption itself. Run the claim and its window in one
 * uninterruptible region (D-d): an interruption after the claim commits but before the window
 * opens would be audited "error" and leave the filing 'dispatching' until startup recovery.
 */
export interface ClaimSignal {
  readonly whileClaimed: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export interface AuditedSendOptions<A, E> {
  /** The outcome of a successful call, e.g. `sendResultOutcome`; `() => "ok"` for void operations. */
  readonly outcomeOf: (value: A) => AuditFinalOutcome;
  /** The detail stored on success; it replaces the start detail. Omitted or undefined keeps it. */
  readonly okDetail?: ((value: A) => unknown) | undefined;
  /** The detail stored on failure; it replaces the start detail. Omitted or undefined keeps it. */
  readonly errorDetail?: ((error: E) => unknown) | undefined;
  /**
   * The outcome of a failure outside any claimed window (e.g. a refusal → "refused").
   * Default: the domain's `defaultFailureOutcome` ("error", or "uncertain" for a sent timeout).
   */
  readonly classify?: ((error: E) => AuditFinalOutcome) | undefined;
}

class AuditMapperError extends Data.TaggedError("AuditMapperError")<{ readonly cause: unknown }> {}

/** Runs a caller's mapper; one that throws is logged and gives `fallback`. */
const mapped = <T>(mapper: () => T, fallback: T): Effect.Effect<T> =>
  Effect.try({ try: mapper, catch: (cause) => new AuditMapperError({ cause }) }).pipe(
    Effect.catch((error) => Effect.as(Effect.logWarning("datova-schranka: an audit mapper failed", error), fallback)),
  );

const finalOf = <A, E>(
  exit: Exit.Exit<A, E>,
  claimed: boolean,
  options: AuditedSendOptions<A, E>,
): Effect.Effect<{ readonly outcome: AuditFinalOutcome; readonly detail: unknown }> => {
  if (Exit.isSuccess(exit)) {
    return Effect.all({
      // An outcomeOf that throws says nothing about the call, so its outcome is unknown.
      outcome: mapped(() => options.outcomeOf(exit.value), "uncertain" as AuditFinalOutcome),
      detail: mapped(() => options.okDetail?.(exit.value), undefined),
    });
  }
  const failure = Cause.findError(exit.cause);
  if (Result.isSuccess(failure)) {
    const error = failure.success;
    const classify = options.classify ?? defaultFailureOutcome;
    return Effect.all({
      // A claimed dispatch may have reached ISDS whatever the error says.
      outcome: claimed ? Effect.succeed<AuditFinalOutcome>("uncertain") : mapped(() => classify(error), "uncertain"),
      detail: mapped(() => options.errorDetail?.(error), undefined),
    });
  }
  // A defect or an interruption: before any claim nothing can have been sent.
  return Effect.succeed({ outcome: claimed ? "uncertain" : "error", detail: undefined });
};

/** The ClaimSignal of one audited call: `openWindows` counts its windows still open. */
const claimSignalOf = (openWindows: Ref.Ref<number>): ClaimSignal => ({
  whileClaimed: (effect) =>
    Effect.uninterruptibleMask((restore) =>
      Ref.update(openWindows, (n) => n + 1).pipe(
        Effect.andThen(restore(effect)),
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Ref.update(openWindows, (n) => n - 1) : Effect.void)),
      ),
    ),
});

/** Writes the finish of audit row `id` for the call's exit; a failing finish is only logged. */
const finishWith =
  <A, E>(audit: AuditLogShape, id: string, openWindows: Ref.Ref<number>, options: AuditedSendOptions<A, E>) =>
  (exit: Exit.Exit<A, E>): Effect.Effect<void> =>
    Ref.get(openWindows).pipe(
      Effect.flatMap((open) => finalOf(exit, open > 0, options)),
      Effect.flatMap((final) => audit.finish(id, final.outcome, final.detail)),
      // A failing finish must not replace the call's own result.
      Effect.catchCause((cause) =>
        Effect.logWarning("datova-schranka: audit entry left started", cause).pipe(Effect.annotateLogs({ auditId: id })),
      ),
    );

/**
 * Audits one send-side call (send_message, approve, reject, markSent, confirmNotSent,
 * reconcileNow), client acquisition included (C6). AuditLog.start runs first and fails
 * closed: when it fails, `run` never runs and the call fails with start's DomainStoreError.
 * The work runs interruptibly; the finish is written uninterruptibly on every exit, and a
 * finish that fails or dies is logged with the audit id and never replaces the call's result.
 */
export const auditedSend = Effect.fn("auditedSend")(function* <A, E, R>(
  input: AuditEventInput,
  run: (claim: ClaimSignal) => Effect.Effect<A, E, R>,
  options: AuditedSendOptions<A, E>,
) {
  const audit = yield* AuditLog;
  const openWindows = yield* Ref.make(0);
  const claim = claimSignalOf(openWindows);
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(audit.start(input), (id) =>
      restore(Effect.suspend(() => run(claim))).pipe(Effect.onExit(finishWith(audit, id, openWindows, options))),
    ),
  );
});

/**
 * `auditedSend` after a `prepare` step whose result the audit row's start needs (an admin call's
 * filing read, for its box). `prepare` runs interruptibly inside the same uninterruptible
 * region as the start, and its whole exit (value, failure, defect or interruption) is
 * captured, so the row is started whatever `prepare` did: `inputOf` builds the start from that
 * exit and `run` gets it, to go on from a value or re-raise the rest inside the audit window.
 * An interruption during `prepare` is audited too: the row starts, then `run` is interrupted
 * as it begins. Only an interruption before `prepare` starts leaves no row (nothing ran).
 */
export const auditedSendAfter = Effect.fn("auditedSendAfter")(function* <P, PE, A, E, R>(
  prepare: Effect.Effect<P, PE, R>,
  inputOf: (prepared: Exit.Exit<P, PE>) => AuditEventInput,
  run: (claim: ClaimSignal, prepared: Exit.Exit<P, PE>) => Effect.Effect<A, E, R>,
  options: AuditedSendOptions<A, E>,
) {
  const audit = yield* AuditLog;
  const openWindows = yield* Ref.make(0);
  const claim = claimSignalOf(openWindows);
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Effect.exit(restore(prepare)), (prepared) =>
      Effect.flatMap(audit.start(inputOf(prepared)), (id) =>
        restore(Effect.suspend(() => run(claim, prepared))).pipe(
          Effect.onExit(finishWith(audit, id, openWindows, options)),
        ),
      ),
    ),
  );
});

/** The audit outcome of a SendResult (binding mapping, ds-send-core-design.md "audit.ts"). */
export const sendResultOutcome = (result: SendResult): AuditFinalOutcome => {
  switch (result._tag) {
    case "Sent":
    case "Queued":
    case "ApprovalRequired":
    case "InProgress":
    case "Expired":
    case "NotSent":
      return "ok";
    case "Refused":
      return "refused";
    case "IsdsRejected":
      return "error";
    case "OutcomeUnknown":
      return "uncertain";
  }
};

/** An attachment as audited: name, size and hash, never content. */
export interface SendDetailAttachment {
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}

export interface SendDetailInput {
  readonly idempotencyKey?: string | undefined;
  /** Source of recipient, contentHash and attachments when those are not given; an ApprovalRequired result's preview is used by default. */
  readonly preview?: FilingPreview | undefined;
  readonly recipient?: string | undefined;
  readonly contentHash?: string | undefined;
  readonly attachments?: ReadonlyArray<SendDetailAttachment> | undefined;
  /** Default: the result's filingId. */
  readonly filingId?: string | undefined;
  readonly result?: SendResult | undefined;
  /** Default: a Refused result's reason. */
  readonly reason?: string | undefined;
}

/** The audit detail of a send-side call; built field by field, so it holds no nonce or attachment bytes. */
export interface SendDetail {
  readonly idempotencyKey?: string;
  readonly recipient?: string;
  readonly contentHash?: string;
  readonly attachments?: ReadonlyArray<SendDetailAttachment>;
  readonly filingId?: string;
  readonly result?: SendResult["_tag"];
  readonly isdsStatus?: Pick<IsdsStatusSummary, "code" | "classification">;
  readonly reason?: string;
}

/**
 * Builds a send call's audit detail. It copies named fields only: an ApprovalRequired
 * result's nonce and any attachment content passed along are dropped, and undefined
 * fields are left out.
 */
export const sendDetail = (input: SendDetailInput): SendDetail => {
  const { result } = input;
  const preview = input.preview ?? (result?._tag === "ApprovalRequired" ? result.preview : undefined);
  const status = result?._tag === "IsdsRejected" ? result.status : undefined;
  const fields: Record<keyof SendDetail, unknown> = {
    idempotencyKey: input.idempotencyKey,
    recipient: input.recipient ?? preview?.recipient,
    contentHash: input.contentHash ?? preview?.contentHash,
    attachments: (input.attachments ?? preview?.attachments)?.map(({ filename, size, sha256 }) => ({
      filename,
      size,
      sha256,
    })),
    filingId: input.filingId ?? (result !== undefined && "filingId" in result ? result.filingId : undefined),
    result: result?._tag,
    isdsStatus: status === undefined ? undefined : { code: status.code, classification: status.classification },
    reason: input.reason ?? (result?._tag === "Refused" ? result.reason : undefined),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as SendDetail;
};
