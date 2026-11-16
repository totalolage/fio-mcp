import { Buffer } from "node:buffer";
import { Effect, Schema } from "effect";
import { IsdsInvalidRequest, IsdsInvalidResponse, IsdsMessageTooLarge } from "./errors.js";
import { DataBoxId, MessageId } from "./models.js";
import { callIsds, type IsdsOperation, type IsdsOperationError, type IsdsResponseStatus } from "./soap.js";
import { type XmlElement, xmlElement } from "./xml.js";
import { XmlText, xmlTextMax } from "./xsd.js";

/**
 * CreateMessage (dm_operations.wsdl, service `operations`): sends one ordinary data message.
 * Sources: dmBaseTypes.xsd v3.11 (tMessageCreateInput :645-676, gMessageEnvelopeSub :367-488,
 * tFilesArray/tFile :73-144, tMessageCreateOutput :677-683) and WS_manipulace_s_datovymi_zpravami.pdf
 * §2.1 (pp. 42-46).
 */

const operation = "CreateMessage";
const xsiNamespace = "http://www.w3.org/2001/XMLSchema-instance";

/**
 * The attachment limit of an ordinary message: its content must not "překročit 20 MB" (exceed;
 * PDF §2.1.2, p. 45; the overview on p. 42 says "menšími než 20 MB", less than). The PDF defines neither the
 * unit (10^6 or 2^20) nor what is measured (decoded bytes, base64 or the whole request), so this
 * uses the smaller reading: 20,000,000 bytes of decoded attachment content in total. A message the
 * server would accept between 20,000,000 and 20,971,520 bytes is refused locally. This is a
 * conservative local policy, not a server threshold anyone has measured: ISDS may enforce a
 * different figure or count differently.
 */
export const createMessageMaxAttachmentBytes = 20_000_000;

/** At most 100 attachments per message (PDF §2.1.2, p. 45; the XSD leaves dmFile unbounded). */
export const createMessageMaxFiles = 100;

const Integer = Schema.Finite.pipe(Schema.check(Schema.isInt()));


/**
 * dmType values a sender may set (tDmType, dmBaseTypes.xsd:904-920; PDF §2.1, pp. 42-43). The XSD
 * restricts the attribute only to one character; these are the documented input values:
 * - `V`: public (non-commercial) message, the default when absent.
 * - `K`: commercial (postal) message, paid by contract.
 * - `E`: commercial message paid from credit instead of the contract, when both are available.
 * - `I`: initiating commercial message that pre-pays the recipient's reply.
 * - `O`: reply commercial message using a pre-paid initiating message.
 * When absent, ISDS infers the type (contract payment first); a choice it can't use is ignored.
 */
export const CreateMessageType = Schema.Literals(["V", "K", "E", "I", "O"]);
export type CreateMessageType = typeof CreateMessageType.Type;

/**
 * dmFileMetaType (dmBaseTypes.xsd:101-115). PDF §2.1.2 says the first file "by měl" (should) be
 * `main` and later ones `enclosure`, `signature` or `meta`; it is a recommendation, so it is not
 * enforced, and nothing requires exactly one `main` file.
 */
export const FileMetaType = Schema.Literals(["main", "enclosure", "signature", "meta"]);
export type FileMetaType = typeof FileMetaType.Type;

/**
 * One attachment (tFile, dmBaseTypes.xsd:92-144). `content` is sent as dmEncodedContent (base64);
 * the dmXMLContent alternative is not supported. Attribute rules (PDF §2.1.2, p. 45):
 * - `dmMimeType` is required but may be empty or an extension only; a real MIME type is checked
 *   against the content by ISDS.
 * - `dmFileDescr` is required, at most 255 characters; ISDS derives the file type from its
 *   extension, so it should end in an allowed extension (PDF appendix 3).
 * - `dmFormat` is unused by the current ISDS version.
 * ISDS also limits a message to 10 container attachments (ZIP/ASiC); that is left to the server.
 */
export const CreateMessageFile = Schema.Struct({
  content: Schema.Uint8Array,
  dmMimeType: XmlText,
  dmFileMetaType: FileMetaType,
  dmFileDescr: xmlTextMax(255).pipe(Schema.check(Schema.isMinLength(1))),
  dmFileGuid: Schema.optional(XmlText),
  dmUpFileGuid: Schema.optional(XmlText),
  dmFormat: Schema.optional(XmlText),
});
export type CreateMessageFile = typeof CreateMessageFile.Type;

/**
 * The message envelope (tMessageEnvelopeSub) plus its files. Field names are the XSD names;
 * every field but `dbIDRecipient` and `dmFiles` is optional.
 */
export const CreateMessageInput = Schema.Struct({
  /** The recipient's data box (the only required envelope value, PDF p. 42). */
  dbIDRecipient: DataBoxId,
  dmType: Schema.optional(CreateMessageType),
  dmSenderOrgUnit: Schema.optional(XmlText),
  dmSenderOrgUnitNum: Schema.optional(Integer),
  dmRecipientOrgUnit: Schema.optional(XmlText),
  dmRecipientOrgUnitNum: Schema.optional(Integer),
  /** At most 30 characters (PDF p. 42; the XSD has no maxLength). */
  dmToHands: Schema.optional(xmlTextMax(30)),
  /** The subject, at most 255 characters (dmBaseTypes.xsd:402-411). */
  dmAnnotation: Schema.optional(xmlTextMax(255)),
  dmRecipientRefNumber: Schema.optional(xmlTextMax(50)),
  dmSenderRefNumber: Schema.optional(xmlTextMax(50)),
  dmRecipientIdent: Schema.optional(xmlTextMax(50)),
  dmSenderIdent: Schema.optional(xmlTextMax(50)),
  /** Legal title: law number, year, section, paragraph and point (PDF p. 42). */
  dmLegalTitleLaw: Schema.optional(Integer),
  dmLegalTitleYear: Schema.optional(Integer),
  dmLegalTitleSect: Schema.optional(XmlText),
  dmLegalTitlePar: Schema.optional(XmlText),
  dmLegalTitlePoint: Schema.optional(XmlText),
  /** Delivery "do vlastních rukou": only a user with the right to read such messages can open it. */
  dmPersonalDelivery: Schema.optional(Schema.Boolean),
  /**
   * Whether deemed delivery (fikce doručení) applies; ISDS defaults to true. Only an OVM sender
   * may set false; for other senders ISDS ignores the value (PDF p. 42).
   */
  dmAllowSubstDelivery: Schema.optional(Schema.Boolean),
  /** Ignored by current ISDS: the elevated non-OVM sender mode it selected was abolished (PDF pp. 42-43). */
  dmOVM: Schema.optional(Schema.Boolean),
  /** Publish the sending person's identification to the recipient (PDF p. 43). */
  dmPublishOwnID: Schema.optional(Schema.Boolean),
  /**
   * The dmPublishOwnID IdLevel attribute: the sum of the details to publish (1 names, 2 birth
   * date, 4 birth city, 8 birth county/country, 16 RUIAN address code, 32 full address, 64 ROB
   * flag; PDF p. 43). Only with `dmPublishOwnID: true`; ISDS answers 1179 for a conflicting pair.
   */
  IdLevel: Schema.optional(Integer.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  /** 1 to 100 attachments (tFilesArray minOccurs 1; PDF §2.1.2 maximum 100). */
  dmFiles: Schema.Array(CreateMessageFile).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(createMessageMaxFiles)),
  ),
}).pipe(
  Schema.check(
    Schema.makeFilter((input: { readonly dmPublishOwnID?: boolean | undefined; readonly IdLevel?: number | undefined }) =>
      input.IdLevel === undefined || input.dmPublishOwnID === true ? undefined : "IdLevel requires dmPublishOwnID: true",
    ),
  ),
);
export type CreateMessageInput = typeof CreateMessageInput.Type;

export interface CreateMessageResult {
  /** The new message's ID. */
  readonly dmID: MessageId;
  /** The status ISDS accepted the message with ("0000"). */
  readonly status: IsdsResponseStatus;
}

export type CreateMessageError = IsdsOperationError | IsdsMessageTooLarge;

/** tMessageCreateOutput: dmID is minOccurs 0 in the XSD, so its absence is checked separately. */
const CreateMessageResponse = Schema.Struct({ dmID: Schema.optional(MessageId) });

const decodeInput = Schema.decodeUnknownEffect(CreateMessageInput);
/**
 * xs:base64Binary for dmEncodedContent. Node's native encoder (a view, no copy): the pure-JS
 * encoder behind `XsBase64` takes seconds on a 20 MB message.
 */
const encodeBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/** A nillable element: `xsi:nil` when the value is absent, so the required element is still present. */
const nillable = (name: string, value: string | number | boolean | undefined): XmlElement =>
  value === undefined
    ? xmlElement(name, [], { "xsi:nil": "true", "xmlns:xsi": xsiNamespace })
    : xmlElement(name, String(value));

/** gMessageEnvelopeSub (1..1 nillable each) in XSD order, then the optional dmOVM and dmPublishOwnID. */
const envelopeElement = (input: CreateMessageInput): XmlElement =>
  xmlElement(
    "dmEnvelope",
    [
      nillable("dmSenderOrgUnit", input.dmSenderOrgUnit),
      nillable("dmSenderOrgUnitNum", input.dmSenderOrgUnitNum),
      nillable("dbIDRecipient", input.dbIDRecipient),
      nillable("dmRecipientOrgUnit", input.dmRecipientOrgUnit),
      nillable("dmRecipientOrgUnitNum", input.dmRecipientOrgUnitNum),
      nillable("dmToHands", input.dmToHands),
      nillable("dmAnnotation", input.dmAnnotation),
      nillable("dmRecipientRefNumber", input.dmRecipientRefNumber),
      nillable("dmSenderRefNumber", input.dmSenderRefNumber),
      nillable("dmRecipientIdent", input.dmRecipientIdent),
      nillable("dmSenderIdent", input.dmSenderIdent),
      nillable("dmLegalTitleLaw", input.dmLegalTitleLaw),
      nillable("dmLegalTitleYear", input.dmLegalTitleYear),
      nillable("dmLegalTitleSect", input.dmLegalTitleSect),
      nillable("dmLegalTitlePar", input.dmLegalTitlePar),
      nillable("dmLegalTitlePoint", input.dmLegalTitlePoint),
      nillable("dmPersonalDelivery", input.dmPersonalDelivery),
      nillable("dmAllowSubstDelivery", input.dmAllowSubstDelivery),
      input.dmOVM === undefined ? undefined : xmlElement("dmOVM", String(input.dmOVM)),
      input.dmPublishOwnID === undefined
        ? undefined
        : xmlElement("dmPublishOwnID", String(input.dmPublishOwnID), { IdLevel: input.IdLevel }),
    ],
    { dmType: input.dmType },
  );

/** One dmFile, attributes in XSD order. */
const fileElement = (file: CreateMessageFile, base64: string): XmlElement =>
  xmlElement("dmFile", [xmlElement("dmEncodedContent", base64)], {
    dmMimeType: file.dmMimeType,
    dmFileMetaType: file.dmFileMetaType,
    dmFileGuid: file.dmFileGuid,
    dmUpFileGuid: file.dmUpFileGuid,
    dmFileDescr: file.dmFileDescr,
    dmFormat: file.dmFormat,
  });

/**
 * Fails with `IsdsMessageTooLarge` when the decoded attachment content totals more than
 * `createMessageMaxAttachmentBytes`.
 */
export const checkAttachmentSize = Effect.fn("Isds.createMessage.checkAttachmentSize")(function* (
  files: ReadonlyArray<{ readonly content: Uint8Array }>,
) {
  const totalBytes = files.reduce((sum, file) => sum + file.content.byteLength, 0);
  if (totalBytes > createMessageMaxAttachmentBytes) {
    return yield* new IsdsMessageTooLarge({ totalBytes, limitBytes: createMessageMaxAttachmentBytes });
  }
  return totalBytes;
});

/**
 * Sends a data message (CreateMessage) and returns its dmID.
 *
 * Fails before sending with `IsdsInvalidRequest` for input the XSD or the PDF rules reject
 * (lengths, more than 100 files, characters XML can't carry) and with `IsdsMessageTooLarge` when
 * the attachments total more than `createMessageMaxAttachmentBytes`. Messages over 20 MB need
 * the VoDZ service (UploadAttachment + CreateBigMessage), which is not implemented (TODO).
 *
 * ISDS has no idempotency key, and a created message is legally binding: a retry after an
 * unknown outcome can send it twice. Once the request was sent, ISDS may have created the
 * message even though the call fails with
 * - `IsdsTimeoutError` with `requestSent: true`,
 * - `IsdsTransportError` with reason `Connection` or `ResponseTooLarge` (the request went out,
 *   the reply was lost or refused),
 * - `IsdsHttpError` (e.g. a proxy or load balancer error page after ISDS accepted it), or
 * - `IsdsInvalidResponse`, including status 0000 without a dmID.
 * After any of these, reconcile with `reconcileSentMessage` before retrying. These failures are
 * propagated unchanged, never mapped to a success or a failure. A non-success dmStatus fails
 * with `IsdsStatusError` (e.g. 1214 `AttachmentRejected`): ISDS answered that it refused it.
 */
export const createMessage = Effect.fn("Isds.createMessage")(function* (input: CreateMessageInput) {
  const valid = yield* decodeInput(input).pipe(
    Effect.mapError((error) => new IsdsInvalidRequest({ operation, detail: error.message })),
  );
  yield* checkAttachmentSize(valid.dmFiles);
  const files = valid.dmFiles.map((file) => fileElement(file, encodeBase64(file.content)));
  const request: IsdsOperation<typeof CreateMessageResponse.Type> = {
    service: "operations",
    operation,
    request: xmlElement(operation, [envelopeElement(valid), xmlElement("dmFiles", files)]),
    response: CreateMessageResponse,
    status: "dm",
  };
  const { response, status } = yield* callIsds(request);
  if (response.dmID === undefined) {
    return yield* new IsdsInvalidResponse({ service: "operations", operation, detail: "status 0000 without dmID" });
  }
  return { dmID: response.dmID, status } satisfies CreateMessageResult;
});
