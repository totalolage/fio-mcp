import { assert, describe, it } from "@effect/vitest";
import { markUntrusted } from "@mcps/core/mcp/untrusted.js";
import { Context, Effect, Exit, Schema } from "effect";
import { Tool } from "effect/ai";
import { DomainStoreError } from "../../src/domain/errors.js";
import { FilingNotFound, SendResult, SendUnavailable } from "../../src/domain/send/api.js";
import {
  FILING_STATUS_DESCRIPTION,
  filingStatusHandler,
  makeSendTools,
  OUTCOME_UNKNOWN_GUIDANCE,
  SEND_DESCRIPTION,
  SEND_TOOL_SPECS,
  SENT_NOTE,
  SendToolFailure,
  sendMessageHandler,
} from "../../src/mcp/send-tools.js";
import { BOX_ID, fakeSendService, filing, HASH, preview, RECIPIENT } from "../send-support/fake-send-service.js";

const CALLER = { grantId: "grant_1", clientId: "client_1", subject: "grant_1" };
const tools = makeSendTools(Schema.Literals(["Office", "Home"]), SendToolFailure);

const VALID = {
  box: "Office",
  idempotencyKey: "invoice-2026-11",
  recipient: RECIPIENT,
  annotation: "Invoice 2026/11",
  attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0=" }],
};

const decodes = (schema: Schema.Top, value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value));

const sendParams = tools.send_message.parametersSchema;
const statusParams = tools.get_filing_status.parametersSchema;

/** Runs send_message's handler with the service answering `result`. */
const sendWith = (result: SendResult, params: Record<string, unknown> = VALID) =>
  Effect.gen(function* () {
    const fake = fakeSendService([], { sendMessage: Effect.succeed(result) });
    const decoded = yield* Schema.decodeUnknownEffect(sendParams)(params).pipe(Effect.orDie);
    const output = yield* sendMessageHandler(fake.service, CALLER, BOX_ID, decoded);
    return { output, calls: fake.calls };
  });

const failureText = <A>(effect: Effect.Effect<A, SendToolFailure>) =>
  Effect.flip(effect).pipe(Effect.map((failure) => failure.text));

describe("send tool specs and descriptions", () => {
  it("both tools need isds:send and take a box", () => {
    assert.deepStrictEqual(SEND_TOOL_SPECS, [
      { name: "send_message", scopes: ["isds:send"] },
      { name: "get_filing_status", scopes: ["isds:send"] },
    ]);
    assert.strictEqual(tools.send_message.name, "send_message");
    assert.strictEqual(tools.get_filing_status.name, "get_filing_status");
  });

  it("states the tier behaviour, the sent wording and the outcome_unknown guidance", () => {
    for (const text of ["none", "approve", "full", "approvalNonce", "idempotencyKey", "20,000,000"]) {
      assert.include(SEND_DESCRIPTION, text);
    }
    assert.include(SEND_DESCRIPTION, "it does not mean the message was delivered");
    assert.include(SEND_DESCRIPTION, "do not resend");
    assert.include(FILING_STATUS_DESCRIPTION, "exactly one of filingId or idempotencyKey");
    assert.include(FILING_STATUS_DESCRIPTION, "not proof of delivery");
    assert.strictEqual(tools.send_message.description, SEND_DESCRIPTION);
  });

  it("marks send_message as a destructive open-world tool and get_filing_status as read-only", () => {
    const send = Tool.getJsonSchema(tools.send_message) as { readonly properties: Record<string, unknown> };
    assert.containsAllKeys(send.properties, ["box", "idempotencyKey", "recipient", "annotation", "attachments"]);
    assert.isFalse(Context.get(tools.send_message.annotations, Tool.Readonly));
    assert.isTrue(Context.get(tools.send_message.annotations, Tool.Destructive));
    assert.isTrue(Context.get(tools.get_filing_status.annotations, Tool.Readonly));
  });
});

describe("send_message input schema", () => {
  it("accepts a minimal message and every optional envelope field", () => {
    assert.isTrue(decodes(sendParams, VALID));
    assert.isTrue(decodes(sendParams, { ...VALID, annotation: "" }));
    assert.isTrue(decodes(sendParams, { ...VALID, annotation: "a".repeat(255) }));
    assert.isTrue(
      decodes(sendParams, {
        ...VALID,
        toHands: "x".repeat(30),
        senderRefNumber: "r".repeat(50),
        recipientRefNumber: "r".repeat(50),
        senderIdent: "i".repeat(50),
        recipientIdent: "i".repeat(50),
        personalDelivery: true,
        allowSubstDelivery: false,
        legalTitleLaw: 300,
        legalTitleYear: 2008,
        legalTitleSect: "17",
        legalTitlePar: "2",
        legalTitlePoint: "a",
        approvalNonce: "n".repeat(43),
        attachments: [
          { filename: "a.pdf", mimeType: "application/pdf", metaType: "main", contentBase64: "AA==" },
          { filename: "b.pdf", mimeType: "", metaType: "enclosure", contentBase64: "AA==" },
        ],
      }),
    );
  });

  const refused: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["a box outside the enum", { box: "Elsewhere" }],
    ["an empty idempotencyKey", { idempotencyKey: "" }],
    ["a 101-character idempotencyKey", { idempotencyKey: "k".repeat(101) }],
    ["an uppercase recipient", { recipient: "XYZ9876" }],
    ["a 6-character recipient", { recipient: "xyz987" }],
    ["a 256-character annotation", { annotation: "a".repeat(256) }],
    ["a 31-character toHands", { toHands: "x".repeat(31) }],
    ["a 51-character senderRefNumber", { senderRefNumber: "r".repeat(51) }],
    ["a 51-character recipientIdent", { recipientIdent: "i".repeat(51) }],
    ["a fractional legalTitleLaw", { legalTitleLaw: 1.5 }],
    ["no attachments", { attachments: [] }],
    [
      "101 attachments",
      { attachments: Array.from({ length: 101 }, () => ({ filename: "a", mimeType: "", contentBase64: "" })) },
    ],
    ["an unknown metaType", { attachments: [{ filename: "a", mimeType: "", metaType: "cover", contentBase64: "" }] }],
    ["an empty filename", { attachments: [{ filename: "", mimeType: "", contentBase64: "" }] }],
    ["a 256-character filename", { attachments: [{ filename: "f".repeat(256), mimeType: "", contentBase64: "" }] }],
    ["an empty approvalNonce", { approvalNonce: "" }],
  ];
  for (const [what, change] of refused) {
    it(`refuses ${what}`, () => {
      assert.isFalse(decodes(sendParams, { ...VALID, ...change }));
    });
  }

  it("get_filing_status takes a box and an optional filingId or idempotencyKey", () => {
    assert.isTrue(decodes(statusParams, { box: "Home", filingId: "filing_1" }));
    assert.isTrue(decodes(statusParams, { box: "Home", idempotencyKey: "k" }));
    assert.isFalse(decodes(statusParams, { box: "Home", idempotencyKey: "k".repeat(101) }));
    assert.isFalse(decodes(statusParams, { box: "Nowhere", filingId: "filing_1" }));
  });
});

describe("sendMessageHandler", () => {
  it.effect("passes the request to the service with the box id and the envelope fields", () =>
    Effect.gen(function* () {
      const { calls } = yield* sendWith(SendResult.Queued({ filingId: "filing_1" }), {
        ...VALID,
        senderRefNumber: "REF-1",
        personalDelivery: true,
        approvalNonce: "nonce-1",
      });
      assert.deepStrictEqual(calls, [
        {
          op: "sendMessage",
          args: [
            CALLER,
            {
              boxId: BOX_ID,
              idempotencyKey: VALID.idempotencyKey,
              recipient: RECIPIENT,
              annotation: VALID.annotation,
              envelope: { senderRefNumber: "REF-1", personalDelivery: true },
              attachments: [
                { filename: "invoice.pdf", mimeType: "application/pdf", metaType: undefined, contentBase64: "JVBERi0=" },
              ],
              approvalNonce: "nonce-1",
            },
          ],
        },
      ]);
    }),
  );

  it.effect("sent: filingId, dmID and the not-delivered note", () =>
    Effect.gen(function* () {
      const { output } = yield* sendWith(SendResult.Sent({ filingId: "filing_1", dmID: "123456789" }));
      assert.deepStrictEqual(output, { result: "sent", filingId: "filing_1", dmID: "123456789", note: SENT_NOTE });
      assert.strictEqual(
        SENT_NOTE,
        "sent means ISDS accepted the submission and assigned a dmID; it does not mean the message was delivered",
      );
    }),
  );

  it.effect("queued: pending_admin and what happens next", () =>
    Effect.gen(function* () {
      const { output } = yield* sendWith(SendResult.Queued({ filingId: "filing_1" }));
      assert.strictEqual(output.result, "queued");
      assert.strictEqual(output.filingId, "filing_1");
      assert.strictEqual(output.state, "pending_admin");
      assert.include(String(output.guidance), "administrator");
    }),
  );

  it.effect("approval_required: nonce, preview, ISO expiry and the confirm instruction", () =>
    Effect.gen(function* () {
      const expiresAt = Date.UTC(2026, 10, 17, 9, 15);
      const { output } = yield* sendWith(
        SendResult.ApprovalRequired({ filingId: "filing_1", nonce: "nonce-1", preview: preview(), expiresAt }),
      );
      assert.strictEqual(output.result, "approval_required");
      assert.strictEqual(output.filingId, "filing_1");
      assert.strictEqual(output.nonce, "nonce-1");
      assert.strictEqual(output.expiresAt, "2026-11-17T09:15:00.000Z");
      assert.deepStrictEqual(output.preview, preview());
      const instruction = String(output.instruction);
      assert.include(instruction, "Show the preview to the user");
      assert.include(instruction, "same arguments plus approvalNonce");
      assert.include(instruction, "only if they confirm");
    }),
  );

  it.effect("in_progress: do not resend", () =>
    Effect.gen(function* () {
      const { output } = yield* sendWith(SendResult.InProgress({ filingId: "filing_1" }));
      assert.strictEqual(output.result, "in_progress");
      assert.strictEqual(output.filingId, "filing_1");
      assert.include(String(output.guidance), "get_filing_status");
    }),
  );

  it.effect("outcome_unknown: the do-not-resend guidance", () =>
    Effect.gen(function* () {
      const { output } = yield* sendWith(SendResult.OutcomeUnknown({ filingId: "filing_1" }));
      assert.deepStrictEqual(output, { result: "outcome_unknown", filingId: "filing_1", guidance: OUTCOME_UNKNOWN_GUIDANCE });
      for (const text of ["Do not resend", "get_filing_status later", "administrator resolves it"]) {
        assert.include(OUTCOME_UNKNOWN_GUIDANCE, text);
      }
    }),
  );

  it.effect("refused: the reason, with the filing when there is one", () =>
    Effect.gen(function* () {
      const plain = yield* sendWith(SendResult.Refused({ reason: "recipient box is not active" }));
      assert.deepStrictEqual(plain.output, { result: "refused", reason: markUntrusted("recipient box is not active") });
      const kept = yield* sendWith(SendResult.Refused({ reason: "different content", filingId: "filing_1" }));
      assert.deepStrictEqual(kept.output, {
        result: "refused",
        reason: markUntrusted("different content"),
        filingId: "filing_1",
      });
      // The reason can quote ISDS or an administrator: marked, so the output guard wraps it.
      assert.notStrictEqual(plain.output.reason, "recipient box is not active");
    }),
  );

  it.effect("isds_rejected: the status, its ISDS text marked untrusted", () =>
    Effect.gen(function* () {
      const { output } = yield* sendWith(
        SendResult.IsdsRejected({
          filingId: "filing_1",
          status: { code: "1214", message: "Neplatný příjemce", classification: "AttachmentRejected" },
        }),
      );
      assert.strictEqual(output.result, "isds_rejected");
      assert.strictEqual(output.filingId, "filing_1");
      const status = output.status as Record<string, unknown>;
      assert.strictEqual(status.code, "1214");
      assert.notStrictEqual(status.message, "Neplatný příjemce");
      assert.include(String(status.message), "Neplatný příjemce");
      assert.include(String(output.guidance), "not sent");
    }),
  );

  it.effect("expired and not_sent: use a new idempotencyKey", () =>
    Effect.gen(function* () {
      const expired = yield* sendWith(SendResult.Expired({ filingId: "filing_1" }));
      assert.strictEqual(expired.output.result, "expired");
      assert.include(String(expired.output.guidance), "new idempotencyKey");
      const notSent = yield* sendWith(SendResult.NotSent({ filingId: "filing_1" }));
      assert.strictEqual(notSent.output.result, "not_sent");
      assert.strictEqual(notSent.output.filingId, "filing_1");
      assert.include(String(notSent.output.guidance), "use a new idempotencyKey");
    }),
  );

  it.effect("maps service failures to retry guidance", () =>
    Effect.gen(function* () {
      const params = yield* Schema.decodeUnknownEffect(sendParams)(VALID).pipe(Effect.orDie);
      const unavailable = fakeSendService([], {
        sendMessage: Effect.fail(new SendUnavailable({ detail: "the recipient could not be checked" })),
      });
      const text = yield* failureText(sendMessageHandler(unavailable.service, CALLER, BOX_ID, params));
      assert.include(text, "Nothing was sent or changed");
      assert.include(text, "the recipient could not be checked");
      assert.include(text, "same arguments");
      const store = fakeSendService([], { sendMessage: Effect.fail(new DomainStoreError({ operation: "insert filing" })) });
      const storeText = yield* failureText(sendMessageHandler(store.service, CALLER, BOX_ID, params));
      assert.include(storeText, "idempotencyKey");
      assert.include(storeText, "get_filing_status");
    }),
  );
});

describe("filingStatusHandler", () => {
  const stored = filing({
    id: "filing_1",
    state: "sent",
    tier: "approve",
    dmId: "123456789",
    submittedAt: Date.UTC(2026, 10, 17, 8, 1),
    updatedAt: Date.UTC(2026, 10, 17, 8, 2),
  });

  it.effect("reports state, dmID, ISO timestamps and the guidance for a filing id", () =>
    Effect.gen(function* () {
      const fake = fakeSendService([], { filingStatus: Effect.succeed({ filing: stored, guidance: "Nothing to do." }) });
      const output = yield* filingStatusHandler(fake.service, CALLER, BOX_ID, { filingId: "filing_1" });
      assert.deepStrictEqual(fake.calls, [{ op: "filingStatus", args: [CALLER, BOX_ID, { filingId: "filing_1" }] }]);
      assert.deepStrictEqual(output, {
        filingId: "filing_1",
        idempotencyKey: "key-filing_1",
        state: "sent",
        tier: "approve",
        recipient: RECIPIENT,
        contentHash: HASH,
        dmID: "123456789",
        createdAt: "2026-11-17T08:00:00.000Z",
        submittedAt: "2026-11-17T08:01:00.000Z",
        updatedAt: "2026-11-17T08:02:00.000Z",
        guidance: "Nothing to do.",
        note: SENT_NOTE,
      });
    }),
  );

  it.effect("looks up by idempotencyKey and reports the reason, expiry and ISDS status", () =>
    Effect.gen(function* () {
      const rejected = filing({
        id: "filing_2",
        state: "isds_rejected",
        reason: "ISDS refused it",
        expiresAt: Date.UTC(2026, 10, 24, 8, 0),
        reconciledAt: Date.UTC(2026, 10, 17, 8, 5),
        isdsStatus: { code: "1214", message: "Chyba", classification: "AttachmentRejected" },
      });
      const fake = fakeSendService([], { filingStatus: Effect.succeed({ filing: rejected, guidance: "Use a new key." }) });
      const output = yield* filingStatusHandler(fake.service, CALLER, BOX_ID, { idempotencyKey: "key-filing_2" });
      assert.deepStrictEqual(fake.calls, [{ op: "filingStatus", args: [CALLER, BOX_ID, { idempotencyKey: "key-filing_2" }] }]);
      assert.strictEqual(output.reason, markUntrusted("ISDS refused it"));
      assert.notStrictEqual(output.reason, "ISDS refused it");
      assert.strictEqual(output.expiresAt, "2026-11-24T08:00:00.000Z");
      assert.strictEqual(output.reconciledAt, "2026-11-17T08:05:00.000Z");
      assert.include(String((output.isdsStatus as Record<string, unknown>).message), "Chyba");
      assert.notProperty(output, "note");
      assert.notProperty(output, "dmID");
    }),
  );

  it.effect("needs exactly one of filingId and idempotencyKey; the service is not called otherwise", () =>
    Effect.gen(function* () {
      const fake = fakeSendService();
      for (const ref of [{}, { filingId: "filing_1", idempotencyKey: "k" }]) {
        const text = yield* failureText(filingStatusHandler(fake.service, CALLER, BOX_ID, ref));
        assert.include(text, "exactly one of filingId or idempotencyKey");
      }
      assert.deepStrictEqual(fake.calls, []);
    }),
  );

  it.effect("an unknown filing says so without naming other grants' filings", () =>
    Effect.gen(function* () {
      const fake = fakeSendService([], { filingStatus: Effect.fail(new FilingNotFound({ filingId: "filing_9" })) });
      const text = yield* failureText(filingStatusHandler(fake.service, CALLER, BOX_ID, { filingId: "filing_9" }));
      assert.include(text, "No filing matches");
    }),
  );
});
