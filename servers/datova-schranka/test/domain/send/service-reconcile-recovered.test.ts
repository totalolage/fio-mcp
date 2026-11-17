/**
 * reconcileRecovered (D-i): after a restart, one reconcile per filing startup recovery turned
 * outcome_unknown, one after another; a failing one is counted out. Returns how many ended sent.
 * Also the removed box (D4): a recovered filing stays resolvable without its box.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger } from "effect";
import { sentListUnreachable, sentMessagesReply } from "./support/isds-replies.js";
import { ADMIN, CALLER, MINUTE, makeSendHarness, T0 } from "./support/service.js";

/** Queued filings planted as 'dispatching', an hour apart (no competitors), then a restart recovers them. */
const recoveredHarness = (count: number) =>
  Effect.gen(function* () {
    const h = yield* makeSendHarness({ tiers: {} });
    const first = yield* h.start;
    const ids: Array<string> = [];
    for (let index = 0; index < count; index++) {
      const queued = yield* first.sendMessage(CALLER, h.request({ idempotencyKey: `key-${index}` }));
      if (queued._tag !== "Queued") return yield* Effect.die(queued._tag);
      ids.push(queued.filingId);
    }
    ids.sort();
    for (const [index, id] of ids.entries()) {
      yield* h.patchFiling(id, { state: "dispatching", submitted_at: T0 - (index + 1) * 60 * MINUTE });
    }
    return { h, ids };
  });

describe("SendService.reconcileRecovered", () => {
  it.effect("a filing whose reconcile dies is logged with its id and counted out; the rest still run", () => {
    const logs: Array<string> = [];
    const capture = Logger.make<unknown, void>((entry) => void logs.push(Logger.formatLogFmt.log(entry)));
    return Effect.gen(function* () {
      const { h, ids } = yield* recoveredHarness(3);
      const [dying = "", found = "", notFound = ""] = ids;
      yield* h.reply("GetListOfSentMessages", (_request, call) => {
        if (call === 1) return Effect.die("listing defect");
        if (call === 2) return Effect.succeed(sentMessagesReply([{ dmID: "7654321" }]));
        return Effect.succeed(sentMessagesReply([]));
      });
      const service = yield* h.start;

      assert.strictEqual(yield* service.reconcileRecovered, 1);
      assert.strictEqual(h.calls("GetListOfSentMessages"), 3);
      assert.strictEqual((yield* h.filing(dying)).state, "outcome_unknown");
      assert.strictEqual((yield* h.filing(found)).state, "sent");
      assert.strictEqual((yield* h.filing(notFound)).state, "outcome_unknown");
      const died = logs.filter((line) => line.includes("reconciling a recovered filing died"));
      assert.strictEqual(died.length, 1);
      assert.include(died[0], dying);
      assert.include(died[0], "listing defect");
    }).pipe(Effect.scoped, Effect.provide(Logger.layer([capture])));
  });

  it.effect("reconcile each recovered filing once, in order; count the ones that ended sent", () =>
    Effect.gen(function* () {
      const { h, ids } = yield* recoveredHarness(3);
      const [found = "", notFound = "", failing = ""] = ids;
      yield* h.reply("GetListOfSentMessages", (_request, call) => {
        if (call === 1) return Effect.succeed(sentMessagesReply([{ dmID: "7654321" }]));
        if (call === 2) return Effect.succeed(sentMessagesReply([]));
        return Effect.fail(sentListUnreachable());
      });
      const service = yield* h.start;

      const sent = yield* service.reconcileRecovered;
      assert.strictEqual(sent, 1);
      assert.strictEqual(h.calls("GetListOfSentMessages"), 3);

      const resolved = yield* h.filing(found);
      assert.strictEqual(resolved.state, "sent");
      assert.strictEqual(resolved.dm_id, "7654321");
      const unknown = yield* h.filing(notFound);
      assert.strictEqual(unknown.state, "outcome_unknown");
      assert.deepInclude(JSON.parse(String(unknown.reconcile_json)), { result: "not_found" });
      const errored = yield* h.filing(failing);
      assert.strictEqual(errored.state, "outcome_unknown");
      assert.deepInclude(JSON.parse(String(errored.reconcile_json)), { result: "error" });

      // Background runs are not admin calls: no audit rows besides the recovery's.
      assert.deepStrictEqual(
        (yield* h.audit()).filter((row) => row.action !== "filing.recover" && row.action !== "send_message"),
        [],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("nothing recovered: no ISDS call, 0", () =>
    Effect.gen(function* () {
      const { h } = yield* recoveredHarness(0);
      const service = yield* h.start;
      assert.strictEqual(yield* service.reconcileRecovered, 0);
      assert.strictEqual(h.calls("GetListOfSentMessages"), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("a filing resolved before the run is skipped without an ISDS call", () =>
    Effect.gen(function* () {
      const { h, ids } = yield* recoveredHarness(1);
      const service = yield* h.start;
      yield* service.confirmNotSent(ADMIN, ids[0] ?? "");
      assert.strictEqual(yield* service.reconcileRecovered, 0);
      assert.strictEqual(h.calls("GetListOfSentMessages"), 0);
      assert.strictEqual((yield* h.filing(ids[0] ?? "")).state, "not_sent");
    }).pipe(Effect.scoped),
  );

  it.effect("a removed box (D4): the recovered filing stays unknown with 'box removed', then markSent resolves it", () =>
    Effect.gen(function* () {
      const { h, ids } = yield* recoveredHarness(1);
      const filingId = ids[0] ?? "";
      yield* h.removeBox;
      const service = yield* h.start;
      assert.strictEqual((yield* h.filing(filingId)).state, "outcome_unknown");

      assert.strictEqual(yield* service.reconcileRecovered, 0);
      assert.strictEqual(h.calls("GetListOfSentMessages"), 0);
      assert.deepInclude(JSON.parse(String((yield* h.filing(filingId)).reconcile_json)), { result: "box_removed" });

      const outcome = yield* service.reconcileNow(ADMIN, filingId);
      assert.include(outcome._tag === "StillUnknown" ? outcome.detail : outcome._tag, "box removed");
      yield* service.markSent(ADMIN, filingId, "7654321");
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "sent");
      assert.strictEqual(row.dm_id, "7654321");
    }).pipe(Effect.scoped),
  );
});
