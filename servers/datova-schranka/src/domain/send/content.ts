/**
 * What a send request carries, checked and fixed before anything is stored or sent: the
 * CreateMessage input (validated by the isds client's own Schema and size limit), the
 * byte-free preview stored as preview_json, the content hash that binds a filing to its
 * content, the reconcile hints, and the payload serialisation sealed into payload_sealed.
 *
 * Refusal reasons are shown to the caller. They name the offending field or attachment
 * (index and filename) and never echo attachment content.
 */
import { createHash } from "node:crypto";
import { type DateTime, Effect, Schema, SchemaIssue } from "effect";
import { CreateMessageInput, checkAttachmentSize } from "../../isds/create-message.js";
import type { ReconcileSentMessageInput } from "../../isds/reconcile.js";
import { characterCount } from "../../isds/xsd.js";
import type { Box } from "../boxes.js";
import { isDataBoxId } from "../ids.js";
import type { FilingPreview, PreviewAttachment, SendAttachment, SendEnvelope, SendMessageRequest } from "./api.js";

/** A request the send service refuses before storing anything (SendResult.Refused, no filing). */
export class InvalidSendRequest extends Schema.TaggedError<InvalidSendRequest>()("InvalidSendRequest", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Invalid send request: ${this.reason}`;
  }
}

/** A sealed filing payload that no longer decodes to a valid CreateMessageInput. */
export class CorruptPayload extends Schema.TaggedError<CorruptPayload>()("CorruptPayload", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `The stored filing payload is corrupt: ${this.reason}`;
  }
}

/**
 * What a reconcile after an unknown outcome matches on; maps 1:1 onto
 * ReconcileSentMessageInput (see {@link reconcileInputOf}). submittedAt comes from the filing.
 */
export interface ReconcileHints {
  readonly recipient: string;
  readonly annotation: string;
  readonly senderRefNumber?: string | undefined;
  readonly senderIdent?: string | undefined;
  readonly totalBytes: number;
}

export interface NormalisedMessage {
  readonly createInput: CreateMessageInput;
  readonly preview: FilingPreview;
  readonly contentHash: string;
  readonly hints: ReconcileHints;
}

export const IDEMPOTENCY_KEY_MAX_LENGTH = 100;

/** Each SendEnvelope field and the CreateMessage field of the same name. */
const ENVELOPE_FIELDS = {
  allowSubstDelivery: "dmAllowSubstDelivery",
  legalTitleLaw: "dmLegalTitleLaw",
  legalTitlePar: "dmLegalTitlePar",
  legalTitlePoint: "dmLegalTitlePoint",
  legalTitleSect: "dmLegalTitleSect",
  legalTitleYear: "dmLegalTitleYear",
  personalDelivery: "dmPersonalDelivery",
  recipientIdent: "dmRecipientIdent",
  recipientRefNumber: "dmRecipientRefNumber",
  senderIdent: "dmSenderIdent",
  senderRefNumber: "dmSenderRefNumber",
  toHands: "dmToHands",
} as const satisfies { readonly [K in keyof Required<SendEnvelope>]: keyof CreateMessageInput };

const ENVELOPE_KEYS = (Object.keys(ENVELOPE_FIELDS) as Array<keyof SendEnvelope>).sort();

/** Request field names for the CreateMessageInput fields a schema failure can point at. */
const REQUEST_FIELDS: Readonly<Record<string, string>> = {
  dbIDRecipient: "recipient",
  dmAnnotation: "annotation",
  dmFiles: "attachments",
  ...Object.fromEntries(Object.entries(ENVELOPE_FIELDS).map(([field, dmField]) => [dmField, `envelope.${field}`])),
};

const FILE_FIELDS: Readonly<Record<string, string>> = {
  content: "contentBase64",
  dmMimeType: "mimeType",
  dmFileMetaType: "metaType",
  dmFileDescr: "filename",
};

/** The known envelope fields that are set, in sorted key order; anything else is dropped. */
const normaliseEnvelope = (envelope: SendEnvelope): SendEnvelope => {
  const normalised: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEYS) {
    if (envelope[key] !== undefined) normalised[key] = envelope[key];
  }
  return normalised as SendEnvelope;
};

/**
 * Decodes strict canonical standard base64 (RFC 4648 §4 with padding, no whitespace), else
 * undefined. Node's decoder is lenient (it skips whitespace and unknown characters, accepts
 * the url-safe alphabet and missing padding, ignores trailing bits), so the text must
 * re-encode to itself; that rejects every other form. No regex: on a 20 MB text a repeated
 * group overflows the regex engine's stack.
 */
const decodeCanonicalBase64 = (text: string): Uint8Array | undefined => {
  if (text.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(text, "base64");
  // A copy, so the content never shares memory with Node's Buffer pool.
  return bytes.toString("base64") === text ? new Uint8Array(bytes) : undefined;
};

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

const sha256Hex = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");

const attachmentName = (index: number, attachments: ReadonlyArray<SendAttachment>): string =>
  `attachments[${index}] (${JSON.stringify(attachments[index]?.filename ?? "")})`;

/**
 * Formats schema issues without their input: a wrong-typed value could be anything the caller
 * sent, so its leaf message names the problem only. Check messages never carry the input.
 */
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => (issue._tag === "InvalidType" ? "has the wrong type" : SchemaIssue.defaultLeafHook(issue)),
});

const firstIssue = (error: Schema.SchemaError): { readonly path: ReadonlyArray<PropertyKey>; readonly message: string } => {
  const issue = formatIssue(error.issue).issues[0];
  const path = (issue?.path ?? []).map((segment) =>
    typeof segment === "object" && segment !== null ? segment.key : segment,
  );
  return { path, message: issue?.message ?? "is invalid" };
};

const requestReason = (error: Schema.SchemaError, attachments: ReadonlyArray<SendAttachment>): string => {
  const { path, message } = firstIssue(error);
  const [head, index, field] = path;
  if (head === "dmFiles" && typeof index === "number") {
    const name = attachmentName(index, attachments);
    return field === undefined ? `${name}: ${message}` : `${name} ${FILE_FIELDS[String(field)] ?? String(field)}: ${message}`;
  }
  return head === undefined ? `message: ${message}` : `${REQUEST_FIELDS[String(head)] ?? String(head)}: ${message}`;
};

const decodeCreateInput = Schema.decodeUnknownEffect(CreateMessageInput);

/** Sorts object keys recursively and drops undefined values; array order is kept. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return Object.fromEntries(keys.map((key) => [key, canonical(record[key])]));
};

/**
 * The content hash: sha256 hex of the canonical JSON (sorted keys, undefined dropped) of
 * {v: 1, box, recipient, annotation, envelope, attachments: [{filename, mimeType, metaType,
 * size, sha256}]}, attachment order kept. Covers everything ISDS would receive, and the sender
 * box id; not the idempotency key, the approval nonce, or the box's dbId and label. Takes a
 * preview so a stored preview_json can be checked against its own contentHash.
 */
export const contentHashOf = (
  preview: Pick<FilingPreview, "senderBox" | "recipient" | "annotation" | "envelope" | "attachments">,
): string =>
  sha256Hex(
    JSON.stringify(
      canonical({
        v: 1,
        box: preview.senderBox.id,
        recipient: preview.recipient,
        annotation: preview.annotation,
        envelope: normaliseEnvelope(preview.envelope),
        attachments: preview.attachments.map((attachment) => ({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          metaType: attachment.metaType,
          size: attachment.size,
          sha256: attachment.sha256,
        })),
      }),
    ),
  );

/** The reconcile hints of a filing, from its (stored) preview. */
export const reconcileHintsOf = (preview: FilingPreview): ReconcileHints => ({
  recipient: preview.recipient,
  annotation: preview.annotation,
  ...(preview.envelope.senderRefNumber === undefined ? {} : { senderRefNumber: preview.envelope.senderRefNumber }),
  ...(preview.envelope.senderIdent === undefined ? {} : { senderIdent: preview.envelope.senderIdent }),
  totalBytes: preview.totalBytes,
});

/** The reconcileSentMessage input for a filing submitted at `submittedAt`. */
export const reconcileInputOf = (hints: ReconcileHints, submittedAt: DateTime.Utc): ReconcileSentMessageInput => ({
  submittedAt,
  dbIDRecipient: hints.recipient,
  dmAnnotation: hints.annotation,
  ...(hints.senderRefNumber === undefined ? {} : { dmSenderRefNumber: hints.senderRefNumber }),
  ...(hints.senderIdent === undefined ? {} : { dmSenderIdent: hints.senderIdent }),
  expectedAttachmentBytes: hints.totalBytes,
});

const invalid = (reason: string) => new InvalidSendRequest({ reason });

/**
 * Checks a send request and derives everything the send service stores and sends. Own rules
 * first (idempotencyKey 1–100 characters, recipient a data box ID, attachment content strict
 * canonical base64 and not empty), then the isds CreateMessageInput Schema (field lengths, XML
 * text, 1–100 attachments) and the 20,000,000-byte total. Zero-byte attachments are refused:
 * the isds client would send them, but an empty attachment is almost certainly a caller
 * mistake and ISDS behaviour for one is undocumented.
 */
export const normaliseRequest = Effect.fn("SendContent.normaliseRequest")(function* (
  request: SendMessageRequest,
  senderBox: Box,
) {
  const keyLength = characterCount(request.idempotencyKey);
  if (keyLength < 1 || keyLength > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return yield* invalid(`idempotencyKey: must be 1–${IDEMPOTENCY_KEY_MAX_LENGTH} characters, got ${keyLength}`);
  }
  if (!isDataBoxId(request.recipient)) {
    return yield* invalid(
      `recipient: ${JSON.stringify(request.recipient)} is not a data box ID (7 lowercase letters and digits)`,
    );
  }
  const contents: Array<Uint8Array> = [];
  for (const [index, attachment] of request.attachments.entries()) {
    const content = decodeCanonicalBase64(attachment.contentBase64);
    if (content === undefined) {
      return yield* invalid(
        `${attachmentName(index, request.attachments)}: contentBase64 is not canonical standard base64 ` +
          `(A–Z, a–z, 0–9, "+", "/", "=" padding, no whitespace)`,
      );
    }
    if (content.byteLength === 0) {
      return yield* invalid(`${attachmentName(index, request.attachments)}: is empty (0 bytes)`);
    }
    contents.push(content);
  }

  const envelope = normaliseEnvelope(request.envelope);
  const fields: Record<string, unknown> = {
    dbIDRecipient: request.recipient,
    dmAnnotation: request.annotation,
    dmFiles: request.attachments.map((attachment, index) => ({
      content: contents[index],
      dmMimeType: attachment.mimeType,
      dmFileMetaType: attachment.metaType ?? (index === 0 ? "main" : "enclosure"),
      dmFileDescr: attachment.filename,
    })),
  };
  for (const [key, value] of Object.entries(envelope)) fields[ENVELOPE_FIELDS[key as keyof SendEnvelope]] = value;
  const createInput = yield* decodeCreateInput(fields).pipe(
    Effect.mapError((error) => invalid(requestReason(error, request.attachments))),
  );
  const totalBytes = yield* checkAttachmentSize(createInput.dmFiles).pipe(
    Effect.mapError((error) =>
      invalid(`attachments: ${error.totalBytes} bytes in total, over the limit of ${error.limitBytes} bytes`),
    ),
  );

  const attachments: ReadonlyArray<PreviewAttachment> = createInput.dmFiles.map((file) => ({
    filename: file.dmFileDescr,
    mimeType: file.dmMimeType,
    metaType: file.dmFileMetaType,
    size: file.content.byteLength,
    sha256: sha256Hex(file.content),
  }));
  const content = {
    senderBox: { id: senderBox.id, dbId: senderBox.dbId, label: senderBox.label },
    recipient: request.recipient,
    annotation: request.annotation,
    envelope,
    attachments,
  };
  const contentHash = contentHashOf(content);
  const preview: FilingPreview = { ...content, totalBytes, contentHash };
  return { createInput, preview, contentHash, hints: reconcileHintsOf(preview) } satisfies NormalisedMessage;
});

/** Serialises a CreateMessageInput for sealing: JSON with file contents as standard base64. */
export const encodePayload = (createInput: CreateMessageInput): string =>
  JSON.stringify({
    ...createInput,
    dmFiles: createInput.dmFiles.map((file) => ({ ...file, content: toBase64(file.content) })),
  });

const decodePayloadJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(CreateMessageInput)));

/** Parses an {@link encodePayload} text and re-validates it through the CreateMessageInput Schema. */
export const decodePayload = Effect.fn("SendContent.decodePayload")(function* (text: string) {
  return yield* decodePayloadJson(text).pipe(
    Effect.mapError((error) => {
      const { path, message } = firstIssue(error);
      const at = path.map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`)).join("");
      return new CorruptPayload({ reason: at === "" ? message : `${at.replace(/^\./, "")}: ${message}` });
    }),
  );
});
