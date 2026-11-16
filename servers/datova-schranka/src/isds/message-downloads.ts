import { Effect, Schema, SchemaTransformation } from "effect";
import { IsdsInvalidRequest } from "./errors.js";
import { MessageEnvelope, MessageHash, MessageId, XsMessageState } from "./models.js";
import { callIsds } from "./soap.js";
import { xmlElement } from "./xml.js";
import { XsBase64, XsBoolean, XsDateTime, XsInteger, xmlList } from "./xsd.js";

/**
 * Connectivity check and the read-only message download operations of ISDS v3.11
 * (dmBaseTypes.xsd; dm_operations.wsdl service "operations", dm_info.wsdl service "info").
 *
 * None of these operations triggers legal delivery (doručení) of a received message; listing
 * received messages (GetListOfReceivedMessages) does. Downloading a message still in state 4
 * (delivered to the box) or 5 (deemed delivered) with SignedMessageDownload, MessageDownload or
 * MessageEnvelopeDownload is refused with dmStatusCode 1222 (`IsdsStatusError`, classification
 * NotDelivered), so list received messages first (WS_manipulace_s_datovymi_zpravami.pdf p. 18).
 */

// --- Shared response pieces ----------------------------------------------------------------

/**
 * xs:base64Binary allows XML whitespace inside the lexical form (XSD Part 2 §3.2.16), so line
 * breaks some producers insert are removed before the strict base64 decode.
 */
const Base64Bytes = Schema.String.pipe(
  Schema.decodeTo(
    XsBase64,
    SchemaTransformation.transform({
      decode: (text: string) => text.replace(/[\t\n\r ]/g, ""),
      encode: (text: string) => text,
    }),
  ),
);


/**
 * tDmType (dmBaseTypes.xsd:904-914): a one-character message type code. In responses: K
 * contractual commercial, O reply commercial, G globally subsidised, Z restricted subsidised,
 * D externally subsidised, E EPZ, I initiating for a reply message, Y/X consumed/expired
 * initiating, A/B/C their subsidised counterparts; absent means a public (government) message.
 * The XSD restricts only the length, so the code is kept as text.
 */
const DmType = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(1)));

/** tFile's dmFileMetaType (dmBaseTypes.xsd:108-117). */
export const FileMetaType = Schema.Literals(["main", "enclosure", "signature", "meta"]);
export type FileMetaType = typeof FileMetaType.Type;

/**
 * The content of a dmXMLContent element (`xs:any processContents="skip"`, dmBaseTypes.xsd:80-88):
 * the inner XML exactly as ISDS sent it, between `<dmXMLContent>` and `</dmXMLContent>`, not
 * parsed and with entity references, CDATA sections, comments and surrounding whitespace kept
 * verbatim. Namespace declarations made on ancestors (dmXMLContent itself, the SOAP envelope)
 * are not part of it, so a prefix the content uses without declaring it must be resolved by
 * the caller. It is the XML as transmitted in this response, not the signed original: for
 * verifiable content use `downloadSignedMessage`.
 */
export const XmlContent = Schema.String;

/** The attributes of a dmFile (tFilesArray, dmBaseTypes.xsd:92-144). */
const fileAttributes = {
  dmMimeType: Schema.String,
  dmFileMetaType: FileMetaType,
  dmFileDescr: Schema.String,
  dmFileGuid: Schema.optional(Schema.String),
  dmUpFileGuid: Schema.optional(Schema.String),
  dmFormat: Schema.optional(Schema.String),
};

/**
 * One returned document (dmFile). tFile is a choice (dmBaseTypes.xsd:73-91), so a file carries
 * exactly one of `dmEncodedContent` (the decoded bytes) or `dmXMLContent` (see `XmlContent`);
 * narrow with `"dmEncodedContent" in file`.
 */
export const MessageFile = Schema.Union([
  Schema.Struct({ ...fileAttributes, dmEncodedContent: Base64Bytes }),
  Schema.Struct({ ...fileAttributes, dmXMLContent: XmlContent }),
]);
export type MessageFile = typeof MessageFile.Type;

/** One delivery event (tEvent, dmBaseTypes.xsd:171-181); both elements are nillable. */
export const DeliveryEvent = Schema.Struct({
  dmEventTime: Schema.optional(XsDateTime),
  dmEventDescr: Schema.optional(Schema.String),
});
export type DeliveryEvent = typeof DeliveryEvent.Type;

/** Elements that repeat in these responses; one occurrence must still decode as an array. */
const repeating: ReadonlySet<string> = new Set(["dmFile", "dmEvent"]);

/** Elements whose content is arbitrary XML, kept as the raw inner XML string (see `XmlContent`). */
const raw: ReadonlySet<string> = new Set(["dmXMLContent"]);

/**
 * tReturnedMessageEnvelope (dmBaseTypes.xsd:611-643): the envelope of a message with its
 * hash, qualified timestamp and delivery data, without the documents.
 */
export const ReturnedMessageEnvelope = Schema.Struct({
  dmDm: MessageEnvelope,
  dmHash: MessageHash,
  /** The qualified timestamp token (RFC 3161, DER), as received. */
  dmQTimestamp: Base64Bytes,
  dmDeliveryTime: Schema.optional(XsDateTime),
  dmAcceptanceTime: Schema.optional(XsDateTime),
  dmMessageStatus: XsMessageState,
  /** Total size of the documents in kB. */
  dmAttachmentSize: Schema.optional(XsInteger),
  dmType: Schema.optional(DmType),
  /** Whether this is a high-volume message (VODZ, documents uploaded separately). */
  dmVODZ: Schema.optional(XsBoolean),
  attsNum: Schema.optional(XsInteger),
  specMessFlag: Schema.optional(XsInteger),
});
export type ReturnedMessageEnvelope = typeof ReturnedMessageEnvelope.Type;

/** tReturnedMessage (dmBaseTypes.xsd:557-610): the complete message with decoded documents. */
export const ReturnedMessage = Schema.Struct({
  dmDm: Schema.Struct({ ...MessageEnvelope.fields, dmFiles: xmlList("dmFile", MessageFile) }),
  dmHash: MessageHash,
  /** The qualified timestamp token (RFC 3161, DER); nillable in tReturnedMessage. */
  dmQTimestamp: Schema.optional(Base64Bytes),
  dmDeliveryTime: Schema.optional(XsDateTime),
  dmAcceptanceTime: Schema.optional(XsDateTime),
  dmMessageStatus: XsMessageState,
  /** Total size of the documents in kB. */
  dmAttachmentSize: Schema.optional(XsInteger),
  dmType: Schema.optional(DmType),
  specMessFlag: Schema.optional(XsInteger),
});
export type ReturnedMessage = typeof ReturnedMessage.Type;

/**
 * tDelivery (dmBaseTypes.xsd:692-717): the delivery receipt data. tEventsArray declares one
 * dmEvent per sequence, but a receipt lists every event (acceptance, delivery, …), so dmEvent
 * is read as repeating; a single XSD-valid event decodes as a one-element array.
 */
export const DeliveryInfo = Schema.Struct({
  dmDm: MessageEnvelope,
  dmHash: MessageHash,
  /** The qualified timestamp token (RFC 3161, DER), as received. */
  dmQTimestamp: Base64Bytes,
  dmDeliveryTime: Schema.optional(XsDateTime),
  dmAcceptanceTime: Schema.optional(XsDateTime),
  dmMessageStatus: XsMessageState,
  dmEvents: xmlList("dmEvent", DeliveryEvent),
});
export type DeliveryInfo = typeof DeliveryInfo.Type;

/**
 * A signed message download: `dmSignature` holds the signed message (ZFO, a CMS SignedData
 * structure) exactly as ISDS sent it, base64-decoded and not parsed.
 */
export interface SignedMessage {
  readonly dmSignature: Uint8Array;
  /**
   * Status 0005: the timestamp server did not answer in time, so the message came back sealed
   * (CAdES-BES) but without the qualified timestamp (WS_manipulace_s_datovymi_zpravami.pdf
   * p. 64). The bytes are still the complete signed message; retry later for a timestamped one.
   * A third download of the same message within 20 minutes waits 50 s and fails with 3005.
   */
  readonly withoutQualifiedTimestamp: boolean;
}

// --- Input ---------------------------------------------------------------------------------

/** tIDMessInput (dmBaseTypes.xsd:866-870): the message to download. */
export const MessageIdInput = Schema.Struct({ dmID: MessageId });
export type MessageIdInput = typeof MessageIdInput.Type;

const decodeMessageIdInput = (operation: string, input: MessageIdInput) =>
  Schema.decodeEffect(MessageIdInput)(input).pipe(
    Effect.mapError((error) => new IsdsInvalidRequest({ operation, detail: error.message })),
  );

const messageIdRequest = (operation: string, dmID: string) => xmlElement(operation, [xmlElement("dmID", dmID)]);

// --- Operations ----------------------------------------------------------------------------

/**
 * DummyOperation (dm_operations.wsdl): a no-op that checks the connection and the login.
 * Succeeds with status 0000.
 */
export const ping = Effect.fn("Isds.ping")(function* () {
  yield* callIsds({
    service: "operations",
    operation: "DummyOperation",
    // xs:string, nillable (dmBaseTypes.xsd:977): an empty string is the simplest valid value.
    request: xmlElement("DummyOperation", ""),
    response: Schema.Struct({}),
    status: "dm",
  });
});

/**
 * MessageEnvelopeDownload (dm_info.wsdl): the envelope of a sent or received message, without
 * its documents. Does not trigger delivery; a received message in state 4/5 fails with 1222.
 */
export const downloadMessageEnvelope = Effect.fn("Isds.downloadMessageEnvelope")(function* (input: MessageIdInput) {
  const operation = "MessageEnvelopeDownload";
  const { dmID } = yield* decodeMessageIdInput(operation, input);
  const { response } = yield* callIsds({
    service: "info",
    operation,
    request: messageIdRequest(operation, dmID),
    response: Schema.Struct({ dmReturnedMessageEnvelope: ReturnedMessageEnvelope }),
    repeating,
    status: "dm",
  });
  return response.dmReturnedMessageEnvelope;
});

/**
 * MessageDownload (dm_operations.wsdl): a received message with its documents decoded. Does not
 * trigger delivery; a received message in state 4/5 fails with 1222. Every document is a
 * `MessageFile`; even a single dmFile decodes as a one-element array.
 */
export const downloadMessage = Effect.fn("Isds.downloadMessage")(function* (input: MessageIdInput) {
  const operation = "MessageDownload";
  const { dmID } = yield* decodeMessageIdInput(operation, input);
  const { response } = yield* callIsds({
    service: "operations",
    operation,
    request: messageIdRequest(operation, dmID),
    response: Schema.Struct({ dmReturnedMessage: ReturnedMessage }),
    repeating,
    raw,
    status: "dm",
  });
  return response.dmReturnedMessage;
});

/** Status 0005: SignedMessageDownload succeeded without the qualified timestamp (PDF p. 64). */
const withoutTimestampCode = "0005";

/**
 * SignedMessageDownload (dm_operations.wsdl): a received message as the signed ZFO (CMS), the
 * legally valid form for archiving. The bytes are returned exactly as received, never parsed.
 * Does not trigger delivery; a received message in state 4/5 fails with 1222. Status 0005 is a
 * success, reported as `withoutQualifiedTimestamp`; any other code besides 0000 fails.
 */
export const downloadSignedMessage = Effect.fn("Isds.downloadSignedMessage")(function* (input: MessageIdInput) {
  const operation = "SignedMessageDownload";
  const { dmID } = yield* decodeMessageIdInput(operation, input);
  const { response, status } = yield* callIsds({
    service: "operations",
    operation,
    request: messageIdRequest(operation, dmID),
    response: Schema.Struct({ dmSignature: Base64Bytes }),
    status: "dm",
    successCodes: new Set([withoutTimestampCode]),
  });
  return {
    dmSignature: response.dmSignature,
    withoutQualifiedTimestamp: status.code === withoutTimestampCode,
  } satisfies SignedMessage;
});

/**
 * GetDeliveryInfo (dm_info.wsdl): the delivery receipt data of a sent or received message,
 * with its delivery events. Does not trigger delivery.
 */
export const getDeliveryInfo = Effect.fn("Isds.getDeliveryInfo")(function* (input: MessageIdInput) {
  const operation = "GetDeliveryInfo";
  const { dmID } = yield* decodeMessageIdInput(operation, input);
  const { response } = yield* callIsds({
    service: "info",
    operation,
    request: messageIdRequest(operation, dmID),
    response: Schema.Struct({ dmDelivery: DeliveryInfo }),
    repeating,
    status: "dm",
  });
  return response.dmDelivery;
});
