import { Schema, SchemaTransformation } from "effect";
import { XmlText, XsBoolean, XsInteger } from "./xsd.js";

/**
 * Shared ISDS message models (dmBaseTypes.xsd, ISDS v3.11). Field names follow the XSD element
 * names so every field can be checked against the schema and the spec.
 */

/** tIdDb: a data box ID, exactly 7 characters (dmBaseTypes.xsd:65-72). */
export const DataBoxId = XmlText.pipe(Schema.check(Schema.isMinLength(7)), Schema.check(Schema.isMaxLength(7)));
export type DataBoxId = typeof DataBoxId.Type;

/** tIdDm: a message ID, at most 20 characters (dmBaseTypes.xsd:57-64). */
export const MessageId = XmlText.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(20)));
export type MessageId = typeof MessageId.Type;

/**
 * dmMessageStatus (WS_manipulace_s_datovymi_zpravami.pdf §1.5):
 * 1 submitted, 2 timestamped, 3 failed the antivirus check (never delivered), 4 delivered to the
 * box, 5 deemed delivered (fiction, 10 days), 6 delivered by an authorized login, 7 read
 * (informative only), 8 undeliverable (box made inaccessible), 9 content deleted, 10 moved to
 * the Data Vault.
 */
export const MessageState = Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
export type MessageState = typeof MessageState.Type;

/** dmMessageStatus as XML text → MessageState. */
export const XsMessageState = XsInteger.pipe(Schema.decodeTo(MessageState));

/**
 * The states a list's dmStatusFilter can select. The bit for state n is 2^n (PDF §2.9.1,
 * p. 79); the table lists 1–8 and 10 but not 9, so 9 can't be filtered for.
 */
export type ListableMessageState = Exclude<MessageState, 9>;

/** Selects all states the caller may see: dmStatusFilter -1. */
export type MessageStateFilter = "all" | ReadonlySet<ListableMessageState> | ReadonlyArray<ListableMessageState>;

/** The dmStatusFilter bit mask for a set of states; "all" is -1. An empty set selects nothing (0). */
export const messageStateMask = (filter: MessageStateFilter): number => {
  if (filter === "all") return -1;
  let mask = 0;
  for (const state of filter) mask |= 2 ** state;
  return mask;
};

/**
 * gMessageEnvelopeSub (dmBaseTypes.xsd:367-488), as returned: every element is nillable, so
 * each is optional here (a nil element decodes as absent).
 */
export const MessageEnvelopeSubFields = {
  dmSenderOrgUnit: Schema.optional(Schema.String),
  dmSenderOrgUnitNum: Schema.optional(XsInteger),
  dbIDRecipient: Schema.optional(Schema.String),
  dmRecipientOrgUnit: Schema.optional(Schema.String),
  dmRecipientOrgUnitNum: Schema.optional(XsInteger),
  dmToHands: Schema.optional(Schema.String),
  dmAnnotation: Schema.optional(Schema.String),
  dmRecipientRefNumber: Schema.optional(Schema.String),
  dmSenderRefNumber: Schema.optional(Schema.String),
  dmRecipientIdent: Schema.optional(Schema.String),
  dmSenderIdent: Schema.optional(Schema.String),
  dmLegalTitleLaw: Schema.optional(XsInteger),
  dmLegalTitleYear: Schema.optional(XsInteger),
  dmLegalTitleSect: Schema.optional(Schema.String),
  dmLegalTitlePar: Schema.optional(Schema.String),
  dmLegalTitlePoint: Schema.optional(Schema.String),
  dmPersonalDelivery: Schema.optional(XsBoolean),
  dmAllowSubstDelivery: Schema.optional(XsBoolean),
};

/**
 * gMessageEnvelope (dmBaseTypes.xsd:489-555): the envelope ISDS returns in list records,
 * envelope and message downloads and delivery info (`dmDm`).
 */
export const MessageEnvelope = Schema.Struct({
  dmID: Schema.String,
  dbIDSender: Schema.optional(Schema.String),
  dmSender: Schema.optional(Schema.String),
  dmSenderAddress: Schema.optional(Schema.String),
  /** Sender box type code; 10–50 with the 2026 subtypes, so kept numeric. */
  dmSenderType: XsInteger,
  dmRecipient: Schema.optional(Schema.String),
  dmRecipientAddress: Schema.optional(Schema.String),
  dmAmbiguousRecipient: Schema.optional(XsBoolean),
  ...MessageEnvelopeSubFields,
});
export type MessageEnvelope = typeof MessageEnvelope.Type;

/** tHash: base64 digest text with an optional `algorithm` attribute (dmBaseTypes.xsd:160-170). */
export const MessageHash = Schema.Struct({
  "#text": Schema.String,
  algorithm: Schema.optional(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ value: Schema.String, algorithm: Schema.optional(Schema.String) }),
    SchemaTransformation.transform({
      decode: (hash: { readonly "#text": string; readonly algorithm?: string | undefined }) =>
        hash.algorithm === undefined ? { value: hash["#text"] } : { value: hash["#text"], algorithm: hash.algorithm },
      encode: (hash: { readonly value: string; readonly algorithm?: string | undefined }) =>
        hash.algorithm === undefined ? { "#text": hash.value } : { "#text": hash.value, algorithm: hash.algorithm },
    }),
  ),
);
export type MessageHash = typeof MessageHash.Type;
