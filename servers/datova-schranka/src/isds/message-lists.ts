import { DateTime, Effect, Schema } from "effect";
import { IsdsInvalidRequest } from "./errors.js";
import { MessageEnvelope, type MessageStateFilter, messageStateMask, XsMessageState } from "./models.js";
import { callIsds, type IsdsOperation } from "./soap.js";
import { type XmlElement, xmlElement } from "./xml.js";
import { formatXsDateTime, XsBoolean, XsDateTime, XsInteger, xmlList } from "./xsd.js";

/**
 * The dm_info list operations (dm_info.wsdl, service "info"): GetListOfReceivedMessages,
 * GetListOfSentMessages and GetMessageStateChanges. Field names follow dmBaseTypes.xsd.
 */

const xsiNamespace = "http://www.w3.org/2001/XMLSchema-instance";

/** A required-but-nillable element without a value: `<name xsi:nil="true"/>`. */
const nilElement = (name: string): XmlElement => xmlElement(name, [], { "xsi:nil": "true", "xmlns:xsi": xsiNamespace });

/** A required, nillable element: the value's text, or xsi:nil when it is absent. */
const nillableElement = (name: string, value: string | number | undefined): XmlElement =>
  value === undefined ? nilElement(name) : xmlElement(name, String(value));

const timeElement = (name: string, value: DateTime.Utc | undefined): XmlElement =>
  nillableElement(name, value === undefined ? undefined : formatXsDateTime(value));

const PositiveInt = Schema.Finite.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)));

/** A state a dmStatusFilter can select (models.ts ListableMessageState: 1–8 and 10). */
const ListableMessageStateSchema = Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8, 10]);

const MessageStateFilterSchema = Schema.Union([
  Schema.Literal("all"),
  Schema.ReadonlySet(ListableMessageStateSchema),
  Schema.Array(ListableMessageStateSchema),
]);

const TimeWindowFields = {
  /** Lower bound of the window (dmFromTime); no bound when absent. */
  from: Schema.optional(Schema.DateTimeUtc),
  /** Upper bound of the window (dmToTime); no bound when absent. */
  to: Schema.optional(Schema.DateTimeUtc),
};

/** Input of {@link listReceivedMessagesAndDeliver} and {@link listSentMessages}. */
export const ListMessagesInput = Schema.Struct({
  ...TimeWindowFields,
  /** Which message states to return (dmStatusFilter); "all" (-1) when absent. */
  states: Schema.optional(MessageStateFilterSchema),
  /** 1-based position of the first record to return (dmOffset); the server default when absent. */
  offset: Schema.optional(PositiveInt),
  /** How many records to return at most (dmLimit); the server default when absent. */
  limit: Schema.optional(PositiveInt),
});
export type ListMessagesInput = typeof ListMessagesInput.Type;

/** Input of {@link getMessageStateChanges}. */
export const MessageStateChangesInput = Schema.Struct(TimeWindowFields);
export type MessageStateChangesInput = typeof MessageStateChangesInput.Type;

/**
 * tRecord (dmBaseTypes.xsd:734-775): one row of a sent or received message list, i.e. the
 * returned envelope plus the list-specific fields. The XSD makes the record's sequence
 * optional, but ISDS always fills it; a record without dmOrdinal fails decoding.
 */
export const MessageRecord = Schema.Struct({
  /** Position of the record in the whole list, from 1 (dmOrdinal). */
  dmOrdinal: XsInteger,
  ...MessageEnvelope.fields,
  /** The message's current state (dmMessageStatus). */
  dmMessageStatus: XsMessageState,
  /**
   * Size of all the message's attachments in KILOBYTES, rounded, measured on their Base64 form,
   * so about 4/3 of the binary size (dmAttachmentSize; dmBaseTypes.xsd:751-755; PDF §2.6.1
   * p. 60). Not bytes. The spec doesn't say how it rounds or whether a kilobyte is 1000 or
   * 1024 bytes.
   */
  dmAttachmentSize: Schema.optional(XsInteger),
  /** When the message was delivered into the recipient's box ("čas dodání"); absent before that. */
  dmDeliveryTime: Schema.optional(XsDateTime),
  /** When the message was legally delivered to the recipient ("čas doručení"); absent before that. */
  dmAcceptanceTime: Schema.optional(XsDateTime),
  /** Message type code (tDmType, one character, dmBaseTypes.xsd:904-911); absent for a public message. */
  dmType: Schema.optional(Schema.String),
  /** Whether this is a high-volume (VoDZ) message. */
  dmVODZ: Schema.optional(XsBoolean),
  /** Special-message flag; 1 marks a suspicious message (dmBaseTypes.xsd:50). */
  specMessFlag: Schema.optional(XsInteger),
});
export type MessageRecord = typeof MessageRecord.Type;

/** tStateChangesRecord (dmBaseTypes.xsd:951-957): one state change of a message. */
export const MessageStateChange = Schema.Struct({
  dmID: Schema.String,
  /** When the message entered `dmMessageStatus`. */
  dmEventTime: XsDateTime,
  dmMessageStatus: XsMessageState,
});
export type MessageStateChange = typeof MessageStateChange.Type;

/** tListOfMessOutput (dmBaseTypes.xsd:818-827); an absent, nil or empty dmRecords is []. */
const MessageListResponse = Schema.Struct({ dmRecords: Schema.optional(xmlList("dmRecord", MessageRecord)) });

/** tGetStateChangesOutput (dmBaseTypes.xsd:966-975). */
const StateChangesResponse = Schema.Struct({ dmRecords: Schema.optional(xmlList("dmRecord", MessageStateChange)) });

const repeating: ReadonlySet<string> = new Set(["dmRecord"]);

const invalidRequest = (operation: string) => (error: { readonly message: string }) =>
  new IsdsInvalidRequest({ operation, detail: error.message });

/** Validates the input and rejects a window whose start is after its end. */
const validateWindow = Effect.fn("Isds.validateWindow")(function* <A extends MessageStateChangesInput>(
  operation: string,
  schema: Schema.Decoder<A>,
  input: unknown,
) {
  const decoded = yield* Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(invalidRequest(operation)));
  if (decoded.from !== undefined && decoded.to !== undefined && DateTime.isGreaterThan(decoded.from, decoded.to)) {
    return yield* new IsdsInvalidRequest({ operation, detail: "`from` is after `to`" });
  }
  return decoded;
});

/**
 * Builds tListOfSentInput / tListOfFReceivedInput (dmBaseTypes.xsd:784-817, 828-861): every
 * element is required, all but dmStatusFilter nillable. The org-unit element is always nil.
 */
const listRequest = (operation: string, orgUnitElement: string, input: ListMessagesInput): XmlElement =>
  xmlElement(operation, [
    timeElement("dmFromTime", input.from),
    timeElement("dmToTime", input.to),
    nilElement(orgUnitElement),
    xmlElement("dmStatusFilter", String(messageStateMask(input.states ?? ("all" satisfies MessageStateFilter)))),
    nillableElement("dmOffset", input.offset),
    nillableElement("dmLimit", input.limit),
  ]);

const listMessages = Effect.fn("Isds.listMessages")(function* (
  operation: "GetListOfReceivedMessages" | "GetListOfSentMessages",
  input: ListMessagesInput,
) {
  const valid = yield* validateWindow(operation, ListMessagesInput, input);
  const request: IsdsOperation<typeof MessageListResponse.Type> = {
    service: "info",
    operation,
    request: listRequest(
      operation,
      operation === "GetListOfReceivedMessages" ? "dmRecipientOrgUnitNum" : "dmSenderOrgUnitNum",
      valid,
    ),
    response: MessageListResponse,
    repeating,
    status: "dm",
  };
  const { response } = yield* callIsds(request);
  return response.dmRecords ?? [];
});

/**
 * GetListOfReceivedMessages: lists the messages the box received.
 *
 * WARNING — LEGAL DELIVERY SIDE EFFECT. Calling this operation LEGALLY DELIVERS (doručuje)
 * EVERY eligible received message the caller is allowed to read: ISDS counts the call as a
 * login, so all such messages in state 4 (delivered into the box) or 5 (deemed delivered) move
 * to state 6, recorded as event EV13 (delivered to an application logged in with a system
 * certificate). This applies to all such messages, NOT only to the rows this call returns or
 * that its time window, state filter, offset or limit select. It is the only ISDS operation
 * that triggers delivery; message and envelope downloads, the sent list and state changes do
 * not (WS_manipulace_s_datovymi_zpravami.pdf §§1.4–1.8.1 p. 18, §2.8.1 p. 71, §2.9.1 p. 76).
 * Legal delivery starts the recipient's statutory deadlines, so call it only when the box
 * owner wants their received mail delivered. A message that arrives during the call may still
 * be listed in state 4.
 *
 * `from`/`to` bound the delivery time, dmDeliveryTime (dmFromTime/dmToTime); absent bounds are
 * sent as nil. Records come newest first; ISDS returns 1000 when `limit` is absent. A page as
 * long as the limit may be incomplete: narrow the window (§2.9.1 p. 76). The receiving org
 * unit (dmRecipientOrgUnitNum) is always nil.
 */
export const listReceivedMessagesAndDeliver = Effect.fn("Isds.listReceivedMessagesAndDeliver")(function* (
  input: ListMessagesInput = {},
) {
  return yield* listMessages("GetListOfReceivedMessages", input);
});

/**
 * GetListOfSentMessages: lists messages sent from the box. No side effects. `from`/`to` bound
 * the delivery time, dmDeliveryTime (dmFromTime/dmToTime); absent bounds are sent as nil.
 * Records come newest first; ISDS returns 1000 when `limit` is absent (§2.9.2 pp. 78-79). The
 * sending org unit (dmSenderOrgUnitNum) is always nil.
 */
export const listSentMessages = Effect.fn("Isds.listSentMessages")(function* (input: ListMessagesInput = {}) {
  return yield* listMessages("GetListOfSentMessages", input);
});

/**
 * GetMessageStateChanges: the state changes of messages sent from the box, filtered by the
 * time of the change (dmFromTime/dmToTime). ISDS keeps the last 15 days: an absent `from`
 * means 15 days back, an absent `to` means now (both sent as nil). A message that changed state
 * several times yields several records (§2.9.3 pp. 82-83). No side effects.
 */
export const getMessageStateChanges = Effect.fn("Isds.getMessageStateChanges")(function* (
  input: MessageStateChangesInput = {},
) {
  const operation = "GetMessageStateChanges";
  const valid = yield* validateWindow(operation, MessageStateChangesInput, input);
  const { response } = yield* callIsds({
    service: "info",
    operation,
    request: xmlElement(operation, [timeElement("dmFromTime", valid.from), timeElement("dmToTime", valid.to)]),
    response: StateChangesResponse,
    repeating,
    status: "dm",
  });
  return response.dmRecords ?? [];
});
