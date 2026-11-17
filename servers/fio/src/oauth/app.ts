import type { OAuthApp } from "@mcps/core/oauth/app.js";
import { FIO_APP } from "../identity.js";
import { SCOPE_PAYMENTS, SCOPE_READ, SCOPES } from "../mcp/permissions.js";
import { paymentFormValues, readPaymentForm } from "../payment-form.js";
import { DEFAULT_GRANT_PAYMENTS, type PaymentLimits } from "../payment-limits.js";
import { grantPaymentSettings, PAYMENT_STYLE, paymentSettingsFields } from "./grant-payments.js";

/**
 * fio-mcp's side of the authorization server: its scopes (fio:read is always
 * granted, fio:payments only when the owner ticks its consent checkbox, which
 * is never pre-ticked), the payment limits and payee allowlist the consent
 * page sets within `ceiling` (the server's payment limits), and the consent
 * page's words for FIO accounts, whose resource ids are token fingerprints.
 */
export const fioOAuthApp = (ceiling: PaymentLimits): OAuthApp => ({
  identity: FIO_APP,
  scopes: {
    supported: SCOPES,
    defaults: [SCOPE_READ],
    challenge: SCOPE_READ,
    granted: (form) => (form.getAll("scope").includes(SCOPE_PAYMENTS) ? [SCOPE_READ, SCOPE_PAYMENTS] : [SCOPE_READ]),
  },
  grantSettings: grantPaymentSettings(ceiling),
  consent: {
    tools: "your FIO bank tools",
    // The box is ticked only when the owner's own submission (`posted`, a
    // page shown again after an error) ticked it; the fields keep what the
    // owner typed, or start at the server defaults.
    permissions: (requested, posted) =>
      `<label><input type="checkbox" checked disabled> Read accounts, transactions, statements and the local cache; sync; move the download marker (<code>${SCOPE_READ}</code>, required)</label>
<input type="checkbox" id="payments" name="scope" value="${SCOPE_PAYMENTS}"${posted?.getAll("scope").includes(SCOPE_PAYMENTS) === true ? " checked" : ""}> <label class="inline" for="payments">Preview payment orders and submit them to FIO for signing in Internetbanking (<code>${SCOPE_PAYMENTS}</code>)</label>
${requested.includes(SCOPE_PAYMENTS) ? `<p class="warn">The application asks to submit payment orders. They create real batches at FIO that must still be signed in Internetbanking, and the grant's payment limits and payee allowlist below apply. Tick the box only if you want this.</p>` : ""}
<div class="payment-settings">
${paymentSettingsFields(posted === undefined ? paymentFormValues(DEFAULT_GRANT_PAYMENTS, ceiling) : readPaymentForm(posted), ceiling)}
</div>`,
    style: PAYMENT_STYLE,
    resources: {
      legend: "Accounts",
      field: "account",
      plural: "accounts",
      changed: "The accounts changed while this page was open. Review the selection and approve again.",
      none: "No FIO accounts are configured yet. Add one at /admin first.",
      noneSelected: "Select at least one account.",
    },
  },
});
