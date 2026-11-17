import { DateTime } from "effect";
import { escapeHtml, styleHash, TOTP_FIELD } from "../oauth/pages.js";

/**
 * Server-rendered admin pages. Every interpolated value goes through
 * `escapeHtml`; the only style is one inline block allowed by its CSP hash;
 * there is no script. The app names the pages (AdminShell) and adds its own
 * tabs, rendered into the same shell with the helpers exported here.
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
  ".muted{color:#555;font-size:.9rem}code{word-break:break-all}.danger{color:#a40000}" +
  "textarea{width:100%;max-width:28rem;padding:.35rem;font-size:.95rem;box-sizing:border-box}" +
  "pre{white-space:pre-wrap;word-break:break-all;background:#f6f6f6;border:1px solid #ddd;padding:.5rem;max-height:24rem;overflow:auto;font-size:.85rem}" +
  ".unlisted{color:#a40000;font-weight:600}";

export const ADMIN_STYLE_HASH = styleHash(STYLE);

const layout = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

/** The hidden CSRF field every form posts. */
export const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;

export const hidden = (name: string, value: string) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

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

/** A navigation entry of the signed-in pages. */
export interface AdminNavTab {
  readonly id: string;
  readonly href: string;
  readonly label: string;
}

/** What the pages name and link: the app's name and every tab, in nav order. */
export interface AdminShell {
  /** The app's name, as in "<name> admin". */
  readonly name: string;
  readonly tabs: ReadonlyArray<AdminNavTab>;
  /** Heading of the column naming the resources a grant covers, e.g. "Projects". */
  readonly resourcesHeading: string;
  /** Where the bootstrap password hash comes from, e.g. an environment variable's name. */
  readonly passwordHashSource: string;
}

/** A signed-in page: nav with `tab` current, the one-shot message, then `body`. */
export const signedInPage = (shell: AdminShell, tab: string, csrf: string, flash: Flash | undefined, body: string) =>
  layout(
    `${shell.name} admin: ${shell.tabs.find(({ id }) => id === tab)?.label ?? ""}`,
    `<nav><strong>${escapeHtml(shell.name)} admin</strong>${shell.tabs
      .map(({ id, href, label }) =>
        id === tab ? `<span aria-current="page">${escapeHtml(label)}</span>` : `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`,
      )
      .join("")}<form method="post" action="/admin/logout">${csrfField(csrf)}<button type="submit">Sign out</button></form></nav>
${flashBlock(flash)}
${body}`,
  );

export interface AdminLoginPage {
  readonly csrf: string;
  readonly error: string | undefined;
  /** Ask for the authenticator code too (a second factor is configured). */
  readonly totp?: boolean;
}

export const adminLoginPage = (name: string, page: AdminLoginPage): string =>
  layout(
    `${name} admin sign-in`,
    `<h1>${escapeHtml(name)} admin</h1>
${page.error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(page.error)}</p>`}
<form method="post" action="/admin/login">
${csrfField(page.csrf)}
<label for="password">Admin password</label>
<input id="password" type="password" name="password" autocomplete="current-password" required autofocus>
${page.totp === true ? TOTP_FIELD : ""}<p><button type="submit">Sign in</button></p>
</form>
<p class="muted">Signed-in sessions end after 15 minutes without activity.</p>`,
  );

export const adminRefusedPage = (name: string): string =>
  layout(
    `${name} admin`,
    `<h1>Request refused</h1><p class="error" role="alert">The form could not be verified. <a href="/admin">Reload the page</a> and try again.</p>`,
  );

export interface GrantRow {
  readonly grantId: string;
  readonly scopes: ReadonlyArray<string>;
  /** Labels of the current resources the grant covers. */
  readonly resources: ReadonlyArray<string>;
  /** Granted resource ids no current resource has any more. */
  readonly staleResources: number;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  /** The app's HTML (escaped) right after the grant's row (AdminGrantSettings.render); "" for none. */
  readonly settings: string;
}

export interface ClientRow {
  readonly clientId: string;
  readonly clientName: string | null;
  readonly redirectUris: ReadonlyArray<string>;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly grants: ReadonlyArray<GrantRow>;
}

const grantResources = (grant: GrantRow) => {
  const names = grant.resources.map((name) => escapeHtml(name)).join(", ");
  const stale =
    grant.staleResources === 0 ? "" : `${names === "" ? "" : "; "}<span class="muted">${grant.staleResources} replaced or removed</span>`;
  return names === "" && stale === "" ? "none" : `${names}${stale}`;
};

const grantRow = (csrf: string, grant: GrantRow) => `<tr>
<td>${grant.scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(" ")}</td>
<td>${grantResources(grant)}</td>
<td>${formatTime(grant.createdAt)}</td>
<td>${formatTime(grant.lastUsedAt)}</td>
<td><form method="post" action="/admin/grants/revoke">${csrfField(csrf)}${hidden("grant", grant.grantId)}<button type="submit">Revoke</button></form></td>
</tr>${grant.settings}`;

const clientBlock = (shell: AdminShell, csrf: string, client: ClientRow) => `<section>
<h2>${client.clientName === null ? "Unnamed client" : `“${escapeHtml(client.clientName)}”`}</h2>
<p class="muted">The name is supplied by the client and not verified. Client ID <code>${escapeHtml(client.clientId)}</code>. Registered ${formatTime(client.createdAt)}, last authorized ${formatTime(client.lastUsedAt)}.<br>
Redirects to ${client.redirectUris.map((uri) => `<code>${escapeHtml(uri)}</code>`).join(", ")}</p>
${
  client.grants.length === 0
    ? "<p>No active authorization.</p>"
    : `<table><thead><tr><th>Scopes</th><th>${escapeHtml(shell.resourcesHeading)}</th><th>Authorized</th><th>Last used</th><th></th></tr></thead><tbody>
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

export const clientsPage = (shell: AdminShell, page: ClientsPage): string =>
  signedInPage(
    shell,
    "clients",
    page.csrf,
    page.flash,
    `<h1>Connected clients</h1>
<p class="muted">Revoking ends the client's tokens at once; it can connect again only through the sign-in and consent pages.</p>
${page.clients.length === 0 ? "<p>No registered clients.</p>" : page.clients.map((client) => clientBlock(shell, page.csrf, client)).join("\n")}
<h2>Revoke everything</h2>
<form method="post" action="/admin/clients/revoke-all">${csrfField(page.csrf)}
<label><input type="checkbox" name="confirm" value="yes" required> Revoke every client's authorization</label>
<button type="submit">Revoke all</button></form>`,
  );

export interface PasswordPage {
  readonly csrf: string;
  readonly flash: Flash | undefined;
}

export const passwordPage = (shell: AdminShell, page: PasswordPage): string =>
  signedInPage(
    shell,
    "password",
    page.csrf,
    page.flash,
    `<h1>Admin password</h1>
<p class="muted">The password signs in here and on the authorization page MCP clients open. Changing it signs out every other admin session; it then replaces the hash in ${escapeHtml(shell.passwordHashSource)} until <code>${escapeHtml(shell.name)} reset-admin-password</code> is run.</p>
<form method="post" action="/admin/password">
${csrfField(page.csrf)}
<label>Current password <input type="password" name="current" autocomplete="current-password" required></label>
<label>New password (12 or more characters) <input type="password" name="next" autocomplete="new-password" minlength="12" required></label>
<label>Repeat the new password <input type="password" name="confirm" autocomplete="new-password" minlength="12" required></label>
<p><button type="submit">Change password</button></p>
</form>`,
  );
