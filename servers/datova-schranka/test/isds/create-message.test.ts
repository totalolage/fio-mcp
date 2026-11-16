import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  type CreateMessageFile,
  type CreateMessageInput,
  checkAttachmentSize,
  createMessage,
  createMessageMaxAttachmentBytes,
} from "../../src/isds/create-message.js";
import { IsdsTimeoutError } from "../../src/isds/errors.js";
import { parseXml } from "../../src/isds/xml.js";
import { dmStatus, fakeTransport, fixture, ok, serverError, soapFault, soapResponse } from "./fake-transport.js";

const bytes = (text: string) => new TextEncoder().encode(text);

const file = (overrides: Partial<CreateMessageFile> = {}): CreateMessageFile => ({
  content: bytes("Hello"),
  dmMimeType: "application/pdf",
  dmFileMetaType: "main",
  dmFileDescr: "zadost.pdf",
  ...overrides,
});

const minimal: CreateMessageInput = { dbIDRecipient: "abc2def", dmFiles: [file()] };

const accepted = ok(soapResponse("CreateMessage", `<dmID>1234567</dmID>${dmStatus("0000")}`));

const send = (input: CreateMessageInput, reply: Parameters<typeof fakeTransport>[0] = accepted) => {
  const transport = fakeTransport(reply);
  return createMessage(input).pipe(
    Effect.provide(transport.layer),
    Effect.map((result) => ({ result, requests: transport.requests })),
  );
};

/** Fails and returns the error together with what reached the transport. */
const sendFailing = (input: CreateMessageInput, reply: Parameters<typeof fakeTransport>[0] = accepted) => {
  const transport = fakeTransport(reply);
  return createMessage(input).pipe(
    Effect.provide(transport.layer),
    Effect.flip,
    Effect.map((error) => ({ error, requests: transport.requests })),
  );
};

const sentEnvelope = (requests: ReadonlyArray<{ readonly envelope: string }>): string => {
  assert.strictEqual(requests.length, 1);
  return requests[0]?.envelope ?? "";
};

const compact = (xml: string) => xml.replace(/>\s+</g, "><").trim();

describe("createMessage", () => {
  it.effect("sends the envelope and files in XSD order, nil for absent envelope values", () =>
    Effect.gen(function* () {
      const { requests } = yield* send({
        dbIDRecipient: "abc2def",
        dmType: "K",
        dmRecipientOrgUnit: "Podatelna",
        dmRecipientOrgUnitNum: 42,
        dmToHands: "Jan Novák",
        dmAnnotation: "Žádost o informace",
        dmSenderRefNumber: "2026/0001",
        dmSenderIdent: "SPIS-7",
        dmLegalTitleLaw: 106,
        dmLegalTitleYear: 1999,
        dmLegalTitleSect: "14",
        dmPersonalDelivery: false,
        dmAllowSubstDelivery: true,
        dmOVM: false,
        dmPublishOwnID: true,
        IdLevel: 3,
        dmFiles: [
          file({ dmFileGuid: "g-1" }),
          file({
            content: new Uint8Array([0, 1, 2, 255]),
            dmMimeType: "application/octet-stream",
            dmFileMetaType: "enclosure",
            dmUpFileGuid: "g-1",
            dmFileDescr: "priloha.bin",
            dmFormat: "f1",
          }),
        ],
      });
      assert.strictEqual(requests[0]?.service, "operations");
      assert.strictEqual(requests[0]?.operation, "CreateMessage");
      assert.strictEqual(sentEnvelope(requests), compact(fixture("CreateMessageRequest.xml")));
    }),
  );

  it.effect("omits the optional dmOVM, dmPublishOwnID and dmType when absent", () =>
    Effect.gen(function* () {
      const { requests } = yield* send(minimal);
      const envelope = sentEnvelope(requests);
      assert.include(envelope, "<dmEnvelope><dmSenderOrgUnit ");
      assert.include(envelope, "<dbIDRecipient>abc2def</dbIDRecipient>");
      assert.strictEqual(envelope.match(/xsi:nil="true"/g)?.length, 17);
      assert.include(envelope, `<dmAllowSubstDelivery xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/></dmEnvelope>`);
      assert.notInclude(envelope, "dmOVM");
      assert.notInclude(envelope, "dmPublishOwnID");
      assert.notInclude(envelope, "dmType");
      assert.include(
        envelope,
        `<dmFiles><dmFile dmMimeType="application/pdf" dmFileMetaType="main" dmFileDescr="zadost.pdf"><dmEncodedContent>SGVsbG8=</dmEncodedContent></dmFile></dmFiles>`,
      );
    }),
  );

  it.effect("escapes hostile text so it round-trips as text without injected markup", () =>
    Effect.gen(function* () {
      const annotation = "</dmAnnotation><x>&";
      const description = `a.pdf" dmFormat="x`;
      const { requests } = yield* send({ ...minimal, dmAnnotation: annotation, dmFiles: [file({ dmFileDescr: description })] });
      const envelope = sentEnvelope(requests);
      assert.include(envelope, "<dmAnnotation>&lt;/dmAnnotation&gt;&lt;x&gt;&amp;</dmAnnotation>");
      const parsed = parseXml(envelope, new Set(["dmFile"]));
      assert.isTrue(Result.isSuccess(parsed));
      const message = Result.isSuccess(parsed) ? parsed.success : undefined;
      assert.nestedPropertyVal(message, "Envelope.Body.CreateMessage.dmEnvelope.dmAnnotation", annotation);
      assert.notNestedProperty(message, "Envelope.Body.CreateMessage.dmEnvelope.x");
      assert.nestedPropertyVal(message, "Envelope.Body.CreateMessage.dmFiles.dmFile[0].dmFileDescr", description);
      assert.notNestedProperty(message, "Envelope.Body.CreateMessage.dmFiles.dmFile[0].dmFormat");
    }),
  );

  it.effect("rejects control characters before sending", () =>
    Effect.gen(function* () {
      for (const input of [
        { ...minimal, dmAnnotation: "a\u0001b" },
        { ...minimal, dmFiles: [file({ dmFileDescr: "a\u0000.pdf" })] },
        { ...minimal, dmLegalTitlePoint: "￾" },
      ]) {
        const { error, requests } = yield* sendFailing(input);
        assert.strictEqual(error._tag, "IsdsInvalidRequest");
        assert.strictEqual(requests.length, 0);
      }
    }),
  );

  it.effect("rejects values over the XSD and PDF length limits, counted in characters, before sending", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<CreateMessageInput> = [
        { ...minimal, dbIDRecipient: "abc2de" },
        { ...minimal, dbIDRecipient: "abc2defg" },
        { ...minimal, dmAnnotation: "x".repeat(256) },
        { ...minimal, dmToHands: "x".repeat(31) },
        { ...minimal, dmSenderRefNumber: "x".repeat(51) },
        { ...minimal, dmRecipientRefNumber: "x".repeat(51) },
        { ...minimal, dmSenderIdent: "x".repeat(51) },
        { ...minimal, dmRecipientIdent: "x".repeat(51) },
        { ...minimal, dmFiles: [file({ dmFileDescr: "x".repeat(256) })] },
        { ...minimal, dmFiles: [file({ dmFileDescr: "" })] },
        { ...minimal, dmLegalTitleYear: 1999.5 },
        { ...minimal, IdLevel: 1 },
        { ...minimal, dmPublishOwnID: false, IdLevel: 1 },
        { ...minimal, dmPublishOwnID: true, IdLevel: -1 },
      ];
      for (const input of cases) {
        const { error, requests } = yield* sendFailing(input);
        assert.strictEqual(error._tag, "IsdsInvalidRequest", JSON.stringify({ ...input, dmFiles: undefined }));
        assert.strictEqual(requests.length, 0);
      }
      const emoji = "\u{1F600}";
      for (const input of [
        { ...minimal, dmAnnotation: `${"x".repeat(255)}${emoji}` },
        { ...minimal, dmToHands: `${"x".repeat(30)}${emoji}` },
        { ...minimal, dmSenderIdent: `${"x".repeat(50)}${emoji}` },
        { ...minimal, dmFiles: [file({ dmFileDescr: `${"x".repeat(255)}${emoji}` })] },
      ]) {
        const { error } = yield* sendFailing(input);
        assert.strictEqual(error._tag, "IsdsInvalidRequest");
      }
      const astral = yield* send({
        ...minimal,
        dmAnnotation: `${"x".repeat(254)}${emoji}`,
        dmToHands: `${"x".repeat(29)}${emoji}`,
        dmSenderIdent: `${"x".repeat(49)}${emoji}`,
        dmFiles: [file({ dmFileDescr: `${"x".repeat(254)}${emoji}` })],
      });
      assert.include(sentEnvelope(astral.requests), `${emoji}</dmAnnotation>`);
      const { requests } = yield* send({
        ...minimal,
        dmAnnotation: "x".repeat(255),
        dmToHands: "x".repeat(30),
        dmSenderRefNumber: "x".repeat(50),
        dmFiles: [file({ dmFileDescr: `${"x".repeat(251)}.pdf` })],
      });
      assert.strictEqual(requests.length, 1);
    }),
  );

  it.effect("accepts 100 files and rejects 0 or 101 before sending", () =>
    Effect.gen(function* () {
      const files = (count: number) => Array.from({ length: count }, (_, index) => file({ dmFileDescr: `${index}.pdf` }));
      for (const count of [0, 101]) {
        const { error, requests } = yield* sendFailing({ ...minimal, dmFiles: files(count) });
        assert.strictEqual(error._tag, "IsdsInvalidRequest");
        assert.strictEqual(requests.length, 0);
      }
      const { requests } = yield* send({ ...minimal, dmFiles: files(100) });
      assert.strictEqual(sentEnvelope(requests).match(/<dmFile /g)?.length, 100);
    }),
  );

  it.effect("fails with IsdsMessageTooLarge over the attachment limit, without sending", () =>
    Effect.gen(function* () {
      const half = createMessageMaxAttachmentBytes / 2;
      const { error, requests } = yield* sendFailing({
        ...minimal,
        dmFiles: [file({ content: new Uint8Array(half) }), file({ content: new Uint8Array(half + 1), dmFileMetaType: "enclosure" })],
      });
      assert.strictEqual(error._tag, "IsdsMessageTooLarge");
      if (error._tag === "IsdsMessageTooLarge") {
        assert.strictEqual(error.totalBytes, 20_000_001);
        assert.strictEqual(error.limitBytes, 20_000_000);
      }
      assert.strictEqual(requests.length, 0);
    }),
  );

  it.effect("sends attachment bytes at an offset of their buffer as base64 of the view only", () =>
    Effect.gen(function* () {
      const view = new Uint8Array([9, 9, 0, 1, 2, 255, 9]).subarray(2, 6);
      const { requests } = yield* send({ ...minimal, dmFiles: [file({ content: view })] });
      assert.include(sentEnvelope(requests), "<dmEncodedContent>AAEC/w==</dmEncodedContent>");
    }),
  );

  it.effect("accepts attachments totalling exactly the limit", () =>
    Effect.gen(function* () {
      // Checked directly: rendering a 20 MB request takes seconds, which the integration test above avoids.
      const total = yield* checkAttachmentSize([
        { content: new Uint8Array(createMessageMaxAttachmentBytes - 1) },
        { content: new Uint8Array(1) },
      ]);
      assert.strictEqual(total, createMessageMaxAttachmentBytes);
      const error = yield* Effect.flip(checkAttachmentSize([{ content: new Uint8Array(createMessageMaxAttachmentBytes + 1) }]));
      assert.strictEqual(error._tag, "IsdsMessageTooLarge");
    }),
  );

  it.effect("decodes the new message ID and the accepted status", () =>
    Effect.gen(function* () {
      const { result } = yield* send(minimal, ok(fixture("CreateMessageResponse.xml")));
      assert.deepStrictEqual(result, { dmID: "1234567", status: { code: "0000", message: "Provedeno úspěšně." } });
    }),
  );

  it.effect("fails with IsdsInvalidResponse when status 0000 comes without dmID", () =>
    Effect.gen(function* () {
      const { error } = yield* sendFailing(minimal, ok(soapResponse("CreateMessage", dmStatus("0000"))));
      assert.strictEqual(error._tag, "IsdsInvalidResponse");
    }),
  );

  it.effect("fails with IsdsStatusError AttachmentRejected on dmStatusCode 1214", () =>
    Effect.gen(function* () {
      const { error } = yield* sendFailing(minimal, ok(soapResponse("CreateMessage", dmStatus("1214", "Nepovolený formát"))));
      assert.strictEqual(error._tag, "IsdsStatusError");
      if (error._tag === "IsdsStatusError") {
        assert.strictEqual(error.code, "1214");
        assert.strictEqual(error.classification, "AttachmentRejected");
        assert.strictEqual(error.operation, "CreateMessage");
      }
    }),
  );

  it.effect("fails with IsdsSoapFault on a SOAP fault", () =>
    Effect.gen(function* () {
      const { error } = yield* sendFailing(minimal, serverError(soapFault("SOAP-ENV:Server", "Internal error")));
      assert.strictEqual(error._tag, "IsdsSoapFault");
      if (error._tag === "IsdsSoapFault") assert.strictEqual(error.faultString, "Internal error");
    }),
  );

  it.effect("propagates IsdsTimeoutError from the transport unchanged", () =>
    Effect.gen(function* () {
      const timeout = new IsdsTimeoutError({
        service: "operations",
        operation: "CreateMessage",
        timeoutMillis: 30_000,
        requestSent: true,
      });
      const { error, requests } = yield* sendFailing(minimal, () => Effect.fail(timeout));
      assert.strictEqual(error, timeout);
      assert.strictEqual(requests.length, 1);
    }),
  );
});
