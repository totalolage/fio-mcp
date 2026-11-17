import type { AppIdentity } from "@mcps/core/app-identity.js";
import { type PasswordHash, type PasswordHashError, parsePasswordHash as parseHashFor } from "@mcps/core/oauth/crypto.js";
import { parsePublicUrl as parseUrlFor } from "@mcps/core/oauth/urls.js";

/** fio-mcp as core names it in pages, cookies, messages and identifiers. */
export const FIO_APP: AppIdentity = { name: "fio-mcp", idPrefix: "fio" };

/** Parses an admin password hash line with fio-mcp's wording in the error. */
export const parsePasswordHash = (line: string): PasswordHash | PasswordHashError => parseHashFor(line, FIO_APP);

/** Parses FIO_MCP_PUBLIC_URL; the problem's example origin is https://fio.example.net. */
export const parsePublicUrl = (raw: string): { readonly origin: string } | { readonly problem: string } =>
  parseUrlFor(raw, FIO_APP);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * FIO_API_BASE_URL: an https URL whose host is fio.cz or ends in .fio.cz,
 * without credentials, query or fragment. With `allowTest`
 * (FIO_API_ALLOW_TEST_BASE_URL) http on 127.0.0.1, [::1] and localhost is
 * accepted too. Returns the normalized URL without trailing slashes, or
 * undefined; the caller's message must not echo the value.
 */
export function parseFioBaseUrl(raw: string, allowTest: boolean): string | undefined {
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  if (url === undefined) return undefined;
  const onFio = url.protocol === "https:" && (url.hostname === "fio.cz" || url.hostname.endsWith(".fio.cz"));
  const testServer = allowTest && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (!onFio && !testServer) return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) return undefined;
  return url.href.replace(/\/+$/, "");
}
