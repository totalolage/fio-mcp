import { G, type GuardSpec } from "@mcps/core/mcp/untrusted.js";

/**
 * The guard policy for ISDS results (core nonce guard,
 * @mcps/core/mcp/untrusted.js): which fields of a read result are text
 * someone else wrote. Anyone with a data box can send a message to any
 * box, so sender and recipient names and addresses, the annotation, the
 * reference numbers and file marks, "to hands", the legal title parts,
 * attachment filenames, event descriptions and directory entries are
 * untrusted. Strict identifiers (message and box IDs, ISO times, codes)
 * stay unguarded while they match their format. A struct field the spec
 * does not name gets only its marked excerpts guarded, so every string
 * field an ISDS value can carry is named here; test/mcp/read-guards.test.ts
 * checks that no string leaf of a guarded result is left unwrapped.
 */

export const MESSAGE_ID = /^[0-9]{1,20}$/;
export const DATA_BOX_ID = /^[a-z0-9]{7}$/;
/** An ISO 8601 UTC time as the tools render ISDS times (DateTime.formatIso). */
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CODE = /^[A-Za-z0-9_]{1,16}$/;
const INTEGER = /^-?\d{1,20}$/;
const BOOLEAN = /^(true|false|1|0)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ZFO_REF = /^[a-z0-9]{7}\/[0-9]{1,20}\.zfo$/;

/** gMessageEnvelope (src/isds/models.ts MessageEnvelope). */
const ENVELOPE_FIELDS = {
  dmID: G.id(MESSAGE_ID),
  dbIDSender: G.id(DATA_BOX_ID),
  dmSender: G.text(),
  dmSenderAddress: G.text(),
  dmSenderType: G.id(INTEGER),
  dmRecipient: G.text(),
  dmRecipientAddress: G.text(),
  dmAmbiguousRecipient: G.id(BOOLEAN),
  dmSenderOrgUnit: G.text(),
  dmSenderOrgUnitNum: G.id(INTEGER),
  dbIDRecipient: G.id(DATA_BOX_ID),
  dmRecipientOrgUnit: G.text(),
  dmRecipientOrgUnitNum: G.id(INTEGER),
  dmToHands: G.text(),
  dmAnnotation: G.text(),
  dmRecipientRefNumber: G.text(),
  dmSenderRefNumber: G.text(),
  dmRecipientIdent: G.text(),
  dmSenderIdent: G.text(),
  dmLegalTitleLaw: G.id(INTEGER),
  dmLegalTitleYear: G.id(INTEGER),
  dmLegalTitleSect: G.text(),
  dmLegalTitlePar: G.text(),
  dmLegalTitlePoint: G.text(),
  dmPersonalDelivery: G.id(BOOLEAN),
  dmAllowSubstDelivery: G.id(BOOLEAN),
} satisfies Readonly<Record<string, GuardSpec>>;

export const ENVELOPE_GUARD = G.struct(ENVELOPE_FIELDS);

/** The fields ISDS returns next to an envelope (records, envelope downloads, delivery info). */
const MESSAGE_STATE_FIELDS = {
  dmOrdinal: G.id(INTEGER),
  dmMessageStatus: G.id(INTEGER),
  dmAttachmentSize: G.id(INTEGER),
  dmDeliveryTime: G.id(ISO_TIME),
  dmAcceptanceTime: G.id(ISO_TIME),
  dmType: G.id(CODE),
  dmVODZ: G.id(BOOLEAN),
  attsNum: G.id(INTEGER),
  specMessFlag: G.id(INTEGER),
  dmHash: G.struct({ value: G.id(BASE64), algorithm: G.id(CODE) }),
} satisfies Readonly<Record<string, GuardSpec>>;

/** tRecord: an envelope plus the list fields. */
export const RECORD_GUARD = G.struct({ ...ENVELOPE_FIELDS, ...MESSAGE_STATE_FIELDS });

/** An envelope download or delivery info: `dmDm` plus state fields and delivery events. */
export const RETURNED_GUARD = G.struct({
  ...MESSAGE_STATE_FIELDS,
  dmDm: ENVELOPE_GUARD,
  dmEvents: G.array(G.struct({ dmEventTime: G.id(ISO_TIME), dmEventDescr: G.text() })),
});

export const STATE_CHANGE_GUARD = G.struct({
  dmID: G.id(MESSAGE_ID),
  dmEventTime: G.id(ISO_TIME),
  dmMessageStatus: G.id(INTEGER),
});

/** tDbOwnerInfoExt2 (FindDataBox2 result) and tDbOwnerInfo (box owner): every text field is untrusted. */
const OWNER_GUARD = G.struct({
  dbID: G.id(DATA_BOX_ID),
  aifoIsds: G.id(BOOLEAN),
  dbType: G.id(CODE),
  ic: G.text(),
  pnFirstName: G.text(),
  pnMiddleName: G.text(),
  pnGivenNames: G.text(),
  pnLastName: G.text(),
  pnLastNameAtBirth: G.text(),
  firmName: G.text(),
  biDate: G.id(ISO_DATE),
  biCity: G.text(),
  biCounty: G.text(),
  biState: G.text(),
  adCode: G.text(),
  adCity: G.text(),
  adDistrict: G.text(),
  adStreet: G.text(),
  adNumberInStreet: G.text(),
  adNumberInMunicipality: G.text(),
  adZipCode: G.text(),
  adState: G.text(),
  nationality: G.text(),
  email: G.text(),
  telNumber: G.text(),
  identifier: G.text(),
  registryCode: G.text(),
  dbIdOVM: G.text(),
  dbState: G.id(INTEGER),
  dbEffectiveOVM: G.id(BOOLEAN),
  dbOpenAddressing: G.id(BOOLEAN),
  dbUpperID: G.id(DATA_BOX_ID),
});

export const LIST_GUARD = G.struct({ records: G.array(RECORD_GUARD) });
export const MESSAGE_GUARD = G.struct({ message: RETURNED_GUARD });
export const DELIVERY_INFO_GUARD = G.struct({ deliveryInfo: RETURNED_GUARD });
export const STATE_CHANGES_GUARD = G.struct({ changes: G.array(STATE_CHANGE_GUARD) });
export const FIND_GUARD = G.struct({ boxes: G.array(OWNER_GUARD) });
export const STATUS_GUARD = G.struct({
  boxes: G.array(G.struct({ dbID: G.id(DATA_BOX_ID), boxType: G.id(CODE), owner: OWNER_GUARD })),
});

/** Attachment metadata in a download result: the filename and the declared MIME type are the sender's text. */
const ATTACHMENT_GUARD = G.struct({
  filename: G.text(),
  declaredMimeType: G.text(),
  mimeType: G.id(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
  metaType: G.id(CODE),
  sha256: G.id(SHA256),
});

export const DOWNLOAD_GUARD = G.struct({
  messageId: G.id(MESSAGE_ID),
  envelope: ENVELOPE_GUARD,
  info: G.struct(MESSAGE_STATE_FIELDS),
  attachments: G.array(ATTACHMENT_GUARD),
  zfo: G.struct({ ref: G.id(ZFO_REF), sha256: G.id(SHA256) }),
});
