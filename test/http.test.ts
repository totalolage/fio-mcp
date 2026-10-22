import { request as nodeRequest } from "node:http";
import { assert, describe, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { SERVER_INFO, ToolsLive } from "../src/app.js";
import { makeFioToolkit } from "../src/mcp/fio-tools.js";
import { makeRedactor } from "../src/redaction.js";
import { Auth, Unauthorized } from "../src/transport/auth.js";
import { makeFrameRedactor } from "../src/transport/frame-redaction.js";
import { type HttpTransportConfig, isAllowedHost, serveHttp } from "../src/transport/http.js";
import { CurrentPrincipal } from "../src/transport/principal.js";
import { ACCOUNT_NAMES, AUTH_TOKEN, FIO_TOKEN, testConfig, testServices } from "./support/transport.js";

const transport = (overrides: Partial<HttpTransportConfig> = {}): HttpTransportConfig => ({
  kind: "http",
  host: "127.0.0.1",
  port: 0,
  authToken: undefined,
  allowedOrigins: [],
  allowedHosts: [],
  ...overrides,
});

/** Reports the principal the HTTP guard provided for the call. */
const WhoAmI = Tool.make("whoami", { success: Schema.Struct({ subject: Schema.String, accounts: Schema.Unknown }) });
const WhoAmIToolkit = Toolkit.make(WhoAmI);
const WhoAmILive = McpServer.toolkit(WhoAmIToolkit).pipe(
  Layer.provide(
    WhoAmIToolkit.toLayer({
      whoami: () =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return { subject: principal.subject, accounts: principal.accounts };
        }),
    }),
  ),
);

/** Serves the app on an ephemeral port for the rest of the scope. */
const startServer = Effect.fnUntraced(function* (
  config: HttpTransportConfig,
  auth: Layer.Layer<Auth, never, HttpRouter.HttpRouter> = Auth.layerFrom(config.authToken),
) {
  const release = yield* Deferred.make<void>();
  const app = serveHttp(Layer.mergeAll(ToolsLive, WhoAmILive), auth, SERVER_INFO, config).pipe(
    Layer.provide(testServices(testConfig(config), release)),
  );
  const context = yield* Layer.build(app);
  const address = Context.get(context, HttpServer.HttpServer).address;
  assert.isTrue("port" in address);
  const port = "port" in address ? address.port : 0;
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
  return { base: `http://127.0.0.1:${port}`, port, release };
});

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | Array<string> | undefined>;
  readonly body: string;
}

/** node:http instead of fetch: fetch cannot set the Host header. */
const raw = (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  Effect.promise(
    () =>
      new Promise<RawResponse>((resolve, reject) => {
        const req = nodeRequest(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.end(options.body);
      }),
  );

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

const postInitialize = (base: string, headers: Record<string, string> = {}) =>
  raw(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: INITIALIZE,
  });

/** An SDK client connected over Streamable HTTP; closed with the scope. */
const connect = (base: string, headers: Record<string, string> = {}) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new Client({ name: "test", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers } });
      yield* Effect.tryPromise(() => client.connect(transport));
      return client;
    }),
    (client) => Effect.promise(() => client.close()),
  );

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");

const FIO_TOOL_NAMES = [...Object.keys(makeFioToolkit(ACCOUNT_NAMES).tools), "whoami"].sort();

describe("HTTP transport", () => {
  it.live("initializes, lists every tool and calls get_server_status", () =>
    Effect.gen(function* () {
      const { base } = yield* startServer(transport());
      const client = yield* connect(base);
      const tools = yield* Effect.promise(() => client.listTools());
      assert.deepStrictEqual(tools.tools.map((t) => t.name).sort(), FIO_TOOL_NAMES);
      const status = yield* Effect.promise(() => client.callTool({ name: "get_server_status", arguments: {} }));
      
      assert.notStrictEqual(status.isError, true);
      const parsed = JSON.parse(textOf(status));
      assert.strictEqual(parsed.accounts[0].name, "main");
    }).pipe(Effect.scoped),
  );

  it.live("serves /healthz without auth, without FIO, and with any Host", () =>
    Effect.gen(function* () {
      const { base } = yield* startServer(
        transport({
          authToken: Redacted.make(AUTH_TOKEN),
          allowedHosts: ["fio.example.test"],
          allowedOrigins: ["https://fio.example.test"],
        }),
      );
      const headerSets: Array<Record<string, string>> = [
        {},
        { host: "localhost:3000" },
        { host: "evil.example", origin: "https://evil.example" },
      ];
      for (const headers of headerSets) {
        const response = yield* raw(`${base}/healthz`, { headers });
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(JSON.parse(response.body), { status: "ok" });
      }
    }).pipe(Effect.scoped),
  );

  it.live("requires the bearer token on /mcp when one is configured", () =>
    Effect.gen(function* () {
      const { base } = yield* startServer(transport({ authToken: Redacted.make(AUTH_TOKEN) }));

      const missing = yield* postInitialize(base);
      assert.strictEqual(missing.status, 401);
      assert.strictEqual(missing.headers["www-authenticate"], "Bearer");

      const wrong = yield* postInitialize(base, { authorization: `Bearer ${AUTH_TOKEN}x` });
      assert.strictEqual(wrong.status, 401);
      assert.strictEqual(wrong.headers["www-authenticate"], 'Bearer error="invalid_token"');

      const otherScheme = yield* postInitialize(base, { authorization: `Basic ${AUTH_TOKEN}` });
      assert.strictEqual(otherScheme.status, 401);

      // Only /mcp is authenticated; other routes belong to whoever adds them.
      assert.strictEqual((yield* raw(`${base}/other`)).status, 404);

      const denied = yield* Effect.exit(connect(base));
      assert.isTrue(Exit.isFailure(denied));

      const client = yield* connect(base, { authorization: `Bearer ${AUTH_TOKEN}` });
      const tools = yield* Effect.promise(() => client.listTools());
      assert.deepStrictEqual(tools.tools.map((t) => t.name).sort(), FIO_TOOL_NAMES);
    }).pipe(Effect.scoped),
  );

  it.live("rejects foreign Origin headers and accepts listed ones", () =>
    Effect.gen(function* () {
      const { base } = yield* startServer(transport({ allowedOrigins: ["https://app.example.test"] }));
      assert.strictEqual((yield* postInitialize(base, { origin: "https://evil.example" })).status, 403);
      assert.strictEqual((yield* postInitialize(base, { origin: "https://app.example.test" })).status, 200);
      assert.strictEqual((yield* postInitialize(base)).status, 200);
    }).pipe(Effect.scoped),
  );

  it.live("rejects Host headers outside the allowlist", () =>
    Effect.gen(function* () {
      const { base } = yield* startServer(transport({ allowedHosts: ["fio.example.test"] }));
      assert.strictEqual((yield* postInitialize(base, { host: "evil.example" })).status, 403);
      assert.strictEqual((yield* postInitialize(base, { host: "127.0.0.1" })).status, 403);
      assert.strictEqual((yield* postInitialize(base, { host: "fio.example.test" })).status, 200);
      assert.strictEqual((yield* postInitialize(base, { host: "FIO.example.test:443" })).status, 200);
    }).pipe(Effect.scoped),
  );

  it.live("shares one rate limiter across concurrent sessions", () =>
    Effect.gen(function* () {
      const { base, release } = yield* startServer(transport());
      const first = yield* connect(base);
      const second = yield* connect(base);
      const call = (client: Client) =>
        Effect.promise(() =>
          client.callTool({
            name: "get_transactions",
            arguments: { account: "main", dateFrom: "2026-01-01", dateTo: "2026-01-31" },
          }),
        );
      // Whichever call reaches the limiter first holds the token's slot until
      // released; with maxWait 0 the other fails fast. Separate limiters
      // would let both through.
      const fibers = yield* Effect.forEach([first, second], (client) => Effect.forkChild(call(client)));
      const limited = yield* Effect.raceAll(
        fibers.map((fiber, index) =>
          Effect.flatMap(Fiber.await(fiber), (exit) =>
            Exit.isSuccess(exit) && exit.value.isError === true ? Effect.succeed(index) : Effect.never,
          ),
        ),
      );
      assert.match(textOf(yield* Fiber.join(fibers[limited]!)), /Rate limited/);
      yield* Deferred.succeed(release, undefined);
      const holder = yield* Fiber.join(fibers[1 - limited]!);
      assert.notStrictEqual(holder.isError, true);
      assert.strictEqual(JSON.parse(textOf(holder)).account, "main");
    }).pipe(Effect.scoped),
  );

  it.live("hands the authenticated principal to tool handlers and lets Auth add routes", () =>
    Effect.gen(function* () {
      // Stands in for an OAuth server: its own route, and a principal per token.
      const auth = Layer.mergeAll(
        Layer.succeed(Auth, {
          authenticate: (request) =>
            request.headers.authorization === "Bearer alice"
              ? Effect.succeed({ subject: "alice", scopes: ["fio:read"], accounts: ["main"] })
              : Effect.fail(new Unauthorized({ challenge: 'Bearer resource_metadata="/.well-known/test"' })),
        }),
        HttpRouter.add("GET", "/.well-known/test", HttpServerResponse.text("metadata")),
      );
      const { base } = yield* startServer(transport(), auth);
      assert.strictEqual((yield* raw(`${base}/.well-known/test`)).body, "metadata");
      const denied = yield* postInitialize(base);
      assert.strictEqual(denied.status, 401);
      assert.strictEqual(denied.headers["www-authenticate"], 'Bearer resource_metadata="/.well-known/test"');

      const alice = yield* connect(base, { authorization: "Bearer alice" });
      const result = yield* Effect.promise(() => alice.callTool({ name: "whoami", arguments: {} }));
      assert.deepStrictEqual(JSON.parse(textOf(result)), { subject: "alice", accounts: ["main"] });
    }).pipe(Effect.scoped),
  );

  it.live("redacts secrets that McpServer echoes into its own messages", () =>
    Effect.gen(function* () {
      const { base } = yield* startServer(transport());
      const init = yield* postInitialize(base);
      const session = init.headers["mcp-session-id"];
      assert.isString(session);
      const response = yield* raw(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": session as string,
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          // McpServer answers "Tool '<name>' not found" itself; no tool
          // handler (and no per-tool redaction) is involved.
          params: { name: FIO_TOKEN, arguments: {} },
        }),
      });
      assert.strictEqual(response.status, 200);
      
      assert.notInclude(response.body, FIO_TOKEN);
      assert.include(response.body, "***");
      const json = response.body.startsWith("data: ") ? response.body.slice(6) : response.body;
      const message = JSON.parse(json.trim());
      assert.strictEqual(message.id, 2);
      assert.strictEqual(message.error.message, "Tool '***' not found");
    }).pipe(Effect.scoped),
  );
});

describe("frame redaction", () => {
  const frames = makeFrameRedactor(makeRedactor([FIO_TOKEN]));

  it("replaces secrets inside JSON frames and keeps them parseable", () => {
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: `token ${FIO_TOKEN} here` } })}\n`;
    const out = frames.text(frame);
    assert.notInclude(out, FIO_TOKEN);
    assert.isTrue(out.endsWith("\n"));
    assert.strictEqual(JSON.parse(out).result.text, "token *** here");
  });

  it("keeps escape sequences intact around token-shaped URL segments", () => {
    // Plain-text redaction would eat the backslash before the quote here.
    const frame = JSON.stringify({ text: 'GET /last/abc" failed' });
    const out = frames.text(frame);
    assert.strictEqual(JSON.parse(out).text, 'GET /last/***" failed');
  });

  it("redacts every event of an SSE body and keeps the event structure", () => {
    const event = (id: number) => `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { t: FIO_TOKEN } })}\n\n`;
    const out = frames.text(`${event(1)}: keepalive\n\n${event(2)}`);
    assert.notInclude(out, FIO_TOKEN);
    const events = out.split("\n\n").filter((e) => e.startsWith("data: "));
    assert.deepStrictEqual(
      events.map((e) => JSON.parse(e.slice(6)).id),
      [1, 2],
    );
    assert.include(out, ": keepalive\n\n");
  });

  it("returns the same chunk when there is nothing to redact", () => {
    const bytes = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    assert.strictEqual(frames.chunk(bytes), bytes);
  });
});

describe("isAllowedHost", () => {
  it("accepts anything when the allowlist is empty", () => {
    assert.isTrue(isAllowedHost([], undefined));
    assert.isTrue(isAllowedHost([], "evil.example"));
  });

  it("matches hosts with or without ports, case-insensitively", () => {
    assert.isTrue(isAllowedHost(["fio.example.test"], "FIO.example.test:8443"));
    assert.isTrue(isAllowedHost(["localhost:3000"], "localhost:3000"));
    assert.isFalse(isAllowedHost(["localhost:3000"], "localhost:3001"));
    assert.isTrue(isAllowedHost(["[::1]"], "[::1]:3000"));
    assert.isFalse(isAllowedHost(["fio.example.test"], "fio.example.test.evil.example"));
    assert.isFalse(isAllowedHost(["fio.example.test"], undefined));
  });
});
