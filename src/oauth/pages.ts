import { createHash } from "node:crypto";
import { isLoopbackRedirect, originOf } from "./urls.js";

/**
 * Server-rendered pages of the authorization server: login, consent, and
 * errors. Every interpolated value goes through `escapeHtml`; the only
 * style is one inline block allowed by its CSP hash; there is no script.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE =
  "body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b;line-height:1.45}" +
  "h1{font-size:1.4rem}fieldset{border:1px solid #ccc;border-radius:6px;margin:1rem 0;padding:.5rem 1rem}" +
  "label{display:block;margin:.35rem 0}input[type=password]{width:100%;padding:.4rem;font-size:1rem;box-sizing:border-box}" +
  "button{font-size:1rem;padding:.45rem 1.1rem;margin-right:.5rem}.warn{background:#fff4d6;border:1px solid #e0b84c;padding:.5rem .75rem;border-radius:6px}" +
  ".error{color:#a40000}code{word-break:break-all}.muted{color:#555;font-size:.9rem}";

const STYLE_HASH = createHash("sha256").update(STYLE, "utf8").digest("base64");

/**
 * Headers for every HTML page. `formTargets` widens form-action for the
 * consent page: browsers apply it to the redirect that follows the POST.
 */
export function pageHeaders(formTargets: ReadonlyArray<string> = []): Record<string, string> {
  const formAction = ["'self'", ...formTargets].join(" ");
  return {
    "content-security-policy": `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    // Not no-referrer: browsers then send `Origin: null` on the form posts,
    // which the Origin check refuses. Cross-origin navigations carry no referrer.
    "referrer-policy": "same-origin",
    "cache-control": "no-store",
    pragma: "no-cache",
  };
}

const layout = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

const clientLabel = (name: string | null) => (name === null || name === "" ? "An unnamed application" : `“${escapeHtml(name)}”`);

export interface LoginPage {
  readonly clientName: string | null;
  readonly redirectUri: string;
  readonly csrf: string;
  readonly error: string | undefined;
}

export const loginPage = (page: LoginPage): string =>
  layout(
    "fio-mcp sign-in",
    `<h1>Sign in to fio-mcp</h1>
<p>${clientLabel(page.clientName)} asks to use your FIO bank tools. It will return to <strong>${escapeHtml(originOf(page.redirectUri))}</strong>.</p>
${page.error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(page.error)}</p>`}
<form method="post" action="/login">
<input type="hidden" name="csrf" value="${escapeHtml(page.csrf)}">
<label for="password">Admin password</label>
<input id="password" type="password" name="password" autocomplete="current-password" required autofocus>
<p><button type="submit">Sign in</button></p>
</form>`,
  );

export interface ConsentPage {
  readonly clientId: string;
  readonly clientName: string | null;
  readonly redirectUri: string;
  readonly csrf: string;
  readonly paymentsRequested: boolean;
  readonly accounts: ReadonlyArray<string>;
  readonly error: string | undefined;
}

export const consentPage = (page: ConsentPage): string => {
  const loopback = isLoopbackRedirect(page.redirectUri)
    ? `<p class="warn">The application receives the authorization on this computer (<code>${escapeHtml(originOf(page.redirectUri))}</code>). Only continue if you just started the sign-in from an application on this computer.</p>`
    : "";
  const accounts = page.accounts
    .map(
      (name) =>
        `<label><input type="checkbox" name="account" value="${escapeHtml(name)}" checked> ${escapeHtml(name)}</label>`,
    )
    .join("\n");
  return layout(
    "fio-mcp authorization",
    `<h1>Authorize ${clientLabel(page.clientName)}</h1>
<p class="muted">The name is supplied by the application and not verified. Client ID <code>${escapeHtml(page.clientId)}</code>.</p>
<p>After you approve, the browser returns to:<br><code>${escapeHtml(page.redirectUri)}</code></p>
${loopback}
${page.error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(page.error)}</p>`}
<form method="post" action="/consent">
<input type="hidden" name="csrf" value="${escapeHtml(page.csrf)}">
<fieldset><legend>Permissions</legend>
<label><input type="checkbox" checked disabled> Read accounts, transactions, statements and the local cache; sync; move the download marker; preview payment orders (<code>fio:read</code>, required)</label>
<label><input type="checkbox" name="scope" value="fio:payments"${page.paymentsRequested ? " checked" : ""}> Submit payment orders to FIO for signing in Internetbanking (<code>fio:payments</code>)</label>
</fieldset>
<fieldset><legend>Accounts</legend>
${accounts}
</fieldset>
<p><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></p>
</form>`,
  );
};

export const errorPage = (title: string, detail: string): string =>
  layout(`fio-mcp: ${title}`, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`);

/** CSP form-action source for the redirect after consent. */
export const redirectFormTarget = (redirectUri: string): ReadonlyArray<string> => {
  const origin = originOf(redirectUri);
  return origin === "" || origin === "null" ? [] : [origin];
};
