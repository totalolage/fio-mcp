import { Result, Schema } from "effect";
import { containsGuardMarkers, FREE_TEXT_CAP, sanitiseUntrusted } from "./mcp/untrusted.js";
import { compact, isValidIban, MAX_AMOUNT, type PaymentOrder } from "./payments.js";

/**
 * Payment limits and the payee allowlist of a grant (SEC-26, SEC-27), and the
 * provenance check on submitted orders (SEC-28). Pure: the ledger and the
 * submit flow (src/payment-controls.ts) supply the usage and act on the
 * results.
 *
 * Amounts are major units (≤ 2 decimals) at the edges and integer cents in
 * every comparison, so 0.1 + 0.2 never exceeds 0.3.
 */

/** Currency (ISO 4217) -> amount in major units, > 0, at most 2 decimals. */
export type CurrencyAmounts = Readonly<Record<string, number>>;

export interface PaymentLimits {
  readonly maxPerOrder: CurrencyAmounts;
  /** Sum of a grant's submitted amounts on one Europe/Prague calendar day. */
  readonly maxPerDay: CurrencyAmounts;
  /** Orders per Europe/Prague calendar day, all currencies together. */
  readonly maxOrdersPerDay: number;
}

export type AllowlistMode = (typeof MODES)[number];
const MODES = ["off", "enforce", "confirm"] as const;
export const ALLOWLIST_MODES: ReadonlyArray<AllowlistMode> = MODES;

export interface PayeeEntry {
  /** Normalised by `normaliseAccount`. */
  readonly account: string;
  readonly label?: string;
}

export interface PayeeAllowlist {
  readonly mode: AllowlistMode;
  readonly entries: ReadonlyArray<PayeeEntry>;
}

export interface GrantPayments {
  /** `null` follows the server defaults (the configured ceilings). */
  readonly limits: PaymentLimits | null;
  readonly allowlist: PayeeAllowlist;
}

export const OFF_ALLOWLIST: PayeeAllowlist = { mode: "off", entries: [] };
export const DEFAULT_GRANT_PAYMENTS: GrantPayments = { limits: null, allowlist: OFF_ALLOWLIST };

export const DEFAULT_PAYMENT_LIMITS: PaymentLimits = {
  maxPerOrder: { CZK: 50_000, EUR: 2_000 },
  maxPerDay: { CZK: 100_000, EUR: 4_000 },
  maxOrdersPerDay: 20,
};

export const MAX_ALLOWLIST_ENTRIES = 200;
export const MAX_PAYEE_LABEL = 100;

const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT_TEXT = /^\d+(\.\d{1,2})?$/;
const DOMESTIC = /^(?:(\d{1,6})-)?(\d{1,10})\/(\d{4})$/;
// Control, format and line/paragraph separators: a label is one visible line.
const LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

export const toCents = (amount: number): number => Math.round(amount * 100);

export const formatCents = (cents: number): string => {
  const whole = Math.round(cents);
  const abs = Math.abs(whole);
  return `${whole < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

const isAmount = (value: number): boolean =>
  Number.isFinite(value) && value > 0 && value <= MAX_AMOUNT && Number(value.toFixed(2)) === value;

const has = (map: CurrencyAmounts, currency: string): boolean => Object.hasOwn(map, currency);
const amountOf = (map: CurrencyAmounts, currency: string): number | undefined =>
  has(map, currency) ? map[currency] : undefined;

/** Currencies listed in both maps, sorted. */
const allowedCurrencies = (limits: PaymentLimits): ReadonlyArray<string> =>
  Object.keys(limits.maxPerOrder)
    .filter((c) => has(limits.maxPerDay, c))
    .sort();

const isValidLabel = (label: string): boolean =>
  Array.from(label).length <= MAX_PAYEE_LABEL && !LABEL_FORBIDDEN.test(label);

// --- Limit maps --------------------------------------------------------------

/**
 * Parses `CZK:50000,EUR:2000`: comma-separated `CUR:amount` items, whitespace
 * around items and the colon tolerated. Errors name the item number and never
 * echo the input.
 */
export function parseLimitMap(text: string): Result.Result<Record<string, number>, string> {
  if (text.trim() === "") return Result.fail("must list at least one currency, e.g. CZK:50000");
  const map: Record<string, number> = {};
  const items = text.split(",");
  for (const [index, raw] of items.entries()) {
    const n = index + 1;
    const item = raw.trim();
    if (item === "") return Result.fail(`item ${n} is empty`);
    const parts = item.split(":");
    if (parts.length !== 2) return Result.fail(`item ${n} must have the form CUR:amount`);
    const currency = (parts[0] ?? "").trim();
    const amountText = (parts[1] ?? "").trim();
    if (!CURRENCY.test(currency)) {
      return Result.fail(`item ${n}: the currency must be three upper-case letters (ISO 4217)`);
    }
    const amount = Number(amountText);
    if (!AMOUNT_TEXT.test(amountText) || !isAmount(amount)) {
      return Result.fail(
        `item ${n}: the amount must be a number above 0 and at most ${MAX_AMOUNT} with at most two decimal places`,
      );
    }
    if (has(map, currency)) return Result.fail(`item ${n} repeats a currency listed earlier`);
    map[currency] = amount;
  }
  return Result.succeed(map);
}

/** `CZK:50000,EUR:2000`, currencies sorted; `parseLimitMap` reads it back unchanged. */
export function formatLimitMap(map: CurrencyAmounts): string {
  return Object.keys(map)
    .sort()
    .map((currency) => `${currency}:${String(map[currency])}`)
    .join(",");
}

/** A whole number of at least 1. Never echoes the input. */
export function parseOrdersPerDay(text: string): Result.Result<number, string> {
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value < 1) {
    return Result.fail("must be a whole number of at least 1");
  }
  return Result.succeed(value);
}

/** Consistency of one set of limits: same currencies in both maps, per-order ≤ per-day. */
export function validateLimits(limits: PaymentLimits): ReadonlyArray<string> {
  const problems: Array<string> = [];
  for (const currency of Object.keys(limits.maxPerOrder).sort()) {
    if (!has(limits.maxPerDay, currency)) problems.push(`${currency} has a per-order limit but no daily limit.`);
  }
  for (const currency of Object.keys(limits.maxPerDay).sort()) {
    if (!has(limits.maxPerOrder, currency)) problems.push(`${currency} has a daily limit but no per-order limit.`);
  }
  for (const currency of allowedCurrencies(limits)) {
    const perOrder = toCents(limits.maxPerOrder[currency] ?? 0);
    const perDay = toCents(limits.maxPerDay[currency] ?? 0);
    if (perOrder > perDay) {
      problems.push(
        `The per-order limit for ${currency} (${formatCents(perOrder)}) exceeds its daily limit (${formatCents(perDay)}).`,
      );
    }
  }
  return problems;
}

/**
 * Problems with `limits` against the server ceiling (D5): a currency the
 * ceiling does not list, or any value above it. Listing fewer currencies is
 * fine.
 */
export function checkWithinCeiling(limits: PaymentLimits, ceiling: PaymentLimits): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const allowed = allowedCurrencies(ceiling);
  const unknown = new Set<string>();
  const check = (map: CurrencyAmounts, ceilingMap: CurrencyAmounts, what: string) => {
    for (const currency of Object.keys(map).sort()) {
      const cap = amountOf(ceilingMap, currency);
      if (cap === undefined || !allowed.includes(currency)) {
        unknown.add(currency);
        continue;
      }
      const value = toCents(map[currency] ?? 0);
      if (value > toCents(cap)) {
        problems.push(
          `The ${what} limit for ${currency} (${formatCents(value)}) is above the server ceiling (${formatCents(toCents(cap))}).`,
        );
      }
    }
  };
  check(limits.maxPerOrder, ceiling.maxPerOrder, "per-order");
  check(limits.maxPerDay, ceiling.maxPerDay, "daily");
  const notAllowed = [...unknown]
    .sort()
    .map((currency) => `${currency} is not allowed by the server (allowed: ${allowedList(allowed)}).`);
  if (limits.maxOrdersPerDay > ceiling.maxOrdersPerDay) {
    problems.push(
      `The daily order limit (${limits.maxOrdersPerDay}) is above the server ceiling (${ceiling.maxOrdersPerDay}).`,
    );
  }
  return [...notAllowed, ...problems];
}

const allowedList = (currencies: ReadonlyArray<string>): string =>
  currencies.length === 0 ? "none" : currencies.join(", ");

/**
 * The limits enforced for a grant (D5): per currency the lower of grant and
 * ceiling, only for currencies both list in both maps. `null` follows the
 * ceiling, so lowering the ceiling lowers every grant.
 */
export function effectiveLimits(limits: PaymentLimits | null, ceiling: PaymentLimits): PaymentLimits {
  if (limits === null) return ceiling;
  const maxPerOrder: Record<string, number> = {};
  const maxPerDay: Record<string, number> = {};
  const grantCurrencies = new Set(allowedCurrencies(limits));
  for (const currency of allowedCurrencies(ceiling)) {
    if (!grantCurrencies.has(currency)) continue;
    maxPerOrder[currency] = Math.min(limits.maxPerOrder[currency] ?? 0, ceiling.maxPerOrder[currency] ?? 0);
    maxPerDay[currency] = Math.min(limits.maxPerDay[currency] ?? 0, ceiling.maxPerDay[currency] ?? 0);
  }
  return { maxPerOrder, maxPerDay, maxOrdersPerDay: Math.min(limits.maxOrdersPerDay, ceiling.maxOrdersPerDay) };
}

// --- Payees and the allowlist ------------------------------------------------

/**
 * The canonical form of an allowlist account (D6, R7): a domestic
 * `[prefix-]number/bankcode` with the leading zeros of prefix and number
 * stripped (an all-zero prefix is dropped), or an IBAN compacted and
 * upper-cased with a valid checksum. Anything else is `undefined`.
 */
export function normaliseAccount(text: string): string | undefined {
  const trimmed = text.trim();
  const domestic = DOMESTIC.exec(trimmed);
  if (domestic) {
    const prefix = (domestic[1] ?? "").replace(/^0+/, "");
    const number = (domestic[2] ?? "").replace(/^0+/, "") || "0";
    return `${prefix === "" ? "" : `${prefix}-`}${number}/${domestic[3]}`;
  }
  const iban = compact(trimmed);
  return isValidIban(iban) ? iban : undefined;
}

/**
 * Reads the allowlist form field: one `<account>[, <label>]` per line, blank
 * lines ignored, duplicates collapsed (the first wins). Errors name the line
 * and never echo it.
 */
export function parseAllowlistLines(text: string): Result.Result<ReadonlyArray<PayeeEntry>, string> {
  const entries: Array<PayeeEntry> = [];
  const seen = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const comma = line.indexOf(",");
    const account = normaliseAccount(comma < 0 ? line : line.slice(0, comma));
    if (account === undefined) {
      return Result.fail(
        `Line ${index + 1}: the account must be a Czech account ([prefix-]number/bankcode) or a valid IBAN.`,
      );
    }
    const label = comma < 0 ? "" : line.slice(comma + 1).trim();
    if (!isValidLabel(label)) {
      return Result.fail(
        `Line ${index + 1}: the label must be one line of at most ${MAX_PAYEE_LABEL} characters without control characters.`,
      );
    }
    if (seen.has(account)) continue;
    seen.add(account);
    entries.push(label === "" ? { account } : { account, label });
  }
  if (entries.length > MAX_ALLOWLIST_ENTRIES) {
    return Result.fail(`The allowlist may hold at most ${MAX_ALLOWLIST_ENTRIES} payees.`);
  }
  return Result.succeed(entries);
}

/** The inverse of `parseAllowlistLines`. */
export function formatAllowlist(entries: ReadonlyArray<PayeeEntry>): string {
  return entries.map((e) => (e.label === undefined || e.label === "" ? e.account : `${e.account}, ${e.label}`)).join("\n");
}

/** One order as the ledger records it (D10 `payees_json`). */
export interface PayeeRecord {
  /** The D6 identity: normalised domestic account, or the compacted IBAN / account. */
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
        payee: normaliseAccount(account) ?? account,
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

/** Distinct payees (first-seen order) that the allowlist does not list, whatever its mode. */
export function unlistedPayees(allowlist: PayeeAllowlist, payees: ReadonlyArray<PayeeRecord>): ReadonlyArray<string> {
  const listed = new Set(allowlist.entries.map((e) => e.account));
  const unlisted = new Set<string>();
  for (const { payee } of payees) if (!listed.has(payee)) unlisted.add(payee);
  return [...unlisted];
}

// --- Limit evaluation --------------------------------------------------------

/** A grant's usage on one Prague day. */
export interface Usage {
  /** Currency -> integer cents. */
  readonly totals: Readonly<Record<string, number>>;
  readonly orders: number;
}

/** Major units; `usedToday` and `remainingToday` are before the batch. */
export interface CurrencyAllowance {
  readonly maxPerOrder: number;
  readonly maxPerDay: number;
  readonly usedToday: number;
  readonly remainingToday: number;
}

export interface LimitEvaluation {
  readonly ok: boolean;
  readonly problems: ReadonlyArray<string>;
  readonly perCurrency: Readonly<Record<string, CurrencyAllowance>>;
  readonly maxOrdersPerDay: number;
  readonly ordersToday: number;
  readonly remainingOrdersToday: number;
}

const DAY_NOTE = "today (Europe/Prague)";

/** Checks a batch against effective limits and today's usage, all in integer cents (D1). */
export function evaluateLimits(
  effective: PaymentLimits,
  payees: ReadonlyArray<PayeeRecord>,
  usage: Usage,
): LimitEvaluation {
  const allowed = allowedCurrencies(effective);
  const usedCents = (currency: string): number => (Object.hasOwn(usage.totals, currency) ? (usage.totals[currency] ?? 0) : 0);
  const problems: Array<string> = [];

  const refused = new Set<string>();
  for (const { currency } of payees) {
    if (!allowed.includes(currency) && !refused.has(currency)) {
      refused.add(currency);
      problems.push(`Payments in ${currency} are not allowed for this grant (allowed: ${allowedList(allowed)}).`);
    }
  }

  const batchCents: Record<string, number> = {};
  for (const [index, { amount, currency }] of payees.entries()) {
    if (!allowed.includes(currency)) continue;
    const cents = toCents(amount);
    batchCents[currency] = (batchCents[currency] ?? 0) + cents;
    const limit = toCents(effective.maxPerOrder[currency] ?? 0);
    if (cents > limit) {
      problems.push(
        `Order ${index + 1} (${formatCents(cents)} ${currency}) exceeds the per-order limit for ${currency} of ${formatCents(limit)}.`,
      );
    }
  }

  const perCurrency: Record<string, CurrencyAllowance> = {};
  for (const currency of allowed) {
    const perDay = toCents(effective.maxPerDay[currency] ?? 0);
    const used = usedCents(currency);
    const remaining = Math.max(0, perDay - used);
    perCurrency[currency] = {
      maxPerOrder: toCents(effective.maxPerOrder[currency] ?? 0) / 100,
      maxPerDay: perDay / 100,
      usedToday: used / 100,
      remainingToday: remaining / 100,
    };
    const batch = batchCents[currency] ?? 0;
    if (batch > 0 && used + batch > perDay) {
      problems.push(`Daily limit for ${currency} is ${formatCents(perDay)}; ${formatCents(remaining)} remains ${DAY_NOTE}.`);
    }
  }

  const remainingOrders = Math.max(0, effective.maxOrdersPerDay - usage.orders);
  if (usage.orders + payees.length > effective.maxOrdersPerDay) {
    problems.push(`Daily limit is ${effective.maxOrdersPerDay} orders; ${remainingOrders} remain ${DAY_NOTE}.`);
  }

  return {
    ok: problems.length === 0,
    problems,
    perCurrency,
    maxOrdersPerDay: effective.maxOrdersPerDay,
    ordersToday: usage.orders,
    remainingOrdersToday: remainingOrders,
  };
}

// --- Provenance (SEC-28) -----------------------------------------------------

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

// --- Stored JSON (oauth_grants.payment_limits_json / payee_allowlist_json) ---

const CurrencyAmountsSchema = Schema.Record(Schema.String, Schema.Finite).check(
  Schema.makeFilter((map: CurrencyAmounts) => Object.keys(map).length > 0, {
    message: "must list at least one currency",
  }),
  Schema.makeFilter((map: CurrencyAmounts) => Object.keys(map).every((c) => CURRENCY.test(c)), {
    message: "currencies must be three upper-case letters (ISO 4217)",
  }),
  Schema.makeFilter((map: CurrencyAmounts) => Object.values(map).every(isAmount), {
    message: "amounts must be above 0 with at most two decimal places",
  }),
);

export const PaymentLimitsSchema = Schema.Struct({
  maxPerOrder: CurrencyAmountsSchema,
  maxPerDay: CurrencyAmountsSchema,
  maxOrdersPerDay: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1, { message: "must be at least 1" })),
}).check(
  Schema.makeFilter((limits: PaymentLimits) => validateLimits(limits).length === 0, {
    message: "both maps must list the same currencies, each per-order limit at most its daily limit",
  }),
);

const PayeeEntrySchema = Schema.Struct({
  account: Schema.String.check(
    Schema.makeFilter((account: string) => normaliseAccount(account) === account, {
      message: "must be a normalised Czech account or IBAN",
    }),
  ),
  label: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter(isValidLabel, {
        message: `must be one line of at most ${MAX_PAYEE_LABEL} characters`,
      }),
    ),
  ),
});

export const PayeeAllowlistSchema = Schema.Struct({
  mode: Schema.Literals(MODES),
  entries: Schema.Array(PayeeEntrySchema).check(
    Schema.isMaxLength(MAX_ALLOWLIST_ENTRIES, { message: `must hold at most ${MAX_ALLOWLIST_ENTRIES} entries` }),
    Schema.makeFilter(
      (entries: ReadonlyArray<PayeeEntry>) => new Set(entries.map((e) => e.account)).size === entries.length,
      { message: "must not list an account twice" },
    ),
  ),
});
