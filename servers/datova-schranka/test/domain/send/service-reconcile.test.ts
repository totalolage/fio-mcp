/**
 * The follow-up reconcile after an unknown CreateMessage outcome (C5, D-e) and the removed box
 * (D4): Found resolves to sent; anything else stays outcome_unknown with the attempt recorded.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { failWith, sentMessagesReply, timeoutAfterSend } from "./support/isds-replies.js";
import { CALLER, dmIdOf, MINUTE, type StartedSendHarness, sendHarness } from "./support/service.js";

/** A full-tier send whose CreateMessage times out after the request went out. */
const unknownSend = (h: StartedSendHarness, key: string) =>
  Effect.gen(function* () {
    yield* h.reply("CreateMessage", failWith(timeoutAfterSend));
    const result = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: key }));
    return { result, filingId: "filingId" in result ? String(result.filingId) : "" };
  });

const reconcileOf = (row: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  JSON.parse(String(row.reconcile_json)) as Record<string, unknown>;

describe("SendService follow-up reconcile", () => {
  it.effect("Found: resolve to sent with the listed dmID", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      yield* h.reply("GetListOfSentMessages", sentMessagesReply([{ dmID: "7654321" }]));
      const { result, filingId } = yield* unknownSend(h, "key-1");
      assert.deepStrictEqual(result, { _tag: "Sent", filingId, dmID: "7654321" });
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "sent");
      assert.strictEqual(row.dm_id, "7654321");
      assert.deepInclude(reconcileOf(row), { result: "found", dmID: "7654321" });
      assert.isNumber(row.reconciled_at);
      assert.strictEqual((yield* h.audit("send_message"))[0]?.outcome, "ok");
    }).pipe(Effect.scoped),
  );

  it.effect("NotFound: stay outcome_unknown, attempt recorded", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const { result, filingId } = yield* unknownSend(h, "key-1");
      assert.strictEqual(result._tag, "OutcomeUnknown");
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.deepInclude(reconcileOf(row), { result: "not_found" });
      assert.isNumber(row.reconciled_at);
    }).pipe(Effect.scoped),
  );

  it.effect("Ambiguous: stay outcome_unknown with the candidate dmIDs recorded", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      yield* h.reply("GetListOfSentMessages", sentMessagesReply([{ dmID: "7654321" }, { dmID: "7654322" }]));
      const { result, filingId } = yield* unknownSend(h, "key-1");
      assert.strictEqual(result._tag, "OutcomeUnknown");
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.deepInclude(reconcileOf(row), { result: "ambiguous", dmIDs: ["7654321", "7654322"] });
      assert.isNumber(row.reconciled_at);
    }).pipe(Effect.scoped),
  );

  it.effect("a match whose dmID is already linked to another filing: stay outcome_unknown", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const first = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(first._tag, "Sent");
      yield* h.reply("GetListOfSentMessages", sentMessagesReply([{ dmID: dmIdOf(1) }]));
      const { result, filingId } = yield* unknownSend(h, "key-2");
      assert.strictEqual(result._tag, "OutcomeUnknown");
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.isNull(row.dm_id);
      assert.deepInclude(reconcileOf(row), { result: "dmid_linked", dmID: dmIdOf(1) });
      assert.isNumber(row.reconciled_at);
    }).pipe(Effect.scoped),
  );

  it.effect("a match while another local filing to the recipient is in flight: stay outcome_unknown", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const earlier = yield* unknownSend(h, "key-1");
      assert.strictEqual(earlier.result._tag, "OutcomeUnknown");
      yield* h.advance(MINUTE);
      yield* h.reply("GetListOfSentMessages", sentMessagesReply([{ dmID: "7654321" }]));
      const { result, filingId } = yield* unknownSend(h, "key-2");
      assert.strictEqual(result._tag, "OutcomeUnknown");
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.isNull(row.dm_id);
      assert.deepInclude(reconcileOf(row), { result: "competing", dmID: "7654321", competitors: [earlier.filingId] });
      assert.isNumber(row.reconciled_at);
    }).pipe(Effect.scoped),
  );

  it.effect("a removed box: stay outcome_unknown with 'box removed' recorded, through filingStatus", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const { filingId } = yield* unknownSend(h, "key-1");
      const listed = h.calls("GetListOfSentMessages");
      yield* h.removeBox;
      yield* h.advance(MINUTE);
      const status = yield* h.service.filingStatus(CALLER, h.box.id, { filingId });
      assert.strictEqual(status.filing.state, "outcome_unknown");
      assert.deepInclude(status.filing.reconcile as object, { result: "box_removed" });
      const row = yield* h.filing(filingId);
      assert.deepInclude(reconcileOf(row), { result: "box_removed" });
      assert.strictEqual(row.reconciled_at, row.updated_at);
      assert.isAbove(Number(row.reconciled_at), Number(row.submitted_at));
      assert.strictEqual(h.calls("GetListOfSentMessages"), listed);
    }).pipe(Effect.scoped),
  );
});
