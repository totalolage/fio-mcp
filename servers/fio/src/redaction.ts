import { stripMarks } from "@mcps/core/mcp/untrusted.js";
import {
  stderrLogger as coreStderrLogger,
  loggerLayer,
  makeRedactor as makeCoreRedactor,
  REDACTED,
  Redactor,
  type RedactorShape,
} from "@mcps/core/redaction.js";
import { Effect, Layer, Redacted } from "effect";
import { AppConfig } from "./config.js";

/**
 * Token redaction. FIO puts read tokens in the URL path and upload tokens in
 * the multipart body, so any URL, error message, or response excerpt may
 * contain one. Tokens are `Redacted` everywhere except the moment FioApi
 * builds a request; this is the safety net for everything that leaves the
 * process anyway (tool results, protocol frames, stderr logs).
 *
 * The redactor itself lives in @mcps/core; FIO supplies its secrets (the
 * configured tokens) and the scrubber for token-shaped REST path segments.
 */

export { REDACTED, Redactor, type RedactorShape } from "@mcps/core/redaction.js";

// Path segments that are immediately followed by a token in FIO's REST API.
// The segment stops at the excerpt markers (U+E000, U+E001, @mcps/core/mcp/untrusted.ts)
// so redaction never removes one.
const TOKEN_PATH =
  /\/(periods|by-id|last|set-last-id|set-last-date|merchant|lastStatement)\/[^/\s?#"'<>\uE000\uE001]+/g;

/** Replaces the token after every FIO REST path segment that takes one. */
export const scrubTokenPaths = (text: string): string =>
  text.replace(TOKEN_PATH, (_match, segment: string) => `/${segment}/${REDACTED}`);

/** A redactor for `initial` tokens that also scrubs token-shaped FIO URL segments. */
export function makeRedactor(initial: ReadonlyArray<string>): RedactorShape {
  return makeCoreRedactor(initial, scrubTokenPaths);
}

/** The redactor for the configured tokens; needs AppConfig. */
export const RedactorDefault = Redactor.layer(
  Effect.map(Effect.service(AppConfig), (config) => config.secrets.map(Redacted.value)),
  scrubTokenPaths,
);

/**
 * One instance per process. The stderr logger (main.ts provides
 * AppLoggerLive around the app) and the app layers build `RedactorLive`
 * from the same memo map, so a token registered at runtime is redacted in
 * logs too.
 */
export const RedactorLive = RedactorDefault.pipe(Layer.provide(AppConfig.Live));

/**
 * Writes logfmt lines to stderr, redacted. Excerpt markers (U+E000, U+E001,
 * @mcps/core/mcp/untrusted.ts) are stripped first, so a log line never carries one.
 */
export const stderrLogger = (redactor: RedactorShape) => coreStderrLogger(redactor, stripMarks);

/** Replaces the default (stdout) logger with the redacting, mark-stripping stderr logger. */
export const LoggerLive = loggerLayer(stripMarks);
