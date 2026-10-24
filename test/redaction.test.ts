import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Logger } from "effect";
import { AppConfig } from "../src/config.js";
import { makeRedactor, Redactor, stderrLogger } from "../src/redaction.js";
import { PAY_TOKEN, READ_TOKEN } from "./fixtures.js";

describe("token redaction", () => {
  it("redacts configured tokens anywhere in text", () => {
    const { redact } = makeRedactor([READ_TOKEN]);
    assert.strictEqual(redact(`token=${READ_TOKEN}&x=1`), "token=***&x=1");
  });

  it("redacts token path segments even for unknown tokens", () => {
    const { redact } = makeRedactor([]);
    assert.strictEqual(
      redact("GET https://fioapi.fio.cz/v1/rest/periods/SECRET123/2024-01-01/2024-01-31/transactions.json"),
      "GET https://fioapi.fio.cz/v1/rest/periods/***/2024-01-01/2024-01-31/transactions.json",
    );
    assert.strictEqual(
      redact("/set-last-id/SECRET/123/ and /lastStatement/SECRET/statement"),
      "/set-last-id/***/123/ and /lastStatement/***/statement",
    );
  });

  it("redacts a token that straddles the excerpt truncation point", () => {
    const { excerpt } = makeRedactor([READ_TOKEN]);
    const short = excerpt(`${"x".repeat(280)}${READ_TOKEN}`);
    assert.notInclude(short, READ_TOKEN.slice(0, 20));
    assert.strictEqual(short, `${"x".repeat(280)}***`);
    const tagged = excerpt(`<html><body>${"x".repeat(290)}<b>${READ_TOKEN}</b> tail</body></html>`);
    assert.notInclude(tagged, READ_TOKEN.slice(0, 5));
  });

  it("redacts JSON- and XML-escaped forms", () => {
    const json = makeRedactor(['ab"cd\\ef']);
    assert.strictEqual(json.redact(JSON.stringify({ token: 'ab"cd\\ef' })), '{"token":"***"}');
    const xml = makeRedactor(["gh&ij<kl"]);
    assert.strictEqual(xml.redact("<msg>gh&amp;ij&lt;kl</msg>"), "<msg>***</msg>");
    assert.strictEqual(xml.excerpt("<msg>gh&amp;ij&lt;kl</msg>"), "***");
  });

  it("does not throw on a malformed secret", () => {
    const { redact } = makeRedactor(["\ud800"]);
    assert.strictEqual(redact("plain text"), "plain text");
  });

  it("redacts every string and key in a JSON-like value, leaving other values alone", () => {
    const { redactDeep } = makeRedactor([READ_TOKEN, PAY_TOKEN]);
    const value = {
      [READ_TOKEN]: [`a ${PAY_TOKEN}`, 1, null, { nested: READ_TOKEN, ok: true }],
    };
    assert.deepStrictEqual<unknown>(redactDeep(value), { "***": ["a ***", 1, null, { nested: "***", ok: true }] });
    // Undefined fields are dropped so the result is a JSON value.
    assert.deepStrictEqual<unknown>(redactDeep({ a: undefined, b: [{ c: undefined, d: 1 }] }), { b: [{ d: 1 }] });
  });

  it.effect("the stderr logger writes redacted logfmt lines to stderr only", () =>
    Effect.gen(function* () {
      const written: Array<string> = [];
      const original = process.stderr.write.bind(process.stderr);
      const stdout = process.stdout.write.bind(process.stdout);
      let stdoutWrites = 0;
      process.stderr.write = ((chunk: string) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      process.stdout.write = ((chunk: string) => {
        stdoutWrites++;
        return stdout(chunk);
      }) as typeof process.stdout.write;
      yield* Effect.logError(`request to /periods/${READ_TOKEN}/2024-01-01 failed with ${PAY_TOKEN}`).pipe(
        Effect.provide(Logger.layer([stderrLogger(makeRedactor([READ_TOKEN, PAY_TOKEN]))])),
        Effect.ensuring(
          Effect.sync(() => {
            process.stderr.write = original;
            process.stdout.write = stdout;
          }),
        ),
      );
      assert.strictEqual(written.length, 1);
      assert.notInclude(written[0], READ_TOKEN);
      assert.notInclude(written[0], PAY_TOKEN);
      assert.include(written[0], "/periods/***/2024-01-01");
      assert.strictEqual(stdoutWrites, 0);
    }),
  );
});

describe("tokens added at runtime", () => {
  it("are redacted from the moment they are registered", () => {
    const redactor = makeRedactor([READ_TOKEN]);
    assert.strictEqual(redactor.redact(`a ${PAY_TOKEN} b`), `a ${PAY_TOKEN} b`);
    redactor.register([PAY_TOKEN]);
    assert.strictEqual(redactor.redact(`a ${PAY_TOKEN} ${READ_TOKEN} b`), "a *** *** b");
  });

  it.effect("reach the logger: main.ts's logger and the app build the same Redactor", () =>
    Effect.gen(function* () {
      // main.ts provides the logger's layers around `Layer.launch(AppLive)`;
      // the inner build reuses the outer one's Redactor from the memo map.
      let outer: Redactor["Service"] | undefined;
      let inner: Redactor["Service"] | undefined;
      const env = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: "/home/test", FIO_TOKEN: READ_TOKEN } }));
      const grab = (set: (redactor: Redactor["Service"]) => void) =>
        Layer.effectDiscard(Effect.map(Effect.service(Redactor), set)).pipe(
          Layer.provide(Redactor.layer),
          Layer.provide(AppConfig.layer),
          Layer.provide(Layer.mergeAll(NodeFileSystem.layer, env)),
        );
      const innerBuild = Effect.scoped(
        Layer.build(
          grab((r) => {
            inner = r;
          }),
        ),
      );
      yield* innerBuild.pipe(
        Effect.provide(
          grab((r) => {
            outer = r;
          }),
        ),
      );
      assert.isDefined(outer);
      assert.strictEqual(inner, outer);
    }),
  );
});
