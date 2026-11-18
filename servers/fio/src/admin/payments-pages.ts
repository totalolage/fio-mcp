import { formatTime } from "@mcps/core/admin/pages.js";
import { escapeHtml } from "@mcps/core/oauth/pages.js";
import type { AuditRow } from "../payment-ledger.js";
import { formatCents } from "../payments.js";

const totalsText = (totals: AuditRow["totals"]) =>
  Object.keys(totals)
    .sort()
    .map((currency) => `${formatCents(totals[currency] ?? 0)} ${escapeHtml(currency)}`)
    .join(", ") || "none";

const payeeText = (payee: AuditRow["payees"][number]) =>
  `<code>${escapeHtml(payee.payee)}</code>${payee.bankCode === null ? "" : ` (bank ${escapeHtml(payee.bankCode)})`}${
    payee.bic === null ? "" : ` (BIC ${escapeHtml(payee.bic)})`
  }: ${escapeHtml(payee.amount.toFixed(2))} ${escapeHtml(payee.currency)}${payee.vs === null ? "" : `, VS ${escapeHtml(payee.vs)}`}`;

const auditRow = (row: AuditRow) => `<tr>
<td>${formatTime(row.createdAt)}<br><span class="muted">${escapeHtml(row.pragueDay)} (Prague)</span></td>
<td><a href="/admin/payments?grant=${encodeURIComponent(row.grantId)}"><code>${escapeHtml(row.grantId)}</code></a>${
  row.clientId === null ? "" : `<br><span class="muted">client <code>${escapeHtml(row.clientId)}</code></span>`
}</td>
<td>${row.accountName === null ? "" : escapeHtml(row.accountName)}</td>
<td><strong>${escapeHtml(row.outcome)}</strong>${row.reason === null ? "" : `<br><span class="muted">${escapeHtml(row.reason)}</span>`}${
  row.fioErrorCode === null ? "" : `<br><span class="muted">${escapeHtml(row.fioErrorCode)}</span>`
}</td>
<td>${row.orderCount}<br>${totalsText(row.totals)}</td>
<td>${row.payees.map(payeeText).join("<br>")}</td>
<td>${row.batchIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}${
  row.idempotencyKey === null ? "" : `<br><span class="muted">key <code>${escapeHtml(row.idempotencyKey)}</code></span>`
}</td>
</tr>`;

export interface PaymentsPage {
  /** Newest first. */
  readonly rows: ReadonlyArray<AuditRow>;
  /** The grant filter, if any. */
  readonly grant: string | undefined;
  /** The link to the next (older) page, when this one is full. */
  readonly older: string | undefined;
}

export const paymentsBody = (page: PaymentsPage): string =>
  `<h1>Payment audit</h1>
<p class="muted">Every <code>submit_payment_orders</code> call that passed validation, newest first. Rows are kept at least 365 days; <code>fio-mcp payments purge --before YYYY-MM-DD</code> deletes older ones.</p>
${page.grant === undefined ? "" : `<p>Showing grant <code>${escapeHtml(page.grant)}</code> only. <a href="/admin/payments">Show all</a></p>`}
${
  page.rows.length === 0
    ? "<p>No payment submissions.</p>"
    : `<table><thead><tr><th>Submitted</th><th>Grant</th><th>Account</th><th>Outcome</th><th>Orders</th><th>Payees</th><th>Batch</th></tr></thead><tbody>
${page.rows.map(auditRow).join("\n")}
</tbody></table>`
}
${page.older === undefined ? "" : `<p><a href="${escapeHtml(page.older)}">Older submissions</a></p>`}`;
