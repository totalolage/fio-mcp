import { Buffer } from "node:buffer";
import { DateTime, Option, Schema, SchemaTransformation } from "effect";
import { findInvalidXmlChar } from "./xml.js";

/**
 * Schemas for XSD simple types as fast-xml-parser leaves them (every value a string), decoding
 * to domain types. Encoding renders the lexical form ISDS expects in requests.
 */

/** xs:boolean: "true"/"false"/"1"/"0" ↔ boolean. */
export const XsBoolean = Schema.Literals(["true", "false", "1", "0"]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (lexical) => lexical === "true" || lexical === "1",
      encode: (value): "true" | "false" => (value ? "true" : "false"),
    }),
  ),
);

/** xs:dateTime ↔ DateTime.Utc. ISDS sends an offset (e.g. `2026-01-02T10:00:00.123+01:00`). */
export const XsDateTime = Schema.DateTimeUtcFromString;

/**
 * An integer within ±(2^53 − 1). Use it for integer request inputs: `String(value)` of such a
 * number is always the xs:integer lexical form, whereas a larger one (e.g. 1e21) renders in
 * exponent notation ("1e+21") that no XSD integer type accepts.
 */
export const SafeInteger = Schema.Finite.pipe(
  Schema.check(Schema.makeFilter((value: number) => (Number.isSafeInteger(value) ? undefined : "Expected a safe integer"))),
);

/**
 * xs:integer / xs:int / xs:long within the safe integer range ↔ number. Only the xs:integer
 * lexical form (XSD Part 2 §3.3.13): an optional sign and decimal digits, with surrounding XML
 * whitespace allowed (whiteSpace facet "collapse"). "1e3", "0x10", "1.0" and "" are rejected,
 * as is any value outside ±(2^53 − 1), which a JavaScript number can't hold exactly.
 */
export const XsInteger = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[\t\n\r ]*[+-]?[0-9]+[\t\n\r ]*$/)),
  Schema.decodeTo(
    SafeInteger,
    SchemaTransformation.transform({
      decode: (text: string) => Number(text.trim()),
      encode: (value: number) => String(value),
    }),
  ),
);

/** Canonical base64 text: whole quanta of the standard alphabet with at most two `=` of padding. */
const Base64Text = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((text: string) =>
      text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text) ? undefined : "Expected base64 text",
    ),
  ),
);

/**
 * xs:base64Binary ↔ bytes. XML whitespace inside the lexical form is allowed (XSD Part 2
 * §3.2.16) and dropped; anything else outside the base64 alphabet fails. Uses Node's native codec,
 * since attachments run to tens of megabytes.
 */
export const XsBase64 = Schema.String.pipe(
  Schema.decodeTo(
    Base64Text,
    SchemaTransformation.transform({
      decode: (text: string) => text.replace(/[\t\n\r ]/g, ""),
      encode: (text: string) => text,
    }),
  ),
  Schema.decodeTo(
    Schema.Uint8Array,
    SchemaTransformation.transform({
      // Copies out of Buffer's shared pool into a plain Uint8Array.
      decode: (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64")),
      encode: (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
    }),
  ),
);

/** 0001-01-01T00:00:00.000Z and 9999-12-31T23:59:59.999Z: the four-digit years xs:dateTime text can carry here. */
const xsDateTimeMinMillis = -62_135_596_800_000;
const xsDateTimeMaxMillis = 253_402_300_799_999;

/**
 * Renders a DateTime for an xs:dateTime request element (UTC, ISO 8601,
 * `YYYY-MM-DDTHH:mm:ss.sssZ`), or None when it has no such form: a non-finite instant (e.g.
 * `DateTime.addDuration(t, Duration.infinity)`, on which `DateTime.formatIso` throws a
 * RangeError) or a UTC year outside 0001–9999 (`formatIso` would emit an expanded year such as
 * `+010000-…` or `-000001-…`, which ISDS has no reason to accept). Every request date goes
 * through here, so callers turn None into IsdsInvalidRequest instead of dying on a defect.
 */
export const formatXsDateTime = (value: DateTime.DateTime): Option.Option<string> => {
  const millis = DateTime.toEpochMillis(value);
  return Number.isFinite(millis) && millis >= xsDateTimeMinMillis && millis <= xsDateTimeMaxMillis
    ? Option.some(DateTime.formatIso(value))
    : Option.none();
};

/** A string XML 1.0 can carry: no C0 controls except tab/LF/CR, no lone surrogates. */
export const XmlText = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((text: string) => {
      const index = findInvalidXmlChar(text);
      return index === undefined ? undefined : `contains a character XML cannot carry at index ${index}`;
    }),
  ),
);

/** The number of Unicode code points, which is what XSD maxLength and the spec's "znaků" count. */
export const characterCount = (text: string): number => {
  let count = 0;
  for (const _char of text) count++;
  return count;
};

/**
 * XmlText of at most `maxLength` characters. Counts code points, not UTF-16 units, so a
 * character outside the BMP (e.g. an emoji) counts once, as in XSD maxLength.
 */
export const xmlTextMax = (maxLength: number) =>
  XmlText.pipe(
    Schema.check(
      Schema.makeFilter((text: string) =>
        characterCount(text) <= maxLength ? undefined : `Expected at most ${maxLength} characters`,
      ),
    ),
  );

/**
 * A repeating element inside an optional container, e.g. `<dmRecords><dmRecord/>…</dmRecords>`.
 * The container may be absent or empty (`<dmRecords/>` parses as "", a pretty-printed
 * `<dmRecords>\n</dmRecords>` as whitespace), which decodes as [].
 * The element name must be in the operation's `repeating` set so one item still parses as an array.
 */
export const xmlList = <S extends Schema.Top>(itemName: string, item: S) =>
  Schema.Union([
    Schema.String.pipe(Schema.check(Schema.isPattern(/^[\t\n\r ]*$/))),
    Schema.Struct({ [itemName]: Schema.optional(Schema.Array(item)) }),
  ]).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(item)),
      SchemaTransformation.transform({
        decode: (container) => (typeof container === "string" ? [] : (container[itemName] ?? [])),
        encode: (items) => ({ [itemName]: items }),
      }),
    ),
  );
