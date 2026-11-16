import { Effect, Schema, SchemaTransformation } from "effect";
import { IsdsInvalidRequest } from "./errors.js";
import { DataBoxId } from "./models.js";
import { callIsds, type IsdsOperation } from "./soap.js";
import { type XmlElement, xmlElement } from "./xml.js";
import { XmlText, XsBoolean, XsInteger, xmlList } from "./xsd.js";

/**
 * Data-box operations: who the caller is (GetOwnerInfoFromLogin, service "access"), finding
 * boxes (FindDataBox2) and checking one box's state (CheckDataBox), both service "search".
 * Structure follows dbTypes.xsd v3.11; behaviour follows "WS rozhraní ISDS pro vyhledávání
 * datových schránek" (cited as "search spec" with its printed page numbers).
 */

const xsiNamespace = "http://www.w3.org/2001/XMLSchema-instance";

/** A required-but-nillable request element: the value, or `xsi:nil="true"` when absent. */
const nillableElement = (name: string, value: string | number | boolean | undefined): XmlElement =>
  value === undefined
    ? xmlElement(name, [], { "xsi:nil": "true", "xmlns:xsi": xsiNamespace })
    : xmlElement(name, String(value));

const invalidRequest = (operation: string) => (error: Schema.SchemaError) =>
  new IsdsInvalidRequest({ operation, detail: error.message });

// ---------------------------------------------------------------------------------------------
// Shared types

/** tDbType (dbTypes.xsd:210-237): the type of an existing data box, as ISDS reports it. */
export const DataBoxType = Schema.Literals([
  "FO",
  "PFO",
  "PFO_REQ",
  "PFO_ADVOK",
  "PFO_DANPOR",
  "PFO_INSSPR",
  "PFO_AUDITOR",
  "PFO_ZNALEC",
  "PFO_TLUMOCNIK",
  "PFO_ARCH",
  "PFO_AIAT",
  "PFO_AZI",
  "PO",
  "PO_ZAK",
  "PO_REQ",
  "OVM",
  "OVM_NOTAR",
  "OVM_EXEKUT",
  "OVM_REQ",
  "OVM_FO",
  "OVM_PFO",
  "OVM_PO",
]);
export type DataBoxType = typeof DataBoxType.Type;

/**
 * The FindDataBox2 input `dbType` enumeration (dbTypes.xsd:696-722). It differs from
 * `DataBoxType`: it adds the virtual types OVM_MAIN, PO_BASE and PFO_BASE (the base type
 * without its subtypes) and lacks the legacy PO_ZAK, OVM_NOTAR and OVM_EXEKUT. A type with
 * subtypes (OVM, PO, PFO) also matches its subtypes (search spec pp.12-13).
 */
export const FindDataBoxType = Schema.Literals([
  "OVM",
  "OVM_MAIN",
  "OVM_REQ",
  "OVM_FO",
  "OVM_PFO",
  "OVM_PO",
  "PO",
  "PO_BASE",
  "PO_REQ",
  "PFO",
  "PFO_BASE",
  "PFO_REQ",
  "PFO_ADVOK",
  "PFO_INSSPR",
  "PFO_DANPOR",
  "PFO_AUDITOR",
  "PFO_ZNALEC",
  "PFO_TLUMOCNIK",
  "PFO_ARCH",
  "PFO_AIAT",
  "PFO_AZI",
  "FO",
]);
export type FindDataBoxType = typeof FindDataBoxType.Type;

/**
 * A data box's state (search spec p.29): 1 accessible (the only state that can receive
 * messages), 2 temporarily inaccessible (both internal causes report as 2), 3 not yet made
 * accessible (nobody logged in yet, not activated by law), 4 permanently inaccessible (deleted
 * three years later), 5 deleted (ISDS still keeps its record). The XSD types it as a bare
 * integer; 0 or absent means an error, so it is not a state.
 */
export const DataBoxState = Schema.Literals([1, 2, 3, 4, 5]);
export type DataBoxState = typeof DataBoxState.Type;

const XsDataBoxState = XsInteger.pipe(Schema.decodeTo(DataBoxState));

const isCalendarDate = (text: string): boolean => {
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
};

/**
 * A calendar date `YYYY-MM-DD`. xs:date (birth dates) has no time of day, so it stays a date
 * string rather than a DateTime at an invented midnight.
 */
export const CalendarDate = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  Schema.check(
    Schema.makeFilter((text: string) => (isCalendarDate(text) ? undefined : "is not a valid calendar date")),
  ),
);
export type CalendarDate = typeof CalendarDate.Type;

/** xs:date ↔ CalendarDate. An optional timezone suffix (`Z`, `+01:00`) is dropped on decode. */
const XsDate = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/)),
  Schema.decodeTo(
    CalendarDate,
    SchemaTransformation.transform({ decode: (lexical) => lexical.slice(0, 10), encode: (date) => date }),
  ),
);

const text = Schema.optional(Schema.String);

// ---------------------------------------------------------------------------------------------
// GetOwnerInfoFromLogin

/**
 * tDbOwnerInfo (dbTypes.xsd:559-609): the owner of the caller's data box. Every element is
 * nillable, so every field is optional; `email` and `telNumber` may also be omitted.
 */
export const DataBoxOwnerInfo = Schema.Struct({
  dbID: Schema.optional(Schema.String),
  dbType: Schema.optional(DataBoxType),
  /** IČO. */
  ic: text,
  pnFirstName: text,
  pnMiddleName: text,
  pnLastName: text,
  pnLastNameAtBirth: text,
  firmName: text,
  biDate: Schema.optional(XsDate),
  biCity: text,
  biCounty: text,
  biState: text,
  adCity: text,
  adStreet: text,
  adNumberInStreet: text,
  adNumberInMunicipality: text,
  adZipCode: text,
  adState: text,
  nationality: text,
  email: text,
  telNumber: text,
  identifier: text,
  registryCode: text,
  dbState: Schema.optional(XsDataBoxState),
  dbEffectiveOVM: Schema.optional(XsBoolean),
  dbOpenAddressing: Schema.optional(XsBoolean),
});
export type DataBoxOwnerInfo = typeof DataBoxOwnerInfo.Type;

const GetOwnerInfoFromLoginResponse = Schema.Struct({ dbOwnerInfo: DataBoxOwnerInfo });

/**
 * GetOwnerInfoFromLogin: the owner of the data box the caller is logged into. The request
 * carries only `dbDummy`, sent empty (dbTypes.xsd:1231-1233). The access spec documents
 * GetOwnerInfoFromLogin2 instead, which returns the newer tDbOwnerInfoExt2 shape; this follows
 * the XSD of the legacy operation, whose status codes the spec doesn't list (only 0000 succeeds).
 */
export const getOwnerInfo = Effect.fn("Isds.getOwnerInfo")(function* () {
  const operation: IsdsOperation<typeof GetOwnerInfoFromLoginResponse.Type> = {
    service: "access",
    operation: "GetOwnerInfoFromLogin",
    request: xmlElement("GetOwnerInfoFromLogin", [xmlElement("dbDummy", "")]),
    response: GetOwnerInfoFromLoginResponse,
    status: "db",
  };
  const { response } = yield* callIsds(operation);
  return response.dbOwnerInfo;
});

// ---------------------------------------------------------------------------------------------
// FindDataBox2

/** A non-empty search value: ISDS ignores empty criteria (search spec p.15). */
const Criterion = XmlText.pipe(Schema.check(Schema.isMinLength(1)));
const criterion = Schema.optional(Criterion);

const queryFields = {
  /** Look up one box by ID; ISDS then ignores every other field except `dbState`. */
  dbID: Schema.optional(DataBoxId),
  /** Only boxes identified (or not) against the population register (ROB). */
  aifoIsds: Schema.optional(Schema.Boolean),
  /** Omit only together with `ic`, to search every box type with that IČO (search spec p.13). */
  dbType: Schema.optional(FindDataBoxType),
  /** IČO; matched exactly, leading zeros optional. */
  ic: criterion,
  /** Given names; prefix match. */
  pnGivenNames: criterion,
  /** Surname; prefix match. */
  pnLastName: criterion,
  /** Firm name; substring match. */
  firmName: criterion,
  /** Birth date; ISDS honours it only when the caller is an OVM box. */
  biDate: Schema.optional(CalendarDate),
  biCity: criterion,
  biCounty: criterion,
  biState: criterion,
  /** Address point code (RÚIAN). */
  adCode: criterion,
  adCity: criterion,
  adDistrict: criterion,
  adStreet: criterion,
  adNumberInStreet: criterion,
  adNumberInMunicipality: criterion,
  adZipCode: criterion,
  adState: criterion,
  nationality: criterion,
  /** Identifier in the register of public authorities (IdOVM); overrides other criteria except `dbID`. */
  dbIdOVM: criterion,
  /** Only boxes in this state. Without it ISDS returns boxes in states 1–4 (search spec p.14). */
  dbState: Schema.optional(DataBoxState),
  dbOpenAddressing: Schema.optional(Schema.Boolean),
  /** Only boxes subordinate to this box. */
  dbUpperID: Schema.optional(DataBoxId),
};

type QueryFields = Schema.Struct.Type<typeof queryFields>;

const atLeast = (value: string | undefined, length: number): boolean =>
  value !== undefined && value.trim().length >= length;

const searchCriteria = [
  "ic",
  "pnGivenNames",
  "pnLastName",
  "firmName",
  "biDate",
  "biCity",
  "biCounty",
  "biState",
  "adCode",
  "adCity",
  "adDistrict",
  "adStreet",
  "adNumberInStreet",
  "adNumberInMunicipality",
  "adZipCode",
  "adState",
  "nationality",
  "dbUpperID",
] as const;

/**
 * The minimum criteria ISDS requires before it searches (search spec pp.11-13), checked here
 * so a doomed query fails before it is sent. `dbID` or `dbIdOVM` alone is always enough. The
 * spec names minimums for FO, PFO, PO, PO_REQ, OVM, OVM_REQ, OVM_FO and OVM_PFO; any other
 * type only needs one criterion besides the filters (`dbState`, `dbOpenAddressing`, `aifoIsds`).
 */
const missingCriteria = (query: QueryFields): string | undefined => {
  if (query.dbID !== undefined || query.dbIdOVM !== undefined) return undefined;
  const surname = atLeast(query.pnLastName, 2);
  const firm = atLeast(query.firmName, 2);
  const ic = atLeast(query.ic, 1);
  const fullName = atLeast(query.pnLastName, 1) && atLeast(query.pnGivenNames, 1);
  switch (query.dbType) {
    case undefined:
      return ic ? undefined : "give dbID, dbIdOVM, dbType, or ic (only an IČO search may span box types)";
    case "FO":
      return surname ? undefined : "an FO search needs pnLastName of at least 2 characters";
    case "PFO":
      return surname && (ic || firm)
        ? undefined
        : "a PFO search needs pnLastName of at least 2 characters and ic or firmName of at least 2 characters";
    case "PO":
    case "PO_REQ":
    case "OVM":
      return ic || firm ? undefined : `a ${query.dbType} search needs ic or firmName of at least 2 characters`;
    case "OVM_REQ":
      return firm ? undefined : "an OVM_REQ search needs firmName of at least 2 characters";
    case "OVM_FO":
      return fullName ? undefined : "an OVM_FO search needs dbIdOVM, or pnLastName and pnGivenNames";
    case "OVM_PFO":
      return ic || fullName ? undefined : "an OVM_PFO search needs dbIdOVM, ic, or pnLastName and pnGivenNames";
    default:
      return searchCriteria.some((key) => query[key] !== undefined)
        ? undefined
        : `a ${query.dbType} search needs at least one criterion besides dbType`;
  }
};

/** FindDataBox2 input (tDbOwnerInfoExt21, dbTypes.xsd:685-754), checked against the minimum criteria. */
export const FindDataBoxesQuery = Schema.Struct(queryFields).pipe(Schema.check(Schema.makeFilter(missingCriteria)));
export type FindDataBoxesQuery = typeof FindDataBoxesQuery.Type;

/**
 * tDbOwnerInfoExt2 (dbTypes.xsd:641-683): one FindDataBox2 result. Every element is nillable,
 * so every field is optional. For FO and PFO boxes found by a non-OVM caller, ISDS replaces the
 * birth place, nationality and birth surname with "*" (search spec p.15).
 */
export const DataBoxSearchResult = Schema.Struct({
  dbID: Schema.optional(Schema.String),
  aifoIsds: Schema.optional(XsBoolean),
  dbType: Schema.optional(DataBoxType),
  ic: text,
  pnGivenNames: text,
  pnLastName: text,
  firmName: text,
  biDate: Schema.optional(XsDate),
  biCity: text,
  biCounty: text,
  biState: text,
  adCode: text,
  /** A free-text (unstructured) address arrives whole in adCity (search spec p.12). */
  adCity: text,
  adDistrict: text,
  adStreet: text,
  adNumberInStreet: text,
  adNumberInMunicipality: text,
  adZipCode: text,
  adState: text,
  nationality: text,
  dbIdOVM: text,
  dbState: Schema.optional(XsDataBoxState),
  dbOpenAddressing: Schema.optional(XsBoolean),
  dbUpperID: text,
});
export type DataBoxSearchResult = typeof DataBoxSearchResult.Type;

const FindDataBox2Response = Schema.Struct({
  dbResults: Schema.optional(xmlList("dbOwnerInfo", DataBoxSearchResult)),
});

/**
 * How a search ended (search spec pp.14-15):
 * - `complete` (0000): every match is in `boxes`.
 * - `empty` (0002): nothing matched.
 * - `truncated` (0003): more than the server limit (currently 100) matched; `boxes` holds the first ones.
 * - `suppressed` (0009): exactly one non-OVM box matched, but it does not accept commercial
 *   messages (PDZ) from the caller's non-OVM box, so ISDS withholds its data; `boxes` is empty.
 */
export type FindDataBoxesOutcome = "complete" | "empty" | "truncated" | "suppressed";

export interface FindDataBoxesResult {
  readonly boxes: ReadonlyArray<DataBoxSearchResult>;
  readonly outcome: FindDataBoxesOutcome;
  /** `outcome === "truncated"`: more boxes matched than were returned. */
  readonly truncated: boolean;
}

const outcomeByCode: Record<string, FindDataBoxesOutcome> = {
  "0002": "empty",
  "0003": "truncated",
  "0009": "suppressed",
};

const findDataBox2Request = (query: FindDataBoxesQuery): XmlElement =>
  xmlElement("FindDataBox2", [
    xmlElement("dbOwnerInfo", [
      nillableElement("dbID", query.dbID),
      query.aifoIsds === undefined ? undefined : xmlElement("aifoIsds", String(query.aifoIsds)),
      nillableElement("dbType", query.dbType),
      nillableElement("ic", query.ic),
      nillableElement("pnGivenNames", query.pnGivenNames),
      nillableElement("pnLastName", query.pnLastName),
      nillableElement("firmName", query.firmName),
      nillableElement("biDate", query.biDate),
      nillableElement("biCity", query.biCity),
      nillableElement("biCounty", query.biCounty),
      nillableElement("biState", query.biState),
      nillableElement("adCode", query.adCode),
      nillableElement("adCity", query.adCity),
      nillableElement("adDistrict", query.adDistrict),
      nillableElement("adStreet", query.adStreet),
      nillableElement("adNumberInStreet", query.adNumberInStreet),
      nillableElement("adNumberInMunicipality", query.adNumberInMunicipality),
      nillableElement("adZipCode", query.adZipCode),
      nillableElement("adState", query.adState),
      nillableElement("nationality", query.nationality),
      nillableElement("dbIdOVM", query.dbIdOVM),
      nillableElement("dbState", query.dbState),
      nillableElement("dbOpenAddressing", query.dbOpenAddressing),
      nillableElement("dbUpperID", query.dbUpperID),
    ]),
  ]);

/**
 * FindDataBox2, the current search (FindDataBox is its legacy predecessor and isn't exposed).
 * A non-OVM caller may only find OVM boxes or one specific box that accepts commercial
 * messages; an ambiguous query then fails with status 1109 (search spec p.14). Statuses other
 * than 0000/0002/0003/0009 fail with `IsdsStatusError` (e.g. 2017 for an invalid date).
 */
export const findDataBoxes = Effect.fn("Isds.findDataBoxes")(function* (query: FindDataBoxesQuery) {
  const valid = yield* Schema.decodeEffect(FindDataBoxesQuery)(query).pipe(
    Effect.mapError(invalidRequest("FindDataBox2")),
  );
  const operation: IsdsOperation<typeof FindDataBox2Response.Type> = {
    service: "search",
    operation: "FindDataBox2",
    request: findDataBox2Request(valid),
    response: FindDataBox2Response,
    repeating: new Set(["dbOwnerInfo"]),
    status: "db",
    successCodes: new Set(Object.keys(outcomeByCode)),
  };
  const { response, status } = yield* callIsds(operation);
  const outcome = outcomeByCode[status.code] ?? "complete";
  const boxes = outcome === "suppressed" ? [] : (response.dbResults ?? []);
  return { boxes, outcome, truncated: outcome === "truncated" } satisfies FindDataBoxesResult;
});

// ---------------------------------------------------------------------------------------------
// CheckDataBox

export const CheckDataBoxInput = Schema.Struct({ dbID: DataBoxId });
export type CheckDataBoxInput = typeof CheckDataBoxInput.Type;

/** tCheckDBOutput (dbTypes.xsd:1220-1226). A successful check always carries a state. */
const CheckDataBoxResponse = Schema.Struct({ dbState: XsDataBoxState });

export interface CheckDataBoxResult {
  readonly dbState: DataBoxState;
}

/**
 * CheckDataBox: the state of the box with this ID; only state 1 can receive messages. An ID of
 * the right format with no box fails with `IsdsStatusError` 5001 (classified `BoxNotFound`), a
 * malformed one with 2011 or 1007 (search spec p.29). The XSD's optional `dbApproved` and
 * `dbExternRefNumber` inputs aren't documented for this operation and aren't sent.
 */
export const checkDataBox = Effect.fn("Isds.checkDataBox")(function* (input: CheckDataBoxInput) {
  const { dbID } = yield* Schema.decodeEffect(CheckDataBoxInput)(input).pipe(
    Effect.mapError(invalidRequest("CheckDataBox")),
  );
  const operation: IsdsOperation<typeof CheckDataBoxResponse.Type> = {
    service: "search",
    operation: "CheckDataBox",
    request: xmlElement("CheckDataBox", [xmlElement("dbID", dbID)]),
    response: CheckDataBoxResponse,
    status: "db",
  };
  const { response } = yield* callIsds(operation);
  return { dbState: response.dbState } satisfies CheckDataBoxResult;
});
