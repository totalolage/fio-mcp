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
 */

const SSE_DATA = "data: ";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export interface FrameRedactor {
  readonly text: (text: string) => string;
  /** Redacts one transport chunk; returns the same value when nothing changed. */
  readonly chunk: {
    (chunk: Uint8Array): Uint8Array;
    (chunk: string | Uint8Array): string | Uint8Array;
  };
}

export function makeFrameRedactor(redactor: RedactorShape): FrameRedactor {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const line = (raw: string): string => {
    const prefix = raw.startsWith(SSE_DATA) ? SSE_DATA : "";
    return Option.match(decodeJson(raw.slice(prefix.length)), {
      onNone: () => redactor.redact(raw),
      onSome: (value) => `${prefix}${JSON.stringify(redactor.redactDeep(value))}`,
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
