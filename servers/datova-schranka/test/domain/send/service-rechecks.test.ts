/**
 * Refusals before anything is sent: authority first (D-a), the CheckDataBox preflight (C3,
 * D-c), and the dispatch-time rechecks at confirmation and admin approval, which run after the
 * preflight (C4).
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { AuthorityVerdict } from "../../../src/domain/send/authority.js";
import { checkDataBoxReply, checkDataBoxStatusError, checkDataBoxUnreachable, failWith } from "./support/isds-replies.js";
import { RECIPIENT_DB_ID } from "./support/requests.js";
import { ADMIN, askApproval, CALLER, type StartedSendHarness, sendHarness } from "./support/service.js";

const verdicts: ReadonlyArray<Exclude<AuthorityVerdict, "ok">> = ["grant_inactive", "scope_missing", "box_not_granted"];

/** A CheckDataBox reply that turns the caller's verdict to `verdict` from its `call`-th call on, then answers state 1. */
const flipAuthorityOnCheck = (h: StartedSendHarness, verdict: AuthorityVerdict, fromCall: number) =>
  h.reply("CheckDataBox", (_request, call) =>
    Effect.sync(() => {
      if (call >= fromCall) h.authority.setNow(CALLER.grantId, h.box.id, verdict);
      return checkDataBoxReply(1);
    }),
  );

/** The hard refusal of a stored filing: refused with the reason, payload cleared, nonces burned, nothing sent. */
const assertHardRefused = (h: StartedSendHarness, filingId: string, reasonPart: string) =>
  Effect.gen(function* () {
    const row = yield* h.filing(filingId);
    assert.strictEqual(row.state, "refused");
    assert.include(String(row.reason), reasonPart);
    assert.isNull(row.payload_sealed);
    assert.isTrue((yield* h.nonces).every((nonce) => nonce.used_at !== null));
    assert.strictEqual(h.calls("CreateMessage"), 0);
  });

describe("SendService refusals of a new send", () => {
  for (const verdict of verdicts) {
    it.effect(`${verdict} at the start: refused before anything is touched`, () =>
      Effect.gen(function* () {
        const h = yield* sendHarness();
        yield* h.authority.set(CALLER.grantId, h.box.id, verdict);
        const result = yield* h.service.sendMessage(CALLER, h.request());
        assert.strictEqual(result._tag, "Refused");
        assert.deepStrictEqual(yield* h.filings, []);
        assert.strictEqual(h.calls("CheckDataBox"), 0);
        assert.strictEqual((yield* h.audit("send_message"))[0]?.outcome, "refused");
      }).pipe(Effect.scoped),
    );
  }

  it.effect("authority lost during the preflight: refused, no row", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      yield* flipAuthorityOnCheck(h, "grant_inactive", 1);
      const result = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(result._tag, "Refused");
      assert.deepStrictEqual(yield* h.filings, []);
      assert.strictEqual(h.calls("CreateMessage"), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("an unknown box: refused, no row", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const result = yield* h.service.sendMessage(CALLER, h.request({ boxId: "box_OOOOOOOOOOOOOOOOOOOOOO" }));
      assert.strictEqual(result._tag, "Refused");
      assert.deepStrictEqual(yield* h.filings, []);
    }).pipe(Effect.scoped),
  );

  it.effect("an invalid request: refused, no row, the key stays unused", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const invalid = yield* h.service.sendMessage(CALLER, h.request({ attachments: [] }));
      assert.strictEqual(invalid._tag, "Refused");
      assert.deepStrictEqual(yield* h.filings, []);
      assert.strictEqual((yield* h.service.sendMessage(CALLER, h.request()))._tag, "Sent");
    }).pipe(Effect.scoped),
  );

  const unreceivable: ReadonlyArray<readonly [string, ReturnType<typeof checkDataBoxReply>, string]> = [
    ["a recipient box not in state 1", checkDataBoxReply(2), "ISDS state 2"],
    ["a CheckDataBox status error", checkDataBoxStatusError("5001"), "5001"],
  ];
  for (const tier of ["none", "approve", "full"] as const) {
    for (const [name, reply, reasonPart] of unreceivable) {
      it.effect(`${tier} tier, ${name}: a terminal refused row reserves the key`, () =>
        Effect.gen(function* () {
          const h = yield* sendHarness({ tiers: { [RECIPIENT_DB_ID]: tier } });
          yield* h.reply("CheckDataBox", reply);
          const result = yield* h.service.sendMessage(CALLER, h.request());
          assert.strictEqual(result._tag, "Refused");
          if (result._tag !== "Refused" || result.filingId === undefined) return yield* Effect.die("no filing");
          assert.include(result.reason, reasonPart);
          const row = yield* h.filing(result.filingId);
          assert.strictEqual(row.state, "refused");
          assert.isNull(row.payload_sealed);
          assert.deepStrictEqual(yield* h.nonces, []);
          assert.strictEqual(h.calls("CreateMessage"), 0);

          // The key is reserved: a replay answers the stored refusal without ISDS.
          yield* h.reply("CheckDataBox", checkDataBoxReply(1));
          const replayed = yield* h.service.sendMessage(CALLER, h.request());
          assert.deepStrictEqual(replayed, result);
          assert.strictEqual(h.calls("CheckDataBox"), 1);
        }).pipe(Effect.scoped),
      );
    }
  }

  it.effect("a CheckDataBox transport failure: SendUnavailable, no row", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      yield* h.reply("CheckDataBox", failWith(checkDataBoxUnreachable));
      const error = yield* Effect.flip(h.service.sendMessage(CALLER, h.request()));
      assert.strictEqual(error._tag, "SendUnavailable");
      assert.deepStrictEqual(yield* h.filings, []);
      assert.strictEqual((yield* h.audit("send_message"))[0]?.outcome, "error");
    }).pipe(Effect.scoped),
  );
});

describe("SendService dispatch-time rechecks", () => {
  for (const verdict of verdicts) {
    it.effect(`${verdict} at confirmation, seen after the preflight: hard refusal`, () =>
      Effect.gen(function* () {
        const h = yield* sendHarness({ tiers: { [RECIPIENT_DB_ID]: "approve" } });
        const first = yield* askApproval(h);
        yield* flipAuthorityOnCheck(h, verdict, 2);
        const result = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: first.nonce }));
        assert.strictEqual(result._tag, "Refused");
        if (result._tag === "Refused") assert.strictEqual(result.filingId, first.filingId);
        yield* assertHardRefused(h, first.filingId, "authorization");
      }).pipe(Effect.scoped),
    );

    it.effect(`${verdict} at admin approval, seen after the preflight: hard refusal`, () =>
      Effect.gen(function* () {
        const h = yield* sendHarness({ tiers: {} });
        const queued = yield* h.service.sendMessage(CALLER, h.request());
        if (queued._tag !== "Queued") return yield* Effect.die(queued._tag);
        yield* flipAuthorityOnCheck(h, verdict, 2);
        const result = yield* h.service.approve(ADMIN, queued.filingId);
        assert.strictEqual(result._tag, "Refused");
        yield* assertHardRefused(h, queued.filingId, "authorization");
        assert.strictEqual((yield* h.audit("filing.approve"))[0]?.outcome, "refused");
      }).pipe(Effect.scoped),
    );
  }

  it.effect("a recipient that can no longer receive at confirmation: hard refusal", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: { [RECIPIENT_DB_ID]: "approve" } });
      const first = yield* askApproval(h);
      yield* h.reply("CheckDataBox", checkDataBoxReply(4));
      const result = yield* h.service.sendMessage(CALLER, h.request({ approvalNonce: first.nonce }));
      assert.strictEqual(result._tag, "Refused");
      yield* assertHardRefused(h, first.filingId, "ISDS state 4");
    }).pipe(Effect.scoped),
  );

  it.effect("a recipient that can no longer receive at admin approval: hard refusal", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const queued = yield* h.service.sendMessage(CALLER, h.request());
      if (queued._tag !== "Queued") return yield* Effect.die(queued._tag);
      yield* h.reply("CheckDataBox", checkDataBoxStatusError("5001"));
      const result = yield* h.service.approve(ADMIN, queued.filingId);
      assert.strictEqual(result._tag, "Refused");
      yield* assertHardRefused(h, queued.filingId, "5001");
    }).pipe(Effect.scoped),
  );

  it.effect("a corrupt stored payload at admin approval: hard refusal", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const queued = yield* h.service.sendMessage(CALLER, h.request());
      if (queued._tag !== "Queued") return yield* Effect.die(queued._tag);
      yield* h.patchFiling(queued.filingId, { payload_sealed: "not-a-sealed-payload" });
      const result = yield* h.service.approve(ADMIN, queued.filingId);
      assert.strictEqual(result._tag, "Refused");
      yield* assertHardRefused(h, queued.filingId, "payload");
    }).pipe(Effect.scoped),
  );
});
