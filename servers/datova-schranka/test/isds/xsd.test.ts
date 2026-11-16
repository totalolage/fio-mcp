import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { XsBase64, xmlTextMax } from "../../src/isds/xsd.js";

const decodeBase64 = Schema.decodeUnknownEffect(XsBase64);
const encodeBase64 = Schema.encodeEffect(XsBase64);

describe("XsBase64", () => {
  it.effect("round-trips every byte value and ignores XML whitespace", () =>
    Effect.gen(function* () {
      const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
      const text = yield* encodeBase64(bytes);
      const wrapped = text.replace(/(.{76})/g, "$1\r\n ");
      const decoded = yield* decodeBase64(wrapped);
      assert.strictEqual(decoded.constructor, Uint8Array);
      assert.deepStrictEqual(decoded, bytes);
    }),
  );

  it.effect("rejects text outside the base64 alphabet or with broken padding", () =>
    Effect.gen(function* () {
      for (const text of ["QQ=", "Q===", "QQ==QQ==", "QQ-_", "QQ==\u0000", "Q Q"]) {
        const result = yield* Effect.exit(decodeBase64(text));
        assert.isTrue(result._tag === "Failure", text);
      }
      assert.deepStrictEqual(yield* decodeBase64(""), new Uint8Array());
    }),
  );
});

describe("xmlTextMax", () => {
  it.effect("counts code points, so an astral character counts once", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(xmlTextMax(3));
      assert.strictEqual(yield* decode("ab😀"), "ab😀");
      assert.strictEqual((yield* Effect.exit(decode("abc😀")))._tag, "Failure");
      assert.strictEqual((yield* Effect.exit(decode("a\u0001")))._tag, "Failure");
    }),
  );
});
