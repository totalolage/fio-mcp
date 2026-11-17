import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger } from "effect";
import {
  LoggerLive,
  loggerLayer,
  makeRedactor,
  REDACTED,
  Redactor,
  type RedactorShape,
  stderrLogger,
} from "../src/redaction.js";

// A demo app whose storage API takes a box id as a bearer secret in the
// path (`/box/<id>`); it scrubs that segment with its own `extra`.
const BOX_PATH = /\/box\/[^/\s?#"'<>]+/g;
const scrubBoxPath = (text: string) => text.replace(BOX_PATH, `/box/${REDACTED}`);
const SECRET = "demo-secret-123";

describe("makeRedactor", () => {
  it("replaces every form of a registered secret", () => {
    const redactor = makeRedactor(["a&b c"]);
    assert.strictEqual(redactor.redact("raw a&b c"), `raw ${REDACTED}`);
    assert.strictEqual(redactor.redact("uri a%26b%20c"), `uri ${REDACTED}`);
    assert.strictEqual(redactor.redact("xml a&amp;b c"), `xml ${REDACTED}`);
  });

  it("replaces a longer secret that contains a shorter one in full", () => {
    const redactor = makeRedactor(["abc", "abcdef"]);
    assert.strictEqual(redactor.redact("x abcdef y abc"), `x ${REDACTED} y ${REDACTED}`);
  });

  it("runs the app's extra scrubber after secret replacement", () => {
    const seen: Array<string> = [];
    const redactor = makeRedactor([SECRET], (text) => {
      seen.push(text);
      return scrubBoxPath(text);
    });
    assert.strictEqual(
      redactor.redact(`GET https://storage.example.test/box/b-42/items?key=${SECRET}`),
      `GET https://storage.example.test/box/${REDACTED}/items?key=${REDACTED}`,
    );
    assert.deepStrictEqual(seen, [`GET https://storage.example.test/box/b-42/items?key=${REDACTED}`]);
  });

  it("leaves text alone without an extra scrubber", () => {
    assert.strictEqual(makeRedactor([SECRET]).redact("/box/b-42"), "/box/b-42");
  });

  it("redacts secrets registered later, ignoring empty ones", () => {
    const redactor = makeRedactor([]);
    redactor.register([""]);
    assert.strictEqual(redactor.redact("late-secret"), "late-secret");
    redactor.register(["late-secret"]);
    assert.strictEqual(redactor.redact("late-secret"), REDACTED);
  });

  it("redacts deep values, keys included, and drops undefined fields", () => {
    const redactor = makeRedactor([SECRET], scrubBoxPath);
    assert.deepStrictEqual(
      redactor.redactDeep<unknown>({ [SECRET]: [`/box/b-1`, 7, null], gone: undefined, nested: { note: SECRET } }),
      { [REDACTED]: [`/box/${REDACTED}`, 7, null], nested: { note: REDACTED } },
    );
  });

  it("excerpts a body as one short, tag-free, secret-free line", () => {
    const redactor = makeRedactor([SECRET], scrubBoxPath);
    assert.strictEqual(
      redactor.excerpt(`<html>\n<p>bad ${SECRET}</p>\n<a href="/box/b-9">x</a></html>`),
      `bad ${REDACTED} x`,
    );
    const long = redactor.excerpt("y".repeat(400));
    assert.strictEqual(long, `${"y".repeat(300)}…`);
  });

  it("strips only whole tags from an excerpt, keeping a stray `<` and its text", () => {
    const redactor = makeRedactor([SECRET]);
    assert.strictEqual(redactor.excerpt(`1 < 2 <b>${SECRET}</b> <p`), `1 < 2 ${REDACTED} <p`);
  });
});

describe("Redactor.layer", () => {
  it.effect("builds the service from the app's secrets and scrubber", () =>
    Effect.gen(function* () {
      const redactor: RedactorShape = yield* Redactor;
      assert.strictEqual(redactor.redact(`/box/b-1 ${SECRET}`), `/box/${REDACTED} ${REDACTED}`);
    }).pipe(Effect.provide(Redactor.layer(Effect.succeed([SECRET]), scrubBoxPath))),
  );

  it.effect("fails the layer with the secrets effect's error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.scoped(Layer.build(Redactor.layer(Effect.fail("no secrets" as const)))),
      );
      assert.strictEqual(error, "no secrets");
    }),
  );

  it.effect("LoggerLive builds on the Redactor service", () =>
    Effect.scoped(Layer.build(LoggerLive.pipe(Layer.provide(Redactor.layer(Effect.succeed([SECRET])))))).pipe(
      Effect.asVoid,
    ),
  );

  it.effect("loggerLayer(prepare) builds on the Redactor service", () =>
    Effect.scoped(Layer.build(loggerLayer((line) => line).pipe(Layer.provide(Redactor.layer(Effect.succeed([SECRET])))))).pipe(
      Effect.asVoid,
    ),
  );
});

// The demo app marks text in its log lines with `[[mark]]`; its `prepare`
// removes the marks before the line is redacted.
const stripDemoMarks = (line: string) => line.split("[[mark]]").join("");

const captureStderr = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const written: Array<string> = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    yield* effect.pipe(Effect.ensuring(Effect.sync(() => (process.stderr.write = original))));
    return written;
  });

describe("stderrLogger", () => {
  it.effect("runs `prepare` on the formatted line before redacting it", () =>
    Effect.gen(function* () {
      const [half1, half2] = [SECRET.slice(0, 6), SECRET.slice(6)];
      const written = yield* captureStderr(
        Effect.logError(`failed with ${half1}[[mark]]${half2}`).pipe(
          Effect.provide(Logger.layer([stderrLogger(makeRedactor([SECRET]), stripDemoMarks)])),
        ),
      );
      assert.strictEqual(written.length, 1);
      assert.notInclude(written[0], "[[mark]]");
      assert.notInclude(written[0], SECRET);
      assert.include(written[0], `failed with ${REDACTED}`);
    }),
  );

  it.effect("writes the line unchanged apart from redaction without `prepare`", () =>
    Effect.gen(function* () {
      const written = yield* captureStderr(
        Effect.logError(`kept [[mark]] ${SECRET}`).pipe(Effect.provide(Logger.layer([stderrLogger(makeRedactor([SECRET]))]))),
      );
      assert.strictEqual(written.length, 1);
      assert.include(written[0], `kept [[mark]] ${REDACTED}`);
    }),
  );

  it.effect("loggerLayer passes `prepare` to the stderr logger", () =>
    Effect.gen(function* () {
      const written = yield* captureStderr(
        Effect.logError(`x${SECRET.slice(0, 4)}[[mark]]${SECRET.slice(4)}`).pipe(
          Effect.provide(loggerLayer(stripDemoMarks).pipe(Layer.provide(Redactor.layer(Effect.succeed([SECRET]))))),
        ),
      );
      assert.strictEqual(written.length, 1);
      assert.include(written[0], `x${REDACTED}`);
    }),
  );
});
