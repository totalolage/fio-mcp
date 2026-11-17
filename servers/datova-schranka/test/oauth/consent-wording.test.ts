import { createHash } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import {
  ACCEPTED_DELIVERY_CONSENT_VERSIONS,
  DELIVERY_CONSENT_SHA256,
  DELIVERY_CONSENT_VERSION,
  DELIVERY_CONSENT_VERSION_PATTERN,
  DELIVERY_CONSENT_WORDING,
} from "../../src/oauth/consent.js";

/**
 * Every delivery-consent version ever shipped and the sha256 of its wording
 * (Czech, a newline, English). Grants and audit rows record the version, so
 * a version must never name two wordings: change the wording only together
 * with a new DELIVERY_CONSENT_VERSION, add its pin here, and keep the old pins.
 */
const PINNED: Readonly<Record<string, string>> = {
  "2026-11-17.1": "461f65f4bb7d7bfd102f5ca6dafbd0c385f091f27033ce1eaa140f4bd7be1e90",
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

  it("accepts only pinned, well-formed versions, the current one included", () => {
    assert.isTrue(ACCEPTED_DELIVERY_CONSENT_VERSIONS.has(DELIVERY_CONSENT_VERSION));
    for (const version of ACCEPTED_DELIVERY_CONSENT_VERSIONS) {
      assert.match(version, DELIVERY_CONSENT_VERSION_PATTERN);
      assert.isDefined(PINNED[version], version);
    }
  });
});
