import { assert, describe, it } from "@effect/vitest";
import { messageStateMask } from "../../src/isds/models.js";

describe("messageStateMask", () => {
  it("sets bit 2^n for each state n (PDF §2.9.1)", () => {
    assert.strictEqual(messageStateMask([5, 6]), 96);
    assert.strictEqual(messageStateMask(new Set([1])), 2);
    assert.strictEqual(messageStateMask([10]), 1024);
    assert.strictEqual(messageStateMask([4, 5, 6, 7, 10]), 16 + 32 + 64 + 128 + 1024);
  });

  it("is -1 for all and 0 for no states", () => {
    assert.strictEqual(messageStateMask("all"), -1);
    assert.strictEqual(messageStateMask([]), 0);
  });
});
