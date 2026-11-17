/**
 * The expiry sweep (D-j): open filings past expires_at → expired, payload cleared, nonces
 * burned, one system "filing.expire" audit row naming them, in one transaction.
 */
import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Exit } from "effect";
import { askApproval, CALLER, MINUTE, type StartedSendHarness, sendHarness } from "./support/service.js";

/** A queued (pending_admin) filing, an awaiting_approval one and a second queued one, the first two due. */
const plant = (h: StartedSendHarness) =>
  Effect.gen(function* () {
    const pending = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "key-pending" }));
    const later = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "key-later" }));
    if (pending._tag !== "Queued" || later._tag !== "Queued") return yield* Effect.die("expected Queued");
    yield* h.setTier(h.request().recipient, "approve");
    const awaiting = yield* askApproval(h, { idempotencyKey: "key-awaiting" });
    const now = yield* Clock.currentTimeMillis;
    yield* h.patchFiling(awaiting.filingId, { expires_at: now });
    yield* h.patchFiling(pending.filingId, { expires_at: now - MINUTE });
    return { awaiting, pending: pending.filingId, later: later.filingId };
  });

describe("SendService.expireDue", () => {
  it.effect("expire the due open filings: payload cleared, nonces burned, one filing.expire row; others untouched", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const { awaiting, pending, later } = yield* plant(h);

      assert.strictEqual(yield* h.service.expireDue, 2);
      for (const id of [awaiting.filingId, pending]) {
        const row = yield* h.filing(id);
        assert.strictEqual(row.state, "expired");
        assert.isNull(row.payload_sealed);
      }
      const untouched = yield* h.filing(later);
      assert.strictEqual(untouched.state, "pending_admin");
      assert.isString(untouched.payload_sealed);
      for (const nonce of yield* h.nonces) assert.isNotNull(nonce.used_at);

      const rows = yield* h.audit("filing.expire");
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(
        [rows[0]?.actor_kind, rows[0]?.outcome, rows[0]?.box_id],
        ["system", "ok", null],
      );
      assert.sameMembers((rows[0]?.detail as { filingIds: Array<string> } | undefined)?.filingIds ?? [], [awaiting.filingId, pending]);
      assert.notInclude(rows[0]?.detail_json ?? "", awaiting.nonce);

      // Nothing more is due: 0 and no further row.
      assert.strictEqual(yield* h.service.expireDue, 0);
      assert.strictEqual((yield* h.audit("filing.expire")).length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("a replay of an expired filing's key answers Expired, with or without its nonce", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const { awaiting, pending } = yield* plant(h);
      yield* h.service.expireDue;
      const created = h.calls("CreateMessage");

      const confirm = yield* h.service.sendMessage(
        CALLER,
        h.request({ idempotencyKey: "key-awaiting", approvalNonce: awaiting.nonce }),
      );
      assert.deepStrictEqual(confirm, { _tag: "Expired", filingId: awaiting.filingId });
      const again = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "key-awaiting" }));
      assert.deepStrictEqual(again, { _tag: "Expired", filingId: awaiting.filingId });
      const queued = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "key-pending" }));
      assert.deepStrictEqual(queued, { _tag: "Expired", filingId: pending });
      assert.strictEqual(h.calls("CreateMessage"), created);
    }).pipe(Effect.scoped),
  );

  it.effect("a failing audit write rolls the sweep back: DomainStoreError, filings stay open", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const { pending } = yield* plant(h);
      yield* h.exec(
        `CREATE TRIGGER fail_expire_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'filing.expire'
         BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`,
      );
      const exit = yield* Effect.exit(h.service.expireDue);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual((yield* h.filing(pending)).state, "pending_admin");
      assert.deepStrictEqual(yield* h.audit("filing.expire"), []);
    }).pipe(Effect.scoped),
  );
});
