import { Context, Effect, Layer, Logger, Redacted } from "effect";
import { AppConfig } from "./config.js";

/**
 * Token redaction. FIO puts read tokens in the URL path and upload tokens in
 * the multipart body, so any URL, error message, or response excerpt may
 * contain one. Tokens are `Redacted` everywhere except the moment FioApi
 * builds a request; this is the safety net for everything that leaves the
 * process anyway (tool results, protocol frames, stderr logs).
 */

export const REDACTED = "***";

const EXCERPT_LENGTH = 300;

// Path segments that are immediately followed by a token in FIO's REST API.
const TOKEN_PATH = /\/(periods|by-id|last|set-last-id|set-last-date|merchant|lastStatement)\/[^/\s?#"'<>]+/g;

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Forms a token takes in output: raw, URL-encoded (read URLs), JSON-escaped,
 * and XML-escaped. Config restricts tokens to URL-safe characters, so these
 * coincide today; they stay as defence in depth.
 */
function tokenForms(token: string): ReadonlyArray<string> {
  return [...new Set([token, JSON.stringify(token).slice(1, -1), escapeXmlText(token), ...uriForm(token)])];
}

/** A lone surrogate has no URI form; redaction must still not fail. */
function uriForm(token: string): ReadonlyArray<string> {
  try {
    return [encodeURIComponent(token)];
  } catch {
    return [];
  }
}

export interface RedactorShape {
  /** Replaces every configured secret and every token-shaped URL segment. */
  readonly redact: (text: string) => string;
  /** Redacts every string (and object key) in a JSON-like value and drops undefined fields. */
  readonly redactDeep: <T>(value: T) => T;
  /** Short, single-line, token-free excerpt of a response body for error messages. */
  readonly excerpt: (body: string) => string;
  /**
   * Adds secrets to redact from now on (tokens added at runtime through
   * /admin). Secrets are never removed: a replaced token may still appear
   * in a late log line.
   */
  readonly register: (secrets: ReadonlyArray<string>) => void;
}

export function makeRedactor(initial: ReadonlyArray<string>): RedactorShape {
  const known = new Set<string>();
  let forms: ReadonlyArray<string> = [];
  const register = (secrets: ReadonlyArray<string>) => {
    const fresh = secrets.filter((s) => s.length > 0 && !known.has(s));
    if (fresh.length === 0) return;
    for (const secret of fresh) known.add(secret);
    // Longest first so a secret that contains another is fully replaced.
    forms = [...new Set([...known].flatMap(tokenForms))].sort((a, b) => b.length - a.length);
  };
  register(initial);
  const redact = (text: string): string => {
    let out = text;
    for (const form of forms) out = out.split(form).join(REDACTED);
    return out.replace(TOKEN_PATH, (_match, segment: string) => `/${segment}/${REDACTED}`);
  };
  const redactDeep = <T>(value: T): T => deep(value, redact) as T;
  const excerpt = (body: string): string => {
    // Redact before stripping tags and again before truncating: a cut could
    // leave a token prefix that redact no longer recognizes.
    const text = redact(
      redact(body)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;
  };
  return { redact, redactDeep, excerpt, register };
}

function deep(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => deep(item, redact));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    // Undefined fields are dropped, as JSON would: MCP structured content
    // must be a JSON value.
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [redact(key), deep(item, redact)]),
    );
  }
  return value;
}

/**
 * One instance per process. The stderr logger (main.ts provides
 * AppLoggerLive around the app) and the app layers build `Redactor.layer`
 * from the same memo map, so a token registered at runtime is redacted in
 * logs too.
 */
export class Redactor extends Context.Service<Redactor, RedactorShape>()("fio-mcp/Redactor") {
  static readonly layer = Layer.effect(
    Redactor,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return Redactor.of(makeRedactor(config.secrets.map(Redacted.value)));
    }),
  );

  /** For tests and tools that run without configured secrets. */
  static readonly layerFrom = (secrets: ReadonlyArray<string>) => Layer.succeed(Redactor, makeRedactor(secrets));
}

/** Writes logfmt lines to stderr (stdout is the MCP stdio channel), redacted. */
export const stderrLogger = (redactor: RedactorShape) =>
  Logger.make<unknown, void>((options) => {
    process.stderr.write(`${redactor.redact(Logger.formatLogFmt.log(options))}\n`);
  });

/** Replaces the default (stdout) logger with the redacting stderr logger. */
export const LoggerLive = Layer.unwrap(
  Effect.gen(function* () {
    const redactor = yield* Redactor;
    return Logger.layer([stderrLogger(redactor)]);
  }),
);
