/**
 * URL rules of the authorization server: the public origin (issuer), the
 * resource identifier tokens are bound to, and client redirect URIs.
 */

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

export const MAX_REDIRECT_URI_LENGTH = 2000;

/** Path of the MCP endpoint; the resource identifier is the public origin plus this. */
export const MCP_RESOURCE_PATH = "/mcp";

const parse = (raw: string): URL | undefined => (URL.canParse(raw) ? new URL(raw) : undefined);

/**
 * FIO_MCP_PUBLIC_URL: an https origin (http only for loopback hosts, for
 * local testing) without path, query, fragment, or credentials. Returns the
 * canonical origin, or a problem description that does not echo the value.
 */
export function parsePublicUrl(raw: string): { readonly origin: string } | { readonly problem: string } {
  const url = parse(raw);
  if (url === undefined) return { problem: "must be an absolute URL such as https://fio.example.net" };
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    return { problem: "must use https (http is accepted only for 127.0.0.1, [::1] and localhost)" };
  }
  if (url.username !== "" || url.password !== "") return { problem: "must not contain credentials" };
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    return { problem: "must be an origin without path, query, or fragment (the server answers at the root)" };
  }
  return { origin: url.origin };
}

/**
 * Whether `presented` names `resource` (RFC 8707). Scheme and host compare
 * case-insensitively and a trailing slash is ignored; no query or fragment.
 */
export function isResource(presented: string, resource: string): boolean {
  const url = parse(presented);
  if (url === undefined || url.search !== "" || url.hash !== "" || presented.includes("#")) return false;
  if (url.username !== "" || url.password !== "") return false;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : "";
  return `${url.origin}${path}` === resource;
}

/**
 * A redirect URI a client may register or present: https, or http on a
 * loopback host (RFC 8252 §7.3), with a port from 1 to 65535 if any, without
 * fragment or credentials. Returns a problem or undefined.
 */
export function redirectUriProblem(raw: string): string | undefined {
  if (raw.length > MAX_REDIRECT_URI_LENGTH) return `redirect URIs must be at most ${MAX_REDIRECT_URI_LENGTH} characters`;
  if (/[\p{Cc}\s]/u.test(raw)) return "redirect URIs must not contain whitespace or control characters";
  const url = parse(raw);
  if (url === undefined) return "redirect URIs must be absolute URLs";
  if (raw.includes("#")) return "redirect URIs must not contain a fragment";
  // The parsed URL drops an empty userinfo (`http://@host/`) and an empty port (`http://host:/`).
  const authority = /^[^:]*:\/\/([^/?#]*)/.exec(raw)?.[1] ?? "";
  if (authority === "") return "redirect URIs must be absolute URLs"; // e.g. `http:////@host/`, `http:host/`
  if (url.username !== "" || url.password !== "" || authority.includes("@")) {
    return "redirect URIs must not contain credentials";
  }
  if (url.port === "0" || authority.endsWith(":")) return "redirect URIs must use a port from 1 to 65535";
  if (url.protocol === "https:" && url.hostname !== "") return undefined;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  return "redirect URIs must use https, or http on 127.0.0.1, [::1] or localhost";
}

// The authority of a loopback http URI, split into host and optional port.
const LOOPBACK_AUTHORITY = /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d{1,5})?(?=[/?]|$)/;

const withoutLoopbackPort = (uri: string) => uri.replace(LOOPBACK_AUTHORITY, (_match, host: string) => `http://${host}`);

/**
 * Exact string match, except that a registered loopback http URI matches
 * the same URI on any port (RFC 8252 §7.3). A presented URI that is not a
 * valid redirect URI never matches, so it is never redirected to.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (redirectUriProblem(presented) !== undefined) return false;
  if (registered === presented) return true;
  if (!LOOPBACK_AUTHORITY.test(registered) || !LOOPBACK_AUTHORITY.test(presented)) return false;
  return withoutLoopbackPort(registered) === withoutLoopbackPort(presented);
}

/** The redirect URI with OAuth response parameters appended to its query. */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.append(key, value);
  }
  return url.href;
}

/** True for loopback redirect URIs, which the consent page flags. */
export const isLoopbackRedirect = (uri: string): boolean => LOOPBACK_AUTHORITY.test(uri);

/** `scheme://host[:port]` of a redirect URI, for display and CSP form-action. */
export const originOf = (uri: string): string => parse(uri)?.origin ?? "";
