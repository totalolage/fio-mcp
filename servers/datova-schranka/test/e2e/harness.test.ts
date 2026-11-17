import { describe, expect, it } from "vitest";
import { SCRUBBED, scrubber } from "./support/app.js";

describe("e2e harness scrubber", () => {
  const secret = `p"a<s s&w/rd`;
  const forms = {
    raw: secret,
    html: "p&quot;a&lt;s s&amp;w/rd",
    json: 'p\\"a<s s&w/rd',
    uri: encodeURIComponent(secret),
  };

  it.each(Object.entries(forms))("replaces the %s form and records the site", (_, form) => {
    const hits = new Set<string>();
    const scrub = scrubber(new Set([secret]), hits);
    expect(scrub(`before ${form} after`, "admin page /admin")).toBe(`before ${SCRUBBED} after`);
    expect([...hits]).toEqual(["admin page /admin"]);
  });

  it("replaces a secret that contains another one whole, and records nothing for clean text", () => {
    const hits = new Set<string>();
    const scrub = scrubber(new Set(["abc", "xabcx", ""]), hits);
    expect(scrub("clean text", "server log")).toBe("clean text");
    expect([...hits]).toEqual([]);
    expect(scrub("a xabcx b abc", "server log")).toBe(`a ${SCRUBBED} b ${SCRUBBED}`);
    expect([...hits]).toEqual(["server log"]);
  });
});
