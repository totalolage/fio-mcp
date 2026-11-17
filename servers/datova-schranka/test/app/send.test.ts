/**
 * The send side in the composed app: the production features over the fake
 * ISDS, with the real SendService, SendAuthority, filings tab and database.
 * Tools go through MCP with OAuth grants; recipient tiers and the filings
 * tab's actions run on the app's own services.
 */

import type { AdminActionContext, AdminTab } from "@mcps/core/admin/tab.js";
import type { LoginResult } from "@mcps/core/oauth/login.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { filingsTab } from "../../src/admin/filings-tab.js";
import { AuditLog } from "../../src/domain/audit-log.js";
import { type RecipientTier, RecipientTiers } from "../../src/domain/recipient-tiers.js";
import { SendService } from "../../src/domain/send/api.js";
import { READ_TOOL_SPECS } from "../../src/mcp/read-tools.js";
import { READ_SCOPE, SEND_SCOPE } from "../../src/mcp/tool-group.js";
import { sentMessagesReply } from "../domain/send/support/isds-replies.js";
import type { FakeRespond } from "../domain/support/fake-isds.js";
import { fixture, ok } from "../isds/fake-transport.js";
import { type AppHarness, startApp } from "../support/app.js";
import { type HarnessServices, tokensFor } from "../support/oauth.js";

const SEND = "send_message";
const STATUS = "get_filing_status";
const RECIPIENT = "xyz7abc";
/** CreateMessageResponse.xml's dmID. */
const DM_ID = "1234567";
const APPROVE_PATH = "/admin/filings/approve";
const REJECT_PATH = "/admin/filings/reject";

let app: AppHarness | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * The fake ISDS beyond logins: the recipient can receive, CreateMessage
 * accepts with DM_ID, nothing was sent before. `calls` counts each operation.
 */
const fakeIsds = () => {
  const counts = new Map<string, number>();
  const respond: FakeRespond = (_config, request) =>
    Effect.sync(() => {
      counts.set(request.operation, (counts.get(request.operation) ?? 0) + 1);
      switch (request.operation) {
        case "CheckDataBox":
          return ok(fixture("CheckDataBox.xml"));
        case "CreateMessage":
          return ok(fixture("CreateMessageResponse.xml"));
        case "GetListOfSentMessages":
          return sentMessagesReply([]);
        default:
          return ok("");
      }
    });
  return { respond, calls: (operation: string) => counts.get(operation) ?? 0 };
};

const start = async () => {
  const isds = fakeIsds();
  app = await startApp({ respond: isds.respond });
  return { harness: app, isds };
};

/**
 * `run` with the send services too: `run` provides the context the whole app
 * layer built (servicesLive merges the extension and app services into it),
 * though its type names only HarnessServices.
 */
const runApp = <A, E>(
  harness: AppHarness,
  effect: Effect.Effect<A, E, HarnessServices | SendService | RecipientTiers>,
): Promise<A> =>
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
  harness.run(effect as Effect.Effect<A, E, HarnessServices>);

const mainId = (harness: AppHarness) => harness.added[0]?.id ?? "";

const setTier = (harness: AppHarness, tier: RecipientTier) =>
  runApp(
    harness,
    Effect.flatMap(Effect.service(RecipientTiers), (tiers) => tiers.set(mainId(harness), RECIPIENT, tier)),
  );

const sendArgs = (idempotencyKey: string, extra: Record<string, unknown> = {}) => ({
  box: "Main",
  idempotencyKey,
  recipient: RECIPIENT,
  annotation: "Invoice 2026/11",
  attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0=" }],
  ...extra,
});

const textOf = (result: CallToolResult) =>
  result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

/** A successful call's JSON output. */
const output = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await call(client, name, args);
  expect(result.isError ?? false, textOf(result)).toBe(false);
  return JSON.parse(textOf(result)) as Record<string, unknown>;
};

/** Tool name → its `box` enum. */
const listed = async (harness: AppHarness, access: string) => {
  const client = await harness.mcp(access);
  const { tools } = await client.listTools();
  return new Map(
    tools.map((tool) => [
      tool.name,
      (tool.inputSchema.properties?.box as { enum?: ReadonlyArray<string> } | undefined)?.enum,
    ]),
  );
};

const sender = async (harness: AppHarness) => {
  const tokens = await tokensFor(harness, { boxes: ["Main"], scopes: [SEND_SCOPE] });
  return harness.mcp(tokens.access);
};

const ACCEPTED: LoginResult<void> = { _tag: "Accepted", value: undefined };
const REJECTED: LoginResult<void> = { _tag: "Rejected" };

const contextFor = (factor: LoginResult<void>): AdminActionContext => ({
  checkSecondFactor: Effect.succeed(factor),
  files: [],
});

/** Runs the filings tab's action at `path` with `form`, built over the app's own services. */
const tabAction = async (
  harness: AppHarness,
  path: string,
  form: Record<string, string>,
  context: AdminActionContext,
) => {
  const tab: AdminTab = await runApp(harness, filingsTab);
  const action = tab.actions.find((candidate) => candidate.path === path);
  if (action === undefined) throw new Error(`no action ${path}`);
  return runApp(harness, action.run(new URLSearchParams(form), context));
};

const filingState = (harness: AppHarness, filingId: string) =>
  runApp(
    harness,
    Effect.flatMap(Effect.service(SendService), (service) => service.getFiling(filingId)),
  ).then((filing) => filing.state);

const auditRows = (harness: AppHarness, action: string) =>
  runApp(
    harness,
    Effect.flatMap(Effect.service(AuditLog), (audit) => audit.list({ action, limit: 100 })),
  ).then((page) => page.entries);

describe("the send side in the composed app", () => {
  it("lists the send tools only for an isds:send grant, with `box` narrowed to the granted boxes", async () => {
    const { harness } = await start();
    const reader = await tokensFor(harness, { boxes: ["Main"], scopes: [READ_SCOPE] });
    const sending = await tokensFor(harness, { boxes: ["Main"], scopes: [SEND_SCOPE] });
    const both = await tokensFor(harness, { boxes: ["Main"], scopes: [READ_SCOPE, SEND_SCOPE] });
    const readNames = READ_TOOL_SPECS.map((spec) => spec.name);

    const read = await listed(harness, reader.access);
    expect(read.has(SEND)).toBe(false);
    expect(read.has(STATUS)).toBe(false);
    for (const name of readNames) expect(read.has(name), name).toBe(true);

    const send = await listed(harness, sending.access);
    expect([...send.keys()].sort()).toEqual([STATUS, SEND]);
    expect(send.get(SEND)).toEqual(["Main"]);
    expect(send.get(STATUS)).toEqual(["Main"]);

    const all = await listed(harness, both.access);
    expect([...all.keys()].sort()).toEqual([...readNames, SEND, STATUS].sort());
    expect(all.get(SEND)).toEqual(["Main"]);
  });

  it("full tier: send_message sends at once and get_filing_status reports it sent", async () => {
    const { harness, isds } = await start();
    await setTier(harness, "full");
    const client = await sender(harness);

    const sent = await output(client, SEND, sendArgs("full-1"));
    expect(sent).toMatchObject({ result: "sent", dmID: DM_ID });
    expect(isds.calls("CreateMessage")).toBe(1);

    const status = await output(client, STATUS, { box: "Main", filingId: sent.filingId });
    expect(status).toMatchObject({ filingId: sent.filingId, state: "sent", tier: "full", dmID: DM_ID });
  });

  it("approve tier: the first call returns a nonce and preview, the confirming call sends once", async () => {
    const { harness, isds } = await start();
    await setTier(harness, "approve");
    const client = await sender(harness);

    const pending = await output(client, SEND, sendArgs("approve-1"));
    expect(pending).toMatchObject({
      result: "approval_required",
      preview: { recipient: RECIPIENT, annotation: "Invoice 2026/11" },
    });
    expect(pending.nonce).toEqual(expect.any(String));
    expect(isds.calls("CreateMessage")).toBe(0);

    const sent = await output(client, SEND, sendArgs("approve-1", { approvalNonce: pending.nonce }));
    expect(sent).toMatchObject({ result: "sent", filingId: pending.filingId, dmID: DM_ID });
    expect(isds.calls("CreateMessage")).toBe(1);
  });

  it("no tier: the call is queued, a refused second factor sends nothing, an accepted one sends once", async () => {
    const { harness, isds } = await start();
    await setTier(harness, "none");
    const client = await sender(harness);

    const queued = await output(client, SEND, sendArgs("none-1"));
    expect(queued).toMatchObject({ result: "queued", state: "pending_admin" });
    const filingId = String(queued.filingId);
    expect(isds.calls("CreateMessage")).toBe(0);

    const refused = await tabAction(harness, APPROVE_PATH, { filing: filingId, totp: "000000" }, contextFor(REJECTED));
    expect(refused.kind).toBe("error");
    expect(refused.text).toContain("missing or wrong");
    expect(isds.calls("CreateMessage")).toBe(0);
    expect(await filingState(harness, filingId)).toBe("pending_admin");

    const approved = await tabAction(harness, APPROVE_PATH, { filing: filingId, totp: "123456" }, contextFor(ACCEPTED));
    expect(approved.kind, approved.text).toBe("ok");
    expect(approved.text).toContain(DM_ID);
    expect(isds.calls("CreateMessage")).toBe(1);
    expect(await filingState(harness, filingId)).toBe("sent");

    const status = await output(client, STATUS, { box: "Main", idempotencyKey: "none-1" });
    expect(status).toMatchObject({ filingId, state: "sent", tier: "none", dmID: DM_ID });
  });

  it("no tier: an admin rejection leaves the filing admin_rejected and sends nothing", async () => {
    const { harness, isds } = await start();
    await setTier(harness, "none");
    const client = await sender(harness);

    const queued = await output(client, SEND, sendArgs("none-2"));
    const filingId = String(queued.filingId);
    const rejected = await tabAction(
      harness,
      REJECT_PATH,
      { filing: filingId, reason: "not ours" },
      contextFor(ACCEPTED),
    );
    expect(rejected.kind, rejected.text).toBe("ok");
    expect(await filingState(harness, filingId)).toBe("admin_rejected");
    expect(isds.calls("CreateMessage")).toBe(0);

    const status = await output(client, STATUS, { box: "Main", filingId });
    expect(status).toMatchObject({ filingId, state: "admin_rejected" });
  });

  it("replays the same key and content with the stored result, sending nothing again", async () => {
    const { harness, isds } = await start();
    await setTier(harness, "full");
    const client = await sender(harness);

    const first = await output(client, SEND, sendArgs("replay-1"));
    const again = await output(client, SEND, sendArgs("replay-1"));
    expect(first).toMatchObject({ result: "sent", dmID: DM_ID });
    expect(again).toEqual(first);
    expect(isds.calls("CreateMessage")).toBe(1);
  });

  it("writes exactly one audit row per send tool call, refusals included", async () => {
    const { harness } = await start();
    await setTier(harness, "full");
    const client = await sender(harness);

    /** Runs `act` and checks it added exactly one row under `action` and none under the other tool. */
    const once = async <A>(action: string, act: () => Promise<A>) => {
      const other = action === SEND ? STATUS : SEND;
      const [before, beforeOther] = [(await auditRows(harness, action)).length, (await auditRows(harness, other)).length];
      const value = await act();
      const rows = await auditRows(harness, action);
      expect(rows.length - before, action).toBe(1);
      expect((await auditRows(harness, other)).length, other).toBe(beforeOther);
      return { value, rows };
    };

    const sent = await once(SEND, () => output(client, SEND, sendArgs("audit-1")));
    await once(SEND, () => output(client, SEND, sendArgs("audit-1")));

    // A box the grant does not cover: authorizedBoxCall refuses before the service runs.
    const notGranted = await once(SEND, () => call(client, SEND, { ...sendArgs("audit-2"), box: "Other" }));
    expect(notGranted.value.isError).toBe(true);
    expect(notGranted.rows.map((row) => row.outcome)).toContain("refused");

    await once(STATUS, () => output(client, STATUS, { box: "Main", filingId: sent.value.filingId }));
    await once(STATUS, () => output(client, STATUS, { box: "Main", idempotencyKey: "audit-1" }));

    const ambiguous = await once(STATUS, () =>
      call(client, STATUS, { box: "Main", filingId: sent.value.filingId, idempotencyKey: "audit-1" }),
    );
    expect(ambiguous.value.isError).toBe(true);
    expect(textOf(ambiguous.value)).toContain("Pass exactly one of filingId or idempotencyKey.");

    const neither = await once(STATUS, () => call(client, STATUS, { box: "Main" }));
    expect(neither.value.isError).toBe(true);

    const statusNotGranted = await once(STATUS, () =>
      call(client, STATUS, { box: "Other", idempotencyKey: "audit-1" }),
    );
    expect(statusNotGranted.value.isError).toBe(true);
  });
});
