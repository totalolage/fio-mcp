import { csrfField, type Flash, hidden } from "@mcps/core/admin/pages.js";
import { ADMIN_PATH } from "@mcps/core/admin/sessions.js";
import { type AdminGrantSettings, type AdminGrantView, field } from "@mcps/core/admin/tab.js";
import type { GrantSettings } from "@mcps/core/oauth/grant-settings.js";
import { escapeHtml } from "@mcps/core/oauth/pages.js";
import type { OAuthStore } from "@mcps/core/oauth/store.js";
import { Clock, Effect, Result } from "effect";
import { SCOPE_PAYMENTS } from "../mcp/permissions.js";
import { paymentSettingsFields, readGrantPayments } from "../oauth/grant-payments.js";
import { type PaymentFormValues, parsePaymentForm, paymentFormValues, readPaymentForm } from "../payment-form.js";
import type { PaymentLimits } from "../payment-limits.js";

/**
 * The connected-clients tab's per-grant payment settings: a grant with
 * fio:payments gets a form for its payment limits and payee allowlist,
 * never above the server ceilings (SEC-26, SEC-27). `codec` is
 * `grantPaymentSettings(ceiling)`, and `oauth` is built with it.
 */

interface GrantPaymentsRow {
  readonly values: PaymentFormValues;
  /** The stored limits are null: the grant follows the server defaults. */
  readonly followsDefaults: boolean;
}

const grantPaymentsRow = (csrf: string, grantId: string, payments: GrantPaymentsRow, ceiling: PaymentLimits) => `
<tr><td colspan="5"><details><summary>Payment limits and payee allowlist (${escapeHtml(payments.values.mode)}${payments.followsDefaults ? ", limits follow the server defaults" : ""})</summary>
<p class="muted">Grant <code>${escapeHtml(grantId)}</code>. Saving stores these limits for this grant; they never exceed the server ceilings.</p>
<form method="post" action="/admin/grants/payments">${csrfField(csrf)}${hidden("grant", grantId)}
${paymentSettingsFields(payments.values, ceiling)}
<button type="submit">Save payment settings</button></form>
<p><a href="/admin/payments?grant=${encodeURIComponent(grantId)}">Payment audit of this grant</a></p></details></td></tr>`;

export const makeGrantPaymentSettings = (oauth: OAuthStore, codec: GrantSettings, ceiling: PaymentLimits): AdminGrantSettings => {
  const render = (grant: AdminGrantView, csrf: string) => {
    if (!grant.scopes.includes(SCOPE_PAYMENTS)) return "";
    const payments = readGrantPayments(grant.settings);
    return grantPaymentsRow(
      csrf,
      grant.grantId,
      { values: paymentFormValues(payments, ceiling), followsDefaults: payments.limits === null },
      ceiling,
    );
  };

  /** A live grant's payment limits and allowlist, never above the ceilings (SEC-26, SEC-27). */
  const updateGrantPayments = Effect.fnUntraced(
    function* (form: URLSearchParams) {
      const grantId = field(form, "grant") ?? "";
      const parsed = parsePaymentForm(readPaymentForm(form), ceiling);
      if (Result.isFailure(parsed)) return { kind: "error", text: `Payment settings not saved: ${parsed.failure}` } satisfies Flash;
      const now = yield* Clock.currentTimeMillis;
      const grant = (yield* oauth.listGrants(now)).find((candidate) => candidate.grantId === grantId);
      if (grant === undefined || !grant.scopes.includes(SCOPE_PAYMENTS)) {
        return { kind: "error", text: "That authorization is no longer active or cannot submit payments." } satisfies Flash;
      }
      if (!(yield* oauth.updateGrantSettings(grantId, parsed.success, now))) {
        return { kind: "error", text: "That authorization is no longer active." } satisfies Flash;
      }
      yield* Effect.logInfo(`admin: changed the payment settings of a grant (allowlist ${parsed.success.allowlist.mode})`);
      return { kind: "ok", text: "Saved the payment limits and payee allowlist." } satisfies Flash;
    },
    Effect.mapError((error) => ({ message: error.description })),
  );

  return {
    codec,
    render,
    actions: [{ path: `${ADMIN_PATH}/grants/payments`, run: updateGrantPayments }],
  };
};
