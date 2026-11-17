/**
 * Races the council review found (ds-send phase A): an interruption between the dispatch's
 * audit window and the end of the call, and a box removed while a call holds the box permit.
 */
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import {
  checkDataBoxReply,
  createMessageReply,
  failWith,
  sentListUnreachable,
  sentMessagesReply,
  timeoutAfterSend,
} from "./support/isds-replies.js";
import { ADMIN, askApproval, CALLER, MINUTE, type StartedSendHarness, sendHarness } from "./support/service.js";

/** Whether the harness box's row is gone (BoxRegistry.remove commits it before it waits for the permit). */
const boxRowGone = (h: StartedSendHarness) =>
  h
    .provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT id FROM boxes WHERE id = ${h.box.id}`;
        return rows.length === 0;
      }),
    )
    .pipe(Effect.orDie);

/** A CheckDataBox reply that removes the box (and waits until its row is gone) before answering state 1. */
const removeDuringPreflight = (h: StartedSendHarness) =>
  h.reply("CheckDataBox", () =>
    Effect.gen(function* () {
      yield* Effect.forkDetach(h.removeBox);
      yield* h.eventually(boxRowGone(h));
      return checkDataBoxReply(1);
    }),
  );

describe("SendService races", () => {
  it.effect("audits a call interrupted while CreateMessage runs as uncertain, the filing sent", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const answer = yield* Deferred.make<void>();
      yield* h.reply("CreateMessage", () => Effect.as(Deferred.await(answer), createMessageReply("4711")));
      const fiber = yield* Effect.forkChild(h.service.sendMessage(CALLER, h.request()));
      yield* h.reached("CreateMessage");
      // The interruption waits for the uninterruptible claim → outcome section, then lands after it.
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.join(interrupting);
      const exit = yield* Fiber.await(fiber);
      const [row] = yield* h.filings;
      assert.strictEqual(row?.state, "sent");
      assert.strictEqual(row?.dm_id, "4711");
      assert.strictEqual(h.calls("CreateMessage"), 1);
      const audit = yield* h.audit("send_message");
      assert.strictEqual(audit.length, 1);
      // Interrupted after the outcome was persisted: the caller got no answer, so "uncertain" (R6).
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(audit[0]?.outcome, "uncertain");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a full-tier send whose box is removed during the preflight: no row, no CreateMessage", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      yield* removeDuringPreflight(h);
      const result = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(result._tag, "Refused");
      assert.strictEqual(h.calls("CreateMessage"), 0);
      assert.deepStrictEqual(yield* h.filings, []);
    }).pipe(Effect.scoped),
  );

  it.effect("stores no open filing for a box removed during the preflight (approve tier)", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const request = h.request();
      yield* h.setTier(request.recipient, "approve");
      yield* removeDuringPreflight(h);
      const result = yield* h.service.sendMessage(CALLER, request);
      assert.strictEqual(result._tag, "Refused");
      assert.deepStrictEqual(yield* h.filings, []);
      assert.deepStrictEqual(yield* h.nonces, []);
    }).pipe(Effect.scoped),
  );

  it.effect("does not dispatch a confirmation whose box is removed during the preflight", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const request = h.request();
      yield* h.setTier(request.recipient, "approve");
      const approval = yield* askApproval(h, request);
      yield* removeDuringPreflight(h);
      const result = yield* h.service.sendMessage(CALLER, { ...request, approvalNonce: approval.nonce });
      assert.include(["Refused", "Expired"], result._tag);
      assert.strictEqual(h.calls("CreateMessage"), 0);
      const [row] = yield* h.filings;
      assert.include(["refused", "expired"], row?.state);
      assert.isNull(row?.payload_sealed);
    }).pipe(Effect.scoped),
  );

  it.effect("does not dispatch an admin approval whose box is removed during the preflight", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const queued = yield* h.service.sendMessage(CALLER, h.request());
      if (queued._tag !== "Queued") return yield* Effect.die(queued._tag);
      yield* removeDuringPreflight(h);
      const result = yield* Effect.result(h.service.approve(ADMIN, queued.filingId));
      assert.strictEqual(h.calls("CreateMessage"), 0);
      const [row] = yield* h.filings;
      assert.include(["refused", "expired"], row?.state);
      assert.isTrue(result._tag === "Failure" || result.success._tag === "Refused");
    }).pipe(Effect.scoped),
  );

  for (const [name, answer] of [
    ["finds nothing", Effect.succeed(sentMessagesReply([]))],
    ["fails", Effect.fail(sentListUnreachable())],
  ] as const) {
    it.effect(`lets only one of two concurrent status calls reconcile when the first attempt ${name}`, () =>
      Effect.gen(function* () {
        const h = yield* sendHarness();
        yield* h.reply("CreateMessage", failWith(timeoutAfterSend));
        yield* h.reply("GetListOfSentMessages", sentMessagesReply([]));
        const unknown = yield* h.service.sendMessage(CALLER, h.request());
        if (unknown._tag !== "OutcomeUnknown") return yield* Effect.die(unknown._tag);
        yield* h.advance(MINUTE);
        const listings = h.calls("GetListOfSentMessages");
        const release = yield* Deferred.make<void>();
        yield* h.reply("GetListOfSentMessages", () => Effect.andThen(Deferred.await(release), answer));
        const ref = { filingId: unknown.filingId };
        const both = yield* Effect.forkChild(
          Effect.all([h.service.filingStatus(CALLER, h.box.id, ref), h.service.filingStatus(CALLER, h.box.id, ref)], {
            concurrency: "unbounded",
          }),
        );
        // The first is listing under the permit; the second has passed its own throttle check.
        yield* h.eventually(Effect.sync(() => h.calls("GetListOfSentMessages") === listings + 1));
        yield* h.eventually(Effect.map(h.audit("get_filing_status"), (rows) => rows.length === 2));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        const statuses = yield* Fiber.join(both);
        assert.strictEqual(h.calls("GetListOfSentMessages"), listings + 1);
        for (const status of statuses) assert.strictEqual(status.filing.state, "outcome_unknown");
      }).pipe(Effect.scoped),
    );
  }
});
