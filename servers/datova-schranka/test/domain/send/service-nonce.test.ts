/**
 * The approve tier's nonce (C2, D-f): single use, bound to its filing, content, box and grant,
 * replayed after a lost response until it expires, and the tier change between issue and confirm (D-g).
 */
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { RECIPIENT_DB_ID } from "./support/requests.js";
import { ADMIN, askApproval, CALLER, dmIdOf, MINUTE, OTHER_CALLER, SECOND, sendHarness, T0 } from "./support/service.js";

const approvalHarness = (options: Parameters<typeof sendHarness>[0] = {}) =>
  sendHarness({ tiers: { [RECIPIENT_DB_ID]: "approve" }, ...options });

describe("SendService approval nonce", () => {
  it.effect("refuse an expired nonce and leave the filing awaiting approval", () =>
    Effect.gen(function* () {
      const h = yield* approvalHarness();
      const first = yield* askApproval(h);
      yield* h.advance(15 * MINUTE + SECOND);
      const late = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: first.nonce }));
      assert.strictEqual(late._tag, "Refused");
      if (late._tag === "Refused") assert.include(late.reason, "expired");
      assert.strictEqual((yield* h.filing(first.filingId)).state, "awaiting_approval");
      assert.strictEqual(h.calls("CreateMessage"), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("cap the nonce's expiry at the filing's", () =>
    Effect.gen(function* () {
      const h = yield* approvalHarness({ config: { pendingTtl: Duration.minutes(5) } });
      const first = yield* askApproval(h);
      const row = yield* h.filing(first.filingId);
      assert.strictEqual(first.expiresAt, row.expires_at);
      yield* h.advance(5 * MINUTE);
      // The filing is due: expired on the spot, so the confirmation answers Expired.
      const late = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: first.nonce }));
      assert.deepStrictEqual(late, { _tag: "Expired", filingId: first.filingId });
      const expired = yield* h.filing(first.filingId);
      assert.strictEqual(expired.state, "expired");
      assert.isNull(expired.payload_sealed);
      assert.strictEqual(h.calls("CreateMessage"), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("refuse a used nonce, also under another idempotency key, without a new filing", () =>
    Effect.gen(function* () {
      const h = yield* approvalHarness();
      const first = yield* askApproval(h);
      const sent = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: first.nonce }));
      assert.strictEqual(sent._tag, "Sent");
      const replayed = yield* h.service.sendMessage(
        CALLER,
        h.request({ idempotencyKey: "key-2", approvalNonce: first.nonce }),
      );
      assert.strictEqual(replayed._tag, "Refused");
      if (replayed._tag === "Refused") assert.include(replayed.reason, "already used");
      assert.strictEqual((yield* h.filings).length, 1);
      assert.strictEqual(h.calls("CreateMessage"), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("burn the nonce on a content mismatch and leave the filing unchanged", () =>
    Effect.gen(function* () {
      const h = yield* approvalHarness();
      const first = yield* askApproval(h);
      const before = yield* h.filing(first.filingId);
      yield* h.advance(SECOND);
      const mismatch = yield* h.service.sendMessage(
        CALLER,
        h.request({ annotation: "Another invoice", approvalNonce: first.nonce }),
      );
      assert.strictEqual(mismatch._tag, "Refused");
      if (mismatch._tag === "Refused") assert.include(mismatch.reason, "does not match");
      assert.deepStrictEqual(yield* h.filing(first.filingId), before);
      const [nonce] = yield* h.nonces;
      assert.isNotNull(nonce?.used_at);

      // The burnt nonce no longer confirms the right content either.
      const retry = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: first.nonce }));
      assert.strictEqual(retry._tag, "Refused");
      if (retry._tag === "Refused") assert.include(retry.reason, "already used");
      assert.strictEqual(h.calls("CreateMessage"), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("refuse another grant's nonce without burning it; its owner can still confirm", () =>
    Effect.gen(function* () {
      const h = yield* approvalHarness();
      const first = yield* askApproval(h);
      const stolen = yield* h.service.sendMessage(OTHER_CALLER, h.request({ approvalNonce: first.nonce }));
      assert.strictEqual(stolen._tag, "Refused");
      if (stolen._tag === "Refused") assert.include(stolen.reason, "not issued to this authorization");
      const [nonce] = yield* h.nonces;
      assert.isNull(nonce?.used_at);
      assert.strictEqual((yield* h.filings).length, 1);

      const confirmed = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: first.nonce }));
      assert.deepStrictEqual(confirmed, { _tag: "Sent", filingId: first.filingId, dmID: dmIdOf(1) });
    }).pipe(Effect.scoped),
  );

  it.effect("refuse an unknown nonce", () =>
    Effect.gen(function* () {
      const h = yield* approvalHarness();
      const first = yield* askApproval(h);
      const unknown = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: `${first.nonce}x` }));
      assert.strictEqual(unknown._tag, "Refused");
      if (unknown._tag === "Refused") assert.include(unknown.reason, "unknown approvalNonce");
      assert.strictEqual((yield* h.filing(first.filingId)).state, "awaiting_approval");
    }).pipe(Effect.scoped),
  );

  it.effect("replay a lost response with the same nonce until it expires, then a fresh one", () =>
    Effect.gen(function* () {
      const h = yield* approvalHarness();
      const first = yield* askApproval(h);
      yield* h.advance(MINUTE);
      const again = yield* askApproval(h);
      assert.deepStrictEqual(again, first);

      yield* h.advance(15 * MINUTE);
      const fresh = yield* askApproval(h);
      assert.strictEqual(fresh.filingId, first.filingId);
      assert.notStrictEqual(fresh.nonce, first.nonce);
      assert.isAbove(fresh.expiresAt, first.expiresAt);
      assert.strictEqual((yield* h.nonces).filter((row) => row.used_at === null).length, 1);

      const stale = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: first.nonce }));
      assert.strictEqual(stale._tag, "Refused");
      const confirmed = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: fresh.nonce }));
      assert.deepStrictEqual(confirmed, { _tag: "Sent", filingId: first.filingId, dmID: dmIdOf(1) });
    }).pipe(Effect.scoped),
  );

  it.effect("answer a repeated confirming call with the stored Sent, without a second send", () =>
    Effect.gen(function* () {
      const h = yield* approvalHarness();
      const first = yield* askApproval(h);
      const confirm = h.request({ approvalNonce: first.nonce });
      const sent = yield* h.service.sendMessage(CALLER, confirm);
      const repeated = yield* h.service.sendMessage(CALLER, confirm);
      assert.deepStrictEqual(repeated, sent);
      assert.strictEqual(h.calls("CreateMessage"), 1);
      assert.strictEqual(h.calls("CheckDataBox"), 2);
    }).pipe(Effect.scoped),
  );
});

describe("SendService tier change between nonce issue and confirmation", () => {
  it.effect("approve → none: the confirmation queues the filing for an administrator", () =>
    Effect.gen(function* () {
      const h = yield* approvalHarness();
      const first = yield* askApproval(h);
      yield* h.setTier(RECIPIENT_DB_ID, "none");
      yield* h.advance(MINUTE);
      const queued = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: first.nonce }));
      assert.deepStrictEqual(queued, { _tag: "Queued", filingId: first.filingId });
      const row = yield* h.filing(first.filingId);
      assert.strictEqual(row.state, "pending_admin");
      assert.isString(row.payload_sealed);
      assert.strictEqual(row.expires_at, T0 + MINUTE + 168 * 60 * MINUTE);
      assert.isTrue((yield* h.nonces).every((nonce) => nonce.used_at !== null));
      assert.strictEqual(h.calls("CreateMessage"), 0);

      const approved = yield* h.service.approve(ADMIN, first.filingId);
      assert.deepStrictEqual(approved, { _tag: "Sent", filingId: first.filingId, dmID: dmIdOf(1) });
    }).pipe(Effect.scoped),
  );

  it.effect("approve → full: the confirmation proceeds", () =>
    Effect.gen(function* () {
      const h = yield* approvalHarness();
      const first = yield* askApproval(h);
      yield* h.setTier(RECIPIENT_DB_ID, "full");
      const sent = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: first.nonce }));
      assert.deepStrictEqual(sent, { _tag: "Sent", filingId: first.filingId, dmID: dmIdOf(1) });
      assert.strictEqual(h.calls("CreateMessage"), 1);
    }).pipe(Effect.scoped),
  );
});
