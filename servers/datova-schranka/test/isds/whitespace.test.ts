import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { getDeliveryInfo } from "../../src/isds/message-downloads.js";
import { listReceivedMessagesAndDeliver, listSentMessages } from "../../src/isds/message-lists.js";
import { fakeTransport, fixture, ok } from "./fake-transport.js";

/**
 * Responses as a pretty-printer would send them: indentation between elements and inside empty
 * containers must not change what decodes, while text content keeps its own whitespace.
 */
const run = <A, E, R>(effect: Effect.Effect<A, E, R>, xml: string) =>
  effect.pipe(Effect.provide(fakeTransport(ok(xml)).layer));

describe("pretty-printed responses", () => {
  it.effect("an empty list container holding only whitespace decodes as []", () =>
    Effect.gen(function* () {
      const xml = fixture("GetListOfSentMessages-empty.xml").replace("<p:dmRecords/>", "<p:dmRecords>\n        \t\r\n      </p:dmRecords>");
      const result = yield* run(listSentMessages(), xml);
      assert.deepStrictEqual(result, []);
    }),
  );

  it.effect("a nil list container with whitespace inside decodes as []", () =>
    Effect.gen(function* () {
      const xml = fixture("GetListOfSentMessages-empty.xml").replace(
        "<p:dmRecords/>",
        `<p:dmRecords xsi:nil="true">\n      </p:dmRecords>`,
      );
      const result = yield* run(listSentMessages(), xml);
      assert.deepStrictEqual(result, []);
    }),
  );

  it.effect("indented records decode, and leading or trailing spaces in text survive", () =>
    Effect.gen(function* () {
      const xml = fixture("GetListOfReceivedMessages-multi.xml").replace(
        "<p:dmAnnotation>Výzva</p:dmAnnotation>",
        "<p:dmAnnotation>  Výzva\n </p:dmAnnotation>",
      );
      const result = yield* run(listReceivedMessagesAndDeliver(), xml);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0]?.dmAnnotation, "Faktura 2026/17 & příloha");
      assert.strictEqual(result[1]?.dmAnnotation, "  Výzva\n ");
    }),
  );

  it.effect("a download with an empty, indented events container decodes with no events", () =>
    Effect.gen(function* () {
      const original = fixture("GetDeliveryInfo.xml");
      const start = original.indexOf("<p:dmEvents>");
      const end = original.indexOf("</p:dmEvents>");
      const xml = `${original.slice(0, start)}<p:dmEvents>\n          \n        ${original.slice(end)}`;
      const result = yield* run(getDeliveryInfo({ dmID: "1234567" }), xml);
      assert.deepStrictEqual(result.dmEvents, []);
      assert.strictEqual(result.dmDm.dmAnnotation, "Výzva k doplnění");
    }),
  );
});
