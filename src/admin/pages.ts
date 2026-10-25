import { DateTime } from "effect";
import { escapeHtml, styleHash } from "../oauth/pages.js";

/**
 * Server-rendered admin pages. Every interpolated value goes through
 * `escapeHtml`; the only style is one inline block allowed by its CSP hash;
 * there is no script. Tokens are never rendered, only their last four
 * characters.
 */

const STYLE =
  "body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b;line-height:1.45}" +
  "h1{font-size:1.4rem}h2{font-size:1.15rem;margin-top:2rem}nav{display:flex;gap:1rem;align-items:center;border-bottom:1px solid #ccc;padding-bottom:.6rem}" +
  "nav form{margin-left:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #e3e3e3;vertical-align:top}" +
  "fieldset{border:1px solid #ccc;border-radius:6px;margin:1rem 0;padding:.5rem 1rem}label{display:block;margin:.35rem 0}" +
  "input[type=text],input[type=password]{width:100%;max-width:28rem;padding:.35rem;font-size:1rem;box-sizing:border-box}" +
  "button{font-size:.95rem;padding:.3rem .9rem;margin:.2rem .4rem .2rem 0}details{margin:.2rem 0}summary{cursor:pointer;color:#0b4f8a}" +
  ".ok{background:#e7f6e7;border:1px solid #7cbf7c;padding:.5rem .75rem;border-radius:6px}" +
  ".error{background:#fde8e8;border:1px solid #d77;padding:.5rem .75rem;border-radius:6px}" +
  ".muted{color:#555;font-size:.9rem}code{word-break:break-all}.danger{color:#a40000}";

export const ADMIN_STYLE_HASH = styleHash(STYLE);

const layout = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;

const hidden = (name: string, value: string) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

export const formatTime = (millis: number | null) =>
  millis === null ? "never" : `${DateTime.formatIso(DateTime.makeUnsafe(millis)).slice(0, 16).replace("T", " ")} UTC`;

export interface Flash {
  readonly kind: "ok" | "error";
  readonly text: string;
}

const flashBlock = (flash: Flash | undefined) =>
  flash === undefined
    ? ""
    : `<p class="${flash.kind === "ok" ? "ok" : "error"}" role="${flash.kind === "ok" ? "status" : "alert"}">${escapeHtml(flash.text)}</p>`;

export type AdminTab = "accounts" | "clients" | "password";

const TABS: ReadonlyArray<readonly [AdminTab, string, string]> = [
  ["accounts", "/admin", "Accounts"],
  ["clients", "/admin/clients", "Connected clients"],
  ["password", "/admin/password", "Admin password"],
];

const signedIn = (tab: AdminTab, csrf: string, flash: Flash | undefined, body: string) =>
  layout(
    `fio-mcp admin: ${TABS.find(([id]) => id === tab)?.[2] ?? ""}`,
    `<nav><strong>fio-mcp admin</strong>${TABS.map(([id, href, label]) =>
      id === tab ? `<span aria-current="page">${label}</span>` : `<a href="${href}">${label}</a>`,
    ).join("")}<form method="post" action="/admin/logout">${csrfField(csrf)}<button type="submit">Sign out</button></form></nav>
${flashBlock(flash)}
${body}`,
  );

export interface AdminLoginPage {
  readonly csrf: string;
  readonly error: string | undefined;
}

export const adminLoginPage = (page: AdminLoginPage): string =>
  layout(
    "fio-mcp admin sign-in",
    `<h1>fio-mcp admin</h1>
${page.error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(page.error)}</p>`}
<form method="post" action="/admin/login">
${csrfField(page.csrf)}
<label for="password">Admin password</label>
<input id="password" type="password" name="password" autocomplete="current-password" required autofocus>
<p><button type="submit">Sign in</button></p>
</form>
<p class="muted">Signed-in sessions end after 15 minutes without activity.</p>`,
  );

export const adminRefusedPage = (): string =>
  layout(
    "fio-mcp admin",
    `<h1>Request refused</h1><p class="error" role="alert">The form could not be verified. <a href="/admin">Reload the page</a> and try again.</p>`,
  );

export interface AccountRow {
  readonly id: string;
  readonly name: string;
  /** Last four characters of the token. */
  readonly tokenHint: string;
  readonly accountNumber: string | undefined;
  readonly currency: string | undefined;
  readonly createdAt: number;
  readonly tokenUpdatedAt: number;
}

const accountRow = (csrf: string, row: AccountRow) => `<tr>
<td><strong>${escapeHtml(row.name)}</strong></td>
<td><code>…${escapeHtml(row.tokenHint)}</code></td>
<td>${escapeHtml(row.accountNumber ?? "learned from statements")}${row.currency === undefined ? "" : ` (${escapeHtml(row.currency)})`}</td>
<td>${formatTime(row.createdAt)}<br><span class="muted">token set ${formatTime(row.tokenUpdatedAt)}</span></td>
<td>
<form method="post" action="/admin/accounts/test">${csrfField(csrf)}${hidden("id", row.id)}<button type="submit">Test token</button></form>
<details><summary>Rename</summary><form method="post" action="/admin/accounts/rename">${csrfField(csrf)}${hidden("id", row.id)}
<label>New name <input type="text" name="name" value="${escapeHtml(row.name)}" maxlength="256" required></label>
<button type="submit">Rename</button><span class="muted">Connected clients keep access.</span></form></details>
<details><summary>Replace token</summary><form method="post" action="/admin/accounts/rotate">${csrfField(csrf)}${hidden("id", row.id)}
<label>New FIO token <input type="password" name="token" autocomplete="off" required></label>
<button type="submit">Replace</button><span class="muted">Connected clients lose this account until they reconnect and select it again.</span></form></details>
<details><summary class="danger">Remove</summary><form method="post" action="/admin/accounts/remove">${csrfField(csrf)}${hidden("id", row.id)}
<label><input type="radio" name="cache" value="keep" checked> Keep cached transactions</label>
<label><input type="radio" name="cache" value="purge"> Delete cached transactions</label>
<label><input type="checkbox" name="confirm" value="yes" required> Remove “${escapeHtml(row.name)}”</label>
<button type="submit">Remove</button></form></details>
</td>
</tr>`;

export interface AccountsPage {
  readonly csrf: string;
  readonly flash: Flash | undefined;
  readonly accounts: ReadonlyArray<AccountRow>;
}

export const accountsPage = (page: AccountsPage): string =>
  signedIn(
    "accounts",
    page.csrf,
    page.flash,
    `<h1>FIO accounts</h1>
<p class="muted">Tokens are stored encrypted and never shown; only their last four characters are. Renaming keeps every client's access; replacing a token removes the account from existing client authorizations.</p>
${
  page.accounts.length === 0
    ? "<p>No accounts yet. Add one below.</p>"
    : `<table><thead><tr><th>Name</th><th>Token</th><th>Account</th><th>Added</th><th>Actions</th></tr></thead><tbody>
${page.accounts.map((row) => accountRow(page.csrf, row)).join("\n")}
</tbody></table>`
}
<h2>Add an account</h2>
<form method="post" action="/admin/accounts/add">
${csrfField(page.csrf)}
<label>Name <input type="text" name="name" maxlength="256" required></label>
<label>FIO token <input type="password" name="token" autocomplete="off" required></label>
<label>Account number (optional, without bank code) <input type="text" name="accountNumber" inputmode="numeric" maxlength="10"></label>
<label>Currency (optional, e.g. CZK) <input type="text" name="currency" maxlength="3"></label>
<p><button type="submit">Add account</button></p>
</form>`,
  );

export interface GrantRow {
  readonly grantId: string;
  readonly scopes: ReadonlyArray<string>;
  /** Names of the configured accounts the grant covers. */
  readonly accounts: ReadonlyArray<string>;
  /** Granted tokens no configured account uses any more. */
  readonly staleTokens: number;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

export interface ClientRow {
  readonly clientId: string;
  readonly clientName: string | null;
  readonly redirectUris: ReadonlyArray<string>;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly grants: ReadonlyArray<GrantRow>;
}

const grantAccounts = (grant: GrantRow) => {
  const names = grant.accounts.map((name) => escapeHtml(name)).join(", ");
  const stale =
    grant.staleTokens === 0 ? "" : `${names === "" ? "" : "; "}<span class="muted">${grant.staleTokens} replaced or removed</span>`;
  return names === "" && stale === "" ? "none" : `${names}${stale}`;
};

const grantRow = (csrf: string, grant: GrantRow) => `<tr>
<td>${grant.scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(" ")}</td>
<td>${grantAccounts(grant)}</td>
<td>${formatTime(grant.createdAt)}</td>
<td>${formatTime(grant.lastUsedAt)}</td>
<td><form method="post" action="/admin/grants/revoke">${csrfField(csrf)}${hidden("grant", grant.grantId)}<button type="submit">Revoke</button></form></td>
</tr>`;

const clientBlock = (csrf: string, client: ClientRow) => `<section>
<h2>${client.clientName === null ? "Unnamed client" : `“${escapeHtml(client.clientName)}”`}</h2>
<p class="muted">The name is supplied by the client and not verified. Client ID <code>${escapeHtml(client.clientId)}</code>. Registered ${formatTime(client.createdAt)}, last authorized ${formatTime(client.lastUsedAt)}.<br>
Redirects to ${client.redirectUris.map((uri) => `<code>${escapeHtml(uri)}</code>`).join(", ")}</p>
${
  client.grants.length === 0
    ? "<p>No active authorization.</p>"
    : `<table><thead><tr><th>Scopes</th><th>Accounts</th><th>Authorized</th><th>Last used</th><th></th></tr></thead><tbody>
${client.grants.map((grant) => grantRow(csrf, grant)).join("\n")}
</tbody></table>`
}
<form method="post" action="/admin/clients/revoke">${csrfField(csrf)}${hidden("client", client.clientId)}<button type="submit">Remove client and revoke its access</button></form>
</section>`;

export interface ClientsPage {
  readonly csrf: string;
  readonly flash: Flash | undefined;
  readonly clients: ReadonlyArray<ClientRow>;
}

export const clientsPage = (page: ClientsPage): string =>
  signedIn(
    "clients",
    page.csrf,
    page.flash,
    `<h1>Connected clients</h1>
<p class="muted">Revoking ends the client's tokens at once; it can connect again only through the sign-in and consent pages.</p>
${page.clients.length === 0 ? "<p>No registered clients.</p>" : page.clients.map((client) => clientBlock(page.csrf, client)).join("\n")}
<h2>Revoke everything</h2>
<form method="post" action="/admin/clients/revoke-all">${csrfField(page.csrf)}
<label><input type="checkbox" name="confirm" value="yes" required> Revoke every client's authorization</label>
<button type="submit">Revoke all</button></form>`,
  );

export interface PasswordPage {
  readonly csrf: string;
  readonly flash: Flash | undefined;
}

export const passwordPage = (page: PasswordPage): string =>
  signedIn(
    "password",
    page.csrf,
    page.flash,
    `<h1>Admin password</h1>
<p class="muted">The password signs in here and on the authorization page MCP clients open. Changing it signs out every other admin session; it then replaces the hash in FIO_MCP_ADMIN_PASSWORD_HASH_FILE until <code>fio-mcp reset-admin-password</code> is run.</p>
<form method="post" action="/admin/password">
${csrfField(page.csrf)}
<label>Current password <input type="password" name="current" autocomplete="current-password" required></label>
<label>New password (12 or more characters) <input type="password" name="next" autocomplete="new-password" minlength="12" required></label>
<label>Repeat the new password <input type="password" name="confirm" autocomplete="new-password" minlength="12" required></label>
<p><button type="submit">Change password</button></p>
</form>`,
  );
