import { createHash } from "node:crypto";
import { markUntrusted } from "@mcps/core/mcp/untrusted.js";
import type { Principal } from "@mcps/core/transport/principal.js";
import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import type { Account } from "./accounts.js";
import { addDays, pragueDateOf } from "./cache/dates.js";
import { Database } from "./cache/db.js";
import { AppConfig } from "./config.js";
import {
  InvalidInput,
  PAYMENT_TOKEN_HINT,
  PaymentAuditError,
  PermissionDenied,
  type RateLimited,
  UploadOutcomeUnknown,
  UploadRefused,
} from "./errors.js";
import { FioApi } from "./fio-api.js";
import { type ImportResult, looksLikeMissingPaymentPermission, parseImportResponse } from "./import-response.js";
import { ToolFailure } from "./mcp/common.js";
import { type PayeeRecord, payeeOf, provenanceProblems } from "./payment-details.js";
import {
  type AuditOutcome,
  type AuditQuery,
  type AuditRow,
  type NewAuditRow,
  PaymentLedger,
  type PaymentLedgerShape,
} from "./payment-ledger.js";
import { type Payer, type PaymentOrder, summarizeOrders, toCents } from "./payments.js";
import { isConflictRefusal } from "./rate-limiter.js";
import { Redactor, RedactorLive } from "./redaction.js";

/** Audit rows (and so idempotency keys) are kept at least this long; purge refuses later cut-offs. */
export const AUDIT_RETENTION_DAYS = 365;

/** Appended to failures that are final for their idempotency key (R3). */
export const NEW_KEY_ADVICE = "To submit a corrected batch, use a new idempotencyKey.";

/** The short "check before resubmitting" advice for an ambiguous result. */
export const UPLOAD_UNCERTAIN_SHORT =
  "Check the pending batches in FIO Internetbanking (Platby → Příkazy k autorizaci) before submitting again, or the orders could be duplicated; do not resubmit until the user has checked.";

/** Recorded on the row before dispatch (R4): a crash mid-upload replays as unknown. */
const IN_PROGRESS = new UploadOutcomeUnknown({
  detail: "The upload started but its outcome was never recorded (the server stopped or failed during the upload).",
});

type ToolFailureType = typeof ToolFailure.Type;

/** The import call's success value (D14), the same shape the submit tool always returned. */
export interface SubmitSuccess {
  readonly [key: string]: unknown;
}

export interface SubmitInput {
  readonly principal: Principal;
  readonly account: Account;
  readonly payer: Payer;
  readonly orders: ReadonlyArray<PaymentOrder>;
  /** The exact XML built from `orders` (buildImportXml). */
  readonly xml: string;
  readonly idempotencyKey: string;
}

/** What one upload attempt came to (D15 with R5). */
interface UploadClassification {
  readonly outcome: AuditOutcome;
  /** The parsed response, when FIO answered with one that is not a permission refusal. */
  readonly result: ImportResult | undefined;
  /** The failure to report, when there is no usable result. */
  readonly failure: ToolFailureType | undefined;
  readonly batchIds: ReadonlyArray<string>;
  readonly fioErrorCode: string | null;
  readonly reason: string | null;
}

export interface PaymentControlsShape {
  /** Runs `effect` holding the grant's lock (one submission per grant at a time). */
  readonly withGrantLock: <A, E, R>(grantId: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** D14 end to end: returns the success JSON or a ToolFailure. */
  readonly submit: (input: SubmitInput) => Effect.Effect<SubmitSuccess, ToolFailureType>;
  /** Audit rows newest first, optionally for one grant (/admin/payments). */
  readonly listAudit: (query: AuditQuery) => Effect.Effect<ReadonlyArray<AuditRow>, PaymentAuditError>;
  /**
   * Deletes audit rows of Prague days before `before` (YYYY-MM-DD). Refuses
   * (InvalidInput) a date later than today minus AUDIT_RETENTION_DAYS.
   */
  readonly purgeBefore: (before: string) => Effect.Effect<number, PaymentAuditError | InvalidInput>;
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Integer cents per currency of the batch. */
const batchTotals = (payees: ReadonlyArray<PayeeRecord>): AuditRow["totals"] => {
  const totals = new Map<string, bigint>();
  for (const payee of payees) {
    totals.set(payee.currency, (totals.get(payee.currency) ?? 0n) + toCents(payee.amount));
  }
  return Object.fromEntries(
    Array.from(totals, ([currency, cents]) => [
      currency,
      cents > Number.MAX_SAFE_INTEGER ? cents.toString() : Number(cents),
    ]),
  );
};

const encodeFailure = Schema.encodeUnknownSync(ToolFailure);
const decodeFailure = Schema.decodeUnknownSync(ToolFailure);
const RecordedJson = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ok: Schema.Record(Schema.String, Schema.Unknown) }),
    Schema.Struct({ failure: Schema.Unknown }),
  ]),
);
const decodeRecorded = Schema.decodeUnknownEffect(RecordedJson);

/** Why a RateLimited upload was not sent. A 409 means FIO saw the call and processed nothing. */
const notSentReason = (error: RateLimited): string =>
  isConflictRefusal(error) ? "FIO returned 409 and processed nothing" : "RateLimited";

/**
 * R3: a not-sent or rejected upload is final for its idempotency key, so its
 * failure carries the new-key advice and never a retry hint. Failures without
 * a `detail` become UploadRefused with the original message (a RateLimited
 * one without its "Retry after", since the key never uploads again).
 */
const withNewKeyAdvice = (failure: ToolFailureType): ToolFailureType => {
  switch (failure._tag) {
    case "InvalidInput":
      return new InvalidInput({ detail: `${failure.detail} ${NEW_KEY_ADVICE}` });
    case "PermissionDenied":
      return new PermissionDenied({ detail: `${failure.detail} ${NEW_KEY_ADVICE}` });
    case "UploadOutcomeUnknown":
    case "UploadRefused":
      return failure;
    case "RateLimited":
      return new UploadRefused({
        detail: `The batch was not uploaded: ${notSentReason(failure)}. ${failure.reason} This idempotencyKey never uploads again. ${NEW_KEY_ADVICE}`,
      });
    case "TooManyItems":
      return new UploadRefused({
        detail: `FIO refused the batch as too large (HTTP 413); no batch was created and this idempotencyKey never uploads again. ${NEW_KEY_ADVICE}`,
      });
    default:
      return new UploadRefused({
        detail: `${failure.message} No batch was created in FIO, and this idempotencyKey never uploads again. ${NEW_KEY_ADVICE}`,
      });
  }
};

const statusCode = (result: ImportResult): string => (result.status === "" ? "missing" : result.status);

const nextStepFor = (result: ImportResult): string => {
  switch (result.outcome) {
    case "accepted":
      return "The batch was created but NOT executed. An authorized person must sign it in FIO Internetbanking (SMS or Fio signature) for the payments to be processed.";
    case "rejected":
      return `FIO rejected the batch; nothing was created. Fix the problems listed; a used idempotencyKey never uploads again. ${NEW_KEY_ADVICE}`;
    case "unknown": {
      // Status and batch IDs are FIO's text: marked so the output guards them.
      const batch = result.batchIds.length ? `, batch ID ${markUntrusted(result.batchIds.join(", "))}` : "";
      return `FIO's answer is ambiguous (status "${result.status === "" ? "missing" : markUntrusted(result.status)}"${batch}). The upload may or may not have created a batch. ${UPLOAD_UNCERTAIN_SHORT}`;
    }
  }
};

export const makePaymentControls = Effect.gen(function* () {
  const ledger = yield* PaymentLedger;
  const fio = yield* FioApi;
  const redactor = yield* Redactor;

  // One permit per grant. Created synchronously on first use, so two fibers
  // can never create two semaphores for the same grant.
  const locks = new Map<string, Semaphore.Semaphore>();
  const withGrantLock = <A, E, R>(grantId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      let lock = locks.get(grantId);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(grantId, lock);
      }
      return lock.withPermits(1)(effect);
    });

  const failureJson = (failure: ToolFailureType): string =>
    JSON.stringify({ failure: redactor.redactDeep(encodeFailure(failure)) });
  const okJson = (value: SubmitSuccess): string => JSON.stringify({ ok: redactor.redactDeep(value) });

  /** The recorded response of an owner row (D12). A missing or unreadable one replays as unknown. */
  const replay = (row: AuditRow): Effect.Effect<SubmitSuccess, ToolFailureType> =>
    Effect.gen(function* () {
      if (row.responseJson === null) return yield* Effect.fail<ToolFailureType>(IN_PROGRESS);
      const recorded = yield* decodeRecorded(row.responseJson).pipe(Effect.option);
      if (Option.isNone(recorded)) {
        yield* Effect.logError("payments: unreadable recorded response", { auditId: row.id });
        return yield* Effect.fail<ToolFailureType>(IN_PROGRESS);
      }
      if ("ok" in recorded.value) return recorded.value.ok;
      const failure = Option.liftThrowable(decodeFailure)(recorded.value.failure);
      return yield* Effect.fail<ToolFailureType>(Option.getOrElse(failure, () => IN_PROGRESS));
    });

  const uploadBatch = (account: Account, xml: string): Effect.Effect<UploadClassification> =>
    fio.importXml(account, xml).pipe(
      // FIO's status, batch IDs and messages are bank text stored in the audit
      // columns and the recorded response: redact the body before parsing,
      // since parsing lowercases the status and the redactor matches case.
      Effect.flatMap((body) => parseImportResponse(redactor.redact(body), redactor.excerpt)),
      Effect.map((result): UploadClassification => {
        if (looksLikeMissingPaymentPermission(result)) {
          return {
            outcome: "rejected",
            result: undefined,
            failure: new PermissionDenied({
              detail: `FIO refused the upload: "${markUntrusted(result.messages.join(" "))}". ${PAYMENT_TOKEN_HINT}`,
            }),
            batchIds: result.batchIds,
            fioErrorCode: statusCode(result),
            reason: "fio: missing payment permission",
          };
        }
        return {
          outcome: result.outcome,
          result,
          failure: undefined,
          batchIds: result.batchIds,
          fioErrorCode: result.outcome === "accepted" ? null : statusCode(result),
          reason: result.outcome === "accepted" ? null : `fio: ${result.outcome}`,
        };
      }),
      Effect.catch((error) => Effect.succeed(classifyError(error))),
    );

  // R5. FioApi turns FIO's 409 (token used too soon, nothing processed)
  // into RateLimited once its retries run out, so TokenBusy never reaches
  // here; RateLimited is "not sent" either way, and the reason names the 409.
  const classifyError = (error: ToolFailureType): UploadClassification => {
    const base = { result: undefined, batchIds: [], fioErrorCode: error._tag };
    switch (error._tag) {
      case "RateLimited":
        return { ...base, outcome: "refused", failure: error, reason: `not sent: ${notSentReason(error)}` };
      case "FioTransportError":
        if (!error.dispatched) return { ...base, outcome: "refused", failure: error, reason: "not sent: FioTransportError" };
        break;
      case "PermissionDenied":
      case "FioBadRequest":
      case "TooManyItems":
        return { ...base, outcome: "rejected", failure: error, reason: `fio: ${error._tag}` };
    }
    // Anything else may have reached FIO: fail safe to unknown.
    return {
      ...base,
      outcome: "unknown",
      failure: new UploadOutcomeUnknown({ detail: error.message }),
      reason: `unknown: ${error._tag}`,
    };
  };

  /** The tool response for a classified upload. */
  const responseOf = (
    classified: UploadClassification,
    success: (result: ImportResult) => SubmitSuccess,
  ): { readonly value: SubmitSuccess } | { readonly failure: ToolFailureType } => {
    if (classified.result !== undefined) return { value: success(classified.result) };
    const failure = classified.failure ?? IN_PROGRESS;
    return { failure: classified.outcome === "unknown" ? failure : withNewKeyAdvice(failure) };
  };

  /** Steps 6-8: record unknown, upload, record the outcome. Uninterruptible so the row matches what FIO saw. */
  const uploadRecorded = Effect.fnUntraced(function* (auditId: string, account: Account, xml: string, success: (result: ImportResult) => SubmitSuccess) {
      const classified = yield* uploadBatch(account, xml);
      const response = responseOf(classified, success);
      const now = yield* Clock.currentTimeMillis;
      yield* ledger
        .update(
          auditId,
          {
            outcome: classified.outcome,
            batchIds: classified.batchIds,
            fioErrorCode: classified.fioErrorCode,
            reason: classified.reason,
            responseJson: "value" in response ? okJson(response.value) : failureJson(response.failure),
          },
          now,
        )
        .pipe(
          // The upload happened: report its real outcome even if the row could not be updated.
          Effect.catch((error) => Effect.logError("payments: audit update after upload failed", error)),
        );
      return response;
  }, Effect.uninterruptible);

  const submit = (input: SubmitInput): Effect.Effect<SubmitSuccess, ToolFailureType> => {
    const grantId = input.principal.subject;
    return withGrantLock(
      grantId,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        const payees = input.orders.map((order) => payeeOf(order, input.payer.currency ?? ""));
        const xmlSha256 = sha256Hex(input.xml);
        const summary = summarizeOrders(input.orders, input.payer);
        const success = (result: ImportResult): SubmitSuccess => ({
          account: input.account.name,
          payerAccount: input.payer.accountNumber,
          ...summary,
          result,
          nextStep: nextStepFor(result),
        });

        // 2. Idempotency (D13/R3).
        const owner = yield* ledger.findByKey(grantId, input.idempotencyKey);
        const row = (keyOwner: boolean): Omit<NewAuditRow, "outcome" | "reason" | "responseJson"> => ({
          createdAt: now,
          grantId,
          clientId: input.principal.clientId ?? null,
          accountId: input.account.tokenFingerprint,
          accountName: input.account.name,
          idempotencyKey: input.idempotencyKey,
          keyOwner,
          xmlSha256,
          orderCount: input.orders.length,
          totals: batchTotals(payees),
          payees,
          batchIds: [],
          fioErrorCode: null,
        });
        if (Option.isSome(owner)) {
          if (owner.value.xmlSha256 === xmlSha256) return yield* replay(owner.value);
          const failure = new InvalidInput({
            detail: `This idempotencyKey was already used for a different batch, so nothing was sent to FIO. ${NEW_KEY_ADVICE}`,
          });
          yield* ledger.insert({
            ...row(false),
            outcome: "refused",
            reason: "idempotency key reused with different orders",
            responseJson: failureJson(failure),
          });
          return yield* Effect.fail(failure);
        }

        const refuse = (reason: string, failure: ToolFailureType) =>
          ledger
            .insert({ ...row(true), outcome: "refused", reason, responseJson: failureJson(failure) })
            .pipe(Effect.andThen(Effect.fail(failure)));

        // 3. Provenance (R9).
        const provenance = provenanceProblems(input.orders);
        if (provenance.length > 0) {
          return yield* refuse(
            provenance.join("; "),
            new InvalidInput({
              detail: `These orders contain text that looks copied from guarded bank data (${provenance
                .map((problem) => problem.replace(/^provenance: /, ""))
                .join(
                  "; ",
                )}). Payee, amount, symbols and messages must come from the user's own request or a document the user named, never from transaction or statement text returned by this server. Nothing was sent to FIO. ${NEW_KEY_ADVICE}`,
            }),
          );
        }

        const auditId = yield* ledger.insert({
          ...row(true),
          outcome: "unknown",
          reason: "upload in progress",
          responseJson: failureJson(IN_PROGRESS),
        });
        const response = yield* uploadRecorded(auditId, input.account, input.xml, success);
        if ("value" in response) return response.value;
        return yield* Effect.fail(response.failure);
      }),
    );
  };

  const purgeBefore = Effect.fnUntraced(function* (before: string) {
      const latest = addDays(pragueDateOf(yield* Clock.currentTimeMillis), -AUDIT_RETENTION_DAYS);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(before) || before > latest) {
        return yield* new InvalidInput({
          detail: `The cut-off must be a date (YYYY-MM-DD) no later than ${latest}: payment audit rows are kept at least ${AUDIT_RETENTION_DAYS} days.`,
        });
      }
      return yield* ledger.purgeBefore(before);
  });

  return {
    withGrantLock,
    submit,
    listAudit: ledger.list,
    purgeBefore,
  } satisfies PaymentControlsShape;
});

/** A ledger that opens the database on first use; an open failure is a PaymentAuditError. */
const LazyLedgerLive = Layer.effect(
  PaymentLedger,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const ledger = yield* Effect.cached(
      Layer.buildWithScope(PaymentLedger.Default.pipe(Layer.provide(Database.Live)), scope).pipe(
        Effect.map((services) => Context.get(services, PaymentLedger)),
        Effect.catch((cause) =>
          Effect.logError("payments: failed to open the database", cause).pipe(
            Effect.andThen(Effect.fail(new PaymentAuditError({ operation: "open the payment audit database" }))),
          ),
        ),
      ),
    );
    const via = <A>(use: (shape: PaymentLedgerShape) => Effect.Effect<A, PaymentAuditError>) =>
      Effect.flatMap(ledger, use);
    return PaymentLedger.of({
      insert: (row) => via((l) => l.insert(row)),
      update: (id, patch, now) => via((l) => l.update(id, patch, now)),
      findByKey: (grantId, key) => via((l) => l.findByKey(grantId, key)),
      list: (query) => via((l) => l.list(query)),
      purgeBefore: (day) => via((l) => l.purgeBefore(day)),
    });
  }),
);

export class PaymentControls extends Context.Service<PaymentControls, PaymentControlsShape>()(
  "fio-mcp/PaymentControls",
) {
  /** Needs PaymentLedger, FioApi and Redactor. */
  static readonly Default = Layer.effect(PaymentControls, Effect.map(makePaymentControls, PaymentControls.of));

  /**
   * With the ledger on the server database; also exposes PaymentLedger. The
   * dependencies are the shared `Live` layers, so one build shares them.
   * Without a database already in use (the cache disabled and no OAuth), the
   * database opens on the first payment call instead, so read-only setups
   * keep creating no file.
   */
  static readonly Live = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const opensDatabase =
        config.cache.enabled || (config.transport.kind === "http" && config.transport.auth.kind === "oauth");
      const ledger = opensDatabase ? PaymentLedger.Default.pipe(Layer.provide(Database.Live)) : LazyLedgerLive;
      return PaymentControls.Default.pipe(Layer.provideMerge(ledger));
    }),
  ).pipe(Layer.provide(Layer.mergeAll(AppConfig.Live, FioApi.Live, RedactorLive)));
}
