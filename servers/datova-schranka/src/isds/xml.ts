import { Result } from "effect";
import { XMLParser } from "fast-xml-parser";

/**
 * A minimal XML tree for building SOAP requests. Text is escaped when rendered, so callers
 * pass raw values; element and attribute names are trusted constants from this module's callers.
 */
export interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyArray<readonly [name: string, value: string]>;
  readonly content: string | ReadonlyArray<XmlElement>;
}

type Attributes = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * Builds an element. `content` is either text or child elements; `undefined` children are
 * dropped, so optional elements can be written inline. Attributes whose value is `undefined`
 * are omitted.
 */
export const xmlElement = (
  name: string,
  content: string | ReadonlyArray<XmlElement | undefined> = [],
  attributes: Attributes = {},
): XmlElement => ({
  name,
  attributes: Object.entries(attributes).flatMap(([key, value]) =>
    value === undefined ? [] : [[key, String(value)] as const],
  ),
  content: typeof content === "string" ? content : content.filter((child) => child !== undefined),
});

/** A text element, or `undefined` (no element) when the value is absent. */
export const optionalXmlElement = (name: string, value: string | number | boolean | undefined): XmlElement | undefined =>
  value === undefined ? undefined : xmlElement(name, String(value));

/**
 * Whether a UTF-16 code unit sequence position holds a character XML 1.0 allows (§2.2 Char):
 * tab, line feed, carriage return, U+0020–U+D7FF, U+E000–U+FFFD, and surrogate pairs. C0
 * controls, lone surrogates and U+FFFE/U+FFFF can't be represented even escaped, so text
 * containing one is rejected instead.
 */
const isXmlChar = (codePoint: number): boolean =>
  codePoint === 0x9 ||
  codePoint === 0xa ||
  codePoint === 0xd ||
  (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
  (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
  (codePoint >= 0x10000 && codePoint <= 0x10ffff);

/** The UTF-16 index of the first character XML 1.0 cannot carry, or `undefined` when the text is valid. */
export const findInvalidXmlChar = (text: string): number | undefined => {
  let index = 0;
  for (const char of text) {
    // Iterating a string yields whole code points, or a lone surrogate as its own unit.
    const codePoint = char.codePointAt(0) ?? 0;
    if (!isXmlChar(codePoint)) return index;
    index += char.length;
  }
  return undefined;
};

const escapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
  // Escaped so that a parser's end-of-line normalization keeps them in text and attributes.
  "\r": "&#13;",
};

/** Escapes text for use in element content or a double- or single-quoted attribute value. */
export const escapeXml = (text: string): string => text.replace(/[&<>"'\r]/g, (char) => escapes[char] ?? char);

/**
 * Serializes an element tree. Fails with a description when any text or attribute value
 * contains a character XML cannot represent.
 */
export const renderXml = (root: XmlElement): Result.Result<string, string> => {
  const parts: Array<string> = [];
  const pending: Array<XmlElement | string> = [root];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    if (typeof next === "string") {
      parts.push(next);
      continue;
    }
    parts.push(`<${next.name}`);
    for (const [name, value] of next.attributes) {
      const invalid = findInvalidXmlChar(value);
      if (invalid !== undefined) {
        return Result.fail(`attribute ${name} of <${next.name}> contains a character XML cannot carry at index ${invalid}`);
      }
      parts.push(` ${name}="${escapeXml(value)}"`);
    }
    if (typeof next.content === "string") {
      const invalid = findInvalidXmlChar(next.content);
      if (invalid !== undefined) {
        return Result.fail(`<${next.name}> contains a character XML cannot carry at index ${invalid}`);
      }
      parts.push(`>${escapeXml(next.content)}</${next.name}>`);
    } else if (next.content.length === 0) {
      parts.push("/>");
    } else {
      parts.push(">");
      pending.push(`</${next.name}>`);
      for (let index = next.content.length - 1; index >= 0; index--) {
        const child = next.content[index];
        if (child !== undefined) pending.push(child);
      }
    }
  }
  return Result.succeed(parts.join(""));
};

const predefinedEntities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Decodes XML's five predefined entities and numeric character references in one pass, so
 * `&amp;#65;` stays `&#65;`. Anything else (HTML or DTD-declared names, references to
 * characters XML forbids) is left as written.
 */
export const decodeXmlEntities = (text: string): string =>
  text.includes("&")
    ? text.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos));/g, (reference, hex, decimal, name) => {
        if (typeof name === "string") return predefinedEntities[name] ?? reference;
        const codePoint = typeof hex === "string" ? Number.parseInt(hex, 16) : Number.parseInt(String(decimal), 10);
        return isXmlChar(codePoint) ? String.fromCodePoint(codePoint) : reference;
      })
    : text;

/** Replaces the parser's entity handling: no DTD or HTML entities, ever. */
const entityDecoder = {
  setExternalEntities: () => {},
  addInputEntities: () => {},
  reset: () => {},
  setXmlVersion: () => {},
  decode: decodeXmlEntities,
};

/** The key under which the parser stores an element's text when it also has attributes. */
export const xmlTextKey = "#text";

const parserOptions = (repeating: ReadonlySet<string>) => ({
  // Namespace prefixes are dropped; callers check the SOAP structure by local name.
  removeNSPrefix: true,
  ignoreAttributes: false,
  // Attributes share the object with child elements: ISDS never reuses a name for both.
  attributeNamePrefix: "",
  textNodeName: xmlTextKey,
  // Keep every value a string; Schema decodes numbers, booleans and dates.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  // XML's five predefined entities and numeric character references only. Documents with a
  // DOCTYPE are also rejected before parsing, so no DTD-declared entity is ever expanded.
  processEntities: true,
  entityDecoder,
  isArray: (tagName: string, _jPath: unknown, _isLeafNode: boolean, isAttribute: boolean) =>
    !isAttribute && repeating.has(tagName),
});

/**
 * Parses an XML document into plain objects: element local names as keys, attributes merged
 * in without a prefix, every value a string. Elements named in `repeating` are always arrays,
 * so a single occurrence decodes like many. Fails with a description on malformed XML or on a
 * document type declaration (SOAP forbids them; refusing them rules out entity expansion).
 */
export const parseXml = (xml: string, repeating: ReadonlySet<string> = new Set()): Result.Result<unknown, string> => {
  if (/<!DOCTYPE/i.test(xml)) {
    return Result.fail("the document contains a DOCTYPE declaration");
  }
  return Result.try({
    // `true` validates well-formedness first; without it the parser silently repairs input.
    try: (): unknown => new XMLParser(parserOptions(repeating)).parse(xml, true),
    catch: (error) => `malformed XML: ${error instanceof Error ? error.message : String(error)}`,
  });
};
