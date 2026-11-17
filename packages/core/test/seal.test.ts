import { randomBytes } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted, Result } from "effect";
import { open, seal } from "../src/seal.js";

// A demo app that stores API keys per workspace, bound to the workspace id.
const aad = (workspace: string) => `demo-app:api-key:v1:${workspace}`;
const newKey = () => Redacted.make(new Uint8Array(randomBytes(32)));

describe("seal and open", () => {
  it.effect("round-trips a secret under the same key and AAD", () =>
    Effect.gen(function* () {
      const key = newKey();
      const sealed = yield* seal(key, "sk-demo-1", aad("w1"));
      assert.strictEqual(sealed.nonce.length, 12);
      assert.strictEqual(sealed.tag.length, 16);
      assert.notInclude(Buffer.from(sealed.ciphertext).toString("utf8"), "sk-demo-1");
      const opened = open(key, sealed, aad("w1"));
      assert.isTrue(Result.isSuccess(opened));
      if (Result.isSuccess(opened)) assert.strictEqual(Redacted.value(opened.success), "sk-demo-1");
    }),
  );

  it.effect("uses a fresh nonce for every value", () =>
    Effect.gen(function* () {
      const key = newKey();
      const a = yield* seal(key, "same", aad("w1"));
      const b = yield* seal(key, "same", aad("w1"));
      assert.notDeepEqual(a.nonce, b.nonce);
    }),
  );

  it.effect("fails with no detail under another AAD, key, or a changed byte", () =>
    Effect.gen(function* () {
      const key = newKey();
      const sealed = yield* seal(key, "sk-demo-1", aad("w1"));
      const tampered = { ...sealed, ciphertext: sealed.ciphertext.map((byte, i) => (i === 0 ? byte ^ 1 : byte)) };
      for (const result of [
        open(key, sealed, aad("w2")),
        open(newKey(), sealed, aad("w1")),
        open(key, tampered, aad("w1")),
        open(key, { ...sealed, tag: sealed.tag.slice(0, 8) }, aad("w1")),
      ]) {
        assert.deepStrictEqual(result, Result.fail("invalid"));
      }
    }),
  );
});
