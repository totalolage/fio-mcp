import { G, type GuardSpec, hasMarks, markUntrusted } from "@mcps/core/mcp/untrusted.js";
import type { StatementInfo, Transaction } from "../statement.js";

/**
 * Fio's guard policy (SEC-05) for the core nonce guard
 * (@mcps/core/mcp/untrusted.js): which fields of a bank result are third-party
 * text, and which identifiers stay unguarded while they match their format.
 * Anyone can send a small payment with a message, so counterparty names,
 * messages, export content and Fio's own response text are untrusted.
 */

// Strict identifiers stay unguarded while they match their pattern.
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const CURRENCY = /^[A-Z]{3}$/;
export const SYMBOL = /^\d{1,10}$/;
export const BANK_CODE = /^\d{4}$/;
export const CZECH_ACCOUNT = /^(\d{1,6}-)?\d{1,10}$/;
export const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
export const BIC = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** A counterparty account: Czech number or IBAN. */
const ACCOUNT_OR_IBAN = /^(?:(\d{1,6}-)?\d{1,10}|[A-Z]{2}\d{2}[A-Z0-9]{11,30})$/;

/** Bank text in a transaction; ids and amounts are numbers. */
export const TRANSACTION_GUARD = G.struct({
  date: G.id(DATE),
  currency: G.id(CURRENCY),
  counterpartyAccount: G.id(ACCOUNT_OR_IBAN),
  counterpartyName: G.text(),
  counterpartyBankCode: G.id(BANK_CODE),
  counterpartyBankName: G.text(),
  counterpartyBic: G.id(BIC),
  constantSymbol: G.id(SYMBOL),
  variableSymbol: G.id(SYMBOL),
  specificSymbol: G.id(SYMBOL),
  userIdentification: G.text(),
  messageForRecipient: G.text(),
  type: G.text(),
  executedBy: G.text(),
  details: G.text(),
  comment: G.text(),
  payerReference: G.text(),
} satisfies Partial<Record<keyof Transaction, GuardSpec>>);

const INFO_GUARD = G.struct({
  accountId: G.id(CZECH_ACCOUNT),
  bankId: G.id(BANK_CODE),
  currency: G.id(CURRENCY),
  iban: G.id(IBAN),
  bic: G.id(BIC),
  dateStart: G.id(DATE),
  dateEnd: G.id(DATE),
} satisfies Partial<Record<keyof StatementInfo, GuardSpec>>);

/** A statement or a page of transactions (`info` and `transactions` where present). */
export const STATEMENT_GUARD = G.struct({ info: INFO_GUARD, transactions: G.array(TRANSACTION_GUARD) });

const EXCERPT_LEAD = " Response: ";

/**
 * Marks the excerpt of an error message persisted before excerpts were
 * marked (a sync's `lastError` from an older version): everything after
 * " Response: " (src/errors.ts) is bank text. Fails closed to the end.
 */
export const markLegacyExcerpt = (text: string): string => {
  if (hasMarks(text)) return text;
  const at = text.indexOf(EXCERPT_LEAD);
  if (at === -1) return text;
  const start = at + EXCERPT_LEAD.length;
  return text.slice(0, start) + markUntrusted(text.slice(start));
};
