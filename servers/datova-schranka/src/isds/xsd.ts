import { DateTime, Schema, SchemaTransformation } from "effect";
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

/** xs:integer / xs:int / xs:long within the safe integer range ↔ number. */
export const XsInteger = Schema.FiniteFromString.pipe(Schema.check(Schema.isInt()));

/** xs:base64Binary ↔ bytes. */
export const XsBase64 = Schema.Uint8ArrayFromBase64;

/** Renders a DateTime for an xs:dateTime request element (UTC, ISO 8601). */
export const formatXsDateTime = (value: DateTime.DateTime): string => DateTime.formatIso(value);

/** A string XML 1.0 can carry: no C0 controls except tab/LF/CR, no lone surrogates. */
export const XmlText = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((text: string) => {
      const index = findInvalidXmlChar(text);
      return index === undefined ? undefined : `contains a character XML cannot carry at index ${index}`;
    }),
  ),
);

/** XmlText limited to `maxLength` characters (XSD maxLength counts characters). */
export const xmlTextMax = (maxLength: number) => XmlText.pipe(Schema.check(Schema.isMaxLength(maxLength)));

/**
 * A repeating element inside an optional container, e.g. `<dmRecords><dmRecord/>…</dmRecords>`.
 * The container may be absent or empty (`<dmRecords/>` parses as ""), which decodes as [].
 * The element name must be in the operation's `repeating` set so one item still parses as an array.
 */
export const xmlList = <S extends Schema.Top>(itemName: string, item: S) =>
  Schema.Union([
    Schema.Literal(""),
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
