import { Effect, Layer } from "effect";
import type { AuditActor } from "../../src/domain/audit-log.js";
import {
  type Filing,
  type FilingListQuery,
  FilingNotFound,
  type FilingPreview,
  type FilingStatus,
  type ReconcileOutcome,
  type SendResult,
  SendService,
  type SendServiceShape,
} from "../../src/domain/send/api.js";

/** One call that reached the fake, with the arguments that matter to the tests. */
export type FakeSendCall =
  | { readonly op: "sendMessage"; readonly args: Parameters<SendServiceShape["sendMessage"]> }
  | { readonly op: "filingStatus"; readonly args: Parameters<SendServiceShape["filingStatus"]> }
  | { readonly op: "listFilings"; readonly query: FilingListQuery | undefined }
  | { readonly op: "getFiling"; readonly filingId: string }
  | { readonly op: "approve"; readonly admin: AuditActor; readonly filingId: string }
  | { readonly op: "reject"; readonly admin: AuditActor; readonly filingId: string; readonly reason: string | undefined }
  | { readonly op: "reconcileNow"; readonly admin: AuditActor; readonly filingId: string }
  | { readonly op: "markSent"; readonly admin: AuditActor; readonly filingId: string; readonly dmId: string }
  | { readonly op: "confirmNotSent"; readonly admin: AuditActor; readonly filingId: string };

/** What each operation answers; an operation left out dies when called. */
export interface FakeSendAnswers {
  readonly sendMessage?: ReturnType<SendServiceShape["sendMessage"]>;
  readonly filingStatus?: ReturnType<SendServiceShape["filingStatus"]>;
  readonly approve?: ReturnType<SendServiceShape["approve"]>;
  readonly reject?: ReturnType<SendServiceShape["reject"]>;
  readonly reconcileNow?: ReturnType<SendServiceShape["reconcileNow"]>;
  readonly markSent?: ReturnType<SendServiceShape["markSent"]>;
  readonly confirmNotSent?: ReturnType<SendServiceShape["confirmNotSent"]>;
  /** Replaces the default listing (the stored filings filtered by state, newest first, cut to the limit). */
  readonly listFilings?: ReturnType<SendServiceShape["listFilings"]>;
}

export interface FakeSendService {
  readonly service: SendServiceShape;
  readonly layer: Layer.Layer<SendService>;
  /** Every call, in order. */
  readonly calls: Array<FakeSendCall>;
}

const missing = (op: string) => Effect.die(`fake SendService.${op} has no answer in this test`);

/**
 * A SendService over a fixed list of filings and canned answers. It records every call and
 * changes nothing: the tabs and tools under test only render and map what it returns.
 */
export const fakeSendService = (filings: ReadonlyArray<Filing> = [], answers: FakeSendAnswers = {}): FakeSendService => {
  const calls: Array<FakeSendCall> = [];
  const record = <A, E>(call: FakeSendCall, answer: Effect.Effect<A, E> | undefined) =>
    Effect.suspend(() => {
      calls.push(call);
      return answer ?? missing(call.op);
    });
  const listed = (query: FilingListQuery | undefined) =>
    filings
      .filter((filing) => query?.states === undefined || query.states.includes(filing.state))
      .toSorted((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, query?.limit ?? 100);
  const service = SendService.of({
    sendMessage: (...args) => record({ op: "sendMessage", args }, answers.sendMessage),
    filingStatus: (...args) => record({ op: "filingStatus", args }, answers.filingStatus),
    listFilings: (query) => record({ op: "listFilings", query }, answers.listFilings ?? Effect.sync(() => listed(query))),
    getFiling: (filingId) =>
      record(
        { op: "getFiling", filingId },
        Effect.suspend(() => {
          const filing = filings.find((candidate) => candidate.id === filingId);
          return filing === undefined ? Effect.fail(new FilingNotFound({ filingId })) : Effect.succeed(filing);
        }),
      ),
    approve: (admin, filingId) => record({ op: "approve", admin, filingId }, answers.approve),
    reject: (admin, filingId, reason) => record({ op: "reject", admin, filingId, reason }, answers.reject),
    reconcileNow: (admin, filingId) => record({ op: "reconcileNow", admin, filingId }, answers.reconcileNow),
    markSent: (admin, filingId, dmId) => record({ op: "markSent", admin, filingId, dmId }, answers.markSent),
    confirmNotSent: (admin, filingId) => record({ op: "confirmNotSent", admin, filingId }, answers.confirmNotSent),
    reconcileRecovered: missing("reconcileRecovered"),
    expireDue: missing("expireDue"),
  });
  return { service, layer: Layer.succeed(SendService, service), calls };
};

export const BOX_ID = "box_AAAAAAAAAAAAAAAAAAAAAA";
export const REMOVED_BOX_ID = "box_RRRRRRRRRRRRRRRRRRRRRR";
export const SENDER_DB_ID = "aaa1111";
export const RECIPIENT = "xyz9876";
export const HASH = "a".repeat(64);

export const preview = (overrides: Partial<FilingPreview> = {}): FilingPreview => ({
  senderBox: { id: BOX_ID, dbId: SENDER_DB_ID, label: "Office" },
  recipient: RECIPIENT,
  annotation: "Invoice 2026/11",
  envelope: { senderRefNumber: "REF-1" },
  attachments: [
    { filename: "invoice.pdf", mimeType: "application/pdf", metaType: "main", size: 1234, sha256: "b".repeat(64) },
  ],
  totalBytes: 1234,
  contentHash: HASH,
  ...overrides,
});

/** A filing with plausible defaults; `id` and `state` matter most. */
export const filing = (overrides: Partial<Filing> & Pick<Filing, "id" | "state">): Filing => ({
  grantKey: "grant_1",
  boxId: BOX_ID,
  idempotencyKey: `key-${overrides.id}`,
  contentHash: HASH,
  tier: "none",
  recipientDbId: RECIPIENT,
  preview: preview(),
  dmId: undefined,
  isdsStatus: undefined,
  reason: undefined,
  reconcile: undefined,
  submittedAt: undefined,
  reconciledAt: undefined,
  createdAt: Date.UTC(2026, 10, 17, 8, 0),
  updatedAt: Date.UTC(2026, 10, 17, 8, 0),
  expiresAt: undefined,
  ...overrides,
});

export const sent = (result: SendResult): Effect.Effect<SendResult> => Effect.succeed(result);
export const status = (value: FilingStatus): Effect.Effect<FilingStatus> => Effect.succeed(value);
export const reconciled = (value: ReconcileOutcome): Effect.Effect<ReconcileOutcome> => Effect.succeed(value);
