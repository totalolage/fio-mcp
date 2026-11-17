/**
 * The admin decisions besides approve (D-h): reject, reconcileNow, markSent, confirmNotSent, and
 * the removed box (D4). Each call is audited once under its action, refusals as "refused".
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { createMessageReply, failWith, sentListUnreachable, sentMessagesReply, timeoutAfterSend } from "./support/isds-replies.js";
import { ADMIN, CALLER, dmIdOf, MINUTE, type StartedSendHarness, sendHarness } from "./support/service.js";

/** A full-tier send whose CreateMessage times out after the request went out (follow-up: NotFound). */
const unknownSend = (h: StartedSendHarness, key: string) =>
  Effect.gen(function* () {
    yield* h.reply("CreateMessage", failWith(timeoutAfterSend));
    const result = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: key }));
    if (result._tag !== "OutcomeUnknown") return yield* Effect.die(`expected OutcomeUnknown, got ${result._tag}`);
    yield* h.reply("CreateMessage", (_request, call) => Effect.succeed(createMessageReply(dmIdOf(call))));
    return result.filingId;
  });

/** A send queued for the administrator (tier none). */
const queuedSend = (h: StartedSendHarness, key: string) =>
  Effect.gen(function* () {
    const result = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: key }));
    if (result._tag !== "Queued") return yield* Effect.die(`expected Queued, got ${result._tag}`);
    return result.filingId;
  });

const outcomes = (h: StartedSendHarness, action: string) =>
  Effect.map(h.audit(action), (rows) => rows.map((row) => row.outcome));

const reconcileOf = (row: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  JSON.parse(String(row.reconcile_json)) as Record<string, unknown>;

describe("SendService.reject", () => {
  it.effect("pending_admin → admin_rejected: reason stored, payload cleared, nothing sent, audited ok", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const filingId = yield* queuedSend(h, "key-1");
      assert.isString((yield* h.filing(filingId)).payload_sealed);

      yield* h.service.reject(ADMIN, filingId, "  wrong recipient  ");
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "admin_rejected");
      assert.strictEqual(row.reason, "wrong recipient");
      assert.isNull(row.payload_sealed);
      assert.strictEqual(h.calls("CreateMessage"), 0);

      const rows = yield* h.audit("filing.reject");
      assert.deepStrictEqual(
        rows.map((r) => [r.actor_kind, r.outcome, r.box_id, r.detail]),
        [["admin", "ok", h.box.id, { filingId, reason: "wrong recipient" }]],
      );

      // The caller's replay reports the rejection.
      const replay = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "key-1" }));
      assert.deepStrictEqual(replay, {
        _tag: "Refused",
        filingId,
        reason: "an administrator rejected the message: wrong recipient",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("no reason given: none stored or audited", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const filingId = yield* queuedSend(h, "key-1");
      yield* h.service.reject(ADMIN, filingId);
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "admin_rejected");
      assert.isNull(row.reason);
      assert.deepStrictEqual((yield* h.audit("filing.reject"))[0]?.detail, { filingId });
    }).pipe(Effect.scoped),
  );

  it.effect("a filing not pending_admin: FilingStateConflict, unchanged, audited refused", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const sent = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(sent._tag, "Sent");
      const filingId = "filingId" in sent ? (sent.filingId ?? "") : "";
      const error = yield* Effect.flip(h.service.reject(ADMIN, filingId, "too late"));
      assert.deepInclude(error, { _tag: "FilingStateConflict", filingId, state: "sent", expected: "pending_admin" });
      assert.strictEqual((yield* h.filing(filingId)).state, "sent");
      assert.deepStrictEqual(yield* outcomes(h, "filing.reject"), ["refused"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a pending_admin filing past its expiry: expired on the spot, FilingStateConflict", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const filingId = yield* queuedSend(h, "key-1");
      yield* h.patchFiling(filingId, { expires_at: 1 });
      const error = yield* Effect.flip(h.service.reject(ADMIN, filingId));
      assert.deepInclude(error, { _tag: "FilingStateConflict", state: "expired" });
      assert.strictEqual((yield* h.filing(filingId)).state, "expired");
      assert.deepStrictEqual(yield* outcomes(h, "filing.reject"), ["refused"]);
    }).pipe(Effect.scoped),
  );

  it.effect("an unknown id: FilingNotFound, audited refused without a box", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const error = yield* Effect.flip(h.service.reject(ADMIN, "fil_missing"));
      assert.deepInclude(error, { _tag: "FilingNotFound", filingId: "fil_missing" });
      const rows = yield* h.audit("filing.reject");
      assert.deepStrictEqual(
        rows.map((r) => [r.outcome, r.box_id]),
        [["refused", null]],
      );
    }).pipe(Effect.scoped),
  );
});

describe("SendService.reconcileNow", () => {
  it.effect("Found: outcome_unknown → sent, audited ok with the dmID", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const filingId = yield* unknownSend(h, "key-1");
      yield* h.reply("GetListOfSentMessages", sentMessagesReply([{ dmID: "7654321" }]));
      const outcome = yield* h.service.reconcileNow(ADMIN, filingId);
      assert.deepStrictEqual(outcome, { _tag: "Sent", dmID: "7654321" });
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "sent");
      assert.strictEqual(row.dm_id, "7654321");
      const rows = yield* h.audit("filing.reconcile");
      assert.deepStrictEqual(
        rows.map((r) => [r.actor_kind, r.outcome, r.box_id, r.detail]),
        [["admin", "ok", h.box.id, { filingId, outcome: "Sent", dmID: "7654321" }]],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("always runs: no throttle right after the follow-up's attempt", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const filingId = yield* unknownSend(h, "key-1");
      const listed = h.calls("GetListOfSentMessages");
      const first = yield* h.service.reconcileNow(ADMIN, filingId);
      const second = yield* h.service.reconcileNow(ADMIN, filingId);
      assert.strictEqual(first._tag, "StillUnknown");
      assert.strictEqual(second._tag, "StillUnknown");
      assert.strictEqual(h.calls("GetListOfSentMessages"), listed + 2);
      assert.deepStrictEqual(yield* outcomes(h, "filing.reconcile"), ["ok", "ok"]);
    }).pipe(Effect.scoped),
  );

  it.effect("NotFound and Ambiguous: stays outcome_unknown, attempt recorded", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const filingId = yield* unknownSend(h, "key-1");
      yield* h.advance(MINUTE);
      const notFound = yield* h.service.reconcileNow(ADMIN, filingId);
      assert.deepStrictEqual(notFound, { _tag: "StillUnknown", detail: "no matching sent message was found (yet)" });
      const afterNotFound = yield* h.filing(filingId);
      assert.strictEqual(afterNotFound.state, "outcome_unknown");
      assert.deepInclude(reconcileOf(afterNotFound), { result: "not_found" });
      assert.strictEqual(afterNotFound.reconciled_at, afterNotFound.updated_at);

      yield* h.reply("GetListOfSentMessages", sentMessagesReply([{ dmID: "7654321" }, { dmID: "7654322" }]));
      const ambiguous = yield* h.service.reconcileNow(ADMIN, filingId);
      assert.strictEqual(ambiguous._tag, "StillUnknown");
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.deepInclude(reconcileOf(row), { result: "ambiguous", dmIDs: ["7654321", "7654322"] });
      assert.deepStrictEqual(yield* outcomes(h, "filing.reconcile"), ["ok", "ok"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a match whose dmID is linked to another filing: stays outcome_unknown", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const first = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(first._tag, "Sent");
      const filingId = yield* unknownSend(h, "key-2");
      yield* h.reply("GetListOfSentMessages", sentMessagesReply([{ dmID: dmIdOf(1) }]));
      const outcome = yield* h.service.reconcileNow(ADMIN, filingId);
      assert.strictEqual(outcome._tag, "StillUnknown");
      assert.include(outcome._tag === "StillUnknown" ? outcome.detail : "", "already linked");
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.isNull(row.dm_id);
      assert.deepInclude(reconcileOf(row), { result: "dmid_linked", dmID: dmIdOf(1) });
    }).pipe(Effect.scoped),
  );

  it.effect("a match while a competing filing is in flight: stays outcome_unknown", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const earlier = yield* unknownSend(h, "key-1");
      yield* h.advance(MINUTE);
      const filingId = yield* unknownSend(h, "key-2");
      yield* h.reply("GetListOfSentMessages", sentMessagesReply([{ dmID: "7654321" }]));
      const outcome = yield* h.service.reconcileNow(ADMIN, filingId);
      assert.strictEqual(outcome._tag, "StillUnknown");
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.deepInclude(reconcileOf(row), { result: "competing", competitors: [earlier] });
    }).pipe(Effect.scoped),
  );

  it.effect("a transport error: SendUnavailable, state unchanged, attempt recorded, audited error", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const filingId = yield* unknownSend(h, "key-1");
      yield* h.advance(MINUTE);
      yield* h.reply("GetListOfSentMessages", failWith(sentListUnreachable));
      const error = yield* Effect.flip(h.service.reconcileNow(ADMIN, filingId));
      assert.strictEqual(error._tag, "SendUnavailable");
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.deepInclude(reconcileOf(row), { result: "error" });
      assert.strictEqual(row.reconciled_at, row.updated_at);
      assert.deepStrictEqual(yield* outcomes(h, "filing.reconcile"), ["error"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a filing not outcome_unknown: NotApplicable, no ISDS call, audited refused", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const filingId = yield* queuedSend(h, "key-1");
      const listed = h.calls("GetListOfSentMessages");
      const outcome = yield* h.service.reconcileNow(ADMIN, filingId);
      assert.deepStrictEqual(outcome, { _tag: "NotApplicable", state: "pending_admin" });
      assert.strictEqual(h.calls("GetListOfSentMessages"), listed);
      assert.deepStrictEqual(yield* outcomes(h, "filing.reconcile"), ["refused"]);
    }).pipe(Effect.scoped),
  );

  it.effect("an unknown id: FilingNotFound, audited refused", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const error = yield* Effect.flip(h.service.reconcileNow(ADMIN, "fil_missing"));
      assert.strictEqual(error._tag, "FilingNotFound");
      assert.deepStrictEqual(yield* outcomes(h, "filing.reconcile"), ["refused"]);
    }).pipe(Effect.scoped),
  );
});

describe("SendService.markSent", () => {
  it.effect("a valid dmID: outcome_unknown → sent with it, audited ok", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const filingId = yield* unknownSend(h, "key-1");
      yield* h.service.markSent(ADMIN, filingId, "7654321");
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "sent");
      assert.strictEqual(row.dm_id, "7654321");
      const rows = yield* h.audit("filing.mark_sent");
      assert.deepStrictEqual(
        rows.map((r) => [r.actor_kind, r.outcome, r.box_id, r.detail]),
        [["admin", "ok", h.box.id, { filingId, dmId: "7654321" }]],
      );
      const replay = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "key-1" }));
      assert.deepStrictEqual(replay, { _tag: "Sent", filingId, dmID: "7654321" });
    }).pipe(Effect.scoped),
  );

  it.effect("an invalid dmID: SendUnavailable 'not a valid message ID', unchanged, audited refused", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const filingId = yield* unknownSend(h, "key-1");
      for (const dmId of ["", "abc", "123456789012345678901", " 7654321"]) {
        const error = yield* Effect.flip(h.service.markSent(ADMIN, filingId, dmId));
        assert.strictEqual(error._tag, "SendUnavailable");
        assert.include(error.message, "is not a valid message ID");
      }
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.isNull(row.dm_id);
      assert.deepStrictEqual(yield* outcomes(h, "filing.mark_sent"), ["refused", "refused", "refused", "refused"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a dmID linked to another filing: DmIdLinked, unchanged, audited refused", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const first = yield* h.service.sendMessage(CALLER, h.request());
      const firstId = "filingId" in first ? (first.filingId ?? "") : "";
      const filingId = yield* unknownSend(h, "key-2");
      const error = yield* Effect.flip(h.service.markSent(ADMIN, filingId, dmIdOf(1)));
      assert.deepInclude(error, { _tag: "DmIdLinked", dmId: dmIdOf(1), filingId: firstId });
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.isNull(row.dm_id);
      assert.deepStrictEqual(yield* outcomes(h, "filing.mark_sent"), ["refused"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a filing not outcome_unknown: FilingStateConflict, audited refused; unknown id: FilingNotFound", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const filingId = yield* queuedSend(h, "key-1");
      const conflict = yield* Effect.flip(h.service.markSent(ADMIN, filingId, "7654321"));
      assert.deepInclude(conflict, { _tag: "FilingStateConflict", state: "pending_admin", expected: "outcome_unknown" });
      assert.strictEqual((yield* h.filing(filingId)).state, "pending_admin");
      const missing = yield* Effect.flip(h.service.markSent(ADMIN, "fil_missing", "7654321"));
      assert.strictEqual(missing._tag, "FilingNotFound");
      assert.deepStrictEqual(yield* outcomes(h, "filing.mark_sent"), ["refused", "refused"]);
    }).pipe(Effect.scoped),
  );
});

describe("SendService.confirmNotSent", () => {
  it.effect("outcome_unknown → not_sent; the same key replays NotSent, a new key starts a fresh flow", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const filingId = yield* unknownSend(h, "key-1");
      const created = h.calls("CreateMessage");
      yield* h.service.confirmNotSent(ADMIN, filingId);
      const row = yield* h.filing(filingId);
      assert.strictEqual(row.state, "not_sent");
      assert.isNull(row.dm_id);
      const rows = yield* h.audit("filing.confirm_not_sent");
      assert.deepStrictEqual(
        rows.map((r) => [r.actor_kind, r.outcome, r.box_id, r.detail]),
        [["admin", "ok", h.box.id, { filingId }]],
      );

      const replay = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "key-1" }));
      assert.deepStrictEqual(replay, { _tag: "NotSent", filingId });
      assert.strictEqual(h.calls("CreateMessage"), created);

      const fresh = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "key-2" }));
      assert.strictEqual(fresh._tag, "Sent");
      assert.notStrictEqual("filingId" in fresh ? (fresh.filingId ?? "") : "", filingId);
      assert.strictEqual(h.calls("CreateMessage"), created + 1);
    }).pipe(Effect.scoped),
  );

  it.effect("a filing not outcome_unknown: FilingStateConflict, audited refused; unknown id: FilingNotFound", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const sent = yield* h.service.sendMessage(CALLER, h.request());
      const filingId = "filingId" in sent ? (sent.filingId ?? "") : "";
      const conflict = yield* Effect.flip(h.service.confirmNotSent(ADMIN, filingId));
      assert.deepInclude(conflict, { _tag: "FilingStateConflict", state: "sent", expected: "outcome_unknown" });
      assert.strictEqual((yield* h.filing(filingId)).state, "sent");
      const missing = yield* Effect.flip(h.service.confirmNotSent(ADMIN, "fil_missing"));
      assert.strictEqual(missing._tag, "FilingNotFound");
      assert.deepStrictEqual(yield* outcomes(h, "filing.confirm_not_sent"), ["refused", "refused"]);
    }).pipe(Effect.scoped),
  );
});

describe("SendService admin decisions on a removed box (D4)", () => {
  it.effect("outcome_unknown filings stay resolvable: reconcileNow says the box is gone, markSent and confirmNotSent work", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const toMark = yield* unknownSend(h, "key-1");
      yield* h.advance(16 * MINUTE);
      const toConfirm = yield* unknownSend(h, "key-2");
      yield* h.removeBox;
      const listed = h.calls("GetListOfSentMessages");

      const outcome = yield* h.service.reconcileNow(ADMIN, toMark);
      assert.strictEqual(outcome._tag, "StillUnknown");
      assert.include(outcome._tag === "StillUnknown" ? outcome.detail : "", "box removed");
      assert.strictEqual(h.calls("GetListOfSentMessages"), listed);
      assert.deepInclude(reconcileOf(yield* h.filing(toMark)), { result: "box_removed" });

      yield* h.service.markSent(ADMIN, toMark, "7654321");
      yield* h.service.confirmNotSent(ADMIN, toConfirm);
      assert.strictEqual((yield* h.filing(toMark)).state, "sent");
      assert.strictEqual((yield* h.filing(toConfirm)).state, "not_sent");
      assert.deepStrictEqual(yield* outcomes(h, "filing.reconcile"), ["ok"]);
      assert.deepStrictEqual(yield* outcomes(h, "filing.mark_sent"), ["ok"]);
      assert.deepStrictEqual(yield* outcomes(h, "filing.confirm_not_sent"), ["ok"]);
    }).pipe(Effect.scoped),
  );
});
