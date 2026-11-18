import { containsGuardMarkers, FREE_TEXT_CAP, sanitiseUntrusted } from "@mcps/core/mcp/untrusted.js";
import { compact, type PaymentOrder } from "./payments.js";

const DOMESTIC = /^(?:(\d{1,6})-)?(\d{1,10})\/(\d{4})$/;

function normaliseDomesticAccount(text: string): string | undefined {
  const trimmed = text.trim();
  const domestic = DOMESTIC.exec(trimmed);
  if (domestic) {
    const prefix = (domestic[1] ?? "").replace(/^0+/, "");
    const number = (domestic[2] ?? "").replace(/^0+/, "") || "0";
    return `${prefix === "" ? "" : `${prefix}-`}${number}/${domestic[3]}`;
  }
  return undefined;
}

/** One order as the ledger records it (D10 `payees_json`). */
export interface PayeeRecord {
  /** Normalized domestic account or compact IBAN or account number. */
  readonly payee: string;
  readonly bankCode: string | null;
  readonly bic: string | null;
  /** Major units. */
  readonly amount: number;
  readonly currency: string;
  readonly vs: string | null;
}

export function payeeOf(order: PaymentOrder, payerCurrency: string): PayeeRecord {
  const currency = order.currency ?? payerCurrency;
  switch (order.type) {
    case "domestic": {
      const account = `${order.accountTo}/${order.bankCode}`;
      return {
        payee: normaliseDomesticAccount(account) ?? account,
        bankCode: order.bankCode,
        bic: null,
        amount: order.amount,
        currency,
        vs: order.vs ?? null,
      };
    }
    case "euro":
      return {
        payee: compact(order.accountTo),
        bankCode: null,
        bic: order.bic ?? null,
        amount: order.amount,
        currency,
        vs: order.vs ?? null,
      };
    case "foreign":
      return { payee: compact(order.accountTo), bankCode: null, bic: order.bic, amount: order.amount, currency, vs: null };
  }
}

/** Order fields holding free text, which sanitisation must leave unchanged. */
const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set([
  "messageForRecipient",
  "comment",
  "benefName",
  "benefStreet",
  "benefCity",
  "remittanceInfo1",
  "remittanceInfo2",
  "remittanceInfo3",
  "remittanceInfo4",
]);

/**
 * Signs that an order was pasted from guarded bank text (R9): any string
 * field with a guard marker, or a free-text field that sanitisation would
 * change. One problem per field at most; the marker wins. Orders are 1-based.
 */
export function provenanceProblems(orders: ReadonlyArray<PaymentOrder>): ReadonlyArray<string> {
  const problems: Array<string> = [];
  for (const [index, order] of orders.entries()) {
    for (const [field, value] of Object.entries(order)) {
      if (typeof value !== "string") continue;
      if (containsGuardMarkers(value)) {
        problems.push(`provenance: guard marker in ${field} of order ${index + 1}`);
      } else if (FREE_TEXT_FIELDS.has(field) && sanitiseUntrusted(value, FREE_TEXT_CAP) !== value) {
        problems.push(`provenance: ${field} of order ${index + 1} would be altered by sanitisation`);
      }
    }
  }
  return problems;
}
