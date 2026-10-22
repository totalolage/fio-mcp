import { z } from "zod";

/**
 * Payment orders for FIO's XML import (PDF §6.3, schema importIB.xsd).
 *
 * Validation follows the stricter of the PDF tables and the XSD
 * (fio_xml_type.xsd). Character-set classes from the PDF (`e`, `x`, `i`) are
 * documented in field descriptions but not enforced beyond rejecting control
 * characters; FIO validates them server-side and rejects the batch with
 * errorCode 1 rather than creating it.
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

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !CONTROL_CHARS.test(v), "must not contain control characters or line breaks")
    .describe(what);

const digits = (max: number, what: string) =>
  z
    .string()
    .regex(new RegExp(`^\\d{1,${max}}$`), `must be 1-${max} digits`)
    .describe(what);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, "is not a valid calendar date");

export const MAX_AMOUNT = 999_999_999_999.99;

// Exact to the cent: the value must be the nearest double to its own 2-decimal
// rendering, so toFixed(2) never rounds. The cap keeps cents representable.
const amount = z
  .number()
  .min(0.01)
  .max(MAX_AMOUNT)
  .refine((v) => Number(v.toFixed(2)) === v, "must have at most two decimal places")
  .describe("Amount in the payer account's currency, at most 2 decimal places (e.g. 1250.5).");

const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be an ISO 4217 code such as CZK or EUR")
  .optional()
  .describe("Payer-account currency (ISO 4217). Defaults to the configured or last-seen account currency.");

const bic = z
  .string()
  .regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, "must be an 8 or 11 character BIC (ISO 9362)");

const country = z.string().regex(/^[A-Z]{2}$/, "must be an ISO 3166 alpha-2 country code such as DE");

const paymentReason = z.enum(PAYMENT_REASONS);

function compact(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

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

const iban = z
  .string()
  .transform(compact)
  .refine(isValidIban, "must be a valid IBAN");

export const domesticOrderSchema = z
  .strictObject({
    type: z.literal("domestic"),
    amount,
    currency,
    accountTo: z
      .string()
      .regex(/^(\d{1,6}-)?\d{1,10}$/, "must be a Czech account number: optional 1-6 digit prefix, '-', 1-10 digits")
      .describe("Payee account number without bank code, e.g. 2212-2000000699."),
    bankCode: z.string().regex(/^\d{4}$/, "must be 4 digits").describe("Payee bank code, e.g. 0300."),
    date: isoDate.describe("Due date (YYYY-MM-DD)."),
    ks: digits(4, "Constant symbol (up to 4 digits).").optional(),
    vs: digits(10, "Variable symbol (up to 10 digits).").optional(),
    ss: digits(10, "Specific symbol (up to 10 digits).").optional(),
    messageForRecipient: text(140, "Message shown to the recipient (max 140 characters).").optional(),
    comment: text(140, "Your own label for the order (max 140 characters).").optional(),
    paymentReason: paymentReason.optional().describe("Payment reason code (platební titul), optional."),
    paymentType: z
      .enum(["standard", "priority", "collection"])
      .optional()
      .describe("standard (431001, default), priority (431005), or collection (431022): a direct-debit collection that PULLS money from accountTo into your account."),
  })
  .describe("Domestic (Czech) payment, also usable for foreign-currency transfers between FIO accounts.");

export const euroOrderSchema = z
  .strictObject({
    type: z.literal("euro"),
    amount,
    currency,
    accountTo: iban.describe("Payee IBAN."),
    bic: bic.optional().describe("Payee bank BIC, optional."),
    date: isoDate.describe("Due date (YYYY-MM-DD)."),
    ks: digits(4, "Constant symbol (up to 4 digits).").optional(),
    vs: digits(10, "Variable symbol (up to 10 digits).").optional(),
    ss: digits(10, "Specific symbol (up to 10 digits).").optional(),
    comment: text(140, "Your own label (max 140; letters without diacritics, digits, space , . / -).").optional(),
    benefName: text(35, "Beneficiary name (max 35; letters without diacritics, digits, space , . / -)."),
    benefStreet: text(35, "Beneficiary street (max 35).").optional(),
    benefCity: text(35, "Beneficiary city (max 35).").optional(),
    benefCountry: country.optional().describe("Beneficiary country, ISO alpha-2."),
    remittanceInfo1: text(35, "Remittance information line 1 (max 35).").optional(),
    remittanceInfo2: text(35, "Remittance information line 2 (max 35).").optional(),
    remittanceInfo3: text(35, "Remittance information line 3 (max 35).").optional(),
    paymentReason: paymentReason
      .optional()
      .describe("Payment reason code; required only for accounts at FIO's Slovak branch above EUR 50,000."),
    paymentType: z
      .enum(["standard", "priority", "instant"])
      .optional()
      .describe("standard (431008, default), priority (431009), or instant (431018)."),
  })
  .describe("Euro payment (T2/SEPA) to an IBAN.");

export const foreignOrderSchema = z
  .strictObject({
    type: z.literal("foreign"),
    amount,
    currency,
    accountTo: z
      .string()
      .transform(compact)
      .refine((v) => /^[A-Z0-9]{1,34}$/.test(v), "must be an account number or IBAN of up to 34 letters/digits")
      .describe("Payee account number or IBAN."),
    bic: bic.describe("Payee bank BIC (required)."),
    date: isoDate.describe("Due date (YYYY-MM-DD)."),
    comment: text(140, "Additional information (max 140).").optional(),
    benefName: text(35, "Beneficiary name (max 35)."),
    benefStreet: text(35, "Beneficiary street (max 35)."),
    benefCity: text(35, "Beneficiary city (max 35)."),
    benefCountry: country.describe("Beneficiary country, ISO alpha-2."),
    remittanceInfo1: text(35, "Remittance information line 1 (max 35, required)."),
    remittanceInfo2: text(35, "Remittance information line 2 (max 35).").optional(),
    remittanceInfo3: text(35, "Remittance information line 3 (max 35).").optional(),
    remittanceInfo4: text(35, "Remittance information line 4 (max 35).").optional(),
    detailsOfCharges: z
      .enum(["OUR", "BEN", "SHA"])
      .describe("Who pays fees: OUR (sender, 470501), BEN (recipient, 470502), SHA (shared, 470503)."),
    paymentReason: paymentReason.describe("Payment reason code (platební titul), required."),
  })
  .describe("Foreign (non-SEPA) payment.");

export const paymentOrderSchema = z.discriminatedUnion("type", [domesticOrderSchema, euroOrderSchema, foreignOrderSchema]);

export const paymentOrdersSchema = z
  .array(paymentOrderSchema)
  .min(1)
  .max(MAX_ORDERS_PER_BATCH)
  .describe(`1-${MAX_ORDERS_PER_BATCH} orders. They are sent as one batch in the order FIO requires: domestic, euro, foreign.`);

export type PaymentOrder = z.infer<typeof paymentOrderSchema>;
export type DomesticOrder = z.infer<typeof domesticOrderSchema>;
export type EuroOrder = z.infer<typeof euroOrderSchema>;
export type ForeignOrder = z.infer<typeof foreignOrderSchema>;

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

function resolveCurrency(order: PaymentOrder, payer: Payer): string {
  const value = order.currency ?? payer.currency;
  if (!value) {
    throw new Error(
      "Order currency is unknown: pass `currency` on each order, or configure the account currency (FIO_ACCOUNT_CURRENCY / accounts[].currency).",
    );
  }
  return value;
}

/** Element order follows the xs:sequence in importIB.xsd exactly. */
function orderXml(order: PaymentOrder, payer: Payer): string {
  const common: Element[] = [
    ["accountFrom", payer.accountNumber],
    ["currency", resolveCurrency(order, payer)],
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
export function buildImportXml(orders: readonly PaymentOrder[], payer: Payer): string {
  if (!/^\d{1,10}$/.test(payer.accountNumber)) {
    throw new Error("Payer account number must be 1-10 digits (FIO account number without bank code).");
  }
  const body = sortOrders(orders)
    .map((order) => orderXml(order, payer))
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Import xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.fio.cz/schema/importIB.xsd">\n' +
    "  <Orders>\n" +
    body +
    "  </Orders>\n" +
    "</Import>\n"
  );
}

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
