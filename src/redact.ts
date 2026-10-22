/**
 * Token redaction. FIO puts read tokens in the URL path and upload tokens in
 * the multipart body, so any URL, error message, or response excerpt may
 * contain one. Everything that leaves the process (tool results, stderr logs)
 * goes through `redact`.
 */

const REDACTED = "***";

// Path segments that are immediately followed by a token in FIO's REST API.
const TOKEN_PATH = /\/(periods|by-id|last|set-last-id|set-last-date|merchant|lastStatement)\/[^/\s?#"'<>]+/g;

const knownTokens = new Set<string>();

/** Registers secrets that must never appear in output. */
export function registerSecret(token: string): void {
  if (token.length > 0) knownTokens.add(token);
}

/** Test helper: forget registered secrets. */
export function clearSecrets(): void {
  knownTokens.clear();
}

/**
 * Forms a token takes in output: raw, URL-encoded (read URLs), JSON-escaped
 * (tool results are stringified before redaction), and XML-escaped (response
 * bodies and payment XML).
 */
function tokenForms(token: string): string[] {
  const forms = new Set([token, JSON.stringify(token).slice(1, -1), escapeXmlText(token)]);
  try {
    forms.add(encodeURIComponent(token));
  } catch {
    // A lone surrogate has no URI form; redaction must still not throw.
  }
  return [...forms];
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function redact(text: string): string {
  let out = text;
  // Longest first so a token that contains another is fully replaced.
  for (const token of [...knownTokens].sort((a, b) => b.length - a.length)) {
    for (const form of tokenForms(token)) out = out.split(form).join(REDACTED);
  }
  return out.replace(TOKEN_PATH, (_match, segment: string) => `/${segment}/${REDACTED}`);
}

/** Redacts every string (and object key) in a JSON-like value, e.g. an outgoing MCP message. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [redact(key), redactDeep(item)]),
    ) as T;
  }
  return value;
}

function format(value: unknown): string {
  if (value instanceof Error) {
    const cause = value.cause === undefined ? "" : ` (cause: ${format(value.cause)})`;
    return `${value.name}: ${value.message}${cause}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** stderr-only logger: stdout is the MCP stdio channel. */
export const log = {
  info: (...parts: unknown[]) => write("info", parts),
  warn: (...parts: unknown[]) => write("warn", parts),
  error: (...parts: unknown[]) => write("error", parts),
};

function write(level: string, parts: unknown[]): void {
  process.stderr.write(`[fio-mcp] ${level}: ${redact(parts.map(format).join(" "))}\n`);
}
