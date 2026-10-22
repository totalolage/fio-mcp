import { Effect, Schema, SchemaTransformation } from "effect";
import { InvalidInput } from "./errors.js";
import { FIO_COUNTRY_CODES } from "./fio-countries.js";

/**
 * Payment orders for FIO's XML import (PDF §6.3, schema importIB.xsd).
 *
 * Validation follows the stricter of the PDF tables and the XSD
 * (fio_xml_type.xsd). Character-set classes from the PDF (`e`, `x`, `i`) are
 * documented in field descriptions but not enforced beyond rejecting control
 * characters and anything XML 1.0 cannot carry; FIO validates them server-side
 * and rejects the batch with errorCode 1 rather than creating it.
 */

/** Payment reasons ("platební titul", PDF §6.3.4); identical to the XSD enumeration. */
export const PAYMENT_REASONS = [
  "110", "112", "120", "122", "130", "132", "135", "190", "195", "210", "211", "212", "213", "214", "215", "216",
  "217", "218", "219", "220", "221", "222", "223", "224", "226", "233", "235", "239", "260", "262", "265", "270",
  "272", "275", "280", "282", "285", "295", "310", "311", "312", "315", "318", "320", "325", "326", "327", "328",
  "330", "332", "335", "340", "345", "346", "347", "348", "352", "355", "360", "361", "365", "368", "369", "370",
  "372", "375", "376", "378", "380", "382", "384", "385", "386", "387", "388", "390", "392", "395", "397", "410",
  "412", "510", "520", "530", "532", "535", "538", "540", "550", "610", "612", "615", "618", "620", "622", "625",
  "628", "630", "632", "635", "640", "650", "652", "653", "725", "735", "740", "742", "745", "748", "750", "752",
  "755", "760", "762", "770", "790", "818", "820", "822", "825", "835", "850", "852", "855", "862", "890", "950",
  "952",
] as const;

export const DOMESTIC_PAYMENT_TYPES = { standard: "431001", priority: "431005", collection: "431022" } as const;
export const EURO_PAYMENT_TYPES = { standard: "431008", priority: "431009", instant: "431018" } as const;
export const CHARGES = { OUR: "470501", BEN: "470502", SHA: "470503" } as const;

export const MAX_ORDERS_PER_BATCH = 100;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Outside XML 1.0's Char production: U+FFFE, U+FFFF and lone surrogates (with
// the u flag a valid pair is one code point and does not match). A lone
// surrogate would also be replaced by U+FFFD on upload, so FIO would get
// different bytes from the previewed XML.
const NON_XML_CHARS = /[\ud800-\udfff\ufffe\uffff]/u;

const text = (max: number, what: string) =>
  Schema.Trim.check(
    Schema.isMinLength(1, { message: "must not be empty" }),
    Schema.isMaxLength(max, { message: `must be at most ${max} characters` }),
    Schema.makeFilter((v: string) => !CONTROL_CHARS.test(v), {
      message: "must not contain control characters or line breaks",
    }),
    Schema.makeFilter((v: string) => !NON_XML_CHARS.test(v), {
      message: "must not contain U+FFFE, U+FFFF or unpaired surrogates (not valid in XML)",
    }),
  ).annotate({ description: what });

const digits = (max: number, what: string) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^\\d{1,${max}}$`), { message: `must be 1-${max} digits` })).annotate({
    description: what,
  });

const isCalendarDate = (v: string): boolean => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
};

// xs:date (XML Schema 1.0) has no year 0000, though JavaScript's Date does.
const isoDate = (what: string) =>
  Schema.String.check(
    Schema.isPattern(/^(?!0000)\d{4}-\d{2}-\d{2}$/, { message: "must be YYYY-MM-DD with a year from 0001" }),
    Schema.makeFilter(isCalendarDate, { message: "is not a valid calendar date" }),
  ).annotate({ description: what });

export const MAX_AMOUNT = 999_999_999_999.99;

// Exact to the cent: the value must be the nearest double to its own 2-decimal
// rendering, so toFixed(2) never rounds. The cap keeps cents representable.
const amount = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0.01, { message: "must be at least 0.01" }),
  Schema.isLessThanOrEqualTo(MAX_AMOUNT, { message: `must be at most ${MAX_AMOUNT}` }),
  Schema.makeFilter((v: number) => Number(v.toFixed(2)) === v, { message: "must have at most two decimal places" }),
).annotate({ description: "Amount in the payer account's currency, at most 2 decimal places (e.g. 1250.5)." });

const currency = Schema.optionalKey(
  Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/, { message: "must be an ISO 4217 code such as CZK or EUR" })).annotate({
    description: "Payer-account currency (ISO 4217). Defaults to the configured or last-seen account currency.",
  }),
);

const bic = (what: string) =>
  Schema.String.check(
    Schema.isPattern(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, { message: "must be an 8 or 11 character BIC (ISO 9362)" }),
  ).annotate({ description: what });

const FIO_COUNTRIES: ReadonlySet<string> = new Set(FIO_COUNTRY_CODES);

// The XSD's country_type is a closed enumeration; checked by lookup rather than
// a literal union so the tool schema does not carry all 253 codes.
const country = (what: string) =>
  Schema.String.check(
    Schema.isPattern(/^[A-Z]{2}$/, { message: "must be an ISO 3166 alpha-2 country code such as DE" }),
    Schema.makeFilter((v: string) => FIO_COUNTRIES.has(v), {
      message: "is not a country code FIO accepts (fio_xml_type.xsd country_type)",
    }),
  ).annotate({ description: what });

const paymentReason = (what: string) => Schema.Literals(PAYMENT_REASONS).annotate({ description: what });

function compact(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** Decodes by removing whitespace and upper-casing; encodes as is. */
const Compacted = Schema.String.pipe(
  Schema.decodeTo(Schema.String, SchemaTransformation.transform({ decode: compact, encode: (v: string) => v })),
);

/** ISO 13616 mod-97 check. */
export function isValidIban(value: string): boolean {
  const iban = compact(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digitsOf = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digitsOf) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

const iban = (what: string) =>
  Compacted.check(Schema.makeFilter(isValidIban, { message: "must be a valid IBAN" })).annotate({ description: what });

const opt = Schema.optionalKey;

export const DomesticOrder = Schema.Struct({
  type: Schema.Literal("domestic"),
  amount,
  currency,
  accountTo: Schema.String.check(
    Schema.isPattern(/^(\d{1,6}-)?\d{1,10}$/, {
      message: "must be a Czech account number: optional 1-6 digit prefix, '-', 1-10 digits",
    }),
  ).annotate({ description: "Payee account number without bank code, e.g. 2212-2000000699." }),
  bankCode: Schema.String.check(Schema.isPattern(/^\d{4}$/, { message: "must be 4 digits" })).annotate({
    description: "Payee bank code, e.g. 0300.",
  }),
  date: isoDate("Due date (YYYY-MM-DD)."),
  ks: opt(digits(4, "Constant symbol (up to 4 digits).")),
  vs: opt(digits(10, "Variable symbol (up to 10 digits).")),
  ss: opt(digits(10, "Specific symbol (up to 10 digits).")),
  messageForRecipient: opt(text(140, "Message shown to the recipient (max 140 characters).")),
  comment: opt(text(140, "Your own label for the order (max 140 characters).")),
  paymentReason: opt(paymentReason("Payment reason code (platební titul), optional.")),
  paymentType: opt(
    Schema.Literals(["standard", "priority", "collection"]).annotate({
      description:
        "standard (431001, default), priority (431005), or collection (431022): a direct-debit collection that PULLS money from accountTo into your account.",
    }),
  ),
}).annotate({ description: "Domestic (Czech) payment, also usable for foreign-currency transfers between FIO accounts." });

export const EuroOrder = Schema.Struct({
  type: Schema.Literal("euro"),
  amount,
  currency,
  accountTo: iban("Payee IBAN."),
  bic: opt(bic("Payee bank BIC, optional.")),
  date: isoDate("Due date (YYYY-MM-DD)."),
  ks: opt(digits(4, "Constant symbol (up to 4 digits).")),
  vs: opt(digits(10, "Variable symbol (up to 10 digits).")),
  ss: opt(digits(10, "Specific symbol (up to 10 digits).")),
  comment: opt(text(140, "Your own label (max 140; letters without diacritics, digits, space , . / -).")),
  benefName: text(35, "Beneficiary name (max 35; letters without diacritics, digits, space , . / -)."),
  benefStreet: opt(text(35, "Beneficiary street (max 35).")),
  benefCity: opt(text(35, "Beneficiary city (max 35).")),
  benefCountry: opt(country("Beneficiary country, ISO alpha-2.")),
  remittanceInfo1: opt(text(35, "Remittance information line 1 (max 35).")),
  remittanceInfo2: opt(text(35, "Remittance information line 2 (max 35).")),
  remittanceInfo3: opt(text(35, "Remittance information line 3 (max 35).")),
  paymentReason: opt(
    paymentReason("Payment reason code; required only for accounts at FIO's Slovak branch above EUR 50,000."),
  ),
  paymentType: opt(
    Schema.Literals(["standard", "priority", "instant"]).annotate({
      description: "standard (431008, default), priority (431009), or instant (431018).",
    }),
  ),
}).annotate({ description: "Euro payment (T2/SEPA) to an IBAN." });

export const ForeignOrder = Schema.Struct({
  type: Schema.Literal("foreign"),
  amount,
  currency,
  accountTo: Compacted.check(
    Schema.isPattern(/^[A-Z0-9]{1,34}$/, { message: "must be an account number or IBAN of up to 34 letters/digits" }),
  ).annotate({ description: "Payee account number or IBAN." }),
  bic: bic("Payee bank BIC (required)."),
  date: isoDate("Due date (YYYY-MM-DD)."),
  comment: opt(text(140, "Additional information (max 140).")),
  benefName: text(35, "Beneficiary name (max 35)."),
  benefStreet: text(35, "Beneficiary street (max 35)."),
  benefCity: text(35, "Beneficiary city (max 35)."),
  benefCountry: country("Beneficiary country, ISO alpha-2."),
  remittanceInfo1: text(35, "Remittance information line 1 (max 35, required)."),
  remittanceInfo2: opt(text(35, "Remittance information line 2 (max 35).")),
  remittanceInfo3: opt(text(35, "Remittance information line 3 (max 35).")),
  remittanceInfo4: opt(text(35, "Remittance information line 4 (max 35).")),
  detailsOfCharges: Schema.Literals(["OUR", "BEN", "SHA"]).annotate({
    description: "Who pays fees: OUR (sender, 470501), BEN (recipient, 470502), SHA (shared, 470503).",
  }),
  paymentReason: paymentReason("Payment reason code (platební titul), required."),
}).annotate({ description: "Foreign (non-SEPA) payment." });

export const PaymentOrder = Schema.Union([DomesticOrder, EuroOrder, ForeignOrder]);

export const PaymentOrders = Schema.Array(PaymentOrder)
  .check(
    Schema.isMinLength(1, { message: "must contain at least one order" }),
    Schema.isMaxLength(MAX_ORDERS_PER_BATCH, { message: `must contain at most ${MAX_ORDERS_PER_BATCH} orders` }),
  )
  .annotate({
    description: `1-${MAX_ORDERS_PER_BATCH} orders. They are sent as one batch in the order FIO requires: domestic, euro, foreign.`,
  });

export type PaymentOrder = typeof PaymentOrder.Type;
export type DomesticOrder = typeof DomesticOrder.Type;
export type EuroOrder = typeof EuroOrder.Type;
export type ForeignOrder = typeof ForeignOrder.Type;

export interface Payer {
  accountNumber: string;
  currency?: string;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const TYPE_ORDER = { domestic: 0, euro: 1, foreign: 2 } as const;

/** Stable sort into FIO's required order: domestic, euro, foreign (PDF §6.3). */
export function sortOrders<T extends { type: PaymentOrder["type"] }>(orders: readonly T[]): T[] {
  return orders
    .map((order, index) => ({ order, index }))
    .sort((a, b) => TYPE_ORDER[a.order.type] - TYPE_ORDER[b.order.type] || a.index - b.index)
    .map(({ order }) => order);
}

type Element = [name: string, value: string | number | undefined];

function element([name, value]: Element): string {
  if (value === undefined) return "";
  return `      <${name}>${escapeXml(String(value))}</${name}>\n`;
}

function block(tag: string, elements: Element[]): string {
  return `    <${tag}>\n${elements.map(element).join("")}    </${tag}>\n`;
}

/** Element order follows the xs:sequence in importIB.xsd exactly. */
function orderXml(order: PaymentOrder, payer: Payer, currency: string): string {
  const common: Element[] = [
    ["accountFrom", payer.accountNumber],
    ["currency", currency],
    ["amount", order.amount.toFixed(2)],
  ];
  switch (order.type) {
    case "domestic":
      return block("DomesticTransaction", [
        ...common,
        ["accountTo", order.accountTo],
        ["bankCode", order.bankCode],
        ["ks", order.ks],
        ["vs", order.vs],
        ["ss", order.ss],
        ["date", order.date],
        ["messageForRecipient", order.messageForRecipient],
        ["comment", order.comment],
        ["paymentReason", order.paymentReason],
        ["paymentType", order.paymentType && DOMESTIC_PAYMENT_TYPES[order.paymentType]],
      ]);
    case "euro":
      return block("T2Transaction", [
        ...common,
        ["accountTo", order.accountTo],
        ["ks", order.ks],
        ["vs", order.vs],
        ["ss", order.ss],
        ["bic", order.bic],
        ["date", order.date],
        ["comment", order.comment],
        ["benefName", order.benefName],
        ["benefStreet", order.benefStreet],
        ["benefCity", order.benefCity],
        ["benefCountry", order.benefCountry],
        ["remittanceInfo1", order.remittanceInfo1],
        ["remittanceInfo2", order.remittanceInfo2],
        ["remittanceInfo3", order.remittanceInfo3],
        ["paymentReason", order.paymentReason],
        ["paymentType", order.paymentType && EURO_PAYMENT_TYPES[order.paymentType]],
      ]);
    case "foreign":
      return block("ForeignTransaction", [
        ...common,
        ["accountTo", order.accountTo],
        ["bic", order.bic],
        ["date", order.date],
        ["comment", order.comment],
        ["benefName", order.benefName],
        ["benefStreet", order.benefStreet],
        ["benefCity", order.benefCity],
        ["benefCountry", order.benefCountry],
        ["remittanceInfo1", order.remittanceInfo1],
        ["remittanceInfo2", order.remittanceInfo2],
        ["remittanceInfo3", order.remittanceInfo3],
        ["remittanceInfo4", order.remittanceInfo4],
        ["detailsOfCharges", CHARGES[order.detailsOfCharges]],
        ["paymentReason", order.paymentReason],
      ]);
  }
}

/** Builds a Fio XML import document (UTF-8) for the given orders. */
export const buildImportXml = Effect.fnUntraced(function* (orders: readonly PaymentOrder[], payer: Payer) {
  if (!/^\d{1,10}$/.test(payer.accountNumber)) {
    return yield* new InvalidInput({
      detail: "Payer account number must be 1-10 digits (FIO account number without bank code).",
    });
  }
  const parts: Array<string> = [];
  for (const order of sortOrders(orders)) {
    const currency = order.currency ?? payer.currency;
    if (currency === undefined) {
      return yield* new InvalidInput({
        detail:
          "Order currency is unknown: pass `currency` on each order, or configure the account currency (FIO_ACCOUNT_CURRENCY / accounts[].currency).",
      });
    }
    parts.push(orderXml(order, payer, currency));
  }
  const body = parts.join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Import xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.fio.cz/schema/importIB.xsd">\n' +
    "  <Orders>\n" +
    body +
    "  </Orders>\n" +
    "</Import>\n"
  );
});

/** Totals per currency, for the confirmation summary. */
export function summarizeOrders(orders: readonly PaymentOrder[], payer: Payer) {
  const totals: Record<string, number> = {};
  const counts = { domestic: 0, euro: 0, foreign: 0 };
  for (const order of orders) {
    const cur = order.currency ?? payer.currency ?? "?";
    totals[cur] = Math.round(((totals[cur] ?? 0) + order.amount) * 100) / 100;
    counts[order.type]++;
  }
  return { orderCount: orders.length, counts, totalsByCurrency: totals };
}
