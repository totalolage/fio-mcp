import { markUntrusted } from "@mcps/core/mcp/untrusted.js";
import { DateTime, Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import {
  type FilingNotFound,
  type FilingRef,
  type FilingStatus,
  type IsdsStatusSummary,
  type SendCaller,
  type SendEnvelope,
  type SendFailure,
  SendResult,
  type SendServiceShape,
} from "../domain/send/api.js";
import { createMessageMaxAttachmentBytes, createMessageMaxFiles, FileMetaType } from "../isds/create-message.js";

/**
 * The send tools: send_message and get_filing_status (scope isds:send). This module holds
 * their policy specs, their definitions (built for the current box enum) and handlers that
 * map SendService results and failures to tool output. The tool group (authorization,
 * auditing of refusals, output guarding) wraps them.
 */

const SEND_SCOPE = "isds:send";

/** What the tool policy needs: both tools need isds:send and take the `box` input. */
export const SEND_TOOL_SPECS = [
  { name: "send_message", scopes: [SEND_SCOPE] },
  { name: "get_filing_status", scopes: [SEND_SCOPE] },
] as const satisfies ReadonlyArray<{ readonly name: string; readonly scopes: ReadonlyArray<typeof SEND_SCOPE> }>;

export const SENT_NOTE =
  "sent means ISDS accepted the submission and assigned a dmID; it does not mean the message was delivered";

export const OUTCOME_UNKNOWN_GUIDANCE =
  "It is not known whether ISDS accepted this message. Do not resend it (not with a new idempotencyKey either): check get_filing_status later; the server re-checks the sent messages with ISDS, and otherwise an administrator resolves it.";

export const APPROVAL_INSTRUCTION =
  "Show the preview to the user (sender box, recipient, subject, envelope fields and every attachment with its size and SHA-256). Call send_message again with the same arguments plus approvalNonce set to this nonce only if they confirm, before expiresAt. Nothing is sent otherwise. If the nonce expired, call send_message again without approvalNonce for a fresh one.";

const QUEUED_GUIDANCE =
  "Nothing is sent yet: an administrator must approve this message in the server's admin console. Check get_filing_status for the outcome; calling send_message again with the same arguments returns this result.";

const IN_PROGRESS_GUIDANCE =
  "This message is being sent right now. Do not resend it; check get_filing_status in a moment.";

const ISDS_REJECTED_GUIDANCE =
  "ISDS refused the message, so it was not sent. Fix what the status names and send it with a new idempotencyKey.";

const EXPIRED_GUIDANCE =
  "The message expired before it was approved or sent; nothing was sent. To send it, call send_message with a new idempotencyKey.";

const NOT_SENT_GUIDANCE =
  "An administrator confirmed this message was not sent. To send it, call send_message again and use a new idempotencyKey.";

export const SEND_DESCRIPTION = `Send a message from a data box (datová schránka) through ISDS.
What happens depends on the tier the server's administrator set for the recipient on this box:
- none (the default): the message waits for an administrator to approve it in the admin console (result queued).
- approve: the result is approval_required with a preview and a single-use approvalNonce. Show the preview to the user; only if they confirm, call send_message again with the same arguments plus approvalNonce.
- full: the message is sent at once.
idempotencyKey (1-100 characters) is required: calling again with the same key and the same content returns the earlier result instead of sending twice; the same key with different content is refused. The recipient must be an active data box.
Results: sent, queued, approval_required, in_progress, outcome_unknown, refused, isds_rejected, expired, not_sent. ${SENT_NOTE}. On outcome_unknown do not resend: check get_filing_status later; an administrator resolves it.
Attachments: 1-100 files, at most 20,000,000 bytes in total after base64 decoding; metaType defaults to main for the first file and enclosure for the rest.`;

export const FILING_STATUS_DESCRIPTION = `Report the state of a message sent with send_message from this box under your authorization. Pass exactly one of filingId or idempotencyKey.
States: awaiting_approval (waits for your confirming call with approvalNonce), pending_admin (waits for an administrator), dispatching (being sent), sent (ISDS accepted it and assigned a dmID; not proof of delivery), isds_rejected, refused, admin_rejected, expired, outcome_unknown (not known whether ISDS accepted it: do not resend; this call re-checks with ISDS at most once a minute, and an administrator resolves it otherwise), not_sent.
guidance says what to do next.`;

// ---------------------------------------------------------------------------------------------
// Inputs

const MAX_KEY_LENGTH = 100;
/** No single file can exceed the decoded total, so its base64 text is bounded by that too. */
const MAX_BASE64_LENGTH = Math.ceil(createMessageMaxAttachmentBytes / 3) * 4;

const text = (max: number, description: string) =>
  Schema.String.pipe(Schema.check(Schema.isMaxLength(max))).annotate({ description });

const IdempotencyKey = Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, MAX_KEY_LENGTH)));

const Attachment = Schema.Struct({
  filename: Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 255))).annotate({
    description: "File name with an extension ISDS allows (e.g. invoice.pdf); ISDS derives the file type from it.",
  }),
  mimeType: Schema.String.annotate({ description: "MIME type, e.g. application/pdf." }),
  metaType: Schema.optional(FileMetaType).annotate({
    description: "main, enclosure, signature or meta; default main for the first file, enclosure for the rest.",
  }),
  contentBase64: Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_BASE64_LENGTH))).annotate({
    description: "The file content, base64.",
  }),
});

const LegalNumber = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/** send_message's inputs besides `box`. */
const SEND_MESSAGE_FIELDS = {
  idempotencyKey: IdempotencyKey.annotate({
    description: "Your key for this message (1-100 characters). The same key and content never send twice.",
  }),
  recipient: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9]{7}$/))).annotate({
    description: "The recipient's data box ID (dbID): 7 lowercase letters and digits.",
  }),
  annotation: text(255, "The message subject (dmAnnotation), at most 255 characters."),
  toHands: Schema.optional(text(30, "For the attention of (k rukám), at most 30 characters.")),
  recipientRefNumber: Schema.optional(text(50, "The recipient's reference number (naše č.j. of the recipient).")),
  senderRefNumber: Schema.optional(text(50, "Your reference number (č.j.).")),
  recipientIdent: Schema.optional(text(50, "The recipient's file mark (spisová značka).")),
  senderIdent: Schema.optional(text(50, "Your file mark (spisová značka).")),
  personalDelivery: Schema.optional(Schema.Boolean).annotate({
    description: "Delivery to own hands: only a user allowed to read such messages can open it.",
  }),
  allowSubstDelivery: Schema.optional(Schema.Boolean).annotate({
    description: "Whether deemed delivery applies (ISDS default true; only public authorities may set false).",
  }),
  legalTitleLaw: Schema.optional(LegalNumber).annotate({ description: "Legal title: law number." }),
  legalTitleYear: Schema.optional(LegalNumber).annotate({ description: "Legal title: year of the law." }),
  legalTitleSect: Schema.optional(Schema.String).annotate({ description: "Legal title: section." }),
  legalTitlePar: Schema.optional(Schema.String).annotate({ description: "Legal title: paragraph." }),
  legalTitlePoint: Schema.optional(Schema.String).annotate({ description: "Legal title: point." }),
  attachments: Schema.Array(Attachment)
    .pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(createMessageMaxFiles)))
    .annotate({ description: "1-100 files, at most 20,000,000 bytes in total after decoding." }),
  approvalNonce: Schema.optional(Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, MAX_KEY_LENGTH)))).annotate({
    description: "Only for the confirming call after approval_required: the nonce it returned.",
  }),
};

const FILING_STATUS_FIELDS = {
  filingId: Schema.optional(Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, MAX_KEY_LENGTH)))).annotate({
    description: "The filingId send_message returned.",
  }),
  idempotencyKey: Schema.optional(IdempotencyKey).annotate({
    description: "The idempotencyKey you sent the message with.",
  }),
};

export type SendMessageParams = Schema.Struct<typeof SEND_MESSAGE_FIELDS>["Type"];
export type FilingStatusParams = Schema.Struct<typeof FILING_STATUS_FIELDS>["Type"];

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
export type SendToolOutput = Record<string, unknown>;

/**
 * The definitions of both tools for one box input (the enum of box labels) and the failure
 * every datova-schranka tool declares.
 */
export const makeSendTools = <Box extends Schema.Top, Failure extends Schema.Top>(box: Box, failure: Failure) => ({
  send_message: Tool.make("send_message", {
    description: SEND_DESCRIPTION,
    parameters: Schema.Struct({ box, ...SEND_MESSAGE_FIELDS }),
    success: JsonObject,
    failure,
    failureMode: "error",
  })
    .annotate(Tool.Title, "Send a data box message")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Strict, true),
  get_filing_status: Tool.make("get_filing_status", {
    description: FILING_STATUS_DESCRIPTION,
    parameters: Schema.Struct({ box, ...FILING_STATUS_FIELDS }),
    success: JsonObject,
    failure,
    failureMode: "error",
  })
    .annotate(Tool.Title, "Status of a sent data box message")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Strict, true),
});

// ---------------------------------------------------------------------------------------------
// Failures

/** A handler failure as the text of the tool's error result (the tool group wraps it). */
export class SendToolFailure extends Schema.TaggedError<SendToolFailure>()("SendToolFailure", {
  text: Schema.String,
}) {
  override get message(): string {
    return this.text;
  }
}

const failureText = (error: SendFailure | FilingNotFound): string => {
  switch (error._tag) {
    case "SendUnavailable":
      // The detail can carry ISDS text (e.g. why the recipient could not be checked).
      return `Nothing was sent or changed: ${markUntrusted(error.detail)} It is safe to call again later with the same arguments.`;
    case "DomainStoreError":
      return "The server could not read or write its filing records. Call again later with the same arguments and the same idempotencyKey (it never sends twice), or check get_filing_status first.";
    case "FilingNotFound":
      return "No filing matches on this box for your authorization.";
  }
};

const fail = (error: SendFailure | FilingNotFound) => new SendToolFailure({ text: failureText(error) });

// ---------------------------------------------------------------------------------------------
// Outputs

const iso = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));
const optionalIso = (millis: number | undefined) => (millis === undefined ? undefined : iso(millis));

/** ISDS's status text is the ISDS server's, so it is marked for the output guard. */
const statusOutput = (status: IsdsStatusSummary): SendToolOutput => ({
  code: status.code,
  message: markUntrusted(status.message),
  classification: status.classification,
});

/** The defined fields only, so absent values stay out of the JSON. */
const defined = (fields: Record<string, unknown>): SendToolOutput =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

export const sendResultOutput: (result: SendResult) => SendToolOutput = SendResult.$match({
  Sent: ({ filingId, dmID }) => ({ result: "sent", filingId, dmID, note: SENT_NOTE }),
  Queued: ({ filingId }) => ({ result: "queued", filingId, state: "pending_admin", guidance: QUEUED_GUIDANCE }),
  ApprovalRequired: ({ filingId, nonce, preview, expiresAt }) => ({
    result: "approval_required",
    filingId,
    nonce,
    expiresAt: iso(expiresAt),
    preview,
    instruction: APPROVAL_INSTRUCTION,
  }),
  InProgress: ({ filingId }) => ({ result: "in_progress", filingId, guidance: IN_PROGRESS_GUIDANCE }),
  OutcomeUnknown: ({ filingId }) => ({ result: "outcome_unknown", filingId, guidance: OUTCOME_UNKNOWN_GUIDANCE }),
  Refused: ({ reason, filingId }) => defined({ result: "refused", reason, filingId }),
  IsdsRejected: ({ filingId, status }) => ({
    result: "isds_rejected",
    filingId,
    status: statusOutput(status),
    guidance: ISDS_REJECTED_GUIDANCE,
  }),
  Expired: ({ filingId }) => ({ result: "expired", filingId, guidance: EXPIRED_GUIDANCE }),
  NotSent: ({ filingId }) => ({ result: "not_sent", filingId, guidance: NOT_SENT_GUIDANCE }),
});

export const filingStatusOutput = ({ filing, guidance }: FilingStatus): SendToolOutput =>
  defined({
    filingId: filing.id,
    idempotencyKey: filing.idempotencyKey,
    state: filing.state,
    tier: filing.tier,
    recipient: filing.recipientDbId,
    contentHash: filing.contentHash,
    dmID: filing.dmId,
    isdsStatus: filing.isdsStatus === undefined ? undefined : statusOutput(filing.isdsStatus),
    reason: filing.reason,
    createdAt: iso(filing.createdAt),
    submittedAt: optionalIso(filing.submittedAt),
    updatedAt: iso(filing.updatedAt),
    expiresAt: optionalIso(filing.expiresAt),
    reconciledAt: optionalIso(filing.reconciledAt),
    guidance,
    note: filing.state === "sent" ? SENT_NOTE : undefined,
  });


// ---------------------------------------------------------------------------------------------
// Handlers

const envelopeOf = (params: SendMessageParams): SendEnvelope =>
  defined({
    toHands: params.toHands,
    recipientRefNumber: params.recipientRefNumber,
    senderRefNumber: params.senderRefNumber,
    recipientIdent: params.recipientIdent,
    senderIdent: params.senderIdent,
    personalDelivery: params.personalDelivery,
    allowSubstDelivery: params.allowSubstDelivery,
    legalTitleLaw: params.legalTitleLaw,
    legalTitleYear: params.legalTitleYear,
    legalTitleSect: params.legalTitleSect,
    legalTitlePar: params.legalTitlePar,
    legalTitlePoint: params.legalTitlePoint,
  });

/** send_message on the authorized box `boxId` (the tool group resolved the label). */
export const sendMessageHandler = (
  service: SendServiceShape,
  caller: SendCaller,
  boxId: string,
  params: SendMessageParams,
): Effect.Effect<SendToolOutput, SendToolFailure> =>
  service
    .sendMessage(caller, {
      boxId,
      idempotencyKey: params.idempotencyKey,
      recipient: params.recipient,
      annotation: params.annotation,
      envelope: envelopeOf(params),
      attachments: params.attachments.map((attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        metaType: attachment.metaType,
        contentBase64: attachment.contentBase64,
      })),
      approvalNonce: params.approvalNonce,
    })
    .pipe(Effect.map(sendResultOutput), Effect.mapError(fail));

const refOf = (params: FilingStatusParams): FilingRef | undefined => {
  if (params.filingId !== undefined && params.idempotencyKey === undefined) return { filingId: params.filingId };
  if (params.idempotencyKey !== undefined && params.filingId === undefined) {
    return { idempotencyKey: params.idempotencyKey };
  }
  return undefined;
};

/** get_filing_status on the authorized box `boxId`. */
export const filingStatusHandler = (
  service: SendServiceShape,
  caller: SendCaller,
  boxId: string,
  params: FilingStatusParams,
): Effect.Effect<SendToolOutput, SendToolFailure> => {
  const ref = refOf(params);
  return ref === undefined
    ? Effect.fail(new SendToolFailure({ text: "Pass exactly one of filingId or idempotencyKey." }))
    : service.filingStatus(caller, boxId, ref).pipe(Effect.map(filingStatusOutput), Effect.mapError(fail));
};

