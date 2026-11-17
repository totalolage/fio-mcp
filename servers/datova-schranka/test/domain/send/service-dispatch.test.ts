/**
 * CreateMessage outcomes (C4, D-d): which failures make a filing outcome_unknown, refused or
 * isds_rejected; a dmID already on another filing; the outcome write that keeps failing; and
 * the interrupted follow-up reconcile (obligation 4).
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Logger } from "effect";
import type { IsdsClientShape } from "../../../src/isds/client.js";
import { IsdsConfigError, IsdsCredentialsError, IsdsInvalidRequest, IsdsMessageTooLarge } from "../../../src/isds/errors.js";
import {
  ambiguousTransportFailures,
  createMessageReply,
  createMessageStatusError,
  createMessageWithoutDmId,
  failWith,
  soapFaultReply,
  timeoutAfterSend,
  timeoutBeforeSend,
} from "./support/isds-replies.js";
import { CALLER, dmIdOf, type ScriptedReply, SECOND, type StartedSendHarness, sendHarness } from "./support/service.js";

/** One full-tier send whose CreateMessage answers `reply`; the result, its row and its audit outcome. */
const sendWith = (h: StartedSendHarness, reply: ScriptedReply) =>
  Effect.gen(function* () {
    yield* h.reply("CreateMessage", reply);
    const result = yield* h.service.sendMessage(CALLER, h.request());
    const filingId = "filingId" in result ? result.filingId : undefined;
    if (filingId === undefined) return yield* Effect.die(`no filing for ${result._tag}`);
    const row = yield* h.filing(filingId);
    const [audit] = yield* h.audit("send_message");
    return { result, row, outcome: audit?.outcome };
  });

const ambiguous: ReadonlyArray<readonly [string, ScriptedReply]> = [
  ...Object.entries(ambiguousTransportFailures).map(([name, failure]) => [name, failWith(failure)] as const),
  ["IsdsSoapFault", soapFaultReply()],
  ["IsdsInvalidResponse (0000 without dmID)", createMessageWithoutDmId()],
  ["a defect", () => Effect.die("transport exploded")],
];

type CreateMessageError = Effect.Error<ReturnType<IsdsClientShape["createMessage"]>>;

/**
 * Replaces CreateMessage on the client with a failure the real client raises before the
 * transport; IsdsConfigError and IsdsCredentialsError are outside its declared error type (the
 * real client meets them building the transport), so they are cast in.
 */
const failBeforeTransport = (
  error: CreateMessageError | IsdsConfigError | IsdsCredentialsError,
): IsdsClientShape["createMessage"] => {
  const fail = () => Effect.fail(error);
  return fail as unknown as IsdsClientShape["createMessage"];
};

const preSend: ReadonlyArray<readonly [string, IsdsClientShape["createMessage"]]> = [
  ["IsdsInvalidRequest", failBeforeTransport(new IsdsInvalidRequest({ operation: "CreateMessage", detail: "bad" }))],
  ["IsdsMessageTooLarge", failBeforeTransport(new IsdsMessageTooLarge({ totalBytes: 20_000_001, limitBytes: 20_000_000 }))],
  ["IsdsConfigError", failBeforeTransport(new IsdsConfigError({ detail: "bad config" }))],
  ["IsdsCredentialsError", failBeforeTransport(new IsdsCredentialsError({ detail: "bad credentials" }))],
];

describe("SendService CreateMessage outcomes", () => {
  for (const [name, reply] of ambiguous) {
    it.effect(`outcome_unknown after ${name}, with the follow-up reconcile recorded`, () =>
      Effect.gen(function* () {
        const h = yield* sendHarness();
        const { result, row, outcome } = yield* sendWith(h, reply);
        assert.strictEqual(result._tag, "OutcomeUnknown");
        assert.strictEqual(row.state, "outcome_unknown");
        assert.include(String(row.reason), "ISDS may have received the message");
        assert.isNull(row.dm_id);
        // The follow-up found nothing (the default listing is empty) and recorded the attempt.
        assert.strictEqual(h.calls("GetListOfSentMessages"), 1);
        assert.deepInclude(JSON.parse(String(row.reconcile_json)), { result: "not_found" });
        assert.isNumber(row.reconciled_at);
        assert.strictEqual(outcome, "uncertain");
        assert.strictEqual(h.calls("CreateMessage"), 1);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("refused after IsdsTimeoutError before the request went out", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const { result, row, outcome } = yield* sendWith(h, failWith(timeoutBeforeSend));
      assert.strictEqual(result._tag, "Refused");
      assert.strictEqual(row.state, "refused");
      assert.include(String(row.reason), "nothing was sent");
      assert.strictEqual(outcome, "refused");
      assert.strictEqual(h.calls("GetListOfSentMessages"), 0);
    }).pipe(Effect.scoped),
  );

  for (const [name, override] of preSend) {
    it.effect(`refused after ${name}`, () =>
      Effect.gen(function* () {
        const h = yield* sendHarness();
        yield* h.overrideCreateMessage(override);
        const result = yield* h.service.sendMessage(CALLER, h.request());
        assert.strictEqual(result._tag, "Refused");
        if (result._tag !== "Refused" || result.filingId === undefined) return;
        assert.include(result.reason, "nothing was sent");
        const row = yield* h.filing(result.filingId);
        assert.strictEqual(row.state, "refused");
        assert.strictEqual(h.calls("CreateMessage"), 1);
        assert.strictEqual(h.calls("GetListOfSentMessages"), 0);
        assert.strictEqual((yield* h.audit("send_message"))[0]?.outcome, "refused");
      }).pipe(Effect.scoped),
    );
  }

  it.effect("isds_rejected after IsdsStatusError, with the status stored", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const { result, row, outcome } = yield* sendWith(h, createMessageStatusError("1214"));
      assert.strictEqual(result._tag, "IsdsRejected");
      if (result._tag === "IsdsRejected") assert.strictEqual(result.status.code, "1214");
      assert.strictEqual(row.state, "isds_rejected");
      assert.strictEqual(JSON.parse(String(row.isds_status_json)).code, "1214");
      assert.strictEqual(outcome, "error");
      assert.strictEqual(h.calls("GetListOfSentMessages"), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("outcome_unknown when ISDS answers with a dmID already on another filing, without a reconcile", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const first = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(first._tag, "Sent");
      yield* h.reply("CreateMessage", createMessageReply(dmIdOf(1)));
      const second = yield* h.service.sendMessage(CALLER, h.request({ idempotencyKey: "key-2" }));
      assert.strictEqual(second._tag, "OutcomeUnknown");
      if (second._tag !== "OutcomeUnknown" || first._tag !== "Sent") return;
      const row = yield* h.filing(second.filingId);
      assert.strictEqual(row.state, "outcome_unknown");
      assert.isNull(row.dm_id);
      assert.include(String(row.reason), first.filingId);
      assert.deepInclude(JSON.parse(String(row.reconcile_json)), {
        result: "dmid_linked",
        dmID: dmIdOf(1),
        linkedTo: first.filingId,
      });
      assert.strictEqual(h.calls("GetListOfSentMessages"), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("keep the filing dispatching, fail the call and audit uncertain when the outcome write keeps failing", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      yield* h.exec(
        `CREATE TRIGGER fail_sent BEFORE UPDATE ON filings WHEN NEW.state = 'sent'
         BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`,
      );
      const fiber = yield* Effect.forkChild(h.service.sendMessage(CALLER, h.request()));
      // The write is retried on an exponential schedule (50 ms × 4) driven by the TestClock.
      for (let tick = 0; tick < 20; tick++) yield* h.advance(SECOND);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.include(String(exit.cause), "DomainStoreError");
      const [row] = yield* h.filings;
      assert.strictEqual(row?.state, "dispatching");
      assert.strictEqual(h.calls("CreateMessage"), 1);
      assert.strictEqual((yield* h.audit("send_message"))[0]?.outcome, "uncertain");
    }).pipe(Effect.scoped),
  );

  it.effect("audit an interrupted follow-up reconcile as uncertain, the filing outcome_unknown (obligation 4)", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      yield* h.reply("CreateMessage", failWith(timeoutAfterSend));
      yield* h.reply("GetListOfSentMessages", () => Effect.never);
      const fiber = yield* Effect.forkChild(h.service.sendMessage(CALLER, h.request()));
      yield* h.reached("GetListOfSentMessages");
      yield* Fiber.interrupt(fiber);
      const [row] = yield* h.filings;
      assert.strictEqual(row?.state, "outcome_unknown");
      const audit = yield* h.audit("send_message");
      assert.strictEqual(audit.length, 1);
      assert.strictEqual(audit[0]?.outcome, "uncertain");
    }).pipe(Effect.scoped),
  );
});

describe("SendService dispatch: the sent outcome loses its CAS", () => {
  it.effect("ISDS accepted the message but the filing moved meanwhile: the dmID is logged at warning", () => {
    const logs: Array<string> = [];
    const capture = Logger.make<unknown, void>((entry) => void logs.push(Logger.formatLogFmt.log(entry)));
    return Effect.gen(function* () {
      const h = yield* sendHarness();
      yield* h.reply("CreateMessage", (_request, call) =>
        Effect.gen(function* () {
          // Something else moves the dispatching filing while ISDS accepts the message.
          for (const row of yield* h.filings) yield* h.patchFiling(String(row.id), { state: "outcome_unknown" });
          return createMessageReply(dmIdOf(call));
        }),
      );
      const result = yield* h.service.sendMessage(CALLER, h.request());
      assert.strictEqual(result._tag, "OutcomeUnknown");
      const moved = logs.filter((line) => line.includes("its filing had already moved"));
      assert.strictEqual(moved.length, 1);
      assert.include(moved[0], "level=WARN");
      assert.include(moved[0], `dmID=${dmIdOf(1)}`);
    }).pipe(Effect.scoped, Effect.provide(Logger.layer([capture])));
  });
});
