import { createHash } from "node:crypto";
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import type { IsdsClientShape } from "../isds/client.js";
import type { CheckDataBoxResult, FindDataBoxesQuery, FindDataBoxesResult } from "../isds/databox.js";
import { type IsdsCallError, type IsdsInvalidRequest, IsdsStatusError, IsdsTimeoutError } from "../isds/errors.js";
import type {
  DeliveryInfo,
  FileMetaType,
  MessageFile,
  ReturnedMessage,
  ReturnedMessageEnvelope,
} from "../isds/message-downloads.js";
import type {
  ListMessagesInput,
  MessageRecord,
  MessageStateChange,
  MessageStateChangesInput,
} from "../isds/message-lists.js";
import type { MessageEnvelope } from "../isds/models.js";
import { type AuditActor, type AuditFinalOutcome, AuditLog, type AuditLogShape } from "./audit-log.js";
import { type BoxClientError, BoxClients } from "./box-clients.js";
import { BoxRegistry } from "./boxes.js";
import { DomainConfig, type DomainConfigShape } from "./config.js";
import { type DomainStoreError, InvalidIdentifier } from "./errors.js";
import { isDataBoxId, isMessageId } from "./ids.js";
import { type StoredZfo, ZfoStore, type ZfoWriteFailed } from "./zfo-store.js";

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

// --- Implementation ------------------------------------------------------------------------

const RECEIVED_NOTE =
  "Listing received messages legally delivered every eligible message in the box, whatever the filters, offset and limit; the returned records are not necessarily the complete delivered set.";

interface Tagged {
  readonly _tag: string;
}

/** Audit detail of a failure: its tag, the ISDS status code, or whether a timed-out request was sent. No message text. */
const failureDetail = (error: Tagged): object => {
  if (error instanceof IsdsStatusError) {
    return { error: error._tag, code: error.code, classification: error.classification };
  }
  if (error instanceof IsdsTimeoutError) return { error: error._tag, requestSent: error.requestSent };
  return { error: error._tag };
};

/** A timeout after the request was sent may have taken effect: "uncertain". */
const failureOutcome = (error: Tagged): AuditFinalOutcome =>
  error instanceof IsdsTimeoutError && error.requestSent ? "uncertain" : "error";

const outcomeOf = <A, E extends Tagged>(
  exit: Exit.Exit<A, E>,
  base: object,
  okDetail: (value: A) => object,
): readonly [AuditFinalOutcome, object] => {
  if (Exit.isSuccess(exit)) return ["ok", { ...base, ...okDetail(exit.value) }];
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isSome(error)) return [failureOutcome(error.value), { ...base, ...failureDetail(error.value) }];
  if (Cause.hasDies(exit.cause)) return ["error", { ...base, error: "Defect" }];
  return ["uncertain", { ...base, error: "Interrupted" }];
};

/**
 * Writes the intent (`detail`), runs `effect` only if that succeeded, then the outcome: the
 * detail merged with `okDetail` of the value, or with the failure's tag and status code. The
 * outcome is written on every exit (interruption → "uncertain"); a failing outcome write is
 * logged and the call's own result kept (the row stays "started").
 * Local stand-in for audit-log.ts's `audited` (same semantics); consolidate once both land.
 */
const audited = <A, E extends Tagged>(
  audit: AuditLogShape,
  actor: AuditActor,
  action: string,
  boxId: string,
  detail: object,
  effect: Effect.Effect<A, E>,
  okDetail: (value: A) => object,
): Effect.Effect<A, E | DomainStoreError> =>
  Effect.flatMap(audit.start({ actor, action, boxId, detail }), (id) =>
    Effect.uninterruptibleMask((restore) =>
      restore(effect).pipe(
        Effect.onExit((exit) => {
          const [outcome, finalDetail] = outcomeOf(exit, detail, okDetail);
          return audit
            .finish(id, outcome, finalDetail)
            .pipe(Effect.catch((error) => Effect.logWarning("datova-schranka: audit outcome not written", error)));
        }),
      ),
    ),
  );

const requireMessageId = (dmId: string): Effect.Effect<void, InvalidIdentifier> =>
  isMessageId(dmId) ? Effect.void : Effect.fail(new InvalidIdentifier({ kind: "messageId", rule: "1-20 digits" }));

const requireDataBoxId = (dbId: string): Effect.Effect<void, InvalidIdentifier> =>
  isDataBoxId(dbId)
    ? Effect.void
    : Effect.fail(new InvalidIdentifier({ kind: "dataBoxId", rule: "7 lowercase letters or digits" }));

/** 1222 (classified NotDelivered) → NotDeliveredYet; every other failure unchanged. */
const notDeliveredYet =
  (dmId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | NotDeliveredYet, R> =>
    Effect.mapError(
      effect,
      (error): E | NotDeliveredYet =>
        error instanceof IsdsStatusError && error.classification === "NotDelivered" ? new NotDeliveredYet({ dmId }) : error,
    );

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The document's bytes: dmEncodedContent as decoded, dmXMLContent as UTF-8. */
const contentOf = (file: MessageFile): Uint8Array =>
  "dmEncodedContent" in file ? file.dmEncodedContent : new TextEncoder().encode(file.dmXMLContent);

type InlineCaps = Pick<DomainConfigShape, "attachmentInlineMaxBytes" | "responseInlineMaxBytes">;

/**
 * In dmFiles order: inline while the attachment is within the per-attachment cap and the
 * inline total stays within the per-download cap; otherwise skipped, pointing at the ZFO.
 */
const toAttachments = (
  files: ReadonlyArray<MessageFile>,
  caps: InlineCaps,
  zfoRef: string,
): ReadonlyArray<DownloadedAttachment> => {
  let inlined = 0;
  return files.map((file, index): DownloadedAttachment => {
    const content = contentOf(file);
    const meta: AttachmentMeta = {
      index,
      filename: file.dmFileDescr,
      mimeType: file.dmMimeType,
      metaType: file.dmFileMetaType,
      size: content.byteLength,
      sha256: sha256Hex(content),
    };
    if (meta.size > caps.attachmentInlineMaxBytes) {
      return {
        _tag: "Skipped",
        ...meta,
        note: `Larger than the ${caps.attachmentInlineMaxBytes}-byte per-attachment inline limit; the content is in the stored signed message ${zfoRef}.`,
      };
    }
    if (inlined + meta.size > caps.responseInlineMaxBytes) {
      return {
        _tag: "Skipped",
        ...meta,
        note: `Would take this download over its ${caps.responseInlineMaxBytes}-byte per-download inline limit; the content is in the stored signed message ${zfoRef}.`,
      };
    }
    inlined += meta.size;
    return { _tag: "Inline", ...meta, content };
  });
};

/** MessageDownload then SignedMessageDownload, in one hold of the box. */
const fetchMessage = (client: IsdsClientShape, dmId: string) =>
  Effect.all([client.downloadMessage({ dmID: dmId }), client.downloadSignedMessage({ dmID: dmId })]);

const downloadDetail = (message: DownloadedMessage): object => ({
  attachments: message.attachments.map((attachment) => ({
    index: attachment.index,
    size: attachment.size,
    sha256: attachment.sha256,
    inline: attachment._tag === "Inline",
  })),
  zfo: message.zfo,
});

const makeReadService = Effect.gen(function* () {
  const clients = yield* BoxClients;
  const registry = yield* BoxRegistry;
  const audit = yield* AuditLog;
  const zfoStore = yield* ZfoStore;
  const config = yield* DomainConfig;

  const download = Effect.fn("ReadService.download")(function* (boxId: string, dmId: string) {
    const box = yield* registry.get(boxId);
    const [message, signed] = yield* clients.use(boxId, (client) => fetchMessage(client, dmId));
    const zfo = yield* zfoStore.write(box.dbId, dmId, signed.dmSignature);
    const { dmDm, dmQTimestamp: _timestamp, ...info } = message;
    const { dmFiles, ...envelope } = dmDm;
    const downloaded: DownloadedMessage = { envelope, info, attachments: toAttachments(dmFiles, config, zfo.ref), zfo };
    return downloaded;
  });

  const service: ReadServiceShape = {
    listReceivedMessages: Effect.fn("ReadService.listReceivedMessages")(function* (
      actor: AuditActor,
      boxId: string,
      input: ListMessagesInput,
    ) {
      const records = yield* audited(
        audit,
        actor,
        "list_received_messages",
        boxId,
        input,
        clients.use(boxId, (client) => client.listReceivedMessagesAndDeliver(input)),
        (found) => ({ records: found.length, dmIds: found.map((record) => record.dmID) }),
      );
      return { records, note: RECEIVED_NOTE };
    }),
    listSentMessages: Effect.fn("ReadService.listSentMessages")(function* (
      actor: AuditActor,
      boxId: string,
      input: ListMessagesInput,
    ) {
      return yield* audited(
        audit,
        actor,
        "list_sent_messages",
        boxId,
        input,
        clients.use(boxId, (client) => client.listSentMessages(input)),
        (found) => ({ records: found.length }),
      );
    }),
    getMessageEnvelope: Effect.fn("ReadService.getMessageEnvelope")(function* (
      actor: AuditActor,
      boxId: string,
      dmId: string,
    ) {
      yield* requireMessageId(dmId);
      return yield* audited(
        audit,
        actor,
        "get_message",
        boxId,
        { dmId },
        clients.use(boxId, (client) => client.downloadMessageEnvelope({ dmID: dmId })),
        () => ({}),
      ).pipe(notDeliveredYet(dmId));
    }),
    downloadMessage: Effect.fn("ReadService.downloadMessage")(function* (actor: AuditActor, boxId: string, dmId: string) {
      yield* requireMessageId(dmId);
      return yield* audited(audit, actor, "download_message", boxId, { dmId }, download(boxId, dmId), downloadDetail).pipe(
        notDeliveredYet(dmId),
      );
    }),
    getDeliveryInfo: Effect.fn("ReadService.getDeliveryInfo")(function* (actor: AuditActor, boxId: string, dmId: string) {
      yield* requireMessageId(dmId);
      return yield* audited(
        audit,
        actor,
        "get_delivery_info",
        boxId,
        { dmId },
        clients.use(boxId, (client) => client.getDeliveryInfo({ dmID: dmId })),
        (info) => ({ events: info.dmEvents.length }),
      ).pipe(notDeliveredYet(dmId));
    }),
    getMessageStateChanges: Effect.fn("ReadService.getMessageStateChanges")(function* (
      actor: AuditActor,
      boxId: string,
      input: MessageStateChangesInput,
    ) {
      return yield* audited(
        audit,
        actor,
        "get_message_state_changes",
        boxId,
        input,
        clients.use(boxId, (client) => client.getMessageStateChanges(input)),
        (changes) => ({ changes: changes.length }),
      );
    }),
    findDataBox: Effect.fn("ReadService.findDataBox")(function* (
      actor: AuditActor,
      boxId: string,
      query: FindDataBoxesQuery,
    ) {
      return yield* audited(
        audit,
        actor,
        "find_data_box",
        boxId,
        query,
        clients.use(boxId, (client) => client.findDataBoxes(query)),
        (result) => ({ outcome: result.outcome, boxes: result.boxes.length }),
      );
    }),
    checkDataBox: Effect.fn("ReadService.checkDataBox")(function* (actor: AuditActor, boxId: string, dbId: string) {
      yield* requireDataBoxId(dbId);
      return yield* audited(
        audit,
        actor,
        "check_data_box",
        boxId,
        { dbId },
        clients.use(boxId, (client) => client.checkDataBox({ dbID: dbId })),
        (result) => ({ dbState: result.dbState }),
      );
    }),
  };
  return service;
});

export class ReadService extends Context.Service<ReadService, ReadServiceShape>()("datova-schranka/ReadService") {
  /** Needs BoxClients, BoxRegistry, AuditLog, ZfoStore and DomainConfig. */
  static readonly Default = Layer.effect(ReadService, Effect.map(makeReadService, ReadService.of));
}
