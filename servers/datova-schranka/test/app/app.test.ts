import { Buffer } from "node:buffer";
import { REDACTED, Redactor } from "@mcps/core/redaction.js";
import { WITHHELD_RESOURCES_TEXT } from "@mcps/core/transport/frame-redaction.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../../src/domain/audit-log.js";
import { READ_SCOPE, SEND_SCOPE } from "../../src/mcp/tool-group.js";
import { CONSENT_ACTION } from "../../src/oauth/app.js";
import { type AppHarness, freePort, socketFetch, startApp } from "../support/app.js";
import { type OAuthHarness, PUBLIC_URL, tokensFor } from "../support/oauth.js";
import {
  BLOB_TOOL,
  ECHO_TOOL,
  READ_TOOL,
  RESOURCE_URI,
  SEND_TOOL,
  STATUS_TOOL,
  seen,
  TEST_FEATURES,
} from "./test-tools.js";

let app: AppHarness | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const start = async (env: Record<string, string> = {}) => {
  app = await startApp({ features: TEST_FEATURES, env });
  return app;
};

/** Tool name → its `box` enum (undefined for a tool without one). */
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

const textOf = (result: CallToolResult) =>
  result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");

describe("the composed HTTP app", () => {
  it("serves /healthz without a token", async () => {
    const harness = await start();
    const response = await harness.fetch(`${PUBLIC_URL}/healthz`);
    expect(response.status).toBe(200);
  });

  it("runs the OAuth round trip: register, consent in the browser, token, initialize, tools/list, tools/call", async () => {
    const harness = await start();
    const tokens = await tokensFor(harness, { boxes: ["Main"], scopes: [READ_SCOPE] });
    const client = await harness.mcp(tokens.access);
    expect(client.getServerVersion()?.name).toBe("datova-schranka");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain(READ_TOOL);
    const result = (await client.callTool({ name: READ_TOOL, arguments: { box: "Main" } })) as CallToolResult;
    expect(result.isError ?? false).toBe(false);
    expect(textOf(result)).toBe("read Main");
    // The consent's audit row was written by the app's AuditLog, in the grant's transaction.
    const { entries } = await harness.run(
      Effect.flatMap(Effect.service(AuditLog), (audit) => audit.list({ action: CONSENT_ACTION })),
    );
    expect(entries).toHaveLength(1);
  });

  it("lists only the tools the grant's scopes allow, with `box` narrowed to the granted boxes", async () => {
    const harness = await start();
    const reader = await tokensFor(harness, { boxes: ["Main"], scopes: [READ_SCOPE] });
    const sender = await tokensFor(harness, { boxes: ["Main", "Other"], scopes: [SEND_SCOPE] });

    const read = await listed(harness, reader.access);
    expect(read.has(SEND_TOOL)).toBe(false);
    expect(read.get(READ_TOOL)).toEqual(["Main"]);
    expect(read.has(STATUS_TOOL)).toBe(true);

    const send = await listed(harness, sender.access);
    expect(send.has(READ_TOOL)).toBe(false);
    expect(send.has(STATUS_TOOL)).toBe(false);
    expect(send.get(SEND_TOOL)).toEqual(["Main", "Other"]);
  });

  it("redacts HTTP responses with the Redactor the tools get, which knows the box secrets", async () => {
    const harness = await start();
    const services = await harness.run(Effect.service(Redactor));
    expect(seen.redactors.at(-1)).toBe(services);
    const tokens = await tokensFor(harness, { boxes: ["Main"], scopes: [READ_SCOPE] });
    const client = await harness.mcp(tokens.access);
    // Registered by the tool on its own Redactor, then returned unredacted by the tool.
    const fresh = "fresh-secret-registered-by-a-tool";
    const echoed = (await client.callTool({
      name: ECHO_TOOL,
      arguments: { secret: fresh, text: `a ${fresh} b` },
    })) as CallToolResult;
    expect(textOf(echoed)).toBe(`a ${REDACTED} b`);
    // A box password BoxRegistry registered at add.
    const password = "secret-of-main-user";
    const box = (await client.callTool({ name: ECHO_TOOL, arguments: { text: `x ${password} y` } })) as CallToolResult;
    expect(textOf(box)).toBe(`x ${REDACTED} y`);
  });

  it("withholds an embedded resource that redaction would alter, and passes others byte for byte", async () => {
    const harness = await start();
    const tokens = await tokensFor(harness, { boxes: ["Main"], scopes: [READ_SCOPE] });
    const client = await harness.mcp(tokens.access);
    const secret = Buffer.from("a box passphrase in base64").toString("base64");
    await harness.run(Effect.map(Effect.service(Redactor), (redactor) => redactor.register([secret])));

    const withheld = (await client.callTool({ name: BLOB_TOOL, arguments: { blob: secret } })) as CallToolResult;
    expect(withheld.isError).toBe(true);
    expect(textOf(withheld)).toBe(WITHHELD_RESOURCES_TEXT);
    expect(withheld.content.some((item) => item.type === "resource")).toBe(false);

    const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index)).toString("base64");
    const passed = (await client.callTool({ name: BLOB_TOOL, arguments: { blob: bytes } })) as CallToolResult;
    expect(passed.isError ?? false).toBe(false);
    const resource = passed.content.find((item) => item.type === "resource");
    expect(resource).toEqual({
      type: "resource",
      resource: { uri: RESOURCE_URI, mimeType: "application/octet-stream", blob: bytes },
    });
  });
});

const expectHidden = async (harness: OAuthHarness, path: string) =>
  expect((await harness.fetch(`${PUBLIC_URL}${path}`)).status, path).toBe(404);

const expectServed = async (harness: OAuthHarness, path: string) =>
  expect((await harness.fetch(`${PUBLIC_URL}${path}`)).status, path).not.toBe(404);

describe("the admin perimeter", () => {
  it("serves /admin and the sign-in pages on the main listener by default", async () => {
    const harness = await start();
    await expectServed(harness, "/admin/login");
    await expectServed(harness, "/login");
  });

  it("hides /admin and the sign-in pages from networks outside DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS", async () => {
    const harness = await start({ DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS: "10.0.0.0/8" });
    for (const path of ["/admin/login", "/admin/clients", "/login", "/consent", "/authorize"]) {
      await expectHidden(harness, path);
    }
    expect((await harness.fetch(`${PUBLIC_URL}/healthz`)).status).toBe(200);
  });

  it("admits the allowed networks", async () => {
    const harness = await start({ DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS: "127.0.0.0/8" });
    await expectServed(harness, "/admin/login");
    await expectServed(harness, "/login");
  });

  it("serves /admin only on DATOVA_SCHRANKA_ADMIN_PORT when it is set", async () => {
    const adminPort = await freePort();
    const harness = await start({ DATOVA_SCHRANKA_ADMIN_PORT: String(adminPort) });
    const onAdminPort: OAuthHarness = { ...harness, fetch: socketFetch(`http://127.0.0.1:${adminPort}`) };
    for (const path of ["/admin/login", "/admin/clients"]) await expectHidden(harness, path);
    await expectServed(onAdminPort, "/admin/login");
    expect((await onAdminPort.fetch(`${PUBLIC_URL}/mcp`, { method: "POST" })).status).toBe(404);
    // The sign-in pages stay on the main listener: OAuth clients reach them there.
    await expectServed(harness, "/login");
  });

  it("applies DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS on the admin listener too", async () => {
    const adminPort = await freePort();
    const harness = await start({
      DATOVA_SCHRANKA_ADMIN_PORT: String(adminPort),
      DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS: "10.0.0.0/8",
    });
    const onAdminPort: OAuthHarness = { ...harness, fetch: socketFetch(`http://127.0.0.1:${adminPort}`) };
    for (const path of ["/admin/login", "/admin/clients"]) await expectHidden(onAdminPort, path);
  });
});
