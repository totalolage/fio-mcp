import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { IsdsTimeoutError } from "../../src/isds/errors.js";
import {
  attachmentSizeMatches,
  normalizeText,
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
  readonly dmMessageStatus?: number;
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
  `<dmMessageStatus>${row.dmMessageStatus ?? 2}</dmMessageStatus>` +
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
      assert.deepStrictEqual(result, { _tag: "Found", dmID: "100", dmMessageStatus: 2 });
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

  it.effect("Found carries the listed state: the message exists, delivered or not", () =>
    Effect.gen(function* () {
      for (const dmMessageStatus of [1, 3, 6] as const) {
        const { result } = yield* reconcile(sent, sentList([{ ...matching, dmMessageStatus }]));
        assert.deepStrictEqual(result, { _tag: "Found", dmID: "100", dmMessageStatus });
      }
    }),
  );

  it.effect("Ambiguous: several records match, each with its state, in list order", () =>
    Effect.gen(function* () {
      const { result } = yield* reconcile(sent, sentList([matching, { ...matching, dmID: "101", dmMessageStatus: 6 }]));
      assert.deepStrictEqual(result, {
        _tag: "Ambiguous",
        matches: [
          { dmID: "100", dmMessageStatus: 2 },
          { dmID: "101", dmMessageStatus: 6 },
        ],
      });
    }),
  );

  it.effect("compares texts after NFC, trimming and collapsing whitespace", () =>
    Effect.gen(function* () {
      const accented: ReconcileSentMessageInput = { ...sent, dmAnnotation: "Faktura č. 17".normalize("NFC") };
      const nfd = yield* reconcile(accented, sentList([{ ...matching, dmAnnotation: "Faktura č. 17".normalize("NFD") }]));
      assert.deepStrictEqual(nfd.result, { _tag: "Found", dmID: "100", dmMessageStatus: 2 });
      const spaced = yield* reconcile(
        { ...sent, dmSenderRefNumber: " REF-17 " },
        sentList([{ ...matching, dmAnnotation: "  Faktura \t\n  17 " }]),
      );
      assert.deepStrictEqual(spaced.result, { _tag: "Found", dmID: "100", dmMessageStatus: 2 });
      const blank = yield* reconcile({ ...sent, dmSenderIdent: "  " }, sentList([matching]));
      assert.strictEqual(blank.result._tag, "Found");
      const different = yield* reconcile(
        accented,
        sentList([
          { ...matching, dmAnnotation: "Faktura c. 17" },
          { ...matching, dmID: "101", dmAnnotation: "Faktura č.17" },
        ]),
      );
      assert.strictEqual(different.result._tag, "NotFound");
    }),
  );

  it.effect("matches the text ISDS made of the sent one by its documented character substitution", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [sent: string, listed: string]> = [
        ["Faktura\u00A017", "Faktura 17"],
        ["Faktura\r\n17", "Faktura 17"],
        ["Fak\u00ADtura\u200B 17\u200E", "Faktura 17"],
        ["Faktura\u202F17", "Faktura 17"],
        ["Faktura\u202F17", "Faktura17"],
        ["Faktura\u008517", "Faktura17"],
        ["Faktura\u0085 17", "Faktura 17"],
      ];
      for (const [dmAnnotation, listed] of cases) {
        const { result } = yield* reconcile({ ...sent, dmAnnotation }, sentList([{ ...matching, dmAnnotation: listed }]));
        assert.strictEqual(result._tag, "Found", JSON.stringify([dmAnnotation, listed]));
      }
      const dropped = yield* reconcile(
        { ...sent, dmAnnotation: "Fak\u00ADtura 17" },
        sentList([{ ...matching, dmAnnotation: "Fak tura 17" }]),
      );
      assert.strictEqual(dropped.result._tag, "NotFound");
    }),
  );

  it.effect("keeps the first sighting of a message listed on two pages", () =>
    Effect.gen(function* () {
      const { result } = yield* reconcile({ ...sent, pageSize: 2 }, [
        sentList([{ dmID: "1" }, matching], 1),
        sentList([{ ...matching, dmMessageStatus: 4 }], 3),
      ]);
      assert.deepStrictEqual(result, { _tag: "Found", dmID: "100", dmMessageStatus: 2 });
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

  it.effect("extends the window to the current time plus slack when submittedAt is in the past", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-16T12:30:00Z"));
      const { requests } = yield* reconcile(sent, sentList([]));
      assert.strictEqual(element(requests[0]?.envelope, "dmFromTime"), "2026-11-16T11:58:00.000Z");
      assert.strictEqual(element(requests[0]?.envelope, "dmToTime"), "2026-11-16T12:32:00.000Z");
      const narrow = yield* reconcile({ ...sent, slack: Duration.seconds(30) }, sentList([]));
      assert.strictEqual(element(narrow.requests[0]?.envelope, "dmFromTime"), "2026-11-16T11:59:30.000Z");
      assert.strictEqual(element(narrow.requests[0]?.envelope, "dmToTime"), "2026-11-16T12:30:30.000Z");
    }),
  );

  it.effect("ends the window at submittedAt plus slack when submittedAt is ahead of the current time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-16T11:00:00Z"));
      const { requests } = yield* reconcile({ ...sent, slack: Duration.seconds(30) }, sentList([]));
      assert.strictEqual(element(requests[0]?.envelope, "dmFromTime"), "2026-11-16T11:59:30.000Z");
      assert.strictEqual(element(requests[0]?.envelope, "dmToTime"), "2026-11-16T12:00:30.000Z");
    }),
  );

  it.effect("rejects a slack that puts the window outside xs:dateTime before sending", () =>
    Effect.gen(function* () {
      for (const input of [
        { ...sent, slack: Duration.infinity },
        { ...sent, slack: Duration.millis(1e16) },
        { ...sent, slack: Duration.days(3_000_000) },
        { ...sent, submittedAt: DateTime.makeUnsafe("9999-12-31T23:59:00Z") },
        { ...sent, submittedAt: DateTime.makeUnsafe("0001-01-01T00:01:00Z") },
      ]) {
        const transport = fakeTransport(sentList([]));
        const error = yield* reconcileSentMessage(input).pipe(Effect.provide(transport.layer), Effect.flip);
        assert.strictEqual(error._tag, "IsdsInvalidRequest");
        assert.include(error._tag === "IsdsInvalidRequest" ? error.detail : "", "xs:dateTime");
        assert.strictEqual(transport.requests.length, 0);
      }
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
      assert.deepStrictEqual(result, { _tag: "Found", dmID: "100", dmMessageStatus: 2 });
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
      assert.deepStrictEqual(big.result, { _tag: "Found", dmID: "100", dmMessageStatus: 2 });
      const small = yield* reconcile({ ...sent, expectedAttachmentBytes: 2_048 }, sentList(rows));
      assert.deepStrictEqual(small.result, { _tag: "Found", dmID: "101", dmMessageStatus: 2 });
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

describe("normalizeText", () => {
  it("composes to NFC, trims and collapses whitespace runs, keeps everything else", () => {
    assert.strictEqual(normalizeText("c\u030C"), "\u010D");
    assert.strictEqual(normalizeText(" \t a\u00A0\u00A0 b \r\n c  "), "a b c");
    assert.strictEqual(normalizeText("Ref/17-A"), "Ref/17-A");
    assert.strictEqual(normalizeText("a\u200Db\u2061c\u00AD"), "abc");
    assert.strictEqual(normalizeText("a\u2028b\u2029c\u202Fd\u0085e"), "a b c de");
    assert.notStrictEqual(normalizeText("REF-17"), normalizeText("ref-17"));
  });
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
