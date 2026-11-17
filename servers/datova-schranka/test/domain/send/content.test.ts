import { createHash } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import type { SendAttachment, SendEnvelope, SendMessageRequest } from "../../../src/domain/send/api.js";
import {
  CorruptPayload,
  contentHashOf,
  decodePayload,
  encodePayload,
  InvalidSendRequest,
  normaliseRequest,
  reconcileHintsOf,
  reconcileInputOf,
} from "../../../src/domain/send/content.js";
import type { CreateMessageInput } from "../../../src/isds/create-message.js";
import { fakeBox } from "../support/fake-box-registry.js";
import {
  ANNEX_CONTENT,
  base64Of,
  bytesOf,
  LETTER_CONTENT,
  RECIPIENT_DB_ID,
  SENDER_BOX_ID,
  SENDER_DB_ID,
  sendAttachment,
  senderBox,
  sendRequest,
} from "./support/requests.js";

const sha256 = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");

const FULL_ENVELOPE: Required<SendEnvelope> = {
  toHands: "Jan Novák",
  recipientRefNumber: "RR-1",
  senderRefNumber: "SR-1",
  recipientIdent: "RI-1",
  senderIdent: "SI-1",
  personalDelivery: true,
  allowSubstDelivery: false,
  legalTitleLaw: 500,
  legalTitleYear: 2004,
  legalTitleSect: "17",
  legalTitlePar: "2",
  legalTitlePoint: "a",
};

const normalised = (request: SendMessageRequest = sendRequest()) => normaliseRequest(request, senderBox);

/** The reason of the InvalidSendRequest the request is refused with. */
const refusal = (request: SendMessageRequest) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(normalised(request));
    assert.instanceOf(error, InvalidSendRequest);
    return error.reason;
  });

const hashOf = (request: SendMessageRequest, box = senderBox) =>
  Effect.map(normaliseRequest(request, box), (message) => message.contentHash);

const withAttachment = (index: number, overrides: Partial<SendAttachment>): SendMessageRequest => {
  const request = sendRequest();
  return {
    ...request,
    attachments: request.attachments.map((attachment, i) => (i === index ? { ...attachment, ...overrides } : attachment)),
  };
};

describe("normaliseRequest", () => {
  it.effect("maps the request onto CreateMessageInput", () =>
    Effect.gen(function* () {
      const message = yield* normalised(sendRequest({ envelope: FULL_ENVELOPE }));
      assert.deepStrictEqual(message.createInput, {
        dbIDRecipient: RECIPIENT_DB_ID,
        dmAnnotation: "Invoice 2026/11",
        dmToHands: "Jan Novák",
        dmRecipientRefNumber: "RR-1",
        dmSenderRefNumber: "SR-1",
        dmRecipientIdent: "RI-1",
        dmSenderIdent: "SI-1",
        dmPersonalDelivery: true,
        dmAllowSubstDelivery: false,
        dmLegalTitleLaw: 500,
        dmLegalTitleYear: 2004,
        dmLegalTitleSect: "17",
        dmLegalTitlePar: "2",
        dmLegalTitlePoint: "a",
        dmFiles: [
          {
            content: bytesOf(base64Of(LETTER_CONTENT)),
            dmMimeType: "application/pdf",
            dmFileMetaType: "main",
            dmFileDescr: "letter.pdf",
          },
          {
            content: bytesOf(base64Of(ANNEX_CONTENT)),
            dmMimeType: "text/plain",
            dmFileMetaType: "enclosure",
            dmFileDescr: "annex.txt",
          },
        ],
      } satisfies CreateMessageInput);
    }),
  );

  it.effect("leaves out envelope fields the request leaves out", () =>
    Effect.gen(function* () {
      const message = yield* normalised(sendRequest({ envelope: { toHands: undefined } }));
      assert.deepStrictEqual(Object.keys(message.createInput).sort(), ["dbIDRecipient", "dmAnnotation", "dmFiles"]);
    }),
  );

  it.effect("defaults metaType to main for the first attachment and enclosure for the rest", () =>
    Effect.gen(function* () {
      const request = sendRequest({
        attachments: [sendAttachment(), sendAttachment(), sendAttachment()],
      });
      const message = yield* normalised(request);
      assert.deepStrictEqual(
        message.createInput.dmFiles.map((file) => file.dmFileMetaType),
        ["main", "enclosure", "enclosure"],
      );
      assert.deepStrictEqual(
        message.preview.attachments.map((attachment) => attachment.metaType),
        ["main", "enclosure", "enclosure"],
      );
    }),
  );

  it.effect("keeps an explicit metaType", () =>
    Effect.gen(function* () {
      const request = sendRequest({
        attachments: [sendAttachment({ metaType: "enclosure" }), sendAttachment({ metaType: "signature" })],
      });
      const message = yield* normalised(request);
      assert.deepStrictEqual(
        message.createInput.dmFiles.map((file) => file.dmFileMetaType),
        ["enclosure", "signature"],
      );
    }),
  );

  it.effect("accepts an idempotencyKey of 1 and of 100 characters", () =>
    Effect.gen(function* () {
      yield* normalised(sendRequest({ idempotencyKey: "k" }));
      yield* normalised(sendRequest({ idempotencyKey: "k".repeat(100) }));
    }),
  );

  for (const [name, key] of [
    ["empty", ""],
    ["101 characters", "k".repeat(101)],
  ] as const) {
    it.effect(`refuses an idempotencyKey that is ${name}`, () =>
      Effect.gen(function* () {
        const reason = yield* refusal(sendRequest({ idempotencyKey: key }));
        assert.include(reason, "idempotencyKey");
      }),
    );
  }

  for (const recipient of ["ABC1234", "abc123", "abc12345", "abc-123", ""]) {
    it.effect(`refuses the recipient ${JSON.stringify(recipient)}`, () =>
      Effect.gen(function* () {
        const reason = yield* refusal(sendRequest({ recipient }));
        assert.include(reason, "recipient");
      }),
    );
  }

  // "hello" is aGVsbG8= in canonical standard base64.
  for (const [name, contentBase64] of [
    ["an inner space", "aGVs bG8="],
    ["a trailing newline", "aGVsbG8=\n"],
    ["a line break", "aGVs\nbG8="],
    ["url-safe characters", "-_8="],
    ["missing padding", "aGVsbG8"],
    ["extra padding", "aGVsbG8=="],
    ["padding in the middle", "aG=sbG8="],
    ["a length that is not a multiple of 4", "aGVsbG8=a"],
    ["non-zero trailing bits", "aGVsbG9="],
    ["a character outside the alphabet", "aGVs*G8="],
  ] as const) {
    it.effect(`refuses attachment content with ${name}`, () =>
      Effect.gen(function* () {
        const reason = yield* refusal(withAttachment(1, { contentBase64 }));
        assert.include(reason, 'attachments[1] ("annex.txt")');
        assert.include(reason, "base64");
        assert.notInclude(reason, contentBase64.trim());
      }),
    );
  }

  it.effect("refuses a zero-byte attachment", () =>
    Effect.gen(function* () {
      const reason = yield* refusal(withAttachment(0, { contentBase64: "" }));
      assert.include(reason, 'attachments[0] ("letter.pdf")');
      assert.include(reason, "empty");
    }),
  );

  it.effect("refuses an empty attachment list", () =>
    Effect.gen(function* () {
      const reason = yield* refusal(sendRequest({ attachments: [] }));
      assert.match(reason, /^attachments: /);
    }),
  );

  it.effect("accepts 100 attachments and refuses 101", () =>
    Effect.gen(function* () {
      const small = sendAttachment({ contentBase64: base64Of("x") });
      yield* normalised(sendRequest({ attachments: Array.from({ length: 100 }, () => small) }));
      const reason = yield* refusal(sendRequest({ attachments: Array.from({ length: 101 }, () => small) }));
      assert.match(reason, /^attachments: /);
    }),
  );

  it.effect("refuses an annotation over 255 characters", () =>
    Effect.gen(function* () {
      yield* normalised(sendRequest({ annotation: "a".repeat(255) }));
      const reason = yield* refusal(sendRequest({ annotation: "a".repeat(256) }));
      assert.strictEqual(reason, "annotation: Expected at most 255 characters");
    }),
  );

  it.effect("refuses toHands over 30 characters", () =>
    Effect.gen(function* () {
      const reason = yield* refusal(sendRequest({ envelope: { toHands: "t".repeat(31) } }));
      assert.strictEqual(reason, "envelope.toHands: Expected at most 30 characters");
    }),
  );

  it.effect("refuses a non-integer legalTitleLaw", () =>
    Effect.gen(function* () {
      const reason = yield* refusal(sendRequest({ envelope: { legalTitleLaw: 1.5 } }));
      assert.match(reason, /^envelope\.legalTitleLaw: /);
    }),
  );

  it.effect("names the attachment and field of a schema failure", () =>
    Effect.gen(function* () {
      const reason = yield* refusal(withAttachment(1, { mimeType: "text/\u0000plain" }));
      assert.match(reason, /^attachments\[1\] \("annex\.txt"\) mimeType: /);
      const empty = yield* refusal(withAttachment(0, { filename: "" }));
      assert.match(empty, /^attachments\[0\] \(""\) filename: /);
    }),
  );

  it.effect("refuses an unknown metaType without echoing content", () =>
    Effect.gen(function* () {
      const reason = yield* refusal(withAttachment(0, { metaType: "other" as never }));
      assert.match(reason, /^attachments\[0\] \("letter\.pdf"\) metaType: /);
      assert.notInclude(reason, base64Of(LETTER_CONTENT));
    }),
  );

  it.effect("accepts 20,000,000 bytes in total and refuses one byte more", () =>
    Effect.gen(function* () {
      const half = base64Of(new Uint8Array(10_000_000).fill(7));
      const message = yield* normalised(
        sendRequest({ attachments: [sendAttachment({ contentBase64: half }), sendAttachment({ contentBase64: half })] }),
      );
      assert.strictEqual(message.preview.totalBytes, 20_000_000);
      const reason = yield* refusal(
        sendRequest({
          attachments: [
            sendAttachment({ contentBase64: half }),
            sendAttachment({ contentBase64: half }),
            sendAttachment({ contentBase64: base64Of("x") }),
          ],
        }),
      );
      assert.strictEqual(reason, "attachments: 20000001 bytes in total, over the limit of 20000000 bytes");
    }),
  );
});

describe("content hash", () => {
  it.effect("is the sha256 of the canonical JSON of the content", () =>
    Effect.gen(function* () {
      const message = yield* normalised(sendRequest({ envelope: { toHands: "T", senderRefNumber: "R" } }));
      const letter = new TextEncoder().encode(LETTER_CONTENT);
      const annex = new TextEncoder().encode(ANNEX_CONTENT);
      const canonical =
        `{"annotation":"Invoice 2026/11","attachments":[` +
        `{"filename":"letter.pdf","metaType":"main","mimeType":"application/pdf","sha256":"${sha256(letter)}","size":${letter.byteLength}},` +
        `{"filename":"annex.txt","metaType":"enclosure","mimeType":"text/plain","sha256":"${sha256(annex)}","size":${annex.byteLength}}],` +
        `"box":"${SENDER_BOX_ID}","envelope":{"senderRefNumber":"R","toHands":"T"},"recipient":"${RECIPIENT_DB_ID}","v":1}`;
      assert.strictEqual(message.contentHash, sha256(canonical));
      assert.strictEqual(message.preview.contentHash, message.contentHash);
      assert.strictEqual(contentHashOf(message.preview), message.contentHash);
    }),
  );

  it.effect("does not depend on envelope key order or undefined envelope fields", () =>
    Effect.gen(function* () {
      const a = yield* hashOf(sendRequest({ envelope: { senderRefNumber: "R", toHands: "T" } }));
      const b = yield* hashOf(
        sendRequest({ envelope: { toHands: "T", personalDelivery: undefined, senderRefNumber: "R", senderIdent: undefined } }),
      );
      assert.strictEqual(a, b);
    }),
  );

  it.effect("does not depend on the idempotencyKey or the approvalNonce", () =>
    Effect.gen(function* () {
      const a = yield* hashOf(sendRequest({ idempotencyKey: "a" }));
      const b = yield* hashOf(sendRequest({ idempotencyKey: "b", approvalNonce: "nonce" }));
      assert.strictEqual(a, b);
    }),
  );

  it.effect("does not depend on the sender box's dbId or label", () =>
    Effect.gen(function* () {
      const a = yield* hashOf(sendRequest());
      const b = yield* hashOf(sendRequest(), { ...fakeBox(SENDER_BOX_ID, "oth9999"), label: "Renamed" });
      assert.strictEqual(a, b);
    }),
  );

  const base = sendRequest({ envelope: FULL_ENVELOPE });
  const changedEnvelope = {
    toHands: "Other",
    recipientRefNumber: "RR-2",
    senderRefNumber: "SR-2",
    recipientIdent: "RI-2",
    senderIdent: "SI-2",
    personalDelivery: false,
    allowSubstDelivery: true,
    legalTitleLaw: 501,
    legalTitleYear: 2005,
    legalTitleSect: "18",
    legalTitlePar: "3",
    legalTitlePoint: "b",
  } satisfies Required<SendEnvelope>;
  const withFirst = (overrides: Partial<SendAttachment>): SendMessageRequest => ({
    ...base,
    attachments: base.attachments.map((attachment, i) => (i === 0 ? { ...attachment, ...overrides } : attachment)),
  });
  const variants: ReadonlyArray<readonly [string, SendMessageRequest]> = [
    ["recipient", { ...base, recipient: "oth5678" }],
    ["annotation", { ...base, annotation: "Other" }],
    ...(Object.keys(changedEnvelope) as Array<keyof SendEnvelope>).map(
      (key) => [`envelope.${key}`, { ...base, envelope: { ...base.envelope, [key]: changedEnvelope[key] } }] as const,
    ),
    ["envelope field removed", { ...base, envelope: { ...base.envelope, toHands: undefined } }],
    ["filename", withFirst({ filename: "other.pdf" })],
    ["mimeType", withFirst({ mimeType: "application/octet-stream" })],
    ["metaType", withFirst({ metaType: "enclosure" })],
    ["bytes", withFirst({ contentBase64: base64Of(`${LETTER_CONTENT}!`) })],
    ["same-size bytes", withFirst({ contentBase64: base64Of(LETTER_CONTENT.replace("l", "L")) })],
    ["attachment order", { ...base, attachments: [...base.attachments].reverse() }],
  ];

  it.effect("changes with the sender box", () =>
    Effect.gen(function* () {
      const a = yield* hashOf(base);
      const b = yield* hashOf(base, fakeBox("box_TTTTTTTTTTTTTTTTTTTTTT", SENDER_DB_ID));
      assert.notStrictEqual(a, b);
    }),
  );

  for (const [field, variant] of variants) {
    it.effect(`changes with ${field}`, () =>
      Effect.gen(function* () {
        assert.notStrictEqual(yield* hashOf(variant), yield* hashOf(base));
      }),
    );
  }

  it("contentHashOf recomputes a stored preview's hash", () => {
    const preview = Effect.runSync(normalised(base)).preview;
    const stored = JSON.parse(JSON.stringify(preview));
    assert.strictEqual(contentHashOf(stored), preview.contentHash);
    assert.notStrictEqual(contentHashOf({ ...stored, annotation: "tampered" }), preview.contentHash);
  });
});

describe("preview", () => {
  it.effect("describes the content without bytes and round-trips through JSON", () =>
    Effect.gen(function* () {
      const request = sendRequest({ envelope: { toHands: "T", senderIdent: undefined } });
      const message = yield* normalised(request);
      const letter = new TextEncoder().encode(LETTER_CONTENT);
      const annex = new TextEncoder().encode(ANNEX_CONTENT);
      assert.deepStrictEqual(message.preview, {
        senderBox: { id: SENDER_BOX_ID, dbId: SENDER_DB_ID, label: senderBox.label },
        recipient: RECIPIENT_DB_ID,
        annotation: "Invoice 2026/11",
        envelope: { toHands: "T" },
        attachments: [
          { filename: "letter.pdf", mimeType: "application/pdf", metaType: "main", size: letter.byteLength, sha256: sha256(letter) },
          { filename: "annex.txt", mimeType: "text/plain", metaType: "enclosure", size: annex.byteLength, sha256: sha256(annex) },
        ],
        totalBytes: letter.byteLength + annex.byteLength,
        contentHash: message.contentHash,
      });
      const json = JSON.stringify(message.preview);
      assert.deepStrictEqual(JSON.parse(json), message.preview);
      for (const attachment of request.attachments) assert.notInclude(json, attachment.contentBase64);
      assert.notInclude(json, "content\"");
    }),
  );
});

describe("reconcile hints", () => {
  it.effect("come from the preview", () =>
    Effect.gen(function* () {
      const message = yield* normalised(sendRequest({ envelope: { senderRefNumber: "SR", senderIdent: "SI", toHands: "T" } }));
      assert.deepStrictEqual(message.hints, {
        recipient: RECIPIENT_DB_ID,
        annotation: "Invoice 2026/11",
        senderRefNumber: "SR",
        senderIdent: "SI",
        totalBytes: message.preview.totalBytes,
      });
      assert.deepStrictEqual(reconcileHintsOf(JSON.parse(JSON.stringify(message.preview))), message.hints);
    }),
  );

  it.effect("leave out the sender reference and ident when the envelope has none", () =>
    Effect.gen(function* () {
      const message = yield* normalised(sendRequest({ envelope: {} }));
      assert.deepStrictEqual(Object.keys(message.hints).sort(), ["annotation", "recipient", "totalBytes"]);
    }),
  );

  it.effect("map onto ReconcileSentMessageInput", () =>
    Effect.gen(function* () {
      const message = yield* normalised(sendRequest({ envelope: { senderRefNumber: "SR", senderIdent: "SI" } }));
      const submittedAt = DateTime.makeUnsafe(1_700_000_000_000);
      assert.deepStrictEqual(reconcileInputOf(message.hints, submittedAt), {
        submittedAt,
        dbIDRecipient: RECIPIENT_DB_ID,
        dmAnnotation: "Invoice 2026/11",
        dmSenderRefNumber: "SR",
        dmSenderIdent: "SI",
        expectedAttachmentBytes: message.preview.totalBytes,
      });
      const bare = reconcileInputOf((yield* normalised(sendRequest({ envelope: {} }))).hints, submittedAt);
      assert.deepStrictEqual(Object.keys(bare).sort(), [
        "dbIDRecipient",
        "dmAnnotation",
        "expectedAttachmentBytes",
        "submittedAt",
      ]);
    }),
  );
});

describe("payload", () => {
  it.effect("round-trips a CreateMessageInput, bytes included", () =>
    Effect.gen(function* () {
      const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
      const request = sendRequest({
        envelope: FULL_ENVELOPE,
        attachments: [sendAttachment({ contentBase64: base64Of(allBytes) }), sendAttachment({ metaType: "signature" })],
      });
      const { createInput } = yield* normalised(request);
      const decoded = yield* decodePayload(encodePayload(createInput));
      assert.deepStrictEqual(decoded, createInput);
      assert.deepStrictEqual(decoded.dmFiles[0]?.content, allBytes);
    }),
  );

  it.effect("encodes file contents as base64", () =>
    Effect.gen(function* () {
      const { createInput } = yield* normalised();
      const json = JSON.parse(encodePayload(createInput));
      assert.strictEqual(json.dmFiles[0].content, base64Of(LETTER_CONTENT));
    }),
  );

  const valid = JSON.parse(
    encodePayload(Effect.runSync(normalised()).createInput),
  ) as Record<string, unknown> & { dmFiles: Array<Record<string, unknown>> };
  for (const [name, text] of [
    ["not JSON", "{not json"],
    ["JSON null", "null"],
    ["missing the recipient", JSON.stringify({ ...valid, dbIDRecipient: undefined })],
    ["with an empty file list", JSON.stringify({ ...valid, dmFiles: [] })],
    ["with invalid base64 content", JSON.stringify({ ...valid, dmFiles: [{ ...valid.dmFiles[0], content: "!!" }] })],
    ["with toHands over 30 characters", JSON.stringify({ ...valid, dmToHands: "t".repeat(31) })],
    ["with IdLevel but no dmPublishOwnID", JSON.stringify({ ...valid, IdLevel: 1 })],
  ] as const) {
    it.effect(`refuses a payload ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(decodePayload(text));
        assert.instanceOf(error, CorruptPayload);
        assert.notInclude(error.reason, base64Of(LETTER_CONTENT));
      }),
    );
  }
});
