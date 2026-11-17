import { Result } from "effect";
import {
  ALLOWLIST_MODES,
  checkWithinCeiling,
  formatAllowlist,
  formatLimitMap,
  type GrantPayments,
  type PaymentLimits,
  parseAllowlistLines,
  parseLimitMap,
  parseOrdersPerDay,
  validateLimits,
} from "./payment-limits.js";

/**
 * The payment settings form shared by the consent page (SEC-04) and
 * /admin/clients (SEC-26, SEC-27): limits and the payee allowlist of one
 * grant. Values stay the text the owner typed, so a refused form is shown
 * again with the owner's own values.
 */
export interface PaymentFormValues {
  readonly maxPerOrder: string;
  readonly maxPerDay: string;
  readonly maxOrdersPerDay: string;
  readonly mode: string;
  readonly allowlist: string;
}

/** Form field names. */
export const PAYMENT_FIELDS = {
  maxPerOrder: "payMaxPerOrder",
  maxPerDay: "payMaxPerDay",
  maxOrdersPerDay: "payMaxOrdersPerDay",
  mode: "payAllowlistMode",
  allowlist: "payAllowlist",
} as const satisfies Record<keyof PaymentFormValues, string>;

/** The form for stored settings; limits that follow the server defaults show the ceiling. */
export const paymentFormValues = (payments: GrantPayments, ceiling: PaymentLimits): PaymentFormValues => {
  const limits = payments.limits ?? ceiling;
  return {
    maxPerOrder: formatLimitMap(limits.maxPerOrder),
    maxPerDay: formatLimitMap(limits.maxPerDay),
    maxOrdersPerDay: String(limits.maxOrdersPerDay),
    mode: payments.allowlist.mode,
    allowlist: formatAllowlist(payments.allowlist.entries),
  };
};

/** The submitted values; a missing or repeated field reads as empty, which then fails validation. */
export const readPaymentForm = (form: URLSearchParams): PaymentFormValues => {
  const one = (name: string) => {
    const values = form.getAll(name);
    return values.length === 1 ? (values[0] ?? "") : "";
  };
  return {
    maxPerOrder: one(PAYMENT_FIELDS.maxPerOrder),
    maxPerDay: one(PAYMENT_FIELDS.maxPerDay),
    maxOrdersPerDay: one(PAYMENT_FIELDS.maxOrdersPerDay),
    mode: one(PAYMENT_FIELDS.mode),
    allowlist: one(PAYMENT_FIELDS.allowlist),
  };
};

/**
 * Explicit grant settings from the form, or one message listing every
 * problem: syntax, per-order above per-day, a currency or value above the
 * server ceiling (D5), a bad allowlist line. The message never repeats a
 * submitted value.
 */
export function parsePaymentForm(values: PaymentFormValues, ceiling: PaymentLimits): Result.Result<GrantPayments, string> {
  const problems: Array<string> = [];
  const perOrder = parseLimitMap(values.maxPerOrder);
  if (Result.isFailure(perOrder)) problems.push(`Maximum per order: ${perOrder.failure}.`);
  const perDay = parseLimitMap(values.maxPerDay);
  if (Result.isFailure(perDay)) problems.push(`Maximum per day: ${perDay.failure}.`);
  const orders = parseOrdersPerDay(values.maxOrdersPerDay);
  if (Result.isFailure(orders)) problems.push(`Maximum orders per day: ${orders.failure}.`);
  const mode = ALLOWLIST_MODES.find((candidate) => candidate === values.mode);
  if (mode === undefined) problems.push(`Payee allowlist: choose ${ALLOWLIST_MODES.join(", ")}.`);
  const entries = parseAllowlistLines(values.allowlist);
  if (Result.isFailure(entries)) problems.push(`Payee allowlist: ${entries.failure}`);
  if (
    problems.length > 0 ||
    Result.isFailure(perOrder) ||
    Result.isFailure(perDay) ||
    Result.isFailure(orders) ||
    Result.isFailure(entries) ||
    mode === undefined
  ) {
    return Result.fail(problems.join(" "));
  }
  const limits: PaymentLimits = { maxPerOrder: perOrder.success, maxPerDay: perDay.success, maxOrdersPerDay: orders.success };
  const invalid = [...validateLimits(limits), ...checkWithinCeiling(limits, ceiling)];
  if (invalid.length > 0) return Result.fail(invalid.join(" "));
  return Result.succeed({ limits, allowlist: { mode, entries: entries.success } });
}

/** One line describing the ceilings, for the forms. */
export const ceilingText = (ceiling: PaymentLimits): string =>
  `per order ${formatLimitMap(ceiling.maxPerOrder)}; per day ${formatLimitMap(ceiling.maxPerDay)}; ${ceiling.maxOrdersPerDay} orders per day`;
