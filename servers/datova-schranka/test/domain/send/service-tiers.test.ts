/**
 * The three recipient tiers end to end: none queues for an administrator, approve asks the
 * caller to confirm with a nonce, full sends autonomously.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { RECIPIENT_DB_ID } from "./support/requests.js";
import { ADMIN, CALLER, dmIdOf, sendHarness } from "./support/service.js";

describe("SendService tiers", () => {
  it.effect("none: queue the filing for an administrator with its payload sealed, nothing sent", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const result = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(result._tag, "Queued");
      if (result._tag !== "Queued") return;
      const row = yield* h.filing(result.filingId);
      assert.strictEqual(row.state, "pending_admin");
      assert.strictEqual(row.tier, "none");
      assert.isString(row.payload_sealed);
      assert.strictEqual(h.calls("CheckDataBox"), 1);
      assert.strictEqual(h.calls("CreateMessage"), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("none, approved by an administrator: Sent with exactly one CreateMessage", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const queued = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(queued._tag, "Queued");
      if (queued._tag !== "Queued") return;
      const approved = yield* h.service.approve(ADMIN, queued.filingId);
      assert.deepStrictEqual(approved, { _tag: "Sent", filingId: queued.filingId, dmID: dmIdOf(1) });
      assert.strictEqual(h.calls("CreateMessage"), 1);
      const row = yield* h.filing(queued.filingId);
      assert.strictEqual(row.state, "sent");
      assert.strictEqual(row.dm_id, dmIdOf(1));
      assert.isNull(row.payload_sealed);
      // Approving again finds it sent: a conflict, no second send.
      const again = yield* Effect.flip(h.service.approve(ADMIN, queued.filingId));
      assert.strictEqual(again._tag, "FilingStateConflict");
      assert.strictEqual(h.calls("CreateMessage"), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("approve: the first call asks for confirmation, the confirming call with the nonce sends", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: { [RECIPIENT_DB_ID]: "approve" } });
      const first = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(first._tag, "ApprovalRequired");
      if (first._tag !== "ApprovalRequired") return;
      assert.isAbove(first.nonce.length, 40);
      assert.strictEqual(first.preview.recipient, RECIPIENT_DB_ID);
      assert.strictEqual(first.preview.attachments.length, 2);
      assert.strictEqual((yield* h.filing(first.filingId)).state, "awaiting_approval");
      assert.strictEqual(h.calls("CreateMessage"), 0);

      const confirmed = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: first.nonce }));
      assert.deepStrictEqual(confirmed, { _tag: "Sent", filingId: first.filingId, dmID: dmIdOf(1) });
      assert.strictEqual(h.calls("CreateMessage"), 1);
      const [nonce] = yield* h.nonces;
      assert.isNotNull(nonce?.used_at);
    }).pipe(Effect.scoped),
  );

  it.effect("full: send autonomously in one call", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const result = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(result._tag, "Sent");
      if (result._tag !== "Sent") return;
      assert.strictEqual(result.dmID, dmIdOf(1));
      const row = yield* h.filing(result.filingId);
      assert.strictEqual(row.state, "sent");
      assert.strictEqual(row.tier, "full");
      assert.isNull(row.payload_sealed);
      assert.strictEqual(h.calls("CheckDataBox"), 1);
      assert.strictEqual(h.calls("CreateMessage"), 1);
    }).pipe(Effect.scoped),
  );
});
