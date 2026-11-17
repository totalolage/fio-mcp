import { createHash } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { AuditActor } from "../../src/domain/audit-log.js";
import { DomainConfig, type DomainConfigShape } from "../../src/domain/config.js";
import { ReadService } from "../../src/domain/read-service.js";
import { IsdsClient, type IsdsClientShape } from "../../src/isds/client.js";
import { IsdsTimeoutError } from "../../src/isds/errors.js";
import type { MessageFile } from "../../src/isds/message-downloads.js";
import { dbStatus, dmStatus, fakeTransport, fixture, ok, soapResponse } from "../isds/fake-transport.js";
import { readAuditLog } from "./support/read-audit-log.js";
import { type ReadReplies, readBoxClients } from "./support/read-box-clients.js";
import { readBoxRegistry, readTestBox } from "./support/read-box-registry.js";
import { readZfoStore } from "./support/read-zfo-store.js";

const BOX_ID = "box_AAAAAAAAAAAAAAAAAAAAAA";
const DB_ID = "xyz9876";
const DM_ID = "8765432";
const actor: AuditActor = { kind: "tool", grantId: "grant_1", clientId: "client_1" };

const replies = {
  GetListOfReceivedMessages: ok(fixture("GetListOfReceivedMessages-multi.xml")),
  GetListOfSentMessages: ok(fixture("GetListOfReceivedMessages-single.xml").replaceAll("GetListOfReceivedMessages", "GetListOfSentMessages")),
  GetMessageStateChanges: ok(fixture("GetMessageStateChanges.xml")),
  MessageEnvelopeDownload: ok(fixture("MessageEnvelopeDownload.xml")),
  MessageDownload: ok(fixture("MessageDownload.xml")),
  SignedMessageDownload: ok(fixture("SignedMessageDownload.xml")),
  GetDeliveryInfo: ok(fixture("GetDeliveryInfo.xml")),
  FindDataBox2: ok(fixture("FindDataBox2.xml")),
  CheckDataBox: ok(fixture("CheckDataBox.xml")),
} satisfies ReadReplies;

const setup = (
  options: {
    readonly replies?: ReadReplies;
    readonly failStart?: boolean;
    readonly config?: Partial<Pick<DomainConfigShape, "attachmentInlineMaxBytes" | "responseInlineMaxBytes">>;
  } = {},
) => {
  const log: Array<string> = [];
  const clients = readBoxClients(BOX_ID, options.replies ?? replies, log);
  const audit = readAuditLog(log, { failStart: options.failStart ?? false });
  const zfo = readZfoStore(log);
  const layer = ReadService.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        clients.layer,
        audit.layer,
        zfo.layer,
        readBoxRegistry(readTestBox(BOX_ID, DB_ID)),
        DomainConfig.layer({ dataDir: "/unused", ...options.config }),
      ),
    ),
  );
  return { log, requests: clients.requests, audit: audit.events, zfo: zfo.writes, layer };
};

type Harness = ReturnType<typeof setup>;

const withService = <A, E>(h: Harness, f: (service: ReadService["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const service = yield* ReadService;
    return yield* f(service);
  }).pipe(Effect.provide(h.layer));

/** What the ISDS client itself returns for the same canned reply. */
const direct = <A, E>(f: (client: IsdsClientShape) => Effect.Effect<A, E>, reply: ReadReplies[string]) =>
  Effect.gen(function* () {
    const client = yield* IsdsClient;
    return yield* f(client);
  }).pipe(Effect.provide(IsdsClient.Default.pipe(Layer.provide(fakeTransport(reply).layer))));

const bytesOf = (file: MessageFile): Uint8Array =>
  "dmEncodedContent" in file ? file.dmEncodedContent : new TextEncoder().encode(file.dmXMLContent);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const timeout = (requestSent: boolean): ReadReplies[string] => (request) =>
  Effect.fail(
    new IsdsTimeoutError({ service: request.service, operation: request.operation, timeoutMillis: 1000, requestSent }),
  );

describe("ReadService.listReceivedMessages", () => {
  it.effect("writes the intent before the request reaches ISDS and the outcome after", () =>
    Effect.gen(function* () {
      const h = setup();
      const result = yield* withService(h, (s) => s.listReceivedMessages(actor, BOX_ID, { limit: 10 }));
      const expected = yield* direct((c) => c.listReceivedMessagesAndDeliver({ limit: 10 }), replies.GetListOfReceivedMessages);
      assert.deepStrictEqual(result.records, expected);
      assert.deepStrictEqual(h.log, ["audit.start list_received_messages", "isds GetListOfReceivedMessages", "audit.finish ok"]);
      const [start, finish] = h.audit;
      assert.strictEqual(start?.kind, "start");
      if (start?.kind !== "start") return;
      assert.strictEqual(start.input.action, "list_received_messages");
      assert.strictEqual(start.input.boxId, BOX_ID);
      assert.deepStrictEqual(start.input.actor, actor);
      assert.deepStrictEqual(start.input.detail, { limit: 10 });
      assert.strictEqual(finish?.kind, "finish");
      if (finish?.kind !== "finish") return;
      assert.strictEqual(finish.id, start.id);
      assert.deepStrictEqual(finish.detail, {
        limit: 10,
        records: expected.length,
        dmIds: expected.map((record) => record.dmID),
      });
    }),
  );

  it.effect("says that listing delivered every eligible message, not only the returned records", () =>
    Effect.gen(function* () {
      const result = yield* withService(setup(), (s) => s.listReceivedMessages(actor, BOX_ID, {}));
      assert.match(result.note, /deliver/i);
      assert.match(result.note, /not necessarily/i);
    }),
  );

  it.effect("does not call ISDS when the intent cannot be written", () =>
    Effect.gen(function* () {
      const h = setup({ failStart: true });
      const error = yield* Effect.flip(withService(h, (s) => s.listReceivedMessages(actor, BOX_ID, {})));
      assert.strictEqual(error._tag, "DomainStoreError");
      assert.strictEqual(h.requests.length, 0);
      assert.deepStrictEqual(h.log, []);
    }),
  );

  it.effect("records a timeout after the request was sent as uncertain", () =>
    Effect.gen(function* () {
      const h = setup({ replies: { GetListOfReceivedMessages: timeout(true) } });
      const error = yield* Effect.flip(withService(h, (s) => s.listReceivedMessages(actor, BOX_ID, {})));
      assert.strictEqual(error._tag, "IsdsTimeoutError");
      assert.deepStrictEqual(h.log, ["audit.start list_received_messages", "isds GetListOfReceivedMessages", "audit.finish uncertain"]);
      const finish = h.audit[1];
      assert.deepStrictEqual(finish?.kind === "finish" ? finish.detail : undefined, {
        error: "IsdsTimeoutError",
        requestSent: true,
      });
    }),
  );

  it.effect("records a timeout before the request was sent as an error", () =>
    Effect.gen(function* () {
      const h = setup({ replies: { GetListOfReceivedMessages: timeout(false) } });
      yield* Effect.flip(withService(h, (s) => s.listReceivedMessages(actor, BOX_ID, {})));
      assert.strictEqual(h.log.at(-1), "audit.finish error");
    }),
  );

  it.effect("records an ISDS status error with its code", () =>
    Effect.gen(function* () {
      const h = setup({
        replies: { GetListOfReceivedMessages: ok(soapResponse("GetListOfReceivedMessages", dmStatus("3008"))) },
      });
      const error = yield* Effect.flip(withService(h, (s) => s.listReceivedMessages(actor, BOX_ID, {})));
      assert.strictEqual(error._tag, "IsdsStatusError");
      const finish = h.audit[1];
      assert.strictEqual(finish?.kind === "finish" ? finish.outcome : undefined, "error");
      assert.deepStrictEqual(finish?.kind === "finish" ? finish.detail : undefined, {
        error: "IsdsStatusError",
        code: "3008",
        classification: "Transient",
      });
    }),
  );

  it.effect("fails BoxNotFound for an unknown box, audited as an error", () =>
    Effect.gen(function* () {
      const h = setup();
      const error = yield* Effect.flip(withService(h, (s) => s.listReceivedMessages(actor, "box_unknown", {})));
      assert.strictEqual(error._tag, "BoxNotFound");
      assert.deepStrictEqual(h.log, ["audit.start list_received_messages", "audit.finish error"]);
      assert.strictEqual(h.requests.length, 0);
    }),
  );
});

describe("ReadService.downloadMessage", () => {
  it.effect("downloads, stores the signed message under the box's dbID and inlines attachments within the caps", () =>
    Effect.gen(function* () {
      const h = setup();
      const result = yield* withService(h, (s) => s.downloadMessage(actor, BOX_ID, DM_ID));
      const message = yield* direct((c) => c.downloadMessage({ dmID: DM_ID }), replies.MessageDownload);
      const signed = yield* direct((c) => c.downloadSignedMessage({ dmID: DM_ID }), replies.SignedMessageDownload);

      assert.deepStrictEqual(h.log, [
        "audit.start download_message",
        "isds MessageDownload",
        "isds SignedMessageDownload",
        `zfo.write ${DB_ID}/${DM_ID}`,
        "audit.finish ok",
      ]);
      assert.strictEqual(h.zfo.length, 1);
      assert.strictEqual(h.zfo[0]?.dbId, DB_ID);
      assert.strictEqual(h.zfo[0]?.dmId, DM_ID);
      assert.deepStrictEqual(h.zfo[0]?.bytes, signed.dmSignature);
      assert.deepStrictEqual(result.zfo, {
        ref: `${DB_ID}/${DM_ID}.zfo`,
        sha256: sha256(signed.dmSignature),
        bytes: signed.dmSignature.byteLength,
      });

      const { dmFiles, ...envelope } = message.dmDm;
      const { dmDm: _dm, dmQTimestamp: _timestamp, ...info } = message;
      assert.deepStrictEqual(result.envelope, envelope);
      assert.deepStrictEqual(result.info, info);
      assert.isFalse("dmFiles" in result.envelope);
      assert.isFalse("dmQTimestamp" in result.info);

      assert.strictEqual(result.attachments.length, dmFiles.length);
      assert.strictEqual(dmFiles.length, 2);
      dmFiles.forEach((file, index) => {
        const attachment = result.attachments[index];
        const bytes = bytesOf(file);
        assert.strictEqual(attachment?._tag, "Inline");
        if (attachment?._tag !== "Inline") return;
        assert.strictEqual(attachment.index, index);
        assert.strictEqual(attachment.filename, file.dmFileDescr);
        assert.strictEqual(attachment.mimeType, file.dmMimeType);
        assert.strictEqual(attachment.metaType, file.dmFileMetaType);
        assert.strictEqual(attachment.size, bytes.byteLength);
        assert.strictEqual(attachment.sha256, sha256(bytes));
        assert.deepStrictEqual(attachment.content, bytes);
      });
      // The XML document is the UTF-8 bytes of the inner XML.
      const xml = dmFiles[1];
      assert.isTrue(xml !== undefined && "dmXMLContent" in xml);

      const finish = h.audit[1];
      assert.deepStrictEqual(finish?.kind === "finish" ? finish.detail : undefined, {
        dmId: DM_ID,
        attachments: dmFiles.map((file, index) => ({
          index,
          size: bytesOf(file).byteLength,
          sha256: sha256(bytesOf(file)),
          inline: true,
        })),
        zfo: result.zfo,
      });
    }),
  );

  it.effect("skips an attachment over the per-attachment cap, with the stored ZFO as its source", () =>
    Effect.gen(function* () {
      const message = yield* direct((c) => c.downloadMessage({ dmID: DM_ID }), replies.MessageDownload);
      const [pdf, xml] = message.dmDm.dmFiles.map(bytesOf);
      assert.isTrue(pdf !== undefined && xml !== undefined && pdf.byteLength < xml.byteLength);
      if (pdf === undefined || xml === undefined) return;
      const h = setup({ config: { attachmentInlineMaxBytes: pdf.byteLength } });
      const result = yield* withService(h, (s) => s.downloadMessage(actor, BOX_ID, DM_ID));
      const [first, second] = result.attachments;
      assert.strictEqual(first?._tag, "Inline");
      assert.strictEqual(second?._tag, "Skipped");
      if (second?._tag !== "Skipped") return;
      assert.strictEqual(second.size, xml.byteLength);
      assert.strictEqual(second.sha256, sha256(xml));
      assert.strictEqual(second.filename, "data.xml");
      assert.isFalse("content" in second);
      assert.include(second.note, "per-attachment");
      assert.include(second.note, String(pdf.byteLength));
      assert.include(second.note, result.zfo.ref);
    }),
  );

  it.effect("skips attachments that would take the download over the total cap", () =>
    Effect.gen(function* () {
      const message = yield* direct((c) => c.downloadMessage({ dmID: DM_ID }), replies.MessageDownload);
      const [pdf, xml] = message.dmDm.dmFiles.map(bytesOf);
      if (pdf === undefined || xml === undefined) return assert.fail("fixture has two files");
      const total = pdf.byteLength + xml.byteLength - 1;
      const h = setup({ config: { responseInlineMaxBytes: total } });
      const result = yield* withService(h, (s) => s.downloadMessage(actor, BOX_ID, DM_ID));
      const [first, second] = result.attachments;
      assert.strictEqual(first?._tag, "Inline");
      assert.strictEqual(second?._tag, "Skipped");
      if (second?._tag !== "Skipped") return;
      assert.include(second.note, "per-download");
      assert.include(second.note, String(total));
      assert.include(second.note, result.zfo.ref);
    }),
  );

  it.effect("fails NotDeliveredYet on 1222, telling the caller to list received messages first", () =>
    Effect.gen(function* () {
      const h = setup({ replies: { ...replies, MessageDownload: ok(soapResponse("MessageDownload", dmStatus("1222"))) } });
      const error = yield* Effect.flip(withService(h, (s) => s.downloadMessage(actor, BOX_ID, DM_ID)));
      assert.strictEqual(error._tag, "NotDeliveredYet");
      if (error._tag !== "NotDeliveredYet") return;
      assert.strictEqual(error.dmId, DM_ID);
      assert.include(error.message, "list_received_messages");
      assert.deepStrictEqual(h.log, ["audit.start download_message", "isds MessageDownload", "audit.finish error"]);
      assert.strictEqual(h.zfo.length, 0);
      const finish = h.audit[1];
      assert.deepStrictEqual(finish?.kind === "finish" ? finish.detail : undefined, {
        dmId: DM_ID,
        error: "IsdsStatusError",
        code: "1222",
        classification: "NotDelivered",
      });
    }),
  );

  it.effect("rejects a malformed dmID before auditing or calling ISDS", () =>
    Effect.gen(function* () {
      for (const dmId of ["", "12a", "../x", "123456789012345678901"]) {
        const h = setup();
        const error = yield* Effect.flip(withService(h, (s) => s.downloadMessage(actor, BOX_ID, dmId)));
        assert.strictEqual(error._tag, "InvalidIdentifier");
        if (error._tag !== "InvalidIdentifier") return;
        assert.strictEqual(error.kind, "messageId");
        assert.deepStrictEqual(h.log, []);
      }
    }),
  );

  it.effect("fails BoxNotFound for an unknown box without calling ISDS", () =>
    Effect.gen(function* () {
      const h = setup();
      const error = yield* Effect.flip(withService(h, (s) => s.downloadMessage(actor, "box_unknown", DM_ID)));
      assert.strictEqual(error._tag, "BoxNotFound");
      assert.deepStrictEqual(h.log, ["audit.start download_message", "audit.finish error"]);
    }),
  );
});

describe("ReadService.getMessageEnvelope and getDeliveryInfo", () => {
  it.effect("return the client's result and audit once", () =>
    Effect.gen(function* () {
      const h = setup();
      const envelope = yield* withService(h, (s) => s.getMessageEnvelope(actor, BOX_ID, DM_ID));
      assert.deepStrictEqual(
        envelope,
        yield* direct((c) => c.downloadMessageEnvelope({ dmID: DM_ID }), replies.MessageEnvelopeDownload),
      );
      const delivery = yield* withService(h, (s) => s.getDeliveryInfo(actor, BOX_ID, DM_ID));
      assert.deepStrictEqual(delivery, yield* direct((c) => c.getDeliveryInfo({ dmID: DM_ID }), replies.GetDeliveryInfo));
      assert.deepStrictEqual(h.log, [
        "audit.start get_message",
        "isds MessageEnvelopeDownload",
        "audit.finish ok",
        "audit.start get_delivery_info",
        "isds GetDeliveryInfo",
        "audit.finish ok",
      ]);
      const start = h.audit[0];
      assert.deepStrictEqual(start?.kind === "start" ? start.input.detail : undefined, { dmId: DM_ID });
    }),
  );

  it.effect("fail NotDeliveredYet on 1222", () =>
    Effect.gen(function* () {
      const h = setup({
        replies: {
          MessageEnvelopeDownload: ok(soapResponse("MessageEnvelopeDownload", dmStatus("1222"))),
          GetDeliveryInfo: ok(soapResponse("GetDeliveryInfo", dmStatus("1222"))),
        },
      });
      const envelope = yield* Effect.flip(withService(h, (s) => s.getMessageEnvelope(actor, BOX_ID, DM_ID)));
      assert.strictEqual(envelope._tag, "NotDeliveredYet");
      assert.include(envelope.message, "list_received_messages first");
      const delivery = yield* Effect.flip(withService(h, (s) => s.getDeliveryInfo(actor, BOX_ID, DM_ID)));
      assert.strictEqual(delivery._tag, "NotDeliveredYet");
    }),
  );

  it.effect("keep other status errors as they are", () =>
    Effect.gen(function* () {
      const h = setup({ replies: { MessageEnvelopeDownload: ok(soapResponse("MessageEnvelopeDownload", dmStatus("3022"))) } });
      const error = yield* Effect.flip(withService(h, (s) => s.getMessageEnvelope(actor, BOX_ID, DM_ID)));
      assert.strictEqual(error._tag, "IsdsStatusError");
    }),
  );

  it.effect("reject a malformed dmID before auditing", () =>
    Effect.gen(function* () {
      const h = setup();
      const a = yield* Effect.flip(withService(h, (s) => s.getMessageEnvelope(actor, BOX_ID, "x")));
      const b = yield* Effect.flip(withService(h, (s) => s.getDeliveryInfo(actor, BOX_ID, "x")));
      assert.strictEqual(a._tag, "InvalidIdentifier");
      assert.strictEqual(b._tag, "InvalidIdentifier");
      assert.deepStrictEqual(h.log, []);
    }),
  );
});

describe("ReadService list, search and check operations", () => {
  it.effect("listSentMessages returns the client's records and audits once", () =>
    Effect.gen(function* () {
      const h = setup();
      const records = yield* withService(h, (s) => s.listSentMessages(actor, BOX_ID, {}));
      assert.deepStrictEqual(records, yield* direct((c) => c.listSentMessages({}), replies.GetListOfSentMessages));
      assert.deepStrictEqual(h.log, ["audit.start list_sent_messages", "isds GetListOfSentMessages", "audit.finish ok"]);
    }),
  );

  it.effect("getMessageStateChanges returns the client's changes and audits once", () =>
    Effect.gen(function* () {
      const h = setup();
      const changes = yield* withService(h, (s) => s.getMessageStateChanges(actor, BOX_ID, {}));
      assert.deepStrictEqual(changes, yield* direct((c) => c.getMessageStateChanges({}), replies.GetMessageStateChanges));
      assert.deepStrictEqual(h.log, ["audit.start get_message_state_changes", "isds GetMessageStateChanges", "audit.finish ok"]);
    }),
  );

  it.effect("findDataBox returns the client's result and audits the query", () =>
    Effect.gen(function* () {
      const h = setup();
      const query = { dbType: "OVM", firmName: "Úřad" } as const;
      const result = yield* withService(h, (s) => s.findDataBox(actor, BOX_ID, query));
      assert.deepStrictEqual(result, yield* direct((c) => c.findDataBoxes(query), replies.FindDataBox2));
      assert.deepStrictEqual(h.log, ["audit.start find_data_box", "isds FindDataBox2", "audit.finish ok"]);
      const start = h.audit[0];
      assert.deepStrictEqual(start?.kind === "start" ? start.input.detail : undefined, query);
    }),
  );

  it.effect("checkDataBox returns the client's result and audits once", () =>
    Effect.gen(function* () {
      const h = setup();
      const result = yield* withService(h, (s) => s.checkDataBox(actor, BOX_ID, "abc1234"));
      assert.deepStrictEqual(result, yield* direct((c) => c.checkDataBox({ dbID: "abc1234" }), replies.CheckDataBox));
      assert.deepStrictEqual(h.log, ["audit.start check_data_box", "isds CheckDataBox", "audit.finish ok"]);
      const finish = h.audit[1];
      assert.deepStrictEqual(finish?.kind === "finish" ? finish.detail : undefined, {
        dbId: "abc1234",
        dbState: result.dbState,
      });
    }),
  );

  it.effect("checkDataBox rejects a malformed dbID before auditing", () =>
    Effect.gen(function* () {
      const h = setup();
      for (const dbId of ["ABC1234", "abc123", "abc12345", "abc-123"]) {
        const error = yield* Effect.flip(withService(h, (s) => s.checkDataBox(actor, BOX_ID, dbId)));
        assert.strictEqual(error._tag, "InvalidIdentifier");
        if (error._tag !== "InvalidIdentifier") return;
        assert.strictEqual(error.kind, "dataBoxId");
      }
      assert.deepStrictEqual(h.log, []);
    }),
  );

  it.effect("checkDataBox keeps a 5001 status error", () =>
    Effect.gen(function* () {
      const h = setup({ replies: { CheckDataBox: ok(soapResponse("CheckDataBox", dbStatus("5001"))) } });
      const error = yield* Effect.flip(withService(h, (s) => s.checkDataBox(actor, BOX_ID, "abc1234")));
      assert.strictEqual(error._tag, "IsdsStatusError");
      assert.strictEqual(h.log.at(-1), "audit.finish error");
    }),
  );
});
