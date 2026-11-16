import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";
import { decodeXmlEntities, escapeXml, findInvalidXmlChar, parseXml, renderXml, xmlElement } from "../../src/isds/xml.js";

const render = (...args: Parameters<typeof xmlElement>) => Result.getOrThrow(renderXml(xmlElement(...args)));

describe("renderXml", () => {
  it("escapes markup characters in text and attributes", () => {
    const xml = render("dmAnnotation", `</dmAnnotation><x>& "q" 'a'`, { note: `"&<'` });
    assert.strictEqual(
      xml,
      `<dmAnnotation note="&quot;&amp;&lt;&apos;">&lt;/dmAnnotation&gt;&lt;x&gt;&amp; &quot;q&quot; &apos;a&apos;</dmAnnotation>`,
    );
  });

  it("round-trips hostile text through the parser unchanged", () => {
    const hostile = `</dmAnnotation><x>&amp;&#65;\r\n]]>`;
    const parsed = Result.getOrThrow(parseXml(render("a", [xmlElement("dmAnnotation", hostile)])));
    assert.deepStrictEqual(parsed, { a: { dmAnnotation: hostile } });
  });

  it("keeps child order and drops undefined children and attributes", () => {
    assert.strictEqual(
      render("r", [xmlElement("b", "1"), undefined, xmlElement("a", [], { x: undefined, y: 2 })]),
      `<r><b>1</b><a y="2"/></r>`,
    );
  });

  it("rejects characters XML cannot carry", () => {
    assert.isTrue(Result.isFailure(renderXml(xmlElement("a", "bell\u0007"))));
    assert.isTrue(Result.isFailure(renderXml(xmlElement("a", "x", { b: "\u0000" }))));
    assert.isTrue(Result.isFailure(renderXml(xmlElement("a", "lone \uD800 surrogate"))));
  });
});

describe("findInvalidXmlChar", () => {
  it("accepts tab, newlines, BMP text and astral characters", () => {
    assert.isUndefined(findInvalidXmlChar("a\tb\nc\rd Příliš žluťoučký 😀"));
  });

  it("reports the index of the first forbidden character", () => {
    assert.strictEqual(findInvalidXmlChar("ab\u001Fc"), 2);
    assert.strictEqual(findInvalidXmlChar("😀￾"), 2);
    assert.strictEqual(findInvalidXmlChar("x\uDC00"), 1);
  });
});

describe("escapeXml / decodeXmlEntities", () => {
  it("decodes only predefined and numeric references, once", () => {
    assert.strictEqual(decodeXmlEntities("&amp;#65; &#65;&#x10D; &lt;&gt;&quot;&apos; &copy; &#0;"), `&#65; Ač <>"' &copy; &#0;`);
  });

  it("is inverted by decodeXmlEntities", () => {
    const text = `a&b<c>d"e'f\rg`;
    assert.strictEqual(decodeXmlEntities(escapeXml(text)), text);
  });
});

describe("parseXml", () => {
  it("drops namespace prefixes and keeps attributes and values as strings", () => {
    const parsed = Result.getOrThrow(
      parseXml(`<p:r xmlns:p="urn:x"><p:n>007</p:n><p:f dmMimeType="application/pdf"><p:c>QQ==</p:c></p:f></p:r>`),
    );
    assert.deepStrictEqual(parsed, { r: { n: "007", f: { dmMimeType: "application/pdf", c: "QQ==" } } });
  });

  it("parses a repeating element as an array even when it occurs once", () => {
    const parsed = Result.getOrThrow(parseXml(`<r><dmRecord><x>1</x></dmRecord></r>`, new Set(["dmRecord"])));
    assert.deepStrictEqual(parsed, { r: { dmRecord: [{ x: "1" }] } });
  });

  it("rejects a document type declaration instead of expanding its entities", () => {
    const result = parseXml(`<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "boom">]><r>&x;</r>`);
    assert.isTrue(Result.isFailure(result));
  });

  it("rejects malformed XML", () => {
    assert.isTrue(Result.isFailure(parseXml("<a><b></a>")));
  });
});
