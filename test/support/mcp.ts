/**
 * In-process MCP client↔server harness. The official SDK client talks
 * Streamable HTTP to the server's web handler through a fetch function, so
 * nothing listens on a port; FIO is the scripted `FioHttp` client.
 */

import { NodeFileSystem } from "@effect/platform-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { Accounts } from "../../src/accounts.js";
import { SERVER_INFO, ToolsLive } from "../../src/app.js";
import { CacheLive } from "../../src/cache/service.js";
import type { AppConfigShape } from "../../src/config.js";
import { FioApiLayer } from "../../src/fio-api-live.js";
import { RateLimiter } from "../../src/rate-limiter.js";
import { Redactor } from "../../src/redaction.js";
import { Auth } from "../../src/transport/auth.js";
import { httpRouterApp } from "../../src/transport/http.js";
import { seededConfig } from "./config.js";
import { FioHttp, type FioHttpHandler, type FioHttpReply, type RecordedRequest } from "./fio-http.js";

export interface Harness {
  readonly client: Client;
  readonly tools: () => Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]>;
  readonly names: () => Promise<Array<string>>;
  readonly call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  readonly requests: () => Promise<ReadonlyArray<RecordedRequest>>;
  readonly close: () => Promise<void>;
}

export async function connect(config: AppConfigShape, route: FioHttpHandler | FioHttpReply): Promise<Harness> {
  const handler: FioHttpHandler = typeof route === "function" ? route : () => route;
  // Build the FIO mock once so the test can read its recorded requests.
  const fioHttp = await Effect.runPromise(
    Layer.build(
      FioHttp.layer({
        tokens: config.secrets.map(Redacted.value),
        baseUrl: config.baseUrl,
        handler,
      }),
    ).pipe(Effect.scoped),
  );
  const ServicesLive = CacheLive.pipe(
    Layer.provideMerge(FioApiLayer),
    Layer.provideMerge(Layer.mergeAll(Redactor.Default, Accounts.Default, RateLimiter.Default)),
    Layer.provideMerge(seededConfig(config)),
    Layer.provide(Layer.mergeAll(Layer.succeedContext(fioHttp), NodeFileSystem.layer)),
  );
  // The production HTTP router app (guards, frame redaction, /healthz), without auth.
  const httpConfig = {
    kind: "http",
    host: "127.0.0.1",
    port: 0,
    auth: { kind: "unauthenticated" },
    allowedOrigins: [],
    allowedHosts: [],
    trustedProxies: [],
  } as const;
  const app = httpRouterApp(ToolsLive, Auth.layerOpen, SERVER_INFO, httpConfig).pipe(
    Layer.provide(ServicesLive),
    Layer.provide(HttpServer.layerServices),
  );
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => web.handler(new Request(url, init)),
    }),
  );
  const tools = async () => (await client.listTools()).tools;
  return {
    client,
    tools,
    names: async () => (await tools()).map((t) => t.name).sort(),
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    requests: () => Effect.runPromise(FioHttp.requests.pipe(Effect.provide(Layer.succeedContext(fioHttp)))),
    close: async () => {
      await client.close();
      await web.dispose();
    },
  };
}

export function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}
