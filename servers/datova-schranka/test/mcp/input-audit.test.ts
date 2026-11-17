import { afterEach, assert, describe, it } from "@effect/vitest";
import { Redactor } from "@mcps/core/redaction.js";
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { type AuditEntry, AuditLog } from "../../src/domain/audit-log.js";
import { BoxRegistry } from "../../src/domain/boxes.js";
import { boxParameter } from "../../src/mcp/box-param.js";
import { authorizedBoxCall, ToolError, toolError, toolOutput } from "../../src/mcp/call.js";
import { payloadIssues, registerAuditedToolkit } from "../../src/mcp/input-audit.js";
import { JsonObject } from "../../src/mcp/params.js";
import { SEND_SCOPE, type ToolGroup, type ToolSpec } from "../../src/mcp/tool-group.js";
import { BOX, BOX_ID, grant, type Harness, LABEL, startTools, textOf } from "./support/harness.js";
import { DM_ID, REPLIES } from "./support/replies.js";

/** A stand-in for another group (the send tools): its own toolkit, opted in through registerAuditedToolkit. */
const PING_SPEC: ToolSpec = { name: "ping_box", scopes: [SEND_SCOPE] };
let pinged = 0;
const pingGroup: ToolGroup<AuditLog | BoxRegistry | Redactor> = {
  specs: [PING_SPEC],
  register: (labels) => {
    const toolkit = Toolkit.make(
      Tool.make(PING_SPEC.name, {
        description: "Test tool of another group.",
        parameters: Schema.Struct({ box: boxParameter(labels), count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })) }),
        success: JsonObject,
        failure: ToolError,
        failureMode: "error",
      }).annotate(Tool.Strict, true),
    );
    return registerAuditedToolkit(toolkit).pipe(
      Effect.provide(
        toolkit.toLayer(
          Effect.gen(function* () {
            const audit = yield* AuditLog;
            const registry = yield* BoxRegistry;
            const redactor = yield* Redactor;
            return toolkit.of({
              ping_box: (input) =>
                toolOutput(
                  authorizedBoxCall(PING_SPEC, input, () => Effect.sync(() => ({ pinged: ++pinged }))).pipe(
                    Effect.mapError(toolError),
                  ),
                ).pipe(
                  Effect.provideService(AuditLog, audit),
                  Effect.provideService(BoxRegistry, registry),
                  Effect.provideService(Redactor, redactor),
                ),
            });
          }),
        ),
      ),
    );
  },
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const PRINCIPALS = { reader: grant("g-reader"), sender: grant("g-sender", { scopes: [SEND_SCOPE], consent: null }) };

const start = async () => {
  harness = await startTools({ boxes: [BOX], replies: REPLIES, principals: PRINCIPALS, groups: [pingGroup] });
  return harness;
};

const newRows = async (h: Harness, run: () => Promise<unknown>): Promise<ReadonlyArray<AuditEntry>> => {
  const before = new Set((await h.audit()).map((entry) => entry.id));
  await run();
  return (await h.audit()).filter((entry) => !before.has(entry.id));
};

describe("invalid tool input is audited once", () => {
  const cases: ReadonlyArray<{
    readonly bearer: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly issues: ReadonlyArray<{ readonly path: ReadonlyArray<string | number>; readonly kind: string }>;
  }> = [
    { bearer: "reader", tool: "get_message", args: { box: LABEL, messageId: "12a" }, issues: [{ path: ["messageId"], kind: "InvalidValue" }] },
    { bearer: "reader", tool: "get_message", args: { box: LABEL }, issues: [{ path: ["messageId"], kind: "MissingKey" }] },
    { bearer: "reader", tool: "list_received_messages", args: { box: "Nope", limit: 5000 }, issues: [
      { path: ["box"], kind: "AnyOf" },
      { path: ["limit"], kind: "InvalidValue" },
    ] },
    { bearer: "reader", tool: "download_message", args: { box: LABEL, messageId: DM_ID, "x y": 1 }, issues: [{ path: ["<key>"], kind: "UnexpectedKey" }] },
    { bearer: "reader", tool: "download_message", args: { box: 7, messageId: DM_ID }, issues: [{ path: ["box"], kind: "AnyOf" }] },
    { bearer: "sender", tool: "ping_box", args: { box: LABEL, count: 9 }, issues: [{ path: ["count"], kind: "InvalidValue" }] },
  ];

  for (const { bearer, tool, args, issues } of cases) {
    it(`${tool} ${JSON.stringify(args)}: one refused row with paths and kinds, no values, no service call`, async () => {
      const h = await start();
      const client = await h.connect(bearer);
      let result: Awaited<ReturnType<typeof client.call>> | undefined;
      const rows = await newRows(h, async () => {
        result = await client.call(tool, args);
      });
      assert.isTrue(result?.isError);
      assert.match(textOf(result ?? { content: [] }), new RegExp(`^Invalid parameters for tool '${tool}'`));
      assert.lengthOf(rows, 1);
      const [row] = rows;
      assert.deepStrictEqual(
        [row?.action, row?.outcome, row?.actorKind, row?.grantId, row?.clientId, row?.boxId],
        [tool, "refused", "tool", PRINCIPALS[bearer as keyof typeof PRINCIPALS].subject, `client-${PRINCIPALS[bearer as keyof typeof PRINCIPALS].subject}`, undefined],
      );
      const detail = row?.detail as { reason: string; issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; kind: string }> };
      assert.strictEqual(detail.reason, "invalid_input");
      for (const expected of issues) assert.deepInclude(detail.issues, expected);
      const stored = JSON.stringify(detail);
      for (const value of ["12a", "Nope", "5000", "x y", "9"]) assert.notInclude(stored, `"${value}"`);
      assert.deepStrictEqual(h.log, []);
      assert.strictEqual(pinged, 0);
    });
  }

  it("a call without an OAuth caller is audited without grant", async () => {
    const h = await start();
    const client = await h.connect("nobody");
    const rows = await newRows(h, () => client.call("get_message", { box: LABEL, messageId: "x" }));
    assert.deepStrictEqual(
      rows.map((row) => [row.action, row.outcome, row.grantId]),
      [["get_message", "refused", undefined]],
    );
  });

  it("valid calls write no tool-layer row: only the service's, or the group's own", async () => {
    const h = await start();
    const reader = await h.connect("reader");
    const read = await newRows(h, () => reader.call("get_message", { box: LABEL, messageId: DM_ID }));
    assert.deepStrictEqual(
      read.map((row) => [row.action, row.outcome]),
      [["get_message", "ok"]],
    );
    const sender = await h.connect("sender");
    const ping = await newRows(h, () => sender.call("ping_box", { box: LABEL, count: 2 }));
    assert.deepStrictEqual(ping, []);
    assert.strictEqual(pinged, 1);
    pinged = 0;
    assert.notInclude(JSON.stringify(read), "invalid_input");
    assert.strictEqual(read[0]?.boxId, BOX_ID);
  });
});

describe("inputIssues", () => {
  it("keeps parameter names and replaces other keys", () => {
    const schema = Schema.Struct({ a: Schema.String, list: Schema.Array(Schema.Int) });
    const issues = payloadIssues(schema, { a: 1, list: [1, "x"], "<script>": true });
    assert.deepInclude(issues, { path: ["a"], kind: "InvalidType" });
    assert.deepInclude(issues, { path: ["list", 1], kind: "InvalidType" });
    assert.deepInclude(issues, { path: ["<key>"], kind: "UnexpectedKey" });
    assert.deepStrictEqual(payloadIssues(schema, { a: "ok", list: [] }), []);
  });

  it("caps the number of issues", () => {
    const schema = Schema.Struct({ a: Schema.optional(Schema.String) });
    const payload = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    assert.lengthOf(payloadIssues(schema, payload), 20);
  });
});
