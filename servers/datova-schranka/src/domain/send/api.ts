/**
 * The send side's public contract: what the MCP send tools, the admin filings tab and the
 * background tasks call. The implementation lives in ./service.ts (SendService.layer).
 *
 * "Sent" always means ISDS accepted the submission and assigned a dmID, not that the message
 * was delivered to the recipient.
 */
import { Context, Data, type Effect, Schema } from "effect";
import type { FileMetaType } from "../../isds/create-message.js";
import type { IsdsStatusClassification } from "../../isds/errors.js";
import type { AuditActor } from "../audit-log.js";
import type { DomainStoreError } from "../errors.js";
import type { FilingState } from "../migrations.js";
import type { RecipientTier } from "../recipient-tiers.js";

/** The OAuth caller of a send tool; grantId is the filing's grant_key. */
export interface SendCaller {
  readonly grantId: string;
  readonly clientId: string;
  readonly subject: string;
}

/** Optional envelope fields; each maps to the CreateMessage dm* field of the same name. */
export interface SendEnvelope {
  readonly toHands?: string | undefined;
  readonly recipientRefNumber?: string | undefined;
  readonly senderRefNumber?: string | undefined;
  readonly recipientIdent?: string | undefined;
  readonly senderIdent?: string | undefined;
  readonly personalDelivery?: boolean | undefined;
  readonly allowSubstDelivery?: boolean | undefined;
  readonly legalTitleLaw?: number | undefined;
  readonly legalTitleYear?: number | undefined;
  readonly legalTitleSect?: string | undefined;
  readonly legalTitlePar?: string | undefined;
  readonly legalTitlePoint?: string | undefined;
}

export interface SendAttachment {
  readonly filename: string;
  readonly mimeType: string;
  /** Default: the first attachment is "main", the rest "enclosure". */
  readonly metaType?: FileMetaType | undefined;
  readonly contentBase64: string;
}

export interface SendMessageRequest {
  /** The box resource id (box_…), already resolved from the label and authorised by the tool layer. */
  readonly boxId: string;
  /** 1–100 characters. */
  readonly idempotencyKey: string;
  /** Recipient dbID (7 characters). */
  readonly recipient: string;
  /** dmAnnotation, at most 255 characters. */
  readonly annotation: string;
  readonly envelope: SendEnvelope;
  readonly attachments: ReadonlyArray<SendAttachment>;
  readonly approvalNonce?: string | undefined;
}

export interface PreviewAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly metaType: FileMetaType;
  readonly size: number;
  readonly sha256: string;
}

/** Plaintext metadata shown to approvers and stored as preview_json; never attachment content. */
export interface FilingPreview {
  readonly senderBox: { readonly id: string; readonly dbId: string; readonly label: string };
  readonly recipient: string;
  readonly annotation: string;
  readonly envelope: SendEnvelope;
  readonly attachments: ReadonlyArray<PreviewAttachment>;
  readonly totalBytes: number;
  readonly contentHash: string;
}

export interface IsdsStatusSummary {
  readonly code: string;
  readonly message: string;
  readonly classification: IsdsStatusClassification;
}

/** The outcome of send_message (and of an admin approval). */
export type SendResult = Data.TaggedEnum<{
  Sent: { readonly filingId: string; readonly dmID: string };
  Queued: { readonly filingId: string };
  ApprovalRequired: {
    readonly filingId: string;
    readonly nonce: string;
    readonly preview: FilingPreview;
    /** Epoch milliseconds. */
    readonly expiresAt: number;
  };
  InProgress: { readonly filingId: string };
  OutcomeUnknown: { readonly filingId: string };
  Refused: { readonly reason: string; readonly filingId?: string | undefined };
  IsdsRejected: { readonly filingId: string; readonly status: IsdsStatusSummary };
  Expired: { readonly filingId: string };
  NotSent: { readonly filingId: string };
}>;
export const SendResult = Data.taggedEnum<SendResult>();

/** A filing as stored, decoded; payload and nonces are never part of it. */
export interface Filing {
  readonly id: string;
  readonly grantKey: string;
  readonly boxId: string;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly tier: RecipientTier;
  readonly state: FilingState;
  readonly recipientDbId: string;
  readonly preview: FilingPreview;
  readonly dmId: string | undefined;
  readonly isdsStatus: IsdsStatusSummary | undefined;
  readonly reason: string | undefined;
  /** Reconciliation record (last result, competitors, errors); JSON as stored. */
  readonly reconcile: unknown;
  readonly submittedAt: number | undefined;
  readonly reconciledAt: number | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | undefined;
}

export type FilingRef = { readonly filingId: string } | { readonly idempotencyKey: string };

export interface FilingStatus {
  readonly filing: Filing;
  /** What the caller should do next, in plain words (e.g. for outcome_unknown). */
  readonly guidance: string;
}

export type ReconcileOutcome = Data.TaggedEnum<{
  /** Reconciled to sent with this dmID. */
  Sent: { readonly dmID: string };
  /** Stays outcome_unknown; `detail` says why (not found, ambiguous, dmID linked, competitors, box removed). */
  StillUnknown: { readonly detail: string };
  /** The filing was not outcome_unknown (any more); nothing done. */
  NotApplicable: { readonly state: FilingState };
}>;
export const ReconcileOutcome = Data.taggedEnum<ReconcileOutcome>();

export interface FilingListQuery {
  readonly states?: ReadonlyArray<FilingState> | undefined;
  /** 1..500, default 100; newest (updated_at) first. */
  readonly limit?: number | undefined;
}

export class FilingNotFound extends Schema.TaggedError<FilingNotFound>()("FilingNotFound", {
  filingId: Schema.String,
}) {
  override get message(): string {
    return `No filing ${this.filingId}.`;
  }
}

/** An admin decision on a filing that is not (any more) in a state that allows it. */
export class FilingStateConflict extends Schema.TaggedError<FilingStateConflict>()("FilingStateConflict", {
  filingId: Schema.String,
  state: Schema.String,
  expected: Schema.String,
}) {
  override get message(): string {
    return `Filing ${this.filingId} is ${this.state}, not ${this.expected}.`;
  }
}

export class DmIdLinked extends Schema.TaggedError<DmIdLinked>()("DmIdLinked", {
  dmId: Schema.String,
  filingId: Schema.String,
}) {
  override get message(): string {
    return `Message ${this.dmId} is already linked to filing ${this.filingId}.`;
  }
}

/** A transient failure before anything changed (e.g. the recipient could not be checked); safe to retry. */
export class SendUnavailable extends Schema.TaggedError<SendUnavailable>()("SendUnavailable", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `Nothing was sent or changed: ${this.detail}`;
  }
}

export type SendFailure = DomainStoreError | SendUnavailable;

export interface SendServiceShape {
  /** send_message: audited once under "send_message". */
  readonly sendMessage: (caller: SendCaller, request: SendMessageRequest) => Effect.Effect<SendResult, SendFailure>;
  /** get_filing_status: the caller grant's filings on that box only; audited once. */
  readonly filingStatus: (
    caller: SendCaller,
    boxId: string,
    ref: FilingRef,
  ) => Effect.Effect<FilingStatus, FilingNotFound | SendFailure>;

  // Admin (filings tab). The tab checks the second factor before approve / markSent / confirmNotSent
  // and audits a refused second factor itself; each call below audits itself (actor admin).
  readonly listFilings: (query?: FilingListQuery) => Effect.Effect<ReadonlyArray<Filing>, DomainStoreError>;
  readonly getFiling: (filingId: string) => Effect.Effect<Filing, FilingNotFound | DomainStoreError>;
  readonly approve: (
    admin: AuditActor,
    filingId: string,
  ) => Effect.Effect<SendResult, FilingNotFound | FilingStateConflict | SendFailure>;
  readonly reject: (
    admin: AuditActor,
    filingId: string,
    reason?: string,
  ) => Effect.Effect<void, FilingNotFound | FilingStateConflict | DomainStoreError>;
  readonly reconcileNow: (
    admin: AuditActor,
    filingId: string,
  ) => Effect.Effect<ReconcileOutcome, FilingNotFound | SendFailure>;
  readonly markSent: (
    admin: AuditActor,
    filingId: string,
    dmId: string,
  ) => Effect.Effect<void, FilingNotFound | FilingStateConflict | DmIdLinked | SendFailure>;
  readonly confirmNotSent: (
    admin: AuditActor,
    filingId: string,
  ) => Effect.Effect<void, FilingNotFound | FilingStateConflict | DomainStoreError>;

  // Background (SendBackground).
  /** One reconciliation run over every outcome_unknown filing that was recovered at startup. */
  readonly reconcileRecovered: Effect.Effect<number, DomainStoreError>;
  /** Expires open filings past expires_at; returns how many. */
  readonly expireDue: Effect.Effect<number, DomainStoreError>;
}

export class SendService extends Context.Service<SendService, SendServiceShape>()("datova-schranka/SendService") {}
