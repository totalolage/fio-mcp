import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted, Result } from "effect";
import { accountTokenAad, open, parseDataKey, seal } from "../src/token-crypto.js";

const KEY = Redacted.make(new Uint8Array(32).fill(1));
const OTHER_KEY = Redacted.make(new Uint8Array(32).fill(2));
const TOKEN = "fioT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRS";

describe("data key file", () => {
  it("accepts 32 bytes as hex or base64 (standard or URL-safe, padded or not)", () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 250));
    for (const text of [
      bytes.toString("hex"),
      `${bytes.toString("hex").toUpperCase()}\n`,
      bytes.toString("base64"),
      bytes.toString("base64url"),
      bytes.toString("base64").replace(/=+$/, ""),
    ]) {
      const key = parseDataKey(text);
      assert.isDefined(key, text);
      assert.deepStrictEqual(Buffer.from(Redacted.value(key ?? KEY)), bytes);
    }
  });

  it("rejects anything that is not exactly 32 bytes", () => {
    for (const text of ["", "ab".repeat(31), "ab".repeat(33), Buffer.alloc(31).toString("base64"), "not a key at all", "zz".repeat(32)]) {
      assert.isUndefined(parseDataKey(text), text);
    }
  });
});

describe("token encryption", () => {
  it.effect("round-trips with a fresh nonce per value", () =>
    Effect.gen(function* () {
      const a = yield* seal(KEY, TOKEN, accountTokenAad("acct_a"));
      const b = yield* seal(KEY, TOKEN, accountTokenAad("acct_a"));
      assert.isFalse(Buffer.from(a.nonce).equals(Buffer.from(b.nonce)));
      assert.isFalse(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext)));
      assert.notInclude(Buffer.from(a.ciphertext).toString("latin1"), TOKEN);
      const opened = open(KEY, a, accountTokenAad("acct_a"));
      assert.isTrue(Result.isSuccess(opened));
      if (Result.isSuccess(opened)) assert.strictEqual(Redacted.value(opened.success), TOKEN);
    }),
  );

  it.effect("fails under another key, another row's AAD, or any changed byte", () =>
    Effect.gen(function* () {
      const sealed = yield* seal(KEY, TOKEN, accountTokenAad("acct_a"));
      assert.isTrue(Result.isFailure(open(OTHER_KEY, sealed, accountTokenAad("acct_a"))));
      assert.isTrue(Result.isFailure(open(KEY, sealed, accountTokenAad("acct_b"))));
      const flipped = new Uint8Array(sealed.ciphertext);
      flipped[0] = (flipped[0] ?? 0) ^ 1;
      assert.isTrue(Result.isFailure(open(KEY, { ...sealed, ciphertext: flipped }, accountTokenAad("acct_a"))));
      assert.isTrue(Result.isFailure(open(KEY, { ...sealed, tag: sealed.tag.slice(0, 8) }, accountTokenAad("acct_a"))));
    }),
  );
});
