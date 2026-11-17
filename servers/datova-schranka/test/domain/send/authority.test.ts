import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { DomainStoreError } from "../../../src/domain/errors.js";
import { SendAuthority } from "../../../src/domain/send/authority.js";
import { authorityKey, makeTestSendAuthority } from "./support/authority.js";

describe("SendAuthority test layer", () => {
  it.effect("defaults to ok and returns the configured verdict per grant and box", () => {
    const authority = makeTestSendAuthority({ verdicts: { [authorityKey("g1", "box-b")]: "box_not_granted" } });
    return Effect.gen(function* () {
      const { check } = yield* SendAuthority;
      assert.strictEqual(yield* check("g1", "box-a"), "ok");
      assert.strictEqual(yield* check("g1", "box-b"), "box_not_granted");
      assert.strictEqual(yield* check("g2", "box-b"), "ok");
      assert.deepStrictEqual(authority.checks, [
        { grantId: "g1", boxId: "box-a" },
        { grantId: "g1", boxId: "box-b" },
        { grantId: "g2", boxId: "box-b" },
      ]);
    }).pipe(Effect.provide(authority.layer));
  });

  it.effect("observes a verdict changed mid-test on the next check, from an Effect or synchronously", () => {
    const log: Array<string> = [];
    const authority = makeTestSendAuthority({ log });
    return Effect.gen(function* () {
      const { check } = yield* SendAuthority;
      assert.strictEqual(yield* check("g1", "box-a"), "ok");
      // As a fake transport reply would: flip the verdict while producing the reply.
      const reply = authority.set("g1", "box-a", "grant_inactive").pipe(Effect.as("<CheckDataBoxResponse/>"));
      assert.strictEqual(yield* reply, "<CheckDataBoxResponse/>");
      assert.strictEqual(yield* check("g1", "box-a"), "grant_inactive");
      authority.setNow("g1", "box-a", "scope_missing");
      assert.strictEqual(yield* check("g1", "box-a"), "scope_missing");
      assert.deepStrictEqual(log, [
        "authority.check g1|box-a ok",
        "authority.check g1|box-a grant_inactive",
        "authority.check g1|box-a scope_missing",
      ]);
    }).pipe(Effect.provide(authority.layer));
  });

  it.effect("fails checks with DomainStoreError while failChecks is on", () => {
    const log: Array<string> = [];
    const authority = makeTestSendAuthority({ log });
    return Effect.gen(function* () {
      const { check } = yield* SendAuthority;
      yield* authority.failChecks();
      const error = yield* Effect.flip(check("g1", "box-a"));
      assert.instanceOf(error, DomainStoreError);
      yield* authority.failChecks(false);
      assert.strictEqual(yield* check("g1", "box-a"), "ok");
      assert.deepStrictEqual(log, ["authority.check g1|box-a failed", "authority.check g1|box-a ok"]);
    }).pipe(Effect.provide(authority.layer));
  });
});
