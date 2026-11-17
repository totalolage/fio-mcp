import { assert, describe, it } from "@effect/vitest";
import { Redactor } from "@mcps/core/redaction.js";
import { Effect, Layer } from "effect";
import { AppLoggerLive, RedactorLive } from "../../src/app/app.js";

describe("AppLoggerLive", () => {
  it.effect("shares its Redactor with the app layers built inside it (main.ts provides it around serve)", () =>
    Effect.gen(function* () {
      let outer: Redactor["Service"] | undefined;
      let inner: Redactor["Service"] | undefined;
      const grab = (set: (redactor: Redactor["Service"]) => void) =>
        Layer.effectDiscard(Effect.map(Effect.service(Redactor), set)).pipe(Layer.provide(RedactorLive));
      // The app's build (serve's own Effect.provide) runs inside main.ts's provide of AppLoggerLive.
      const appBuild = Effect.scoped(Layer.build(grab((redactor) => (inner = redactor))));
      yield* appBuild.pipe(Effect.provide(Layer.mergeAll(AppLoggerLive, grab((redactor) => (outer = redactor)))));
      assert.isDefined(inner);
      assert.strictEqual(inner, outer);
      // So a box secret BoxRegistry registers on the app's Redactor is redacted in the log lines too.
      inner?.register(["box-password-in-a-log-line"]);
      assert.notInclude(outer?.redact("x box-password-in-a-log-line y") ?? "", "box-password");
    }),
  );
});
