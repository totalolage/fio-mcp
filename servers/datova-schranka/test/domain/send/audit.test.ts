import { assert, describe, it } from "@effect/vitest";
import { Cause, Data, Deferred, Effect, Exit, Fiber, Logger } from "effect";
import type { AuditEventInput, AuditFinalOutcome } from "../../../src/domain/audit-log.js";
import { DomainStoreError } from "../../../src/domain/errors.js";
import type { FilingPreview, SendResult as SendResultType } from "../../../src/domain/send/api.js";
import { SendResult } from "../../../src/domain/send/api.js";
import { auditedSend, auditedSendAfter, sendDetail, sendResultOutcome } from "../../../src/domain/send/audit.js";
import { IsdsTimeoutError } from "../../../src/isds/errors.js";
import { type ReadAuditEvent, readAuditLog } from "../support/read-audit-log.js";

const input: AuditEventInput = {
  actor: { kind: "tool", grantId: "grant_1", clientId: "client_1", subject: "user@example.cz" },
  action: "send_message",
  boxId: "box_1",
  detail: { idempotencyKey: "key-1" },
};

class Refusal extends Data.TaggedError("Refusal")<{ readonly reason: string }> {}

const finishes = (events: ReadonlyArray<ReadAuditEvent>) =>
  events.flatMap((event) => (event.kind === "finish" ? [{ outcome: event.outcome, detail: event.detail }] : []));

const NONCE = "nonce-SECRET-7f3a9c";
const CONTENT_BASE64 = "JVBERi0xLjQKc2VjcmV0LWF0dGFjaG1lbnQtYnl0ZXM=";

const preview: FilingPreview = {
  senderBox: { id: "box_1", dbId: "abc2def", label: "Office" },
  recipient: "xyz9876",
  annotation: "Invoice 42",
  envelope: { senderRefNumber: "REF-1" },
  attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", metaType: "main", size: 31, sha256: "aa11" }],
  totalBytes: 31,
  contentHash: "hash-1",
};

const results: ReadonlyArray<readonly [SendResultType, AuditFinalOutcome]> = [
  [SendResult.Sent({ filingId: "f1", dmID: "123456" }), "ok"],
  [SendResult.Queued({ filingId: "f1" }), "ok"],
  [SendResult.ApprovalRequired({ filingId: "f1", nonce: NONCE, preview, expiresAt: 1_000 }), "ok"],
  [SendResult.InProgress({ filingId: "f1" }), "ok"],
  [SendResult.Expired({ filingId: "f1" }), "ok"],
  [SendResult.NotSent({ filingId: "f1" }), "ok"],
  [SendResult.Refused({ reason: "grant_inactive" }), "refused"],
  [
    SendResult.IsdsRejected({
      filingId: "f1",
      status: { code: "1214", message: "Recipient box inactive", classification: "Blocked" },
    }),
    "error",
  ],
  [SendResult.OutcomeUnknown({ filingId: "f1" }), "uncertain"],
];

describe("sendResultOutcome", () => {
  it("maps every SendResult tag to its audit outcome", () => {
    for (const [result, outcome] of results) assert.strictEqual(sendResultOutcome(result), outcome, result._tag);
  });
});

describe("auditedSend", () => {
  it.effect("fails closed: a failing start runs no work and surfaces start's DomainStoreError", () => {
    const log: Array<string> = [];
    const audit = readAuditLog(log, { failStart: true });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        auditedSend(input, () => Effect.sync(() => log.push("work")), { outcomeOf: () => "ok" }),
      );
      assert.instanceOf(error, DomainStoreError);
      assert.strictEqual(error.operation, "write audit entry");
      assert.deepStrictEqual(log, []);
      assert.deepStrictEqual(audit.events, []);
    }).pipe(Effect.provide(audit.layer));
  });

  it.effect("starts before the work and finishes with the outcome derived from each SendResult", () => {
    const log: Array<string> = [];
    const audit = readAuditLog(log);
    return Effect.gen(function* () {
      for (const [result] of results) {
        const value = yield* auditedSend(
          input,
          () => Effect.sync(() => log.push("work")).pipe(Effect.as(result)),
          { outcomeOf: sendResultOutcome, okDetail: (value) => sendDetail({ result: value }) },
        );
        assert.strictEqual(value, result);
      }
      assert.deepStrictEqual(
        finishes(audit.events).map((finish) => finish.outcome),
        results.map(([, outcome]) => outcome),
      );
      assert.deepStrictEqual(log.slice(0, 3), ["audit.start send_message", "work", "audit.finish ok"]);
      const first = audit.events[0];
      assert.strictEqual(first?.kind, "start");
      assert.deepStrictEqual(first?.kind === "start" ? first.input : undefined, input);
    }).pipe(Effect.provide(audit.layer));
  });

  it.effect("records a failure as error and keeps the failure", () => {
    const audit = readAuditLog([]);
    return Effect.gen(function* () {
      const failure = new DomainStoreError({ operation: "read filing" });
      const error = yield* Effect.flip(auditedSend(input, () => Effect.fail(failure), { outcomeOf: () => "ok" }));
      assert.strictEqual(error, failure);
      assert.deepStrictEqual(finishes(audit.events), [{ outcome: "error", detail: undefined }]);
    }).pipe(Effect.provide(audit.layer));
  });

  it.effect("records a failure, a defect or an interruption inside the claimed window as uncertain", () => {
    const audit = readAuditLog([]);
    return Effect.gen(function* () {
      const failure = new DomainStoreError({ operation: "record filing outcome" });
      yield* Effect.flip(
        auditedSend(input, (claim) => claim.whileClaimed(Effect.fail(failure)), {
          outcomeOf: () => "ok",
          classify: () => "refused",
          errorDetail: (error) => ({ operation: error.operation }),
        }),
      );
      yield* Effect.exit(auditedSend(input, (claim) => claim.whileClaimed(Effect.die("boom")), { outcomeOf: () => "ok" }));
      yield* Effect.exit(auditedSend(input, (claim) => claim.whileClaimed(Effect.interrupt), { outcomeOf: () => "ok" }));
      assert.deepStrictEqual(finishes(audit.events), [
        // The claim wins over classify; errorDetail still applies.
        { outcome: "uncertain", detail: { operation: "record filing outcome" } },
        { outcome: "uncertain", detail: undefined },
        { outcome: "uncertain", detail: undefined },
      ]);
    }).pipe(Effect.provide(audit.layer));
  });

  it.effect("records a failure after the claimed window settled as error, not uncertain", () => {
    const audit = readAuditLog([]);
    return Effect.gen(function* () {
      const failure = new DomainStoreError({ operation: "burn nonces" });
      yield* Effect.flip(
        auditedSend(input, (claim) => claim.whileClaimed(Effect.succeed("persisted")).pipe(Effect.andThen(Effect.fail(failure))), {
          outcomeOf: () => "ok",
        }),
      );
      // Nested windows: the outer one is still open after the inner one settles.
      yield* Effect.flip(
        auditedSend(
          input,
          (claim) => claim.whileClaimed(claim.whileClaimed(Effect.void).pipe(Effect.andThen(Effect.fail(failure)))),
          { outcomeOf: () => "ok" },
        ),
      );
      assert.deepStrictEqual(
        finishes(audit.events).map((finish) => finish.outcome),
        ["error", "uncertain"],
      );
    }).pipe(Effect.provide(audit.layer));
  });

  it.effect("records a defect or an interruption before any claim as error", () => {
    const audit = readAuditLog([]);
    return Effect.gen(function* () {
      yield* Effect.exit(auditedSend(input, () => Effect.die("boom"), { outcomeOf: () => "ok" }));
      yield* Effect.exit(auditedSend(input, () => Effect.interrupt, { outcomeOf: () => "ok" }));
      assert.deepStrictEqual(
        finishes(audit.events).map((finish) => finish.outcome),
        ["error", "error"],
      );
    }).pipe(Effect.provide(audit.layer));
  });

  it.effect("writes the finish as uncertain when the caller is interrupted inside the claimed window", () => {
    const log: Array<string> = [];
    const audit = readAuditLog(log);
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        auditedSend(input, (claim) => claim.whileClaimed(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))), {
          outcomeOf: () => "ok",
        }),
      );
      yield* Deferred.await(entered);
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
      assert.isTrue(Exit.hasInterrupts(exit));
      assert.deepStrictEqual(log, ["audit.start send_message", "audit.finish uncertain"]);
    }).pipe(Effect.provide(audit.layer));
  });

  it.effect("uses classify for failures outside a claim", () => {
    const audit = readAuditLog([]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        auditedSend(input, () => Effect.fail(new Refusal({ reason: "TOTP missing" })), {
          outcomeOf: () => "ok",
          classify: (error) => (error._tag === "Refusal" ? "refused" : "error"),
          errorDetail: (error) => ({ reason: error.reason }),
        }),
      );
      assert.strictEqual(error._tag, "Refusal");
      assert.deepStrictEqual(finishes(audit.events), [{ outcome: "refused", detail: { reason: "TOTP missing" } }]);
    }).pipe(Effect.provide(audit.layer));
  });

  it.effect("by default records a timeout sent before it timed out as uncertain, else error", () => {
    const audit = readAuditLog([]);
    return Effect.gen(function* () {
      for (const requestSent of [true, false]) {
        const timeout = new IsdsTimeoutError({
          service: "operations",
          operation: "CreateMessage",
          timeoutMillis: 60_000,
          requestSent,
        });
        yield* Effect.flip(auditedSend(input, () => Effect.fail(timeout), { outcomeOf: () => "ok" }));
      }
      assert.deepStrictEqual(
        finishes(audit.events).map((finish) => finish.outcome),
        ["uncertain", "error"],
      );
    }).pipe(Effect.provide(audit.layer));
  });

  it.effect("records a throwing classify as uncertain and a throwing errorDetail as no detail, keeping the failure", () => {
    const audit = readAuditLog([]);
    return Effect.gen(function* () {
      const failure = new Refusal({ reason: "TOTP missing" });
      const error = yield* Effect.flip(
        auditedSend(input, () => Effect.fail(failure), {
          outcomeOf: () => "ok",
          classify: () => {
            throw new Error("mapper bug");
          },
          errorDetail: () => {
            throw new Error("mapper bug");
          },
        }),
      );
      assert.strictEqual(error, failure);
      assert.deepStrictEqual(finishes(audit.events), [{ outcome: "uncertain", detail: undefined }]);
    }).pipe(Effect.provide(audit.layer));
  });

  it.effect("records a throwing mapper as uncertain without detail and keeps the value", () => {
    const audit = readAuditLog([]);
    return Effect.gen(function* () {
      const value = yield* auditedSend(input, () => Effect.succeed("done"), {
        outcomeOf: () => {
          throw new Error("mapper bug");
        },
        okDetail: () => {
          throw new Error("mapper bug");
        },
      });
      assert.strictEqual(value, "done");
      assert.deepStrictEqual(finishes(audit.events), [{ outcome: "uncertain", detail: undefined }]);
    }).pipe(Effect.provide(audit.layer));
  });

  for (const failFinish of ["fail", "die"] as const) {
    it.effect(`keeps the call's own success and failure when finish ${failFinish}s, and logs it with the audit id`, () => {
      const log: Array<string> = [];
      const logs: Array<string> = [];
      const audit = readAuditLog(log, { failFinish });
      const capture = Logger.make<unknown, void>((entry) => void logs.push(Logger.formatLogFmt.log(entry)));
      return Effect.gen(function* () {
        const result = SendResult.Sent({ filingId: "f1", dmID: "123456" });
        const value = yield* auditedSend(input, () => Effect.succeed(result), { outcomeOf: sendResultOutcome });
        assert.strictEqual(value, result);
        const failure = new DomainStoreError({ operation: "read filing" });
        const error = yield* Effect.flip(auditedSend(input, () => Effect.fail(failure), { outcomeOf: () => "ok" }));
        assert.strictEqual(error, failure);
        const verb = failFinish === "fail" ? "failed" : "died";
        assert.deepStrictEqual(log, [
          "audit.start send_message",
          `audit.finish ok (${verb})`,
          "audit.start send_message",
          `audit.finish error (${verb})`,
        ]);
        assert.strictEqual(logs.length, 2);
        assert.include(logs[0], "audit entry left started");
        assert.include(logs[0], "auditId=audit_1");
        assert.include(logs[1], "auditId=audit_2");
      }).pipe(Effect.provide([audit.layer, Logger.layer([capture])]));
    });
  }
});

describe("sendDetail", () => {
  it("keeps only the audit fields of an ApprovalRequired result, never the nonce", () => {
    const result = SendResult.ApprovalRequired({ filingId: "f1", nonce: NONCE, preview, expiresAt: 1_000 });
    const detail = sendDetail({ idempotencyKey: "key-1", result });
    assert.deepStrictEqual(detail, {
      idempotencyKey: "key-1",
      recipient: "xyz9876",
      contentHash: "hash-1",
      attachments: [{ filename: "invoice.pdf", size: 31, sha256: "aa11" }],
      filingId: "f1",
      result: "ApprovalRequired",
    });
    assert.notInclude(JSON.stringify(detail), NONCE);
  });

  it.effect("records no nonce or attachment bytes through auditedSend", () => {
    const audit = readAuditLog([]);
    return Effect.gen(function* () {
      const result = SendResult.ApprovalRequired({ filingId: "f1", nonce: NONCE, preview, expiresAt: 1_000 });
      // A caller handing over request attachments (with content) still gets only filename/size/sha256.
      const attachments = [{ filename: "invoice.pdf", size: 31, sha256: "aa11", contentBase64: CONTENT_BASE64 }];
      yield* auditedSend(input, () => Effect.succeed(result), {
        outcomeOf: sendResultOutcome,
        okDetail: (value) => sendDetail({ idempotencyKey: "key-1", attachments, result: value }),
      });
      const recorded = JSON.stringify(audit.events);
      assert.notInclude(recorded, NONCE);
      assert.notInclude(recorded, CONTENT_BASE64);
      assert.include(recorded, "aa11");
    }).pipe(Effect.provide(audit.layer));
  });

  it("carries the ISDS status code and classification, and a refusal's reason", () => {
    assert.deepStrictEqual(
      sendDetail({
        result: SendResult.IsdsRejected({
          filingId: "f1",
          status: { code: "1214", message: "Recipient box inactive", classification: "Blocked" },
        }),
      }),
      { filingId: "f1", result: "IsdsRejected", isdsStatus: { code: "1214", classification: "Blocked" } },
    );
    assert.deepStrictEqual(sendDetail({ idempotencyKey: "key-1", result: SendResult.Refused({ reason: "scope_missing" }) }), {
      idempotencyKey: "key-1",
      result: "Refused",
      reason: "scope_missing",
    });
    assert.deepStrictEqual(sendDetail({ filingId: "f2", reason: "admin said no" }), {
      filingId: "f2",
      reason: "admin said no",
    });
  });
});

describe("auditedSendAfter", () => {
  /** The start input from the prepare step: its box on success, none otherwise. */
  const inputOf = (prepared: Exit.Exit<string, Refusal>): AuditEventInput => ({
    ...input,
    action: "filing.approve",
    boxId: Exit.isSuccess(prepared) ? prepared.value : undefined,
  });
  const reraise = (_claim: unknown, prepared: Exit.Exit<string, Refusal>) =>
    Exit.isSuccess(prepared) ? Effect.succeed(prepared.value) : Effect.failCause(prepared.cause);

  it.effect("a prepare that succeeds names the start's box and hands its value to the work", () => {
    const log: Array<string> = [];
    const audit = readAuditLog(log);
    return Effect.gen(function* () {
      const value = yield* auditedSendAfter(Effect.succeed("box_9"), inputOf, reraise, { outcomeOf: () => "ok" });
      assert.strictEqual(value, "box_9");
      const start = audit.events[0];
      assert.strictEqual(start?.kind === "start" ? start.input.boxId : undefined, "box_9");
      assert.deepStrictEqual(finishes(audit.events).map((finish) => finish.outcome), ["ok"]);
    }).pipe(Effect.provide(audit.layer));
  });

  it.effect("a prepare that fails, dies or is interrupted still yields exactly one row, outcome error, and keeps its cause", () =>
    Effect.gen(function* () {
      const failing: ReadonlyArray<readonly [string, Effect.Effect<string, Refusal>]> = [
        ["fail", Effect.fail(new Refusal({ reason: "unreadable" }))],
        ["die", Effect.die("read defect")],
        ["interrupt", Effect.interrupt],
      ];
      for (const [name, prepare] of failing) {
        const audit = readAuditLog([]);
        const exit = yield* Effect.exit(
          auditedSendAfter(prepare, inputOf, reraise, { outcomeOf: () => "ok" }).pipe(Effect.provide(audit.layer)),
        );
        assert.isTrue(Exit.isFailure(exit), name);
        if (Exit.isFailure(exit)) {
          assert.strictEqual(Cause.hasDies(exit.cause), name === "die", name);
          assert.strictEqual(Cause.hasInterrupts(exit.cause), name === "interrupt", name);
        }
        assert.deepStrictEqual(
          audit.events.map((event) => event.kind),
          ["start", "finish"],
          name,
        );
        const start = audit.events[0];
        assert.isUndefined(start?.kind === "start" ? start.input.boxId : "missing", name);
        assert.deepStrictEqual(finishes(audit.events).map((finish) => finish.outcome), ["error"], name);
      }
    }),
  );

  it.effect("an interruption that arrives while prepare runs is audited once as error", () =>
    Effect.gen(function* () {
      const audit = readAuditLog([]);
      const reading = yield* Deferred.make<void>();
      const fiber = yield* auditedSendAfter(
        Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never)),
        inputOf,
        reraise,
        { outcomeOf: () => "ok" },
      ).pipe(Effect.provide(audit.layer), Effect.forkChild);
      yield* Deferred.await(reading);
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
      assert.isTrue(Exit.hasInterrupts(exit));
      assert.deepStrictEqual(audit.events.map((event) => event.kind), ["start", "finish"]);
      assert.deepStrictEqual(finishes(audit.events).map((finish) => finish.outcome), ["error"]);
    }),
  );
});
