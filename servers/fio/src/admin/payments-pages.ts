import { csrfField, formatTime, hidden } from "@mcps/core/admin/pages.js";
import { escapeHtml } from "@mcps/core/oauth/pages.js";
import type { AuditRow } from "../payment-ledger.js";
import { formatCents } from "../payment-limits.js";

/**
 * The bodies of the admin payments tab (SEC-27, SEC-29): the payment audit
 * at /admin/payments and the batches held for approval at
 * /admin/payments/pending. Core's shell adds the nav and the one-shot
 * message.
 */

const totalsText = (totals: Readonly<Record<string, number>>) =>
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
<p>Batches held for approval: <a href="/admin/payments/pending">pending payments</a>.</p>
<p class="muted">Every <code>submit_payment_orders</code> call that passed validation, newest first. Accepted, unknown and held batches count towards the daily limits. Rows are kept at least 365 days; <code>fio-mcp payments purge --before YYYY-MM-DD</code> deletes older ones.</p>
${page.grant === undefined ? "" : `<p>Showing grant <code>${escapeHtml(page.grant)}</code> only. <a href="/admin/payments">Show all</a></p>`}
${
  page.rows.length === 0
    ? "<p>No payment submissions.</p>"
    : `<table><thead><tr><th>Submitted</th><th>Grant</th><th>Account</th><th>Outcome</th><th>Orders</th><th>Payees</th><th>Batch</th></tr></thead><tbody>
${page.rows.map(auditRow).join("\n")}
</tbody></table>`
}
${page.older === undefined ? "" : `<p><a href="${escapeHtml(page.older)}">Older submissions</a></p>`}`;

export interface PendingRow {
  readonly pendingId: string;
  readonly accountName: string | null;
  readonly xml: string;
  readonly xmlSha256: string;
  readonly expiresAt: number;
  readonly audit: AuditRow;
  /** Payees not on the grant's allowlist; undefined when the grant is no longer active. */
  readonly unlisted: ReadonlyArray<string> | undefined;
}

export interface PendingPage {
  readonly csrf: string;
  readonly rows: ReadonlyArray<PendingRow>;
  /** Approving asks for the admin's authentication code (SEC-03). */
  readonly secondFactor: boolean;
}

const payeeMark = (unlisted: ReadonlyArray<string> | undefined, payee: string) => {
  if (unlisted === undefined) return "";
  return unlisted.includes(payee) ? ` <span class="unlisted">not on the allowlist</span>` : ` <span class="muted">listed</span>`;
};

const pendingPayee = (row: PendingRow, payee: AuditRow["payees"][number]) =>
  `<li>${payeeText(payee)}${payeeMark(row.unlisted, payee.payee)}</li>`;

const pendingBlock = (csrf: string, secondFactor: boolean, row: PendingRow) => `<section>
<h2>Batch <code>${escapeHtml(row.pendingId)}</code></h2>
<p>Account ${row.accountName === null ? "(unnamed)" : `“${escapeHtml(row.accountName)}”`}; grant <code>${escapeHtml(row.audit.grantId)}</code>${
  row.audit.clientId === null ? "" : `, client <code>${escapeHtml(row.audit.clientId)}</code>`
}; submitted ${formatTime(row.audit.createdAt)}; dropped unless approved by <strong>${formatTime(row.expiresAt)}</strong>.</p>
${row.unlisted === undefined ? `<p class="error">The authorization that submitted this batch is no longer active, so approving it uploads nothing. Decline it to clear it.</p>` : ""}
<p>${row.audit.orderCount} orders, total ${totalsText(row.audit.totals)}.</p>
<ul>${row.audit.payees.map((payee) => pendingPayee(row, payee)).join("")}</ul>
<p>SHA-256 of the XML uploaded on approval: <code>${escapeHtml(row.xmlSha256)}</code></p>
<details><summary>Exact XML</summary><pre>${escapeHtml(row.xml)}</pre></details>
<form method="post" action="/admin/payments/pending/approve">${csrfField(csrf)}${hidden("pending", row.pendingId)}${
  secondFactor
    ? `<label>Authentication code <input type="text" name="totp" inputmode="numeric" autocomplete="one-time-code" required></label>`
    : ""
}<button type="submit">Approve and upload to FIO</button></form>
<form method="post" action="/admin/payments/pending/decline">${csrfField(csrf)}${hidden("pending", row.pendingId)}<button type="submit">Decline</button></form>
</section>`;

export const pendingBody = (page: PendingPage): string =>
  `<h1>Pending payments</h1>
<p><a href="/admin/payments">Payment audit</a></p>
<p class="muted">Batches from grants whose payee allowlist is in confirm mode wait here for approval. Approving uploads exactly the XML shown; the batch must then still be signed in FIO Internetbanking. Batches not approved within 24 hours are dropped.</p>
${page.rows.length === 0 ? "<p>No batches are waiting.</p>" : page.rows.map((row) => pendingBlock(page.csrf, page.secondFactor, row)).join("\n")}`;
