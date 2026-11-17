/**
 * get_filing_status (C5, D-e, D-k), listFilings and getFiling: the caller grant's filings on the
 * box only, open filings expired on the spot, outcome_unknown reconciled at most once a minute.
 */
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber } from "effect";
import { failWith, sentListUnreachable, sentMessagesReply, timeoutAfterSend } from "./support/isds-replies.js";
import { CALLER, MINUTE, OTHER_CALLER, SECOND, type StartedSendHarness, sendHarness, T0 } from "./support/service.js";

const unknownFiling = (h: StartedSendHarness) =>
  Effect.gen(function* () {
    yield* h.reply("CreateMessage", failWith(timeoutAfterSend));
    const result = yield* h.service.sendMessage(CALLER, h.request());
    if (result._tag !== "OutcomeUnknown") return yield* Effect.die(`expected OutcomeUnknown, got ${result._tag}`);
    return result.filingId;
  });

describe("SendService filingStatus", () => {
  it.effect("find the caller's filing by id and by idempotency key, with guidance, audited once each", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const sent = yield* h.service.sendMessage(CALLER, h.request());
      if (sent._tag !== "Sent") return yield* Effect.die(sent._tag);
      const byId = yield* h.service.filingStatus(CALLER, h.box.id, { filingId: sent.filingId });
      const byKey = yield* h.service.filingStatus(CALLER, h.box.id, { idempotencyKey: "key-1" });
      assert.deepStrictEqual(byKey, byId);
      assert.strictEqual(byId.filing.id, sent.filingId);
      assert.strictEqual(byId.filing.state, "sent");
      assert.include(byId.guidance, sent.dmID);
      const audit = yield* h.audit("get_filing_status");
      assert.deepStrictEqual(
        audit.map((row) => [row.outcome, row.box_id, row.detail]),
        [
          ["ok", h.box.id, { filingId: sent.filingId, idempotencyKey: "key-1", state: "sent" }],
          ["ok", h.box.id, { filingId: sent.filingId, idempotencyKey: "key-1", state: "sent" }],
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("FilingNotFound for another grant's filing, another box or no filing, audited refused", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const sent = yield* h.service.sendMessage(CALLER, h.request());
      if (sent._tag !== "Sent") return yield* Effect.die(sent._tag);
      const otherGrant = yield* Effect.flip(h.service.filingStatus(OTHER_CALLER, h.box.id, { filingId: sent.filingId }));
      const otherKey = yield* Effect.flip(h.service.filingStatus(OTHER_CALLER, h.box.id, { idempotencyKey: "key-1" }));
      const otherBox = yield* Effect.flip(
        h.service.filingStatus(CALLER, "box_OOOOOOOOOOOOOOOOOOOOOO", { filingId: sent.filingId }),
      );
      const missing = yield* Effect.flip(h.service.filingStatus(CALLER, h.box.id, { filingId: "fil_missing" }));
      assert.deepStrictEqual(
        [otherGrant, otherKey, otherBox, missing].map((error) => error._tag),
        ["FilingNotFound", "FilingNotFound", "FilingNotFound", "FilingNotFound"],
      );
      const audit = yield* h.audit("get_filing_status");
      assert.deepStrictEqual(
        audit.map((row) => row.outcome),
        ["refused", "refused", "refused", "refused"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("expire a due open filing on the spot", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {}, config: { pendingTtl: Duration.minutes(5) } });
      const queued = yield* h.service.sendMessage(CALLER, h.request());
      if (queued._tag !== "Queued") return yield* Effect.die(queued._tag);
      yield* h.advance(5 * MINUTE);
      const status = yield* h.service.filingStatus(CALLER, h.box.id, { filingId: queued.filingId });
      assert.strictEqual(status.filing.state, "expired");
      assert.isNull((yield* h.filing(queued.filingId)).payload_sealed);
    }).pipe(Effect.scoped),
  );

  it.effect("reconcile an outcome_unknown filing at most once a minute and report what it found", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const filingId = yield* unknownFiling(h);
      assert.strictEqual(h.calls("GetListOfSentMessages"), 1);

      yield* h.advance(59 * SECOND);
      const throttled = yield* h.service.filingStatus(CALLER, h.box.id, { filingId });
      assert.strictEqual(throttled.filing.state, "outcome_unknown");
      assert.strictEqual(h.calls("GetListOfSentMessages"), 1);

      yield* h.advance(SECOND);
      yield* h.reply("GetListOfSentMessages", sentMessagesReply([{ dmID: "7654321" }]));
      const resolved = yield* h.service.filingStatus(CALLER, h.box.id, { filingId });
      assert.strictEqual(h.calls("GetListOfSentMessages"), 2);
      assert.strictEqual(resolved.filing.state, "sent");
      assert.strictEqual(resolved.filing.dmId, "7654321");
      assert.strictEqual(resolved.filing.reconciledAt, T0 + MINUTE);
    }).pipe(Effect.scoped),
  );

  it.effect("count a failed reconcile toward the throttle and still answer the status", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const filingId = yield* unknownFiling(h);
      yield* h.advance(MINUTE);
      yield* h.reply(
        "GetListOfSentMessages",
failWith(sentListUnreachable),
      );
      const failed = yield* h.service.filingStatus(CALLER, h.box.id, { filingId });
      assert.strictEqual(failed.filing.state, "outcome_unknown");
      assert.strictEqual(failed.filing.reconciledAt, T0 + MINUTE);
      assert.deepInclude(failed.filing.reconcile as object, { result: "error" });
      assert.strictEqual(h.calls("GetListOfSentMessages"), 2);
      assert.strictEqual((yield* h.audit("get_filing_status"))[0]?.outcome, "ok");

      yield* h.advance(30 * SECOND);
      yield* h.service.filingStatus(CALLER, h.box.id, { filingId });
      assert.strictEqual(h.calls("GetListOfSentMessages"), 2);
      yield* h.advance(30 * SECOND);
      yield* h.service.filingStatus(CALLER, h.box.id, { filingId });
      assert.strictEqual(h.calls("GetListOfSentMessages"), 3);
    }).pipe(Effect.scoped),
  );
});

describe("SendService listFilings and getFiling", () => {
  it.effect("list and get filings without auditing; FilingNotFound for a missing one", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const sent = yield* h.service.sendMessage(CALLER, h.request());
      if (sent._tag !== "Sent") return yield* Effect.die(sent._tag);
      const before = (yield* h.audit()).length;
      const listed = yield* h.service.listFilings();
      assert.deepStrictEqual(
        listed.map((filing) => [filing.id, filing.state]),
        [[sent.filingId, "sent"]],
      );
      assert.deepStrictEqual(yield* h.service.listFilings({ states: ["pending_admin"] }), []);
      const got = yield* h.service.getFiling(sent.filingId);
      assert.deepStrictEqual(got, listed[0]);
      const missing = yield* Effect.flip(h.service.getFiling("fil_missing"));
      assert.deepStrictEqual(missing._tag, "FilingNotFound");
      assert.strictEqual((yield* h.audit()).length, before);
    }).pipe(Effect.scoped),
  );
});

describe("SendService filingStatus: a listing that dies or is interrupted (C5)", () => {
  /** Checks the recorded attempt, then that a status within the minute does not list again. */
  const throttled = (h: StartedSendHarness, filingId: string) =>
    Effect.gen(function* () {
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.strictEqual(row.reconciled_at, T0 + MINUTE);
      assert.deepInclude(JSON.parse(String(row.reconcile_json)) as object, { result: "error" });
      const listed = h.calls("GetListOfSentMessages");
      yield* h.reply("GetListOfSentMessages", sentMessagesReply([]));
      yield* h.advance(59 * SECOND);
      const status = yield* h.service.filingStatus(CALLER, h.box.id, { filingId });
      assert.strictEqual(status.filing.state, "outcome_unknown");
      assert.strictEqual(h.calls("GetListOfSentMessages"), listed);
      yield* h.advance(SECOND);
      yield* h.service.filingStatus(CALLER, h.box.id, { filingId });
      assert.strictEqual(h.calls("GetListOfSentMessages"), listed + 1);
    });

  it.effect("a dying listing is recorded, the defect propagates, and the next status within a minute does not list", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const filingId = yield* unknownFiling(h);
      yield* h.advance(MINUTE);
      yield* h.reply("GetListOfSentMessages", () => Effect.die("listing defect"));
      const exit = yield* Effect.exit(h.service.filingStatus(CALLER, h.box.id, { filingId }));
      assert.isTrue(Exit.isFailure(exit) && Exit.hasDies(exit));
      yield* throttled(h, filingId);
    }).pipe(Effect.scoped),
  );

  it.effect("an interrupted listing is recorded, the interruption propagates, and the next status within a minute does not list", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const filingId = yield* unknownFiling(h);
      yield* h.advance(MINUTE);
      const listing = yield* Deferred.make<void>();
      yield* h.reply("GetListOfSentMessages", () => Deferred.succeed(listing, undefined).pipe(Effect.andThen(Effect.never)));
      const fiber = yield* Effect.forkChild(h.service.filingStatus(CALLER, h.box.id, { filingId }));
      yield* Deferred.await(listing);
      yield* Fiber.interrupt(fiber);
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)));
      yield* throttled(h, filingId);
    }).pipe(Effect.scoped),
  );
});
