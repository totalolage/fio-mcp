import { Effect, Layer, Stream } from "effect";
import { McpProtocol } from "effect/ai";
import { HttpRouter, HttpServer } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";
import { ToolPolicy } from "../src/mcp/grants.js";
import { Redactor } from "../src/redaction.js";
import { Resources } from "../src/resources.js";
import { Auth } from "../src/transport/auth.js";
import { type HttpTransportConfig, httpRouterApp, MAX_BODY_BYTES } from "../src/transport/http.js";

/**
 * The /mcp request body limit: MAX_BODY_BYTES (1 MiB) unless the app sets
 * HttpTransportConfig.maxBodyBytes. Served through a web handler with open
 * authorization and no tools.
 */

const BASE = "http://mcp.example.test";
const CONFIG: HttpTransportConfig = { host: "127.0.0.1", port: 0, allowedOrigins: [], allowedHosts: [], trustedProxies: [] };

const handlers: Array<{ readonly dispose: () => Promise<void> }> = [];
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.dispose();
});

const start = (config: HttpTransportConfig) => {
  const app = httpRouterApp(
    Layer.empty,
    Auth.Open,
    { name: "limits-demo", version: "0.0.0", instructions: "", protocols: [McpProtocol.v2025_06_18] },
    config,
  ).pipe(
    Layer.provide(Layer.succeed(Resources, Resources.of({ list: Effect.succeed([]), changes: Stream.empty }))),
    Layer.provide(ToolPolicy.layer({ scopes: () => [], resourceless: () => true, resourceParameter: "box" })),
    Layer.provide(Redactor.layer(Effect.succeed([]))),
    Layer.provide(HttpServer.layerServices),
  );
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  handlers.push(web);
  return (body: string, headers: Record<string, string> = {}) =>
    web.handler(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body,
      }),
    );
};

/** A session id from an initialize request. */
const initialize = async (post: ReturnType<typeof start>) => {
  const response = await post(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "limits", version: "0.0.0" } },
    }),
  );
  expect(response.status).toBe(200);
  await response.text();
  const session = response.headers.get("mcp-session-id");
  expect(session).not.toBeNull();
  return session ?? "";
};

/** A notification of exactly `bytes` bytes for an existing session. */
const notification = (bytes: number) => {
  const head = '{"jsonrpc":"2.0","method":"notifications/initialized","params":{"_meta":{"pad":"';
  const tail = '"}}}';
  return head + "x".repeat(bytes - head.length - tail.length) + tail;
};

describe("MCP request body limit", () => {
  it("is 1 MiB by default: one byte more is refused with 413", async () => {
    expect(MAX_BODY_BYTES).toBe(1024 * 1024);
    const post = start(CONFIG);
    const session = await initialize(post);
    const headers = { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" };

    expect((await post(notification(MAX_BODY_BYTES + 1), headers)).status).toBe(413);
    const at = await post(notification(MAX_BODY_BYTES), headers);
    expect(at.status).toBe(202);
  });

  it("follows the app's maxBodyBytes", async () => {
    const raised = 32 * 1024 * 1024;
    const post = start({ ...CONFIG, maxBodyBytes: raised });
    const session = await initialize(post);
    const headers = { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" };

    expect((await post(notification(4 * MAX_BODY_BYTES), headers)).status).toBe(202);
    expect((await post(notification(raised + 1), headers)).status).toBe(413);
  });
});
