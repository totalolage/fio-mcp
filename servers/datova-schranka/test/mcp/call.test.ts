import { afterEach, assert, describe, it } from "@effect/vitest";
import type { AuditEntry } from "../../src/domain/audit-log.js";
import { SEND_SCOPE } from "../../src/mcp/tool-group.js";
import { dmStatus, ok, soapResponse } from "../isds/fake-transport.js";
import {
  BOX,
  BOX_ID,
  grant,
  type Harness,
  LABEL,
  OTHER_BOX,
  OTHER_BOX_ID,
  OTHER_LABEL,
  type StartOptions,
  startTools,
  textOf,
} from "./support/harness.js";
import { DM_ID, REPLIES } from "./support/replies.js";

const PRINCIPALS = {
  reader: grant("g-reader"),
  both: grant("g-both", { boxes: [BOX_ID, OTHER_BOX_ID] }),
  sender: grant("g-sender", { scopes: [SEND_SCOPE] }),
  noConsent: grant("g-no-consent", { consent: null }),
  oldConsent: grant("g-old-consent", { consent: "2020-01-01.1" }),
  oddConsent: grant("g-odd-consent", { consent: " 2026-11-17.1" }),
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const start = async (options: Partial<StartOptions> = {}) => {
  harness = await startTools({ boxes: [BOX, OTHER_BOX], replies: REPLIES, principals: PRINCIPALS, ...options });
  return harness;
};

/** Calls `tool` as `bearer` and returns the result and the audit rows the call wrote. */
const callAudited = async (h: Harness, bearer: string, tool: string, args: Record<string, unknown>) => {
  const before = new Set((await h.audit()).map((entry) => entry.id));
  const client = await h.connect(bearer);
  const result = await client.call(tool, args);
  const rows = (await h.audit()).filter((entry) => !before.has(entry.id));
  return { result, rows };
};

const only = (rows: ReadonlyArray<AuditEntry>): AuditEntry => {
  assert.strictEqual(rows.length, 1, `expected exactly one audit row, got ${JSON.stringify(rows)}`);
  return rows[0] as AuditEntry;
};

const reasonOf = (entry: AuditEntry): unknown => (entry.detail as { readonly reason?: unknown } | null)?.reason;

describe("every read tool call is audited exactly once", () => {
  it("success: the service's row only", async () => {
    const h = await start();
    const { result, rows } = await callAudited(h, "reader", "get_message", { box: LABEL, messageId: DM_ID });
    assert.notOk(result.isError);
    const row = only(rows);
    assert.deepStrictEqual(
      [row.action, row.outcome, row.actorKind, row.grantId, row.clientId, row.boxId],
      ["get_message", "ok", "tool", "g-reader", "client-g-reader", BOX_ID],
    );
  });

  it("service error: the service's error row only", async () => {
    // No CheckDataBox reply: the fake ISDS answers an empty body (IsdsInvalidResponse).
    const { CheckDataBox: _unused, ...replies } = REPLIES;
    const h = await start({ replies });
    const { result, rows } = await callAudited(h, "reader", "check_data_box", { box: LABEL, dbID: "abc1234" });
    assert.isTrue(result.isError);
    const row = only(rows);
    assert.deepStrictEqual([row.action, row.outcome], ["check_data_box", "error"]);
  });

  it("not delivered yet (1222): one row and the list-first error", async () => {
    const h = await start({
      replies: { ...REPLIES, MessageDownload: ok(soapResponse("MessageDownload", dmStatus("1222"))) },
    });
    const { result, rows } = await callAudited(h, "reader", "download_message", { box: LABEL, messageId: DM_ID });
    assert.isTrue(result.isError);
    assert.include(textOf(result), "not delivered yet; call list_received_messages first");
    assert.lengthOf(result.content, 1);
    const row = only(rows);
    assert.strictEqual(row.action, "download_message");
    assert.notStrictEqual(row.outcome, "ok");
  });

  it("success of get_server_status (no service): its own row", async () => {
    const h = await start();
    const { result, rows } = await callAudited(h, "reader", "get_server_status", {});
    assert.notOk(result.isError);
    const row = only(rows);
    assert.deepStrictEqual([row.action, row.outcome, row.grantId], ["get_server_status", "ok", "g-reader"]);
  });

  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly bearer: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly reason: string;
    readonly text: string;
    readonly boxId?: string;
    readonly unload?: string;
  }> = [
    {
      name: "ungranted scope",
      bearer: "sender",
      tool: "get_message",
      args: { box: LABEL, messageId: DM_ID },
      reason: "missing_scope",
      text: "lacks the isds:read scope",
    },
    {
      name: "ungranted scope (resourceless tool)",
      bearer: "sender",
      tool: "get_server_status",
      args: {},
      reason: "missing_scope",
      text: "lacks the isds:read scope",
    },
    {
      name: "ungranted box",
      bearer: "reader",
      tool: "get_message",
      args: { box: OTHER_LABEL, messageId: DM_ID },
      reason: "box_not_granted",
      text: "does not cover a data box with that label",
      boxId: OTHER_BOX_ID,
    },
    {
      name: "ungranted box (raw download tool)",
      bearer: "reader",
      tool: "download_message",
      args: { box: OTHER_LABEL, messageId: DM_ID },
      reason: "box_not_granted",
      text: "does not cover a data box with that label",
      boxId: OTHER_BOX_ID,
    },
    {
      name: "missing consent",
      bearer: "noConsent",
      tool: "list_received_messages",
      args: { box: LABEL },
      reason: "no_delivery_consent",
      text: "no accepted delivery consent",
      boxId: BOX_ID,
    },
    {
      name: "consent of a version not accepted",
      bearer: "oldConsent",
      tool: "download_message",
      args: { box: LABEL, messageId: DM_ID },
      reason: "no_delivery_consent",
      text: "no accepted delivery consent",
      boxId: BOX_ID,
    },
    {
      name: "malformed consent version",
      bearer: "oddConsent",
      tool: "get_server_status",
      args: {},
      reason: "no_delivery_consent",
      text: "no accepted delivery consent",
    },
    {
      name: "unknown box (unloaded after registration)",
      bearer: "both",
      tool: "get_message",
      args: { box: OTHER_LABEL, messageId: DM_ID },
      reason: "unknown_box",
      text: "does not cover a data box with that label",
      unload: OTHER_BOX_ID,
    },
    {
      name: "no OAuth caller",
      bearer: "nobody",
      tool: "get_message",
      args: { box: LABEL, messageId: DM_ID },
      reason: "no_caller",
      text: "serves OAuth grants only",
    },
  ];

  for (const refusal of refusals) {
    it(`refusal, ${refusal.name}: one refused row, no ISDS call`, async () => {
      const h = await start();
      if (refusal.unload !== undefined) h.unload(refusal.unload);
      const { result, rows } = await callAudited(h, refusal.bearer, refusal.tool, refusal.args);
      assert.isTrue(result.isError);
      assert.include(textOf(result), refusal.text);
      const row = only(rows);
      assert.deepStrictEqual([row.action, row.outcome, reasonOf(row)], [refusal.tool, "refused", refusal.reason]);
      assert.strictEqual(row.boxId, refusal.boxId);
      assert.deepStrictEqual(h.log, []);
    });
  }

  it("invalid input is rejected as invalid params before anything runs, for toolkit and raw tools alike: no row", async () => {
    const h = await start();
    const client = await h.connect("reader");
    for (const [tool, args] of [
      ["get_message", { box: LABEL, messageId: "12a" }],
      ["download_message", { box: LABEL, messageId: "12a" }],
      ["download_message", { box: LABEL, messageId: DM_ID, extra: true }],
      ["download_message", { box: "Nope", messageId: DM_ID }],
    ] as const) {
      const result = await client.call(tool, args);
      assert.isTrue(result.isError, `${tool} ${JSON.stringify(args)}`);
      assert.match(textOf(result), new RegExp(`^Invalid parameters for tool '${tool}'`));
    }
    assert.deepStrictEqual(await h.audit(), []);
    assert.deepStrictEqual(h.log, []);
  });

  it("the raw tool's invalid-params message does not echo the input", async () => {
    const h = await start();
    const client = await h.connect("reader");
    const result = await client.call("download_message", { box: LABEL, messageId: "SECRETISH-123" });
    assert.notInclude(textOf(result), "SECRETISH");
    assert.include(textOf(result), "messageId must be 1-20 digits");
  });
});
