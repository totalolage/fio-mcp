import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import {
  downloadMessage,
  downloadMessageEnvelope,
  downloadSignedMessage,
  getDeliveryInfo,
  type MessageFile,
  type MessageIdInput,
  ping,
} from "../../src/isds/message-downloads.js";
import type { IsdsOperationError } from "../../src/isds/soap.js";
import type { IsdsTransport } from "../../src/isds/transport.js";
import { dmStatus, fakeTransport, fixture, ok, serverError, soapFault, soapResponse } from "./fake-transport.js";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, reply: Parameters<typeof fakeTransport>[0]) => {
  const transport = fakeTransport(reply);
  return effect.pipe(
    Effect.provide(transport.layer),
    Effect.map((result) => ({ result, requests: transport.requests })),
  );
};

const fails = <A, E, R>(effect: Effect.Effect<A, E, R>, reply: Parameters<typeof fakeTransport>[0]) => {
  const transport = fakeTransport(reply);
  return effect.pipe(
    Effect.provide(transport.layer),
    Effect.flip,
    Effect.map((error) => ({ error, requests: transport.requests })),
  );
};

const envelope = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;

const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);

const sameBytes = (actual: Uint8Array, expected: Uint8Array) => {
  assert.strictEqual(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) assert.fail(`byte ${index}: ${actual[index]} !== ${expected[index]}`);
  }
};

const encodedContent = (file: MessageFile | undefined): Uint8Array => {
  if (file === undefined || !("dmEncodedContent" in file)) return assert.fail("expected an encoded file");
  return file.dmEncodedContent;
};

const operations: ReadonlyArray<{
  readonly name: string;
  readonly service: string;
  readonly call: (input: MessageIdInput) => Effect.Effect<object, IsdsOperationError, IsdsTransport>;
}> = [
  { name: "MessageDownload", service: "operations", call: downloadMessage },
  { name: "SignedMessageDownload", service: "operations", call: downloadSignedMessage },
  { name: "MessageEnvelopeDownload", service: "info", call: downloadMessageEnvelope },
  { name: "GetDeliveryInfo", service: "info", call: getDeliveryInfo },
];

describe("message download requests", () => {
  it.effect("DummyOperation sends an empty operation element to the operations service", () =>
    Effect.gen(function* () {
      const { requests } = yield* run(ping(), ok(fixture("DummyOperation.xml")));
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.service, "operations");
      assert.strictEqual(requests[0]?.operation, "DummyOperation");
      assert.strictEqual(
        requests[0]?.envelope,
        envelope(`<DummyOperation xmlns="http://isds.czechpoint.cz/v20"></DummyOperation>`),
      );
    }),
  );

  for (const { name, service, call } of operations) {
    it.effect(`${name} sends tIDMessInput with the escaped dmID to the ${service} service`, () =>
      Effect.gen(function* () {
        const { requests } = yield* fails(call({ dmID: "1<2&3>" }), ok(soapResponse(name, dmStatus("1219"))));
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0]?.service, service);
        assert.strictEqual(requests[0]?.operation, name);
        assert.strictEqual(
          requests[0]?.envelope,
          envelope(`<${name} xmlns="http://isds.czechpoint.cz/v20"><dmID>1&lt;2&amp;3&gt;</dmID></${name}>`),
        );
      }),
    );

    it.effect(`${name} rejects an invalid dmID before sending`, () =>
      Effect.gen(function* () {
        for (const dmID of ["", "123456789012345678901", "bad\u0001id"]) {
          const { error, requests } = yield* fails(call({ dmID }), ok(soapResponse(name, dmStatus("0000"))));
          assert.strictEqual(error._tag, "IsdsInvalidRequest");
          assert.strictEqual(requests.length, 0);
        }
      }),
    );

    it.effect(`${name} fails with NotDelivered on 1222 and Blocked on 3022`, () =>
      Effect.gen(function* () {
        for (const [code, classification] of [
          ["1222", "NotDelivered"],
          ["3022", "Blocked"],
        ] as const) {
          const { error } = yield* fails(call({ dmID: "8765432" }), ok(soapResponse(name, dmStatus(code))));
          assert.strictEqual(error._tag, "IsdsStatusError");
          if (error._tag !== "IsdsStatusError") return;
          assert.strictEqual(error.code, code);
          assert.strictEqual(error.classification, classification);
          assert.strictEqual(error.operation, name);
        }
      }),
    );

    it.effect(`${name} fails with IsdsSoapFault on an HTTP 500 SOAP fault`, () =>
      Effect.gen(function* () {
        const { error } = yield* fails(call({ dmID: "8765432" }), serverError(soapFault("SOAP-ENV:Server", "boom")));
        assert.strictEqual(error._tag, "IsdsSoapFault");
      }),
    );

    it.effect(`${name} fails with IsdsInvalidResponse on malformed XML and on a missing payload`, () =>
      Effect.gen(function* () {
        const malformed = yield* fails(call({ dmID: "8765432" }), ok(`<SOAP-ENV:Envelope><broken>`));
        assert.strictEqual(malformed.error._tag, "IsdsInvalidResponse");
        const empty = yield* fails(call({ dmID: "8765432" }), ok(soapResponse(name, dmStatus("0000"))));
        assert.strictEqual(empty.error._tag, "IsdsInvalidResponse");
      }),
    );
  }
});

describe("ping", () => {
  it.effect("succeeds on status 0000", () =>
    Effect.gen(function* () {
      const { result } = yield* run(ping(), ok(fixture("DummyOperation.xml")));
      assert.strictEqual(result, undefined);
    }),
  );

  it.effect("fails on a non-success status", () =>
    Effect.gen(function* () {
      const { error } = yield* fails(ping(), ok(soapResponse("DummyOperation", dmStatus("9999"))));
      assert.strictEqual(error._tag, "IsdsStatusError");
    }),
  );
});

describe("downloadMessageEnvelope", () => {
  it.effect("a message hash that is not base64 fails as an invalid response, with or without algorithm", () =>
    Effect.gen(function* () {
      const original = fixture("MessageEnvelopeDownload.xml");
      const hash = `<p:dmHash algorithm="SHA-256">MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=</p:dmHash>`;
      for (const replacement of [
        `<p:dmHash algorithm="SHA-256">not-base64!</p:dmHash>`,
        `<p:dmHash>not-base64!</p:dmHash>`,
        `<p:dmHash>QUJD=</p:dmHash>`,
      ]) {
        const { error } = yield* fails(downloadMessageEnvelope({ dmID: "8765432" }), ok(original.replace(hash, replacement)));
        assert.strictEqual(error._tag, "IsdsInvalidResponse", replacement);
      }
    }),
  );

  it.effect("a message hash keeps its base64 text, with XML whitespace removed", () =>
    Effect.gen(function* () {
      const original = fixture("MessageEnvelopeDownload.xml");
      const hash = `<p:dmHash algorithm="SHA-256">MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=</p:dmHash>`;
      const { result } = yield* run(
        downloadMessageEnvelope({ dmID: "8765432" }),
        ok(original.replace(hash, "<p:dmHash>MDEyMzQ1Njc4\n  OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=</p:dmHash>")),
      );
      assert.deepStrictEqual(result.dmHash, { value: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" });
    }),
  );

  it.effect("decodes tReturnedMessageEnvelope", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        downloadMessageEnvelope({ dmID: "8765432" }),
        ok(fixture("MessageEnvelopeDownload.xml")),
      );
      assert.strictEqual(result.dmDm.dmID, "8765432");
      assert.strictEqual(result.dmDm.dmSender, "Finanční úřad & spol.");
      assert.strictEqual(result.dmDm.dmSenderType, 10);
      assert.strictEqual(result.dmDm.dbIDRecipient, "xyz9876");
      assert.strictEqual(result.dmDm.dmLegalTitleLaw, 280);
      assert.strictEqual(result.dmDm.dmPersonalDelivery, false);
      assert.strictEqual(result.dmDm.dmAllowSubstDelivery, true);
      assert.isUndefined(result.dmDm.dmToHands);
      assert.isUndefined(result.dmDm.dmAmbiguousRecipient);
      assert.deepStrictEqual(result.dmHash, {
        value: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        algorithm: "SHA-256",
      });
      sameBytes(result.dmQTimestamp, Uint8Array.of(0x30, 0x82, 0x01, 0x02, 0xff));
      assert.strictEqual(result.dmDeliveryTime && DateTime.formatIso(result.dmDeliveryTime), "2026-11-02T09:15:30.123Z");
      assert.strictEqual(result.dmAcceptanceTime && DateTime.formatIso(result.dmAcceptanceTime), "2026-11-11T23:00:01.000Z");
      assert.strictEqual(result.dmMessageStatus, 6);
      assert.strictEqual(result.dmAttachmentSize, 12);
      assert.strictEqual(result.dmType, "K");
      assert.strictEqual(result.dmVODZ, false);
      assert.strictEqual(result.attsNum, 2);
      assert.strictEqual(result.specMessFlag, 0);
    }),
  );

  it.effect("fails with IsdsInvalidResponse when the payload does not match the schema", () =>
    Effect.gen(function* () {
      const reply = fixture("MessageEnvelopeDownload.xml").replace(
        "<p:dmMessageStatus>6</p:dmMessageStatus>",
        "<p:dmMessageStatus>11</p:dmMessageStatus>",
      );
      const { error } = yield* fails(downloadMessageEnvelope({ dmID: "8765432" }), ok(reply));
      assert.strictEqual(error._tag, "IsdsInvalidResponse");
    }),
  );
});

describe("downloadMessage", () => {
  it.effect("decodes tReturnedMessage with encoded and XML documents", () =>
    Effect.gen(function* () {
      const { result } = yield* run(downloadMessage({ dmID: "8765432" }), ok(fixture("MessageDownload.xml")));
      assert.strictEqual(result.dmDm.dmID, "8765432");
      assert.strictEqual(result.dmDm.dmAnnotation, "Výzva k doplnění");
      assert.strictEqual(result.dmType, "K");
      assert.strictEqual(result.dmMessageStatus, 6);
      assert.strictEqual(result.dmAttachmentSize, 12);
      assert.isDefined(result.dmQTimestamp);

      const files = result.dmDm.dmFiles;
      assert.strictEqual(files.length, 2);
      const [pdf, xml] = files;
      assert.strictEqual(pdf?.dmMimeType, "application/pdf");
      assert.strictEqual(pdf?.dmFileMetaType, "main");
      assert.strictEqual(pdf?.dmFileDescr, "výzva.pdf");
      assert.strictEqual(pdf?.dmFileGuid, "g-1");
      assert.strictEqual(pdf?.dmFormat, "pdf");
      sameBytes(encodedContent(pdf), new TextEncoder().encode("%PDF-1.4\nhello\n"));

      assert.strictEqual(xml?.dmFileMetaType, "enclosure");
      assert.strictEqual(xml?.dmUpFileGuid, "g-1");
      if (xml === undefined || !("dmXMLContent" in xml)) return assert.fail("expected an XML file");
      assert.strictEqual(
        xml.dmXMLContent,
        `
                <f:Formular xmlns:f="urn:example:form" verze="2"><f:Polozka>A</f:Polozka><f:Polozka>B</f:Polozka></f:Formular>
              `,
      );
    }),
  );

  it.effect("keeps dmXMLContent verbatim: nil-looking, repeated-name and escaped content untouched", () =>
    Effect.gen(function* () {
      const inner =
          `<x:Doc xmlns:x="urn:x" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
          `<x:Gone xsi:nil="true"/><dmFile>1</dmFile><dmEvent/><x:Note> a &amp; b <![CDATA[<y>]]><!-- c --></x:Note>` +
          `<dmXMLContent>nested</dmXMLContent></x:Doc>\n  `;
      const original = fixture("MessageDownload.xml");
      const start = original.indexOf("<p:dmXMLContent>") + "<p:dmXMLContent>".length;
      const end = original.indexOf("</p:dmXMLContent>");
      const { result } = yield* run(
        downloadMessage({ dmID: "8765432" }),
        ok(`${original.slice(0, start)}${inner}${original.slice(end)}`),
      );
      const xml = result.dmDm.dmFiles[1];
      if (xml === undefined || !("dmXMLContent" in xml)) return assert.fail("expected an XML file");
      assert.strictEqual(xml.dmXMLContent, inner);
    }),
  );

  it.effect("an empty dmXMLContent decodes as an empty string", () =>
    Effect.gen(function* () {
      const original = fixture("MessageDownload.xml");
      const start = original.indexOf("<p:dmXMLContent>");
      const end = original.indexOf("</p:dmXMLContent>") + "</p:dmXMLContent>".length;
      const { result } = yield* run(
        downloadMessage({ dmID: "8765432" }),
        ok(`${original.slice(0, start)}<p:dmXMLContent/>${original.slice(end)}`),
      );
      const xml = result.dmDm.dmFiles[1];
      if (xml === undefined || !("dmXMLContent" in xml)) return assert.fail("expected an XML file");
      assert.strictEqual(xml.dmXMLContent, "");
    }),
  );

  it.effect("malformed XML inside dmXMLContent fails as an invalid response", () =>
    Effect.gen(function* () {
      const original = fixture("MessageDownload.xml");
      const start = original.indexOf("<p:dmXMLContent>") + "<p:dmXMLContent>".length;
      const end = original.indexOf("</p:dmXMLContent>");
      const { error } = yield* fails(
        downloadMessage({ dmID: "8765432" }),
        ok(`${original.slice(0, start)}<a><b></a>${original.slice(end)}`),
      );
      assert.strictEqual(error._tag, "IsdsInvalidResponse");
    }),
  );

  it.effect("decodes a single dmFile as a one-element array and nil elements as absent", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        downloadMessage({ dmID: "8765432" }),
        ok(fixture("MessageDownload-single-file.xml")),
      );
      assert.strictEqual(result.dmDm.dmFiles.length, 1);
      sameBytes(encodedContent(result.dmDm.dmFiles[0]), new TextEncoder().encode("%PDF-1.4\nhello\n"));
      assert.deepStrictEqual(result.dmHash, { value: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" });
      assert.isUndefined(result.dmQTimestamp);
      assert.isUndefined(result.dmDeliveryTime);
      assert.isUndefined(result.dmAcceptanceTime);
      assert.isUndefined(result.dmAttachmentSize);
      assert.isUndefined(result.dmType);
      assert.strictEqual(result.dmMessageStatus, 4);
    }),
  );

  it.effect("ignores elements and attributes the XSD does not declare", () =>
    Effect.gen(function* () {
      const reply = fixture("MessageDownload.xml")
        .replace("<p:dmReturnedMessage dmType=\"K\">", "<p:dmReturnedMessage dmType=\"K\" dmVODZ=\"true\" futureAttr=\"x\">")
        .replace("</p:dmDm>", "<p:dmFutureElement><p:nested>1</p:nested></p:dmFutureElement></p:dmDm>")
        .replace("<p:dmMessageStatus>", "<p:dmFutureField>2</p:dmFutureField><p:dmMessageStatus>");
      const { result } = yield* run(downloadMessage({ dmID: "8765432" }), ok(reply));
      assert.strictEqual(result.dmDm.dmFiles.length, 2);
      assert.strictEqual(result.dmMessageStatus, 6);
    }),
  );

  it.effect("fails with IsdsInvalidResponse on an unknown dmFileMetaType or a file without content", () =>
    Effect.gen(function* () {
      const unknownType = fixture("MessageDownload.xml").replace('dmFileMetaType="main"', 'dmFileMetaType="other"');
      const a = yield* fails(downloadMessage({ dmID: "8765432" }), ok(unknownType));
      assert.strictEqual(a.error._tag, "IsdsInvalidResponse");

      const noContent = fixture("MessageDownload-single-file.xml").replace(
        "<p:dmEncodedContent>JVBERi0xLjQKaGVsbG8K</p:dmEncodedContent>",
        "",
      );
      const b = yield* fails(downloadMessage({ dmID: "8765432" }), ok(noContent));
      assert.strictEqual(b.error._tag, "IsdsInvalidResponse");

      const badBase64 = fixture("MessageDownload-single-file.xml").replace("JVBERi0xLjQKaGVsbG8K", "not base64!");
      const c = yield* fails(downloadMessage({ dmID: "8765432" }), ok(badBase64));
      assert.strictEqual(c.error._tag, "IsdsInvalidResponse");
    }),
  );
});

describe("downloadSignedMessage", () => {
  it.effect("returns the signed bytes exactly as received", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        downloadSignedMessage({ dmID: "8765432" }),
        ok(fixture("SignedMessageDownload.xml")),
      );
      sameBytes(result.dmSignature, allBytes);
      assert.strictEqual(result.withoutQualifiedTimestamp, false);
    }),
  );

  it.effect("accepts status 0005 with the flag set, and base64 wrapped across lines", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        downloadSignedMessage({ dmID: "8765432" }),
        ok(fixture("SignedMessageDownload-0005.xml")),
      );
      sameBytes(result.dmSignature, allBytes);
      assert.strictEqual(result.withoutQualifiedTimestamp, true);
    }),
  );

  it.effect("fails on other non-success statuses", () =>
    Effect.gen(function* () {
      const { error } = yield* fails(
        downloadSignedMessage({ dmID: "8765432" }),
        ok(soapResponse("SignedMessageDownload", dmStatus("0006"))),
      );
      assert.strictEqual(error._tag, "IsdsStatusError");
    }),
  );
});

describe("getDeliveryInfo", () => {
  it.effect("decodes tDelivery with several events", () =>
    Effect.gen(function* () {
      const { result } = yield* run(getDeliveryInfo({ dmID: "8765432" }), ok(fixture("GetDeliveryInfo.xml")));
      assert.strictEqual(result.dmDm.dmID, "8765432");
      assert.strictEqual(result.dmMessageStatus, 6);
      sameBytes(result.dmQTimestamp, Uint8Array.of(0x30, 0x82, 0x01, 0x02, 0xff));
      assert.deepStrictEqual(
        result.dmEvents.map((event) => ({
          time: event.dmEventTime && DateTime.formatIso(event.dmEventTime),
          descr: event.dmEventDescr,
        })),
        [
          { time: "2026-11-02T09:15:30.123Z", descr: "EV0: Zpráva byla podána." },
          { time: "2026-11-02T09:16:00.000Z", descr: "EV5: Zpráva byla dodána do schránky." },
          { time: "2026-11-11T23:00:01.000Z", descr: "EV2: Zpráva byla doručena fikcí." },
          { time: undefined, descr: undefined },
        ],
      );
    }),
  );

  it.effect("decodes a single event as a one-element array", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        getDeliveryInfo({ dmID: "8765432" }),
        ok(fixture("GetDeliveryInfo-single-event.xml")),
      );
      assert.strictEqual(result.dmEvents.length, 1);
      assert.strictEqual(result.dmEvents[0]?.dmEventDescr, "EV0: Zpráva byla podána.");
    }),
  );
});
