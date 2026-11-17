import { Option, Schema } from "effect";
import type { RedactorShape } from "../redaction.js";

/**
 * Protocol-boundary redaction: the last pass over every MCP frame before it
 * leaves the process, on top of the per-tool `redactDeep`. McpServer writes
 * some texts itself (parameter-validation errors echo the offending value),
 * and those never pass through a tool handler.
 *
 * Why this cannot corrupt framing:
 * - A chunk is always whole frames. Stdio writes one NDJSON line per encoded
 *   message; the HTTP transport sends one JSON body, or one SSE chunk per
 *   encoded message. A token therefore never straddles two chunks.
 * - Chunks without anything secret-shaped pass through byte for byte.
 * - Otherwise each line is redacted as JSON: the line (minus an SSE `data: `
 *   prefix) is parsed, every string is redacted, and the value is serialized
 *   again. Replacements happen in decoded strings, so they can never eat a
 *   quote or a backslash of an escape sequence. Plain-text redaction of the
 *   raw line would: the token-path pattern accepts `\`, so `/last/x\"` would
 *   lose the backslash and end the string early.
 * - Lines that are not JSON (SSE keep-alive comments, blank separators) get
 *   plain redaction. No secret contains whitespace (config rejects it), so a
 *   replacement never spans a line break and the SSE event structure stays.
 *
 * With `protectEmbeddedResources`, a JSON-RPC result whose `content` embeds a
 * resource (an item of type "resource") is never sent with redacted strings:
 * if redaction would change anything in that message, it is replaced, under
 * the same id, by a tool error without resources (withheldResult). A resource
 * blob is the base64 of exact bytes, and a URI or MIME type names them, so a
 * redacted one is a corrupt resource, not a safe one. The tool handler is
 * expected to withhold such resources itself; this catches what it could not
 * see, such as a secret registered after it ran.
 */

const SSE_DATA = "data: ";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export interface FrameRedactorOptions {
  /** Withholds resource-bearing results that redaction would change. Off by default. */
  readonly protectEmbeddedResources?: boolean | undefined;
}

/** The tool error text that replaces a withheld resource-bearing result. */
export const WITHHELD_RESOURCES_TEXT = "The result was withheld: output redaction would alter its embedded resources.";

/** The JSON-RPC response that replaces a withheld result with this id. */
export const withheldResult = (id: unknown) => ({
  jsonrpc: "2.0",
  id,
  result: { isError: true, content: [{ type: "text", text: WITHHELD_RESOURCES_TEXT }] },
});

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON-RPC message whose result content embeds at least one resource. */
const embedsResource = (message: unknown): boolean =>
  isRecord(message) &&
  isRecord(message.result) &&
  Array.isArray(message.result.content) &&
  message.result.content.some((item) => isRecord(item) && item.type === "resource");

export interface FrameRedactor {
  readonly text: (text: string) => string;
  /** Redacts one transport chunk; returns the same value when nothing changed. */
  readonly chunk: {
    (chunk: Uint8Array): Uint8Array;
    (chunk: string | Uint8Array): string | Uint8Array;
  };
}

export function makeFrameRedactor(redactor: RedactorShape, options: FrameRedactorOptions = {}): FrameRedactor {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const protectMessage = (message: unknown): unknown => {
    const redacted = redactor.redactDeep(message);
    if (!embedsResource(message) || JSON.stringify(redacted) === JSON.stringify(message)) return redacted;
    // The redacted id: a secret in a client-chosen id must not leak either.
    return withheldResult(isRecord(redacted) ? redacted.id : undefined);
  };

  // A JSON-RPC batch (an array) is checked message by message.
  const redactValue: (value: unknown) => unknown =
    options.protectEmbeddedResources === true
      ? (value) => (Array.isArray(value) ? value.map(protectMessage) : protectMessage(value))
      : redactor.redactDeep;

  const line = (raw: string): string => {
    const prefix = raw.startsWith(SSE_DATA) ? SSE_DATA : "";
    return Option.match(decodeJson(raw.slice(prefix.length)), {
      onNone: () => redactor.redact(raw),
      onSome: (value) => `${prefix}${JSON.stringify(redactValue(value))}`,
    });
  };

  const text = (value: string): string =>
    redactor.redact(value) === value ? value : value.split("\n").map(line).join("\n");

  function chunk(value: Uint8Array): Uint8Array;
  function chunk(value: string | Uint8Array): string | Uint8Array;
  function chunk(value: string | Uint8Array): string | Uint8Array {
    if (typeof value === "string") return text(value);
    const decoded = decoder.decode(value);
    const redacted = text(decoded);
    return redacted === decoded ? value : encoder.encode(redacted);
  }

  return { text, chunk };
}
