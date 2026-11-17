import { Context, type Effect, Schema } from "effect";
import type { CheckDataBoxResult, FindDataBoxesQuery, FindDataBoxesResult } from "../isds/databox.js";
import type { IsdsCallError, IsdsInvalidRequest } from "../isds/errors.js";
import type { DeliveryInfo, FileMetaType, ReturnedMessage, ReturnedMessageEnvelope } from "../isds/message-downloads.js";
import type {
  ListMessagesInput,
  MessageRecord,
  MessageStateChange,
  MessageStateChangesInput,
} from "../isds/message-lists.js";
import type { MessageEnvelope } from "../isds/models.js";
import type { AuditActor } from "./audit-log.js";
import type { BoxClientError } from "./box-clients.js";
import type { DomainStoreError, InvalidIdentifier } from "./errors.js";
import type { StoredZfo, ZfoWriteFailed } from "./zfo-store.js";

/**
 * The isds:read operations on one box, through BoxClients (so serialised
 * per box). Results are domain values: ISDS text stays plain here and the
 * tool layer guards it. Every operation is audited here: intent
 * ("started") before its first ISDS call, the outcome after (timeouts
 * after the request was sent → "uncertain"), with the box id and the
 * actor; the tool layer must not write a second row for these calls.
 * If the intent cannot be written, ISDS is not called.
 */

/** 1222: the message is not legally delivered yet; the received list delivers it. */
export class NotDeliveredYet extends Schema.TaggedError<NotDeliveredYet>()("NotDeliveredYet", {
  dmId: Schema.String,
}) {
  override get message(): string {
    return `Message ${this.dmId} is not delivered yet; call list_received_messages first (listing received messages delivers them).`;
  }
}

/** What any read operation can fail with. */
export type ReadError = BoxClientError | IsdsCallError | IsdsInvalidRequest | InvalidIdentifier | DomainStoreError;

export interface ReceivedMessages {
  readonly records: ReadonlyArray<MessageRecord>;
  /** States that listing delivered every eligible message, and these records are not necessarily all of them. */
  readonly note: string;
}

interface AttachmentMeta {
  /** Position in dmFiles, from 0. */
  readonly index: number;
  /** dmFileDescr. */
  readonly filename: string;
  readonly mimeType: string;
  readonly metaType: FileMetaType;
  /** Decoded size in bytes (UTF-8 bytes for dmXMLContent). */
  readonly size: number;
  /** Hex SHA-256 of those bytes. */
  readonly sha256: string;
}

export interface InlineAttachment extends AttachmentMeta {
  readonly _tag: "Inline";
  readonly content: Uint8Array;
}

/** Over the per-attachment or the per-download cap: content only in the stored ZFO. */
export interface SkippedAttachment extends AttachmentMeta {
  readonly _tag: "Skipped";
  readonly note: string;
}

export type DownloadedAttachment = InlineAttachment | SkippedAttachment;

export interface DownloadedMessage {
  /** dmDm without dmFiles. */
  readonly envelope: MessageEnvelope;
  /** ReturnedMessage's other fields (hash, times, state, sizes), without the timestamp token. */
  readonly info: Omit<ReturnedMessage, "dmDm" | "dmQTimestamp">;
  readonly attachments: ReadonlyArray<DownloadedAttachment>;
  /** The signed message (SignedMessageDownload) as stored on the volume. */
  readonly zfo: StoredZfo;
}

export interface ReadServiceShape {
  /** GetListOfReceivedMessages: LEGALLY DELIVERS every eligible message in the box, whatever the filters. */
  readonly listReceivedMessages: (
    actor: AuditActor,
    boxId: string,
    input: ListMessagesInput,
  ) => Effect.Effect<ReceivedMessages, ReadError>;
  readonly listSentMessages: (
    actor: AuditActor,
    boxId: string,
    input: ListMessagesInput,
  ) => Effect.Effect<ReadonlyArray<MessageRecord>, ReadError>;
  readonly getMessageEnvelope: (
    actor: AuditActor,
    boxId: string,
    dmId: string,
  ) => Effect.Effect<ReturnedMessageEnvelope, ReadError | NotDeliveredYet>;
  /** MessageDownload, then SignedMessageDownload (stored as ZFO). Attachments over the caps are skipped with a note. */
  readonly downloadMessage: (
    actor: AuditActor,
    boxId: string,
    dmId: string,
  ) => Effect.Effect<DownloadedMessage, ReadError | NotDeliveredYet | ZfoWriteFailed>;
  readonly getDeliveryInfo: (
    actor: AuditActor,
    boxId: string,
    dmId: string,
  ) => Effect.Effect<DeliveryInfo, ReadError | NotDeliveredYet>;
  readonly getMessageStateChanges: (
    actor: AuditActor,
    boxId: string,
    input: MessageStateChangesInput,
  ) => Effect.Effect<ReadonlyArray<MessageStateChange>, ReadError>;
  /** Directory search with the box's credentials (FindDataBox2); does not deliver anything. */
  readonly findDataBox: (
    actor: AuditActor,
    boxId: string,
    query: FindDataBoxesQuery,
  ) => Effect.Effect<FindDataBoxesResult, ReadError>;
  readonly checkDataBox: (
    actor: AuditActor,
    boxId: string,
    dbId: string,
  ) => Effect.Effect<CheckDataBoxResult, ReadError>;
}

export class ReadService extends Context.Service<ReadService, ReadServiceShape>()("datova-schranka/ReadService") {}
