/**
 * Concurrent dispatch claims (C1, D-d): however callers race, only the claim's winner calls
 * CreateMessage, once.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { RECIPIENT_DB_ID } from "./support/requests.js";
import { ADMIN, askApproval, CALLER, dmIdOf, type StartedSendHarness, sendHarness } from "./support/service.js";

/**
 * Runs `a` and `b` concurrently with the box permit held until both have passed `ready`
 * (their reads before the permit), so both race for the claim.
 */
const race = <A, E>(h: StartedSendHarness, ready: Effect.Effect<boolean>, a: Effect.Effect<A, E>, b: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const release = yield* h.holdPermit;
    const fiber = yield* Effect.forkChild(Effect.all([a, b], { concurrency: "unbounded" }));
    yield* h.eventually(ready);
    yield* release;
    return yield* Fiber.join(fiber);
  });

describe("SendService concurrent claims", () => {
  for (const round of [1, 2, 3]) {
    it.effect(`two admin approvals of one filing: one send (round ${round})`, () =>
      Effect.gen(function* () {
        const h = yield* sendHarness({ tiers: {} });
        const queued = yield* h.service.sendMessage(CALLER, h.request());
        if (queued._tag !== "Queued") return yield* Effect.die(queued._tag);
        const results = yield* race(
          h,
          Effect.map(h.audit("filing.approve"), (rows) => rows.length === 2),
          Effect.result(h.service.approve(ADMIN, queued.filingId)),
          Effect.result(h.service.approve(ADMIN, queued.filingId)),
        );
        assert.strictEqual(h.calls("CreateMessage"), 1);
        const tags = results.map((result) => (result._tag === "Success" ? result.success._tag : result.failure._tag)).sort();
        assert.deepStrictEqual(tags, ["FilingStateConflict", "Sent"]);
        assert.strictEqual((yield* h.filing(queued.filingId)).state, "sent");
        assert.strictEqual((yield* h.audit("filing.approve")).length, 2);
      }).pipe(Effect.scoped),
    );

    it.effect(`two confirmations with the same nonce: one send (round ${round})`, () =>
      Effect.gen(function* () {
        const h = yield* sendHarness({ tiers: { [RECIPIENT_DB_ID]: "approve" } });
        const first = yield* askApproval(h);
        const confirm = h.request({ approvalNonce: first.nonce });
        const checks = h.authority.checks.length;
        const results = yield* race(
          h,
          Effect.sync(() => h.authority.checks.length === checks + 2),
          h.service.sendMessage(CALLER, confirm),
          h.service.sendMessage(CALLER, confirm),
        );
        assert.strictEqual(h.calls("CreateMessage"), 1);
        const sent = { _tag: "Sent", filingId: first.filingId, dmID: dmIdOf(1) };
        assert.deepInclude(results, sent);
        // The loser either replays the stored Sent or finds the nonce already used.
        for (const result of results) assert.include(["Sent", "Refused"], result._tag);
        assert.strictEqual((yield* h.filings).length, 1);
      }).pipe(Effect.scoped),
    );

    it.effect(`two full-tier sends with the same key: one filing, one send (round ${round})`, () =>
      Effect.gen(function* () {
        const h = yield* sendHarness();
        const results = yield* race(
          h,
          Effect.sync(() => h.authority.checks.length === 2),
          h.service.sendMessage(CALLER, h.request()),
          h.service.sendMessage(CALLER, h.request()),
        );
        assert.strictEqual(h.calls("CreateMessage"), 1);
        const [row, ...others] = yield* h.filings;
        assert.deepStrictEqual(others, []);
        assert.strictEqual(row?.state, "sent");
        for (const result of results) {
          assert.include(["Sent", "InProgress"], result._tag);
          assert.strictEqual("filingId" in result ? result.filingId : undefined, row?.id);
        }
      }).pipe(Effect.scoped),
    );
  }
});
