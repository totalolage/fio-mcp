import { Context, Effect, Layer, Logger } from "effect";

/**
 * Secret redaction: the safety net for everything that leaves the process
 * (tool results, protocol frames, stderr logs). Secrets stay `Redacted` in
 * the app; whatever text still reaches output passes through `redact`,
 * which replaces every known secret form and then runs the app's own
 * scrubber for secrets it cannot list (for example a token-shaped URL
 * segment).
 */

export const REDACTED = "***";

const EXCERPT_LENGTH = 300;

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Forms a secret takes in output: raw, URL-encoded, JSON-escaped, and
 * XML-escaped. For URL-safe secrets these coincide; they stay as defence in
 * depth.
 */
function secretForms(secret: string): ReadonlyArray<string> {
  return [...new Set([secret, JSON.stringify(secret).slice(1, -1), escapeXmlText(secret), ...uriForm(secret)])];
}

/** A lone surrogate has no URI form; redaction must still not fail. */
function uriForm(secret: string): ReadonlyArray<string> {
  try {
    return [encodeURIComponent(secret)];
  } catch {
    return [];
  }
}

export interface RedactorShape {
  /** Replaces every registered secret, then applies the app's extra scrubber. */
  readonly redact: (text: string) => string;
  /** Redacts every string (and object key) in a JSON-like value and drops undefined fields. */
  readonly redactDeep: <T>(value: T) => T;
  /** Short, single-line, secret-free excerpt of a response body for error messages. */
  readonly excerpt: (body: string) => string;
  /**
   * Adds secrets to redact from now on (for example ones added at runtime).
   * Secrets are never removed: a replaced secret may still appear in a late
   * log line.
   */
  readonly register: (secrets: ReadonlyArray<string>) => void;
}

/**
 * A redactor for `initial` secrets. `extra` runs on the text after every
 * secret form is replaced, for secrets the app recognizes by shape rather
 * than by value.
 */
export function makeRedactor(initial: ReadonlyArray<string>, extra?: (text: string) => string): RedactorShape {
  const known = new Set<string>();
  let forms: ReadonlyArray<string> = [];
  const register = (secrets: ReadonlyArray<string>) => {
    const fresh = secrets.filter((s) => s.length > 0 && !known.has(s));
    if (fresh.length === 0) return;
    for (const secret of fresh) known.add(secret);
    // Longest first so a secret that contains another is fully replaced.
    forms = [...new Set([...known].flatMap(secretForms))].sort((a, b) => b.length - a.length);
  };
  register(initial);
  const redact = (text: string): string => {
    let out = text;
    for (const form of forms) out = out.split(form).join(REDACTED);
    return extra === undefined ? out : extra(out);
  };
  const redactDeep = <T>(value: T): T => deep(value, redact) as T;
  const excerpt = (body: string): string => {
    // Redact before stripping tags and again before truncating: a cut could
    // leave a secret prefix that redact no longer recognizes.
    const text = redact(
      redact(body)
        .replace(/<[^<>]*>/g, " ")
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
 * The process's redactor. Build it from one layer value shared by the stderr
 * logger and the app, so a secret registered at runtime is redacted in logs
 * too.
 */
export class Redactor extends Context.Service<Redactor, RedactorShape>()("mcps/Redactor") {
  /** A redactor for the secrets `secrets` yields, with the app's optional `extra` scrubber. */
  static readonly layer = <E, R>(
    secrets: Effect.Effect<ReadonlyArray<string>, E, R>,
    extra?: (text: string) => string,
  ): Layer.Layer<Redactor, E, R> =>
    Layer.effect(
      Redactor,
      Effect.map(secrets, (initial) => Redactor.of(makeRedactor(initial, extra))),
    );
}

/**
 * Writes logfmt lines to stderr (stdout is the MCP stdio channel), redacted.
 * `prepare`, when given, runs on each formatted line before redaction (an
 * app removing its own in-band markers, for example).
 */
export const stderrLogger = (redactor: RedactorShape, prepare?: (line: string) => string) =>
  Logger.make<unknown, void>((options) => {
    const line = Logger.formatLogFmt.log(options);
    process.stderr.write(`${redactor.redact(prepare === undefined ? line : prepare(line))}\n`);
  });

/**
 * Replaces the default (stdout) logger with the redacting stderr logger,
 * built on the Redactor service. `prepare` is passed to stderrLogger.
 */
export const loggerLayer = (prepare?: (line: string) => string): Layer.Layer<never, never, Redactor> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const redactor = yield* Redactor;
      return Logger.layer([stderrLogger(redactor, prepare)]);
    }),
  );

/** loggerLayer without a preparation step. */
export const LoggerLive = loggerLayer();
