import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import {
  getMessageStateChanges,
  type ListMessagesInput,
  listReceivedMessagesAndDeliver,
  listSentMessages,
} from "../../src/isds/message-lists.js";
import type { IsdsTransport } from "../../src/isds/transport.js";
import { dmStatus, fakeTransport, fixture, ok, soapResponse } from "./fake-transport.js";

const nil = (name: string) => `<${name} xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>`;

/** The request body element of a recorded envelope. */
const bodyOf = (envelope: string | undefined): string =>
  envelope?.match(/<soap:Body>(.*)<\/soap:Body>/s)?.[1] ?? `no body in ${envelope}`;

const run = <A, E>(
  effect: Effect.Effect<A, E, IsdsTransport>,
  reply: Parameters<typeof fakeTransport>[0],
) => {
  const transport = fakeTransport(reply);
  return effect.pipe(
    Effect.provide(transport.layer),
    Effect.map((result) => ({ result, requests: transport.requests })),
  );
};

const emptySent = ok(fixture("GetListOfSentMessages-empty.xml"));
const millis = (value: DateTime.Utc | undefined) => (value === undefined ? undefined : DateTime.toEpochMillis(value));

describe("list requests", () => {
  it.effect("GetListOfReceivedMessages: elements in XSD order, nil org unit, mask, offset and limit", () =>
    Effect.gen(function* () {
      const input: ListMessagesInput = {
        from: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
        to: DateTime.makeUnsafe("2026-11-16T12:30:00Z"),
        states: [5, 6],
        offset: 11,
        limit: 10,
      };
      const { requests } = yield* run(
        listReceivedMessagesAndDeliver(input),
        ok(fixture("GetListOfReceivedMessages-single.xml")),
      );
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.service, "info");
      assert.strictEqual(requests[0]?.operation, "GetListOfReceivedMessages");
      assert.strictEqual(
        bodyOf(requests[0]?.envelope),
        `<GetListOfReceivedMessages xmlns="http://isds.czechpoint.cz/v20">` +
          `<dmFromTime>2026-11-01T00:00:00.000Z</dmFromTime><dmToTime>2026-11-16T12:30:00.000Z</dmToTime>` +
          `${nil("dmRecipientOrgUnitNum")}<dmStatusFilter>96</dmStatusFilter>` +
          `<dmOffset>11</dmOffset><dmLimit>10</dmLimit></GetListOfReceivedMessages>`,
      );
    }),
  );

  it.effect("GetListOfSentMessages: absent inputs are nil, states default to all (-1)", () =>
    Effect.gen(function* () {
      const { requests } = yield* run(listSentMessages(), emptySent);
      assert.strictEqual(requests[0]?.operation, "GetListOfSentMessages");
      assert.strictEqual(
        bodyOf(requests[0]?.envelope),
        `<GetListOfSentMessages xmlns="http://isds.czechpoint.cz/v20">` +
          `${nil("dmFromTime")}${nil("dmToTime")}${nil("dmSenderOrgUnitNum")}` +
          `<dmStatusFilter>-1</dmStatusFilter>${nil("dmOffset")}${nil("dmLimit")}</GetListOfSentMessages>`,
      );
    }),
  );

  it.effect("accepts a Set of states", () =>
    Effect.gen(function* () {
      const { requests } = yield* run(listSentMessages({ states: new Set([1, 2, 3] as const) }), emptySent);
      assert.include(bodyOf(requests[0]?.envelope), "<dmStatusFilter>14</dmStatusFilter>");
    }),
  );

  it.effect("rejects invalid input before sending", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<ListMessagesInput> = [
        { offset: 0 },
        { limit: 1.5 },
        { limit: 0 },
        { from: DateTime.makeUnsafe("2026-11-02T00:00:00Z"), to: DateTime.makeUnsafe("2026-11-01T00:00:00Z") },
      ];
      for (const input of cases) {
        const transport = fakeTransport(emptySent);
        const error = yield* listSentMessages(input).pipe(Effect.provide(transport.layer), Effect.flip);
        assert.strictEqual(error._tag, "IsdsInvalidRequest");
        assert.strictEqual(transport.requests.length, 0);
      }
    }),
  );
});

describe("list responses", () => {
  it.effect("decodes a multi-record list into records", () =>
    Effect.gen(function* () {
      const { result } = yield* run(listReceivedMessagesAndDeliver(), ok(fixture("GetListOfReceivedMessages-multi.xml")));
      assert.strictEqual(result.length, 2);
      const [first, second] = result;
      assert.strictEqual(first?.dmOrdinal, 1);
      assert.strictEqual(first?.dmID, "1234567");
      assert.strictEqual(first?.dbIDSender, "abc1234");
      assert.strictEqual(first?.dmSenderType, 10);
      assert.strictEqual(first?.dbIDRecipient, "xyz9876");
      assert.strictEqual(first?.dmAnnotation, "Faktura 2026/17 & příloha");
      assert.strictEqual(first?.dmSenderRefNumber, "REF-17");
      assert.strictEqual(first?.dmSenderIdent, "SI-1");
      assert.strictEqual(first?.dmLegalTitleLaw, 300);
      assert.strictEqual(first?.dmPersonalDelivery, false);
      assert.strictEqual(first?.dmAllowSubstDelivery, true);
      assert.strictEqual(first?.dmAmbiguousRecipient, undefined);
      assert.strictEqual(first?.dmSenderOrgUnitNum, undefined);
      assert.strictEqual(first?.dmMessageStatus, 6);
      assert.strictEqual(first?.dmAttachmentSize, 153);
      assert.strictEqual(millis(first?.dmDeliveryTime), Date.UTC(2026, 10, 2, 8, 15, 30, 123));
      assert.strictEqual(millis(first?.dmAcceptanceTime), Date.UTC(2026, 10, 2, 9, 0, 0));
      assert.strictEqual(first?.dmType, "K");
      assert.strictEqual(first?.dmVODZ, false);
      assert.strictEqual(first?.specMessFlag, 1);

      assert.strictEqual(second?.dmOrdinal, 2);
      assert.strictEqual(second?.dmMessageStatus, 4);
      assert.strictEqual(second?.dmAmbiguousRecipient, false);
      assert.strictEqual(second?.dmSenderRefNumber, undefined);
      assert.strictEqual(second?.dmAcceptanceTime, undefined);
      assert.strictEqual(second?.dmType, undefined);
      assert.strictEqual(second?.dmVODZ, undefined);
      assert.strictEqual(second?.specMessFlag, undefined);
      assert.isFalse(second !== undefined && "dmFutureElement" in second);
    }),
  );

  it.effect("decodes a single record as a one-element array", () =>
    Effect.gen(function* () {
      const { result } = yield* run(listSentMessages(), ok(fixture("GetListOfReceivedMessages-single.xml").replaceAll("GetListOfReceivedMessages", "GetListOfSentMessages")));
      assert.isTrue(Array.isArray(result));
      assert.deepStrictEqual(
        result.map((record) => record.dmID),
        ["1234567"],
      );
    }),
  );

  it.effect("decodes an empty, nil or absent dmRecords as []", () =>
    Effect.gen(function* () {
      for (const reply of [
        emptySent,
        ok(fixture("GetListOfSentMessages-nil.xml")),
        ok(soapResponse("GetListOfSentMessages", dmStatus("0000"))),
      ]) {
        const { result } = yield* run(listSentMessages(), reply);
        assert.deepStrictEqual(result, []);
      }
    }),
  );

  it.effect("fails with a transient IsdsStatusError on dmStatusCode 3008", () =>
    Effect.gen(function* () {
      const error = yield* run(listSentMessages(), ok(soapResponse("GetListOfSentMessages", dmStatus("3008")))).pipe(
        Effect.flip,
      );
      assert.strictEqual(error._tag, "IsdsStatusError");
      if (error._tag === "IsdsStatusError") {
        assert.strictEqual(error.code, "3008");
        assert.strictEqual(error.classification, "Transient");
        assert.strictEqual(error.operation, "GetListOfSentMessages");
      }
    }),
  );

  it.effect("fails with IsdsInvalidResponse on malformed XML", () =>
    Effect.gen(function* () {
      const error = yield* run(listSentMessages(), ok("<SOAP-ENV:Envelope><unclosed>")).pipe(Effect.flip);
      assert.strictEqual(error._tag, "IsdsInvalidResponse");
    }),
  );

  it.effect("fails with IsdsInvalidResponse when a record doesn't match the schema", () =>
    Effect.gen(function* () {
      const badState = fixture("GetListOfReceivedMessages-single.xml").replace(
        "<p:dmMessageStatus>6</p:dmMessageStatus>",
        "<p:dmMessageStatus>11</p:dmMessageStatus>",
      );
      const noOrdinal = fixture("GetListOfReceivedMessages-single.xml").replace("<p:dmOrdinal>1</p:dmOrdinal>", "");
      const badTime = fixture("GetListOfReceivedMessages-single.xml").replace(
        "2026-11-02T09:15:30.123+01:00",
        "yesterday",
      );
      for (const xml of [badState, noOrdinal, badTime]) {
        const error = yield* run(listReceivedMessagesAndDeliver(), ok(xml)).pipe(Effect.flip);
        assert.strictEqual(error._tag, "IsdsInvalidResponse");
      }
    }),
  );
});

describe("GetMessageStateChanges", () => {
  it.effect("sends the window, nil when absent", () =>
    Effect.gen(function* () {
      const reply = ok(fixture("GetMessageStateChanges.xml"));
      const both = yield* run(
        getMessageStateChanges({
          from: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
          to: DateTime.makeUnsafe("2026-11-02T00:00:00Z"),
        }),
        reply,
      );
      assert.strictEqual(both.requests[0]?.service, "info");
      assert.strictEqual(
        bodyOf(both.requests[0]?.envelope),
        `<GetMessageStateChanges xmlns="http://isds.czechpoint.cz/v20">` +
          `<dmFromTime>2026-11-01T00:00:00.000Z</dmFromTime><dmToTime>2026-11-02T00:00:00.000Z</dmToTime>` +
          `</GetMessageStateChanges>`,
      );
      const none = yield* run(getMessageStateChanges(), reply);
      assert.strictEqual(
        bodyOf(none.requests[0]?.envelope),
        `<GetMessageStateChanges xmlns="http://isds.czechpoint.cz/v20">${nil("dmFromTime")}${nil("dmToTime")}</GetMessageStateChanges>`,
      );
    }),
  );

  it.effect("decodes state changes", () =>
    Effect.gen(function* () {
      const { result } = yield* run(getMessageStateChanges(), ok(fixture("GetMessageStateChanges.xml")));
      assert.deepStrictEqual(
        result.map((change) => [change.dmID, millis(change.dmEventTime), change.dmMessageStatus]),
        [
          ["1234567", Date.UTC(2026, 10, 2, 8, 15, 30, 123), 4],
          ["1234567", Date.UTC(2026, 10, 2, 9, 0, 0), 6],
        ],
      );
    }),
  );

  it.effect("decodes a single state change as a one-element array, and none as []", () =>
    Effect.gen(function* () {
      const single = yield* run(
        getMessageStateChanges(),
        ok(
          soapResponse(
            "GetMessageStateChanges",
            `<dmRecords><dmRecord><dmID>42</dmID><dmEventTime>2026-11-02T10:00:00Z</dmEventTime><dmMessageStatus>5</dmMessageStatus></dmRecord></dmRecords>${dmStatus("0000")}`,
          ),
        ),
      );
      assert.deepStrictEqual(
        single.result.map((change) => change.dmID),
        ["42"],
      );
      const empty = yield* run(getMessageStateChanges(), ok(soapResponse("GetMessageStateChanges", `<dmRecords/>${dmStatus("0000")}`)));
      assert.deepStrictEqual(empty.result, []);
    }),
  );
});
