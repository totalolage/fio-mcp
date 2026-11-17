/**
 * In-process MCP client↔server harness. The official SDK client talks
 * Streamable HTTP to the server's web handler through a fetch function, so
 * nothing listens on a port; FIO is the scripted `FioHttp` client.
 */

import { Auth } from "@mcps/core/transport/auth.js";
import { httpRouterApp } from "@mcps/core/transport/http.js";
import type { Principal } from "@mcps/core/transport/principal.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type Context, Effect, Exit, Layer, Logger, Redacted, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { Accounts } from "../../src/accounts.js";
import { SERVER_INFO, ToolsLive } from "../../src/app.js";
import { Transactions } from "../../src/cache/service.js";
import type { AppConfigShape } from "../../src/config.js";
import { FioApi } from "../../src/fio-api.js";
import { ConfiguredToolPolicy } from "../../src/mcp/tool-policy.js";
import { PaymentControls } from "../../src/payment-controls.js";
import { type AuditRow, PAYMENT_MIGRATIONS, PaymentLedger } from "../../src/payment-ledger.js";
import { RateLimiter } from "../../src/rate-limiter.js";
import { RedactorDefault } from "../../src/redaction.js";
import { seededConfig } from "./config.js";
import { memoryDatabase, testDatabase } from "./database.js";
import { FioHttp, type FioHttpHandler, type FioHttpReply, type RecordedRequest } from "./fio-http.js";

export interface Harness {
  readonly client: Client;
  readonly tools: () => Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]>;
  readonly names: () => Promise<Array<string>>;
  readonly call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  readonly requests: () => Promise<ReadonlyArray<RecordedRequest>>;
  /** The payment audit log, newest first. */
  readonly audit: () => Promise<ReadonlyArray<AuditRow>>;
  /** Every log line the server wrote, logfmt-formatted. */
  readonly logs: ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

export interface ConnectOptions {
  /** The caller every request authenticates as; LOCAL_PRINCIPAL (Auth.Open) by default. */
  readonly principal?: Principal;
}

export async function connect(
  config: AppConfigShape,
  route: FioHttpHandler | FioHttpReply,
  options: ConnectOptions = {},
): Promise<Harness> {
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
  // The payment ledger lives as long as the harness so tests can read its audit rows.
  const scope = await Effect.runPromise(Scope.make());
  const ledger: Context.Context<PaymentLedger> = await Effect.runPromise(
    Layer.buildWithScope(PaymentLedger.Default.pipe(Layer.provide(memoryDatabase(PAYMENT_MIGRATIONS))), scope),
  );
  const logs: Array<string> = [];
  const captureLogs = Logger.layer([Logger.make<unknown, void>((entry) => logs.push(Logger.formatLogFmt.log(entry)))]);
  const cache = config.cache.enabled
    ? Transactions.Default.pipe(Layer.provide(testDatabase(config.cache.dbPath)))
    : Transactions.Disabled;
  const ServicesLive = Layer.mergeAll(cache, PaymentControls.Default.pipe(Layer.provide(Layer.succeedContext(ledger)))).pipe(
    Layer.provideMerge(FioApi.Default),
    Layer.provideMerge(Layer.mergeAll(Accounts.resources, ConfiguredToolPolicy)),
    Layer.provideMerge(Layer.mergeAll(RedactorDefault, Accounts.Default, RateLimiter.Default)),
    Layer.provideMerge(seededConfig(config)),
    Layer.provide(Layer.succeedContext(fioHttp)),
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
  const auth =
    options.principal === undefined
      ? Auth.Open
      : Layer.succeed(Auth, Auth.of({ authenticate: () => Effect.succeed(options.principal!) }));
  // Request handlers run with the router's context, not the layer's: the logger is provided per request.
  const logPerRequest = HttpRouter.middleware((httpEffect) => httpEffect.pipe(Effect.provide(captureLogs)), { global: true });
  const app = httpRouterApp(Layer.merge(ToolsLive, logPerRequest), auth, SERVER_INFO, httpConfig).pipe(
    Layer.provide(ServicesLive),
    Layer.provide(HttpServer.layerServices),
    Layer.provide(captureLogs),
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
    audit: () => Effect.runPromise(PaymentLedger.use((l) => l.list({ limit: 1000 })).pipe(Effect.provide(Layer.succeedContext(ledger)))),
    logs,
    close: async () => {
      await client.close();
      await web.dispose();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

export function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}
