import { type GrantSettings, GrantSettingsError } from "@mcps/core/oauth/grant-settings.js";
import { escapeHtml } from "@mcps/core/oauth/pages.js";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { Migrations } from "../cache/db.js";
import { SCOPE_PAYMENTS } from "../mcp/permissions.js";
import { ceilingText, PAYMENT_FIELDS, type PaymentFormValues, parsePaymentForm, readPaymentForm } from "../payment-form.js";
import {
  DEFAULT_GRANT_PAYMENTS,
  type GrantPayments,
  OFF_ALLOWLIST,
  PayeeAllowlistSchema,
  type PaymentLimits,
  PaymentLimitsSchema,
} from "../payment-limits.js";

/**
 * A grant's payment limits and payee allowlist (SEC-26, SEC-27) as the
 * grant's app settings (core GrantSettings): their oauth_grants columns, the
 * codec the OAuth store reads and writes them with, the consent form that
 * sets them, and the one reader every consumer narrows a grant's or
 * principal's settings with (`readGrantPayments`).
 */

/**
 * Ids share one sequence with the cache's and the OAuth store's migrations:
 * 0008 follows the accounts' 0007. NULL limits follow the server defaults; a
 * NULL allowlist is mode "off", so grants from before this migration keep
 * working under the server-default limits.
 */
export const GRANT_PAYMENT_MIGRATIONS: Migrations = {
  "0008_grant_payment_settings": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE oauth_grants ADD COLUMN payment_limits_json TEXT`;
    yield* sql`ALTER TABLE oauth_grants ADD COLUMN payee_allowlist_json TEXT`;
  }),
};

const GrantPaymentsSchema = Schema.Struct({
  limits: Schema.NullOr(PaymentLimitsSchema),
  allowlist: PayeeAllowlistSchema,
});
/**
 * A grant's (or principal's) settings as GrantPayments. Absent settings (the
 * stdio and unauthenticated principals) are the server defaults with the
 * allowlist off; anything that is not valid GrantPayments fails the
 * assertion (a defect where an Effect runs it), never something more
 * permissive. A valid value is returned as is.
 */
export const readGrantPayments = (settings: unknown): GrantPayments => {
  if (settings === undefined) return DEFAULT_GRANT_PAYMENTS;
  Schema.asserts(GrantPaymentsSchema, settings);
  return settings;
};

const LimitsJson = Schema.fromJsonString(PaymentLimitsSchema);
const AllowlistJson = Schema.fromJsonString(PayeeAllowlistSchema);
const encodeLimits = Schema.encodeSync(LimitsJson);
const encodeAllowlist = Schema.encodeSync(AllowlistJson);

/**
 * The grant settings of fio-mcp: limits and allowlist in their 0008 columns,
 * set on the consent page within `ceiling` (the server's limits).
 */
export const grantPaymentSettings = (ceiling: PaymentLimits): GrantSettings => ({
  label: "payment settings",
  columns: ["payment_limits_json", "payee_allowlist_json"],
  // A stored setting that does not decode fails the read; it never falls
  // back to something more permissive.
  decode: Effect.fnUntraced(function* (row) {
    const limits =
      row.payment_limits_json === null ? null : yield* Schema.decodeUnknownEffect(LimitsJson)(row.payment_limits_json);
    const allowlist =
      row.payee_allowlist_json === null
        ? OFF_ALLOWLIST
        : yield* Schema.decodeUnknownEffect(AllowlistJson)(row.payee_allowlist_json);
    return limits === null && allowlist === OFF_ALLOWLIST ? DEFAULT_GRANT_PAYMENTS : { limits, allowlist };
  }, Effect.mapError((error) => new GrantSettingsError({ message: `grant payment settings: ${error.message}` }))),
  // Defaults stay NULL.
  encode: (value) => {
    const payments = readGrantPayments(value);
    return {
      payment_limits_json: payments.limits === null ? null : encodeLimits(payments.limits),
      payee_allowlist_json:
        payments.allowlist.mode === "off" && payments.allowlist.entries.length === 0
          ? null
          : encodeAllowlist(payments.allowlist),
    };
  },
  // Explicit limits and allowlist as submitted, never above the ceilings
  // (SEC-26, SEC-27). Without fio:payments the settings are unused: server
  // defaults, allowlist off.
  fromConsent: (form, granted) => {
    if (!granted.includes(SCOPE_PAYMENTS)) return Effect.succeed(DEFAULT_GRANT_PAYMENTS);
    const parsed = parsePaymentForm(readPaymentForm(form), ceiling);
    return Result.isFailure(parsed)
      ? Effect.fail({ message: `Payment settings: ${parsed.failure}` })
      : Effect.succeed(parsed.success);
  },
});

const MODE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["off", "Off: orders to any payee (the default)."],
  ["enforce", "Enforce: refuse orders to payees not on the list. Recommended for AI agents."],
  [
    "confirm",
    "Confirm: hold every batch until an admin approves it at /admin/payments/pending; held batches are dropped after 24 hours.",
  ],
];

/**
 * The payment limit and payee allowlist fields (SEC-26, SEC-27), shared with
 * /admin/clients. No `required` or `pattern`: the consent page hides them
 * while payments are not ticked, and the server validates.
 */
export const paymentSettingsFields = (values: PaymentFormValues, ceiling: PaymentLimits): string => {
  const text = (name: string, label: string, value: string) =>
    `<label>${label} <input type="text" name="${name}" value="${escapeHtml(value)}" autocomplete="off" spellcheck="false"></label>`;
  const modes = MODE_LABELS.map(
    ([mode, label]) =>
      `<label><input type="radio" name="${PAYMENT_FIELDS.mode}" value="${mode}"${values.mode === mode ? " checked" : ""}> ${escapeHtml(label)}</label>`,
  ).join("\n");
  return `<p class="muted">Limits apply per Europe/Prague calendar day; a currency not listed in both maps cannot be paid. Format <code>CUR:amount</code>, comma-separated. Server ceilings: ${escapeHtml(ceilingText(ceiling))}.</p>
${text(PAYMENT_FIELDS.maxPerOrder, "Maximum per order", values.maxPerOrder)}
${text(PAYMENT_FIELDS.maxPerDay, "Maximum per day", values.maxPerDay)}
${text(PAYMENT_FIELDS.maxOrdersPerDay, "Maximum orders per day (all currencies)", values.maxOrdersPerDay)}
<fieldset><legend>Payee allowlist</legend>
${modes}
<label>Payees, one per line: <code>[prefix-]number/bankcode</code> or an IBAN, optionally followed by <code>, label</code>
<textarea name="${PAYMENT_FIELDS.allowlist}" rows="4" spellcheck="false">${escapeHtml(values.allowlist)}</textarea></label>
</fieldset>`;
};

/** Consent-page CSS: payment settings show only while the payments box is ticked (no script under the CSP). */
export const PAYMENT_STYLE =
  "label.inline{display:inline}.payment-settings{display:none}#payments:checked~.payment-settings{display:block}" +
  ".payment-settings input[type=text],.payment-settings textarea{width:100%;padding:.4rem;font-size:1rem;box-sizing:border-box}";
