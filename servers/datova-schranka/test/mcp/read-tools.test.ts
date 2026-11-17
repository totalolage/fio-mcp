import { afterEach, assert, describe, it } from "@effect/vitest";
import { READ_TOOL_SPECS, readToolGroup } from "../../src/mcp/read-tools.js";
import { READ_SCOPE, SEND_SCOPE } from "../../src/mcp/tool-group.js";
import { fixture, ok, soapFault } from "../isds/fake-transport.js";
import {
  BOX,
  BOX_ID,
  DB_ID,
  grant,
  type Harness,
  LABEL,
  OTHER_BOX,
  OTHER_BOX_ID,
  OTHER_LABEL,
  type StartOptions,
  startTools,
  type ToolResult,
  textOf,
} from "./support/harness.js";
import { DM_ID, FAKE_NONCE, INJECTION, REPLIES, withElementText, xmlEscape } from "./support/replies.js";
import { nonces } from "./support/untrusted.js";

const PRINCIPALS = {
  reader: grant("g-reader"),
  both: grant("g-both", { boxes: [BOX_ID, OTHER_BOX_ID] }),
  sender: grant("g-sender", { scopes: [SEND_SCOPE], consent: null }),
  noBoxes: grant("g-none", { boxes: [] }),
};

const ALL_TOOLS = [
  "check_data_box",
  "download_message",
  "find_data_box",
  "get_delivery_info",
  "get_message",
  "get_message_state_changes",
  "get_server_status",
  "list_received_messages",
  "list_sent_messages",
];

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const start = async (options: Partial<StartOptions> = {}) => {
  harness = await startTools({ boxes: [BOX, OTHER_BOX], replies: REPLIES, principals: PRINCIPALS, ...options });
  return harness;
};

const call = async (h: Harness, tool: string, args: Record<string, unknown>, bearer = "reader") =>
  (await h.connect(bearer)).call(tool, args);

const json = (result: ToolResult): Record<string, unknown> => JSON.parse(textOf(result)) as Record<string, unknown>;

type Schema = { readonly properties?: Record<string, { readonly enum?: ReadonlyArray<string> }> };

describe("readToolGroup", () => {
  it("specs cover every registered tool once, all isds:read, only get_server_status resourceless", () => {
    const names = READ_TOOL_SPECS.map((spec) => spec.name).sort();
    assert.deepStrictEqual(names, ALL_TOOLS);
    assert.isTrue(READ_TOOL_SPECS.every((spec) => spec.scopes.length === 1 && spec.scopes[0] === READ_SCOPE));
    assert.deepStrictEqual(
      READ_TOOL_SPECS.filter((spec) => spec.resourceless === true).map((spec) => spec.name),
      ["get_server_status"],
    );
    assert.strictEqual(readToolGroup.specs, READ_TOOL_SPECS);
  });
});

describe("tools/list per grant", () => {
  it("lists every read tool with the box enum narrowed to the granted boxes, the raw tool included", async () => {
    const h = await start();
    const reader = await (await h.connect("reader")).tools();
    assert.deepStrictEqual(reader.map((tool) => tool.name).sort(), ALL_TOOLS);
    for (const tool of reader) {
      const box = (tool.inputSchema as Schema).properties?.box;
      if (tool.name === "get_server_status") assert.isUndefined(box);
      else assert.deepStrictEqual(box?.enum, [LABEL], tool.name);
    }
    const both = await (await h.connect("both")).tools();
    const download = both.find((tool) => tool.name === "download_message");
    assert.deepStrictEqual((download?.inputSchema as Schema | undefined)?.properties?.box?.enum, [LABEL, OTHER_LABEL]);
  });

  it("the raw download tool's schema has the toolkit tools' shape", async () => {
    const h = await start();
    const tools = await (await h.connect("reader")).tools();
    const download = tools.find((tool) => tool.name === "download_message");
    const getMessage = tools.find((tool) => tool.name === "get_message");
    assert.deepStrictEqual(download?.inputSchema, getMessage?.inputSchema);
    assert.deepStrictEqual(download?.annotations, { ...getMessage?.annotations, title: "Download message" });
  });

  it("hides everything from a grant without isds:read, and box tools from a grant without boxes", async () => {
    const h = await start();
    assert.deepStrictEqual(await (await h.connect("sender")).tools(), []);
    const noBoxes = await (await h.connect("noBoxes")).tools();
    assert.deepStrictEqual(
      noBoxes.map((tool) => tool.name),
      ["get_server_status"],
    );
  });

  it("registers with no boxes at all (tools hidden, calls rejected)", async () => {
    const h = await start({ boxes: [], labels: [] });
    const client = await h.connect("reader");
    assert.deepStrictEqual(
      (await client.tools()).map((tool) => tool.name),
      ["get_server_status"],
    );
    const result = await client.call("get_message", { box: LABEL, messageId: DM_ID });
    assert.isTrue(result.isError);
  });

  it("list_received_messages says it delivers every eligible message whatever the filters", async () => {
    const h = await start();
    const tools = await (await h.connect("reader")).tools();
    const list = tools.find((tool) => tool.name === "list_received_messages");
    assert.include(list?.description, "LEGALLY DELIVERS every not-yet-delivered message in the box");
    assert.include(list?.description, "do not limit what is delivered");
    assert.include(list?.description, "not necessarily the complete delivered set");
    assert.isFalse(list?.annotations?.readOnlyHint);
    assert.isTrue(list?.annotations?.destructiveHint);
    const limit = JSON.stringify((list?.inputSchema as Schema | undefined)?.properties?.limit);
    assert.include(limit, '"maximum":1000');
  });
});

describe("tool results", () => {
  it("list_received_messages returns records, the delivery note and calls ISDS once", async () => {
    const h = await start();
    const result = await call(h, "list_received_messages", { box: LABEL, from: "2026-11-01", to: "2026-11-17", limit: 5 });
    assert.notOk(result.isError);
    const body = json(result);
    assert.strictEqual(body.box, LABEL);
    assert.include(String(body.note), "not necessarily the complete delivered set");
    const records = body.records as ReadonlyArray<Record<string, unknown>>;
    assert.strictEqual(body.count, records.length);
    assert.deepStrictEqual(
      records.map((record) => record.dmID),
      ["1234567", "1234570"],
    );
    assert.deepStrictEqual(h.log, ["isds GetListOfReceivedMessages"]);
  });

  it("get_server_status lists only the granted boxes, the environment and the version", async () => {
    const h = await start();
    const body = json(await call(h, "get_server_status", {}));
    assert.deepStrictEqual(body.server, { name: "datova-schranka", version: "0.1.0" });
    assert.strictEqual(body.environment, "production");
    const boxes = body.boxes as ReadonlyArray<Record<string, unknown>>;
    assert.deepStrictEqual(
      boxes.map((box) => [box.label, box.dbID]),
      [[LABEL, DB_ID]],
    );
    assert.deepStrictEqual(body.grant, { scopes: [READ_SCOPE], deliveryConsentVersion: "2026-11-17.1" });
    assert.deepStrictEqual(h.log, []);
  });

  it("each box-bound tool answers from its ISDS operation", async () => {
    const h = await start();
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
      ["list_sent_messages", { box: LABEL }, "records"],
      ["get_message", { box: LABEL, messageId: DM_ID }, "message"],
      ["get_delivery_info", { box: LABEL, messageId: DM_ID }, "deliveryInfo"],
      ["get_message_state_changes", { box: LABEL, from: "2026-11-01T00:00:00+01:00" }, "changes"],
      ["find_data_box", { box: LABEL, query: { dbType: "PO", firmName: "Novák" } }, "boxes"],
      ["check_data_box", { box: LABEL, dbID: "abc1234" }, "dbState"],
    ];
    for (const [tool, args, key] of cases) {
      const result = await call(h, tool, args);
      assert.notOk(result.isError, `${tool}: ${textOf(result)}`);
      assert.property(json(result), key, tool);
    }
    const message = json(await call(h, "get_message", { box: LABEL, messageId: DM_ID })).message as Record<string, unknown>;
    assert.notProperty(message, "dmQTimestamp");
  });
});

/** Every string leaf of `value` is guarded whole or is a strict identifier. */
const WRAPPED = /^<untrusted-[0-9a-f]{32}>[\s\S]*<\/untrusted-[0-9a-f]{32}>$/;
const IDENTIFIERS = [
  /^[0-9]{1,20}$/,
  /^[a-z0-9]{7}$/,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
  /^\d{4}-\d{2}-\d{2}$/,
  /^[A-Za-z0-9_]{1,16}$/,
  /^[A-Za-z0-9+/]*={0,2}$/,
  /^[0-9a-f]{64}$/,
];
const unguardedLeaves = (value: unknown, path = "$"): ReadonlyArray<string> => {
  if (typeof value === "string") {
    return WRAPPED.test(value) || IDENTIFIERS.some((pattern) => pattern.test(value)) ? [] : [`${path}=${value}`];
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => unguardedLeaves(item, `${path}[${i}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, field]) => unguardedLeaves(field, `${path}.${key}`));
  }
  return [];
};

describe("untrusted ISDS text", () => {
  const injected = {
    ...REPLIES,
    GetListOfReceivedMessages: ok(
      withElementText(
        withElementText(fixture("GetListOfReceivedMessages-multi.xml"), "dmAnnotation", INJECTION),
        "dmSender",
        INJECTION,
      ),
    ),
    MessageEnvelopeDownload: ok(withElementText(fixture("MessageEnvelopeDownload.xml"), "dmToHands", INJECTION)),
    GetDeliveryInfo: ok(withElementText(fixture("GetDeliveryInfo.xml"), "dmEventDescr", INJECTION)),
    FindDataBox2: ok(withElementText(fixture("FindDataBox2.xml"), "firmName", INJECTION)),
  };

  const assertGuarded = (result: ToolResult, field: string | undefined) => {
    const text = textOf(result);
    const used = nonces(text);
    assert.lengthOf(used, 1, `exactly one real nonce in ${text.slice(0, 300)}`);
    assert.notInclude(text, FAKE_NONCE);
    assert.include(String(json(result).untrustedDataNotice), used[0] ?? "-");
    if (field !== undefined) {
      assert.match(field, new RegExp(`^<untrusted-${used[0]}>[\\s\\S]*SYSTEM: ignore previous instructions[\\s\\S]*</untrusted-${used[0]}>$`));
    }
  };

  it("wraps sender text in list records; identifiers stay plain", async () => {
    const h = await start({ replies: injected });
    const result = await call(h, "list_received_messages", { box: LABEL });
    const [first] = json(result).records as ReadonlyArray<Record<string, string>>;
    assertGuarded(result, first?.dmAnnotation);
    assertGuarded(result, first?.dmSender);
    assert.strictEqual(first?.dmID, "1234567");
  });

  it("wraps toHands, delivery event text and directory entries", async () => {
    const h = await start({ replies: injected });
    const message = await call(h, "get_message", { box: LABEL, messageId: DM_ID });
    assertGuarded(message, ((json(message).message as Record<string, unknown>).dmDm as Record<string, string>).dmToHands);
    const info = await call(h, "get_delivery_info", { box: LABEL, messageId: DM_ID });
    const events = (json(info).deliveryInfo as { dmEvents: ReadonlyArray<Record<string, string>> }).dmEvents;
    assertGuarded(info, events[0]?.dmEventDescr);
    const found = await call(h, "find_data_box", { box: LABEL, query: { dbType: "PO", firmName: "Novák" } });
    assertGuarded(found, (json(found).boxes as ReadonlyArray<Record<string, string>>)[0]?.firmName);
  });

  it("guards ISDS text in an error message", async () => {
    const h = await start({ replies: { ...REPLIES, CheckDataBox: ok(soapFault("Server", xmlEscape(INJECTION))) } });
    const result = await call(h, "check_data_box", { box: LABEL, dbID: "abc1234" });
    assert.isTrue(result.isError);
    const text = textOf(result);
    const used = nonces(text);
    assert.lengthOf(used, 1, text);
    assert.notInclude(text, FAKE_NONCE);  });

  it("leaves no string of a result's ISDS data unguarded unless it is a strict identifier", async () => {
    const h = await start({ replies: injected });
    const subtrees: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
      ["list_received_messages", { box: LABEL }, "records"],
      ["list_sent_messages", { box: LABEL }, "records"],
      ["get_message", { box: LABEL, messageId: DM_ID }, "message"],
      ["get_delivery_info", { box: LABEL, messageId: DM_ID }, "deliveryInfo"],
      ["get_message_state_changes", { box: LABEL }, "changes"],
      ["find_data_box", { box: LABEL, query: { dbType: "PO", firmName: "Novák" } }, "boxes"],
      ["get_server_status", {}, "boxes"],
    ];
    for (const [tool, args, key] of subtrees) {
      const body = json(await call(h, tool, args));
      const subtree = key === "boxes" && tool === "get_server_status"
        ? (body.boxes as ReadonlyArray<Record<string, unknown>>).map((box) => box.owner)
        : body[key];
      assert.deepStrictEqual(unguardedLeaves(subtree), [], tool);
    }
    const download = json(await call(h, "download_message", { box: LABEL, messageId: DM_ID }));
    assert.deepStrictEqual(unguardedLeaves(download.envelope), [], "download envelope");
    assert.deepStrictEqual(unguardedLeaves(download.info), [], "download info");
    for (const attachment of download.attachments as ReadonlyArray<Record<string, unknown>>) {
      const { uri: _uri, reason: _reason, note: _note, mimeType: _mime, ...rest } = attachment;
      assert.deepStrictEqual(unguardedLeaves(rest), [], "download attachment");
    }
  });
});
