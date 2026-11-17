/**
 * Idempotency (plan step 4, D-b): the same key and content answers the stored result in every
 * state from the DB alone; different content under the key is refused without a change.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { CALLER, sendHarness } from "./support/service.js";

const isdsStatus = JSON.stringify({ code: "1214", message: "Rejected", classification: "AttachmentRejected" });

/** Each stored state, the columns that plant it on a sent filing, and the replay's answer tag. */
const states: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>, string]> = [
  ["pending_admin", { state: "pending_admin", dm_id: null }, "Queued"],
  ["dispatching", { state: "dispatching", dm_id: null }, "InProgress"],
  ["sent", {}, "Sent"],
  ["isds_rejected", { state: "isds_rejected", dm_id: null, isds_status_json: isdsStatus }, "IsdsRejected"],
  ["refused", { state: "refused", dm_id: null, reason: "planted refusal" }, "Refused"],
  ["admin_rejected", { state: "admin_rejected", dm_id: null, reason: "no" }, "Refused"],
  ["expired", { state: "expired", dm_id: null }, "Expired"],
  ["outcome_unknown", { state: "outcome_unknown", dm_id: null }, "OutcomeUnknown"],
  ["not_sent", { state: "not_sent", dm_id: null }, "NotSent"],
];

describe("SendService idempotency", () => {
  for (const [state, columns, tag] of states) {
    it.effect(`${state}: answer the stored result without the box permit or ISDS`, () =>
      Effect.gen(function* () {
        const h = yield* sendHarness();
        const sent = yield* h.service.sendMessage(CALLER, h.request());
        if (sent._tag !== "Sent") return yield* Effect.die(sent._tag);
        yield* h.patchFiling(sent.filingId, columns);
        const before = yield* h.filing(sent.filingId);
        const calls = { check: h.calls("CheckDataBox"), create: h.calls("CreateMessage") };

        const release = yield* h.holdPermit;
        const replayed = yield* h.service.sendMessage(CALLER, h.request());
        yield* release;

        assert.strictEqual(replayed._tag, tag);
        assert.strictEqual("filingId" in replayed ? replayed.filingId : undefined, sent.filingId);
        assert.deepStrictEqual(yield* h.filing(sent.filingId), before);
        assert.deepStrictEqual({ check: h.calls("CheckDataBox"), create: h.calls("CreateMessage") }, calls);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("refuse different content under a used key without changing anything", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const sent = yield* h.service.sendMessage(CALLER, h.request());
      if (sent._tag !== "Sent") return yield* Effect.die(sent._tag);
      const before = yield* h.filings;
      const other = yield* h.service.sendMessage(CALLER, h.request({ annotation: "Another invoice" }));
      assert.strictEqual(other._tag, "Refused");
      if (other._tag === "Refused") {
        assert.include(other.reason, "different message");
        assert.isUndefined(other.filingId);
      }
      assert.deepStrictEqual(yield* h.filings, before);
      assert.strictEqual(h.calls("CreateMessage"), 1);
      assert.strictEqual(h.calls("CheckDataBox"), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("keep keys per grant: another grant's same key is a new filing", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const mine = yield* h.service.sendMessage(CALLER, h.request());
      const theirs = yield* h.service.sendMessage({ ...CALLER, grantId: "grant_2" }, h.request());
      assert.strictEqual(mine._tag, "Sent");
      assert.strictEqual(theirs._tag, "Sent");
      assert.strictEqual((yield* h.filings).length, 2);
    }).pipe(Effect.scoped),
  );
});
