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
}

export function makeRedactor(secrets: ReadonlyArray<string>): RedactorShape {
  // Longest first so a secret that contains another is fully replaced.
  const forms = [...new Set(secrets.filter((s) => s.length > 0).flatMap(tokenForms))].sort(
    (a, b) => b.length - a.length,
  );
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
  return { redact, redactDeep, excerpt };
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

export class Redactor extends Context.Service<Redactor, RedactorShape>()("fio-mcp/Redactor") {
  static readonly Default = Layer.effect(
    Redactor,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return Redactor.of(makeRedactor(config.secrets.map(Redacted.value)));
    }),
  );

  static readonly Live = Redactor.Default.pipe(Layer.provide(AppConfig.Live));
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
