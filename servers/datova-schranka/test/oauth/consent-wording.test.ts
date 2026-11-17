import { createHash } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { DELIVERY_CONSENT_SHA256, DELIVERY_CONSENT_VERSION, DELIVERY_CONSENT_WORDING } from "../../src/oauth/consent.js";

/**
 * Every delivery-consent version ever shipped and the sha256 of its wording
 * (Czech, a newline, English). Grants and audit rows record the version, so
 * a version must never name two wordings: change the wording only together
 * with a new DELIVERY_CONSENT_VERSION, add its pin here, and keep the old pins.
 */
const PINNED: Readonly<Record<string, string>> = {
  "2026-11-17.1": "ade05a96a1ac744ce95bb0664ee0c85c8b5b0068732df039f2281446930dcfc3",
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("delivery consent wording", () => {
  it("is the wording its version pins", () => {
    const actual = sha256(`${DELIVERY_CONSENT_WORDING.cs}\n${DELIVERY_CONSENT_WORDING.en}`);
    assert.strictEqual(
      actual,
      PINNED[DELIVERY_CONSENT_VERSION],
      `the wording of ${DELIVERY_CONSENT_VERSION} changed: bump DELIVERY_CONSENT_VERSION and pin the new version`,
    );
    assert.strictEqual(DELIVERY_CONSENT_SHA256, actual);
  });

  it("never reuses a pinned wording under another version", () => {
    const hashes = Object.values(PINNED);
    assert.strictEqual(new Set(hashes).size, hashes.length);
  });
});
