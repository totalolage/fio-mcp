/**
 * The audit trail of the send service: exactly one row per sendMessage, filingStatus and
 * approve call with the outcome its result maps to, and never a nonce or attachment content.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  checkDataBoxUnreachable,
  createMessageStatusError,
  failWith,
  timeoutAfterSend,
} from "./support/isds-replies.js";
import { ANNEX_CONTENT, base64Of, LETTER_CONTENT, RECIPIENT_DB_ID } from "./support/requests.js";
import { ADMIN, askApproval, CALLER, sendHarness } from "./support/service.js";

const QUEUED_RECIPIENT = "rcp0001";
const APPROVE_RECIPIENT = "rcp0002";

describe("SendService audit", () => {
  it.effect("write one row per call with the outcome of its result", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: { [RECIPIENT_DB_ID]: "full", [APPROVE_RECIPIENT]: "approve" } });
      const expected: Array<readonly [string, string]> = [];
      const expect = (action: string, outcome: string) => Effect.sync(() => expected.push([action, outcome]));

      const sent = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(sent._tag, "Sent");
      yield* expect("send_message", "ok");

      const queued = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "q", recipient: QUEUED_RECIPIENT }));
      if (queued._tag !== "Queued") return yield* Effect.die(queued._tag);
      yield* expect("send_message", "ok");

      yield* askApproval(h, { idempotencyKey: "a", recipient: APPROVE_RECIPIENT });
      yield* expect("send_message", "ok");

      const refused = yield* h.service.sendMessage(CALLER, h.request({ annotation: "Other" }));
      assert.strictEqual(refused._tag, "Refused");
      yield* expect("send_message", "refused");

      yield* h.reply("CreateMessage", createMessageStatusError("1214"));
      assert.strictEqual((yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "r" })))._tag, "IsdsRejected");
      yield* expect("send_message", "error");

      yield* h.reply("CreateMessage", failWith(timeoutAfterSend));
      const unknown = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "u" }));
      assert.strictEqual(unknown._tag, "OutcomeUnknown");
      yield* expect("send_message", "uncertain");

      yield* h.reply("CheckDataBox", failWith(checkDataBoxUnreachable));
      const unavailable = yield* Effect.flip(h.service.sendMessage(CALLER, h.request({ idempotencyKey: "x" })));
      assert.strictEqual(unavailable._tag, "SendUnavailable");
      yield* expect("send_message", "error");

      if (sent._tag !== "Sent") return;
      yield* h.service.filingStatus(CALLER, h.box.id, { filingId: sent.filingId });
      yield* expect("get_filing_status", "ok");
      yield* Effect.flip(h.service.filingStatus(CALLER, h.box.id, { filingId: "fil_missing" }));
      yield* expect("get_filing_status", "refused");

      assert.strictEqual((yield* Effect.flip(h.service.approve(ADMIN, "fil_missing")))._tag, "FilingNotFound");
      yield* expect("filing.approve", "refused");
      assert.strictEqual((yield* Effect.flip(h.service.approve(ADMIN, sent.filingId)))._tag, "FilingStateConflict");
      yield* expect("filing.approve", "refused");
      // The recipient check fails now, so the approval is unavailable: nothing changed.
      assert.strictEqual((yield* Effect.flip(h.service.approve(ADMIN, queued.filingId)))._tag, "SendUnavailable");
      yield* expect("filing.approve", "error");

      const rows = yield* h.audit();
      assert.deepStrictEqual(
        rows.map((row) => [row.action, row.outcome]),
        expected,
      );
      for (const row of rows.filter((row) => row.action === "send_message" || row.action === "get_filing_status")) {
        assert.strictEqual(row.actor_kind, "tool");
        assert.strictEqual(row.grant_id, CALLER.grantId);
        assert.strictEqual(row.box_id, h.box.id);
      }
      const approvals = rows.filter((row) => row.action === "filing.approve");
      assert.deepStrictEqual(
        approvals.map((row) => [row.actor_kind, row.box_id]),
        [
          ["admin", null],
          ["admin", h.box.id],
          ["admin", h.box.id],
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("audit an approval that sends as ok with the filing id", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const queued = yield* h.service.sendMessage(CALLER, h.request());
      if (queued._tag !== "Queued") return yield* Effect.die(queued._tag);
      assert.strictEqual((yield* h.service.approve(ADMIN, queued.filingId))._tag, "Sent");
      const [approval, ...more] = yield* h.audit("filing.approve");
      assert.deepStrictEqual(more, []);
      assert.strictEqual(approval?.outcome, "ok");
      assert.deepInclude(approval?.detail as object, { filingId: queued.filingId });
    }).pipe(Effect.scoped),
  );

  it.effect("never write a nonce or attachment content into any audit detail", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: { [RECIPIENT_DB_ID]: "approve" } });
      const first = yield* askApproval(h);
      const again = yield* askApproval(h);
      assert.strictEqual(again.nonce, first.nonce);
      yield* h.service.sendMessage(CALLER, h.request({ annotation: "Other", approvalNonce: first.nonce }));
      const second = yield* askApproval(h, { idempotencyKey: "key-2" });
      yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "key-2", approvalNonce: second.nonce }));
      yield* h.service.filingStatus(CALLER, h.box.id, { idempotencyKey: "key-2" });

      const forbidden = [
        first.nonce,
        second.nonce,
        LETTER_CONTENT,
        ANNEX_CONTENT,
        base64Of(LETTER_CONTENT),
        base64Of(ANNEX_CONTENT),
      ];
      const rows = yield* h.audit();
      assert.strictEqual(rows.length, 6);
      for (const row of rows) {
        for (const secret of forbidden) assert.notInclude(row.detail_json, secret, `${row.action} detail leaks`);
      }
      // The approval answer's audit row keeps the preview (no content) but not the nonce.
      assert.include(rows[0]?.detail_json, "letter.pdf");
    }).pipe(Effect.scoped),
  );
});
