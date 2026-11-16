import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration, Effect } from "effect";
import { IsdsTimeoutError } from "../../src/isds/errors.js";
import {
  attachmentSizeMatches,
  type ReconcileSentMessageInput,
  reconcileSentMessage,
} from "../../src/isds/reconcile.js";
import { dmStatus, fakeTransport, ok, soapResponse } from "./fake-transport.js";

interface Row {
  readonly dmID: string;
  readonly dbIDRecipient?: string;
  readonly dmAnnotation?: string;
  readonly dmSenderRefNumber?: string;
  readonly dmSenderIdent?: string;
  readonly dmAttachmentSize?: number;
}

const optional = (name: string, value: string | number | undefined) =>
  value === undefined ? "" : `<${name}>${value}</${name}>`;

/** A tRecord in XSD element order with just the fields reconciliation reads. */
const record = (row: Row, ordinal: number) =>
  `<dmRecord><dmOrdinal>${ordinal}</dmOrdinal><dmID>${row.dmID}</dmID><dmSenderType>10</dmSenderType>` +
  optional("dbIDRecipient", row.dbIDRecipient ?? "xyz9876") +
  optional("dmAnnotation", row.dmAnnotation) +
  optional("dmSenderRefNumber", row.dmSenderRefNumber) +
  optional("dmSenderIdent", row.dmSenderIdent) +
  `<dmMessageStatus>2</dmMessageStatus>` +
  optional("dmAttachmentSize", row.dmAttachmentSize) +
  `</dmRecord>`;

const sentList = (rows: ReadonlyArray<Row>, firstOrdinal = 1) =>
  ok(
    soapResponse(
      "GetListOfSentMessages",
      `<dmRecords>${rows.map((row, index) => record(row, firstOrdinal + index)).join("")}</dmRecords>${dmStatus("0000")}`,
    ),
  );

const sent: ReconcileSentMessageInput = {
  submittedAt: DateTime.makeUnsafe("2026-11-16T12:00:00Z"),
  dbIDRecipient: "xyz9876",
  dmAnnotation: "Faktura 17",
  dmSenderRefNumber: "REF-17",
};

const matching: Row = { dmID: "100", dmAnnotation: "Faktura 17", dmSenderRefNumber: "REF-17" };

const reconcile = (input: ReconcileSentMessageInput, reply: Parameters<typeof fakeTransport>[0]) => {
  const transport = fakeTransport(reply);
  return reconcileSentMessage(input).pipe(
    Effect.provide(transport.layer),
    Effect.map((result) => ({ result, requests: transport.requests })),
  );
};

const element = (envelope: string | undefined, name: string) =>
  envelope?.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];

describe("reconcileSentMessage", () => {
  it.effect("Found: exactly one record matches recipient, annotation, ref number and ident", () =>
    Effect.gen(function* () {
      const { result } = yield* reconcile(
        sent,
        sentList([
          { ...matching, dmID: "99", dbIDRecipient: "other12" },
          { ...matching, dmID: "98", dmAnnotation: "Faktura 18" },
          { ...matching, dmID: "97", dmSenderRefNumber: "REF-18" },
          { ...matching, dmID: "96", dmSenderIdent: "SI-1" },
          matching,
        ]),
      );
      assert.deepStrictEqual(result, { _tag: "Found", dmID: "100" });
    }),
  );

  it.effect("NotFound: nothing in the window matches", () =>
    Effect.gen(function* () {
      const { result } = yield* reconcile(sent, sentList([{ ...matching, dmAnnotation: "Jiná" }]));
      assert.strictEqual(result._tag, "NotFound");
      const empty = yield* reconcile(sent, sentList([]));
      assert.strictEqual(empty.result._tag, "NotFound");
    }),
  );

  it.effect("Ambiguous: several records match", () =>
    Effect.gen(function* () {
      const { result } = yield* reconcile(sent, sentList([matching, { ...matching, dmID: "101" }]));
      assert.deepStrictEqual(result, { _tag: "Ambiguous", dmIDs: ["100", "101"] });
    }),
  );

  it.effect("queries all states over submittedAt ± 2 minutes by default", () =>
    Effect.gen(function* () {
      const { requests } = yield* reconcile(sent, sentList([]));
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.operation, "GetListOfSentMessages");
      const envelope = requests[0]?.envelope;
      assert.strictEqual(element(envelope, "dmFromTime"), "2026-11-16T11:58:00.000Z");
      assert.strictEqual(element(envelope, "dmToTime"), "2026-11-16T12:02:00.000Z");
      assert.strictEqual(element(envelope, "dmStatusFilter"), "-1");
      assert.strictEqual(element(envelope, "dmOffset"), "1");
    }),
  );

  it.effect("uses the configured slack", () =>
    Effect.gen(function* () {
      const { requests } = yield* reconcile({ ...sent, slack: Duration.seconds(30) }, sentList([]));
      assert.strictEqual(element(requests[0]?.envelope, "dmFromTime"), "2026-11-16T11:59:30.000Z");
      assert.strictEqual(element(requests[0]?.envelope, "dmToTime"), "2026-11-16T12:00:30.000Z");
    }),
  );

  it.effect("pages while the window returns full pages", () =>
    Effect.gen(function* () {
      const { result, requests } = yield* reconcile({ ...sent, pageSize: 2 }, [
        sentList([{ dmID: "1" }, { dmID: "2" }], 1),
        sentList([{ dmID: "3" }, matching], 3),
        sentList([], 5),
      ]);
      assert.deepStrictEqual(
        requests.map((request) => [element(request.envelope, "dmOffset"), element(request.envelope, "dmLimit")]),
        [
          ["1", "2"],
          ["3", "2"],
          ["5", "2"],
        ],
      );
      assert.deepStrictEqual(result, { _tag: "Found", dmID: "100" });
    }),
  );

  it.effect("stops after a partial page", () =>
    Effect.gen(function* () {
      const { requests } = yield* reconcile({ ...sent, pageSize: 2 }, [sentList([matching], 1), sentList([], 2)]);
      assert.strictEqual(requests.length, 1);
    }),
  );

  it.effect("matches the attachment size in kilobytes when an expected byte count is given", () =>
    Effect.gen(function* () {
      const rows = [
        { ...matching, dmID: "100", dmAttachmentSize: 153 },
        { ...matching, dmID: "101", dmAttachmentSize: 2 },
      ];
      const big = yield* reconcile({ ...sent, expectedAttachmentBytes: 156_000 }, sentList(rows));
      assert.deepStrictEqual(big.result, { _tag: "Found", dmID: "100" });
      const small = yield* reconcile({ ...sent, expectedAttachmentBytes: 2_048 }, sentList(rows));
      assert.deepStrictEqual(small.result, { _tag: "Found", dmID: "101" });
      const none = yield* reconcile({ ...sent, expectedAttachmentBytes: 50_000 }, sentList(rows));
      assert.strictEqual(none.result._tag, "NotFound");
      const ignored = yield* reconcile(sent, sentList(rows));
      assert.strictEqual(ignored.result._tag, "Ambiguous");
    }),
  );

  it.effect("propagates list failures instead of reporting NotFound", () =>
    Effect.gen(function* () {
      const status = yield* reconcile(sent, ok(soapResponse("GetListOfSentMessages", dmStatus("3008")))).pipe(
        Effect.flip,
      );
      assert.strictEqual(status._tag, "IsdsStatusError");
      const timeout = yield* reconcile(sent, () =>
        Effect.fail(
          new IsdsTimeoutError({
            service: "info",
            operation: "GetListOfSentMessages",
            timeoutMillis: 1000,
            requestSent: true,
          }),
        ),
      ).pipe(Effect.flip);
      assert.strictEqual(timeout._tag, "IsdsTimeoutError");
    }),
  );

  it.effect("rejects invalid input before sending", () =>
    Effect.gen(function* () {
      for (const input of [
        { ...sent, dbIDRecipient: "short" },
        { ...sent, slack: Duration.seconds(-1) },
        { ...sent, pageSize: 0 },
        { ...sent, expectedAttachmentBytes: -1 },
      ]) {
        const transport = fakeTransport(sentList([]));
        const error = yield* reconcileSentMessage(input).pipe(Effect.provide(transport.layer), Effect.flip);
        assert.strictEqual(error._tag, "IsdsInvalidRequest");
        assert.strictEqual(transport.requests.length, 0);
      }
    }),
  );
});

describe("attachmentSizeMatches", () => {
  it("accepts the Base64 or binary size in either kilobyte, rejects clear mismatches", () => {
    assert.isTrue(attachmentSizeMatches(156, 117_000));
    assert.isTrue(attachmentSizeMatches(153, 117_000));
    assert.isTrue(attachmentSizeMatches(204, 153_000));
    assert.isFalse(attachmentSizeMatches(300, 117_000));
    assert.isTrue(attachmentSizeMatches(153, 153 * 1024));
    assert.isTrue(attachmentSizeMatches(157, 157 * 1000));
    assert.isTrue(attachmentSizeMatches(0, 300));
    assert.isTrue(attachmentSizeMatches(1, 300));
    assert.isTrue(attachmentSizeMatches(undefined, 10));
    assert.isFalse(attachmentSizeMatches(153, 50_000));
    assert.isFalse(attachmentSizeMatches(2, 153 * 1024));
  });
});
