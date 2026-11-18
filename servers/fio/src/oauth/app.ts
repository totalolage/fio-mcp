import type { OAuthApp } from "@mcps/core/oauth/app.js";
import { FIO_APP } from "../identity.js";
import { SCOPE_PAYMENTS, SCOPE_READ, SCOPES } from "../mcp/permissions.js";

/**
 * fio-mcp's side of the authorization server: its scopes (fio:read is always
 * granted, fio:payments only when the owner ticks its consent checkbox, which
 * is never pre-ticked) and the consent page's words for FIO accounts.
 */
export const fioOAuthApp: OAuthApp = {
  identity: FIO_APP,
  scopes: {
    supported: SCOPES,
    defaults: [SCOPE_READ],
    challenge: SCOPE_READ,
    granted: (form) => (form.getAll("scope").includes(SCOPE_PAYMENTS) ? [SCOPE_READ, SCOPE_PAYMENTS] : [SCOPE_READ]),
  },
  consent: {
    tools: "your FIO bank tools",
    // The box is ticked only when the owner's own submission (`posted`, a
    // page shown again after an error) ticked it.
    permissions: (requested, posted) =>
      `<label><input type="checkbox" checked disabled> Read accounts, transactions, statements and the local cache; sync; move the download marker (<code>${SCOPE_READ}</code>, required)</label>
<label><input type="checkbox" id="payments" name="scope" value="${SCOPE_PAYMENTS}"${posted?.getAll("scope").includes(SCOPE_PAYMENTS) === true ? " checked" : ""}> Preview payment orders and submit them to FIO for signing in Internetbanking (<code>${SCOPE_PAYMENTS}</code>)</label>
${requested.includes(SCOPE_PAYMENTS) ? `<p class="warn">The application asks to submit payment orders. They create real batches at FIO that must still be signed in Internetbanking. Tick the box only if you want this.</p>` : ""}`,
    resources: {
      legend: "Accounts",
      field: "account",
      plural: "accounts",
      changed: "The accounts changed while this page was open. Review the selection and approve again.",
      none: "No FIO accounts are configured yet. Add one at /admin first.",
      noneSelected: "Select at least one account.",
    },
  },
};
