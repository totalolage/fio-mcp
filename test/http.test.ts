import { request as nodeRequest } from "node:http";
import { assert, describe, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SERVER_INFO, ToolsLive } from "../src/app.js";
import { makeCacheToolkit } from "../src/mcp/cache-tools.js";
import { makeFioToolkit } from "../src/mcp/fio-tools.js";
import { makeRedactor } from "../src/redaction.js";
import { Auth, Unauthorized } from "../src/transport/auth.js";
import { clientAddress } from "../src/transport/client-address.js";
import { makeFrameRedactor } from "../src/transport/frame-redaction.js";
import {
  type HttpTransportConfig,
  isAllowedHost,
  MAX_BODY_BYTES,
  makeSessionOwners,
  serveHttp,
} from "../src/transport/http.js";
import { CurrentPrincipal } from "../src/transport/principal.js";
import { ACCOUNT_NAMES, FIO_TOKEN, testConfig, testServices } from "./support/transport.js";

const transport = (overrides: Partial<HttpTransportConfig> = {}): HttpTransportConfig => ({
  kind: "http",
  host: "127.0.0.1",
  port: 0,
  auth: { kind: "unauthenticated" },
  allowedOrigins: [],
  allowedHosts: [],
  trustedProxies: [],
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
          return { subject: principal.subject, accounts: principal.accountFingerprints };
        }),
    }),
  ),
);

/** Serves the app on an ephemeral port for the rest of the scope. */
const startServer = Effect.fnUntraced(function* (
  config: HttpTransportConfig,
  auth: Layer.Layer<Auth, never, HttpRouter.HttpRouter> = Auth.Open,
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

/**
 * POSTs `total` bytes in chunks without a Content-Length; resolves with the
 * status even if the server stops reading, or "reset" if the server drops the
 * connection before answering.
 */
const postChunked = (url: string, total: number) =>
  Effect.promise(
    () =>
      new Promise<number | "reset">((resolve, reject) => {
        const req = nodeRequest(
          url,
          {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        // A no-op once the response has resolved the promise.
        req.on("error", (error: NodeJS.ErrnoException) =>
          error.code === "ECONNRESET" || error.code === "EPIPE" ? resolve("reset") : reject(error),
        );
        const chunk = Buffer.alloc(64 * 1024, "x");
        let sent = 0;
        const pump = () => {
          while (sent < total) {
            sent += chunk.length;
            if (!req.write(chunk)) return void req.once("drain", pump);
          }
          req.end();
        };
        pump();
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

const FIO_TOOL_NAMES = [
  ...Object.keys(makeFioToolkit(ACCOUNT_NAMES).tools),
  ...Object.keys(makeCacheToolkit(ACCOUNT_NAMES).tools),
  "whoami",
].sort();

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
          allowedHosts: ["fio.example.test"],
          trustedProxies: [],
          allowedOrigins: ["https://fio.example.test"],
        }),
        Layer.succeed(
          Auth,
          Auth.of({ authenticate: () => Effect.fail(new Unauthorized({ challenge: "Bearer" })) }),
        ),
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

  it.live("answers 413 to /mcp bodies over the limit, declared or streamed, and keeps serving", () =>
    Effect.gen(function* () {
      const { base } = yield* startServer(transport());
      const big = yield* raw(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: "x".repeat(MAX_BODY_BYTES + 1),
      });
      assert.strictEqual(big.status, 413);
      // Effect 4.0.5 destroys the request once a streamed body passes
      // MaxBodySize, so the connection resets before the 413 can be sent.
      // The reset is accepted only until Effect 4.0.6; restore the 413-only assertion then.
      assert.include([413, "reset"], yield* postChunked(`${base}/mcp`, 4 * MAX_BODY_BYTES));
      assert.strictEqual((yield* postInitialize(base)).status, 200);
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

  it.live("takes the client address from the socket, not from X-Forwarded-For", () =>
    Effect.gen(function* () {
      // Effect 4.0.5 has no peerAddress: clientAddress reads remoteAddress,
      // which only HttpMiddleware.xForwardedHeaders would replace, and only
      // when X-Forwarded-Host is present.
      const auth = Layer.mergeAll(
        Auth.layerOpen,
        HttpRouter.add(
          "GET",
          "/address",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return HttpServerResponse.text(clientAddress(request, []));
          }),
        ),
      );
      const { base } = yield* startServer(transport(), auth);
      const response = yield* raw(`${base}/address`, {
        headers: { "x-forwarded-for": "192.0.2.1", "x-forwarded-host": "127.0.0.1", "x-real-ip": "192.0.2.2" },
      });
      assert.strictEqual(response.body, "127.0.0.1");
    }).pipe(Effect.scoped),
  );

  it.live("hands the authenticated principal to tool handlers and lets Auth add routes", () =>
    Effect.gen(function* () {
      // Stands in for an OAuth server: its own route, and a principal per token.
      const auth = Layer.mergeAll(
        Layer.succeed(Auth, {
          authenticate: (request) => {
            const subject = /^Bearer (alice|bob)$/.exec(request.headers.authorization ?? "")?.[1];
            return subject === undefined
              ? Effect.fail(new Unauthorized({ challenge: 'Bearer resource_metadata="/.well-known/test"' }))
              : Effect.succeed({ subject, scopes: ["fio:read"], accountFingerprints: [subject === "alice" ? "main" : "savings"] });
          },
        }),
        HttpRouter.add("GET", "/.well-known/test", HttpServerResponse.text("metadata")),
      );
      const { base } = yield* startServer(transport(), auth);
      assert.strictEqual((yield* raw(`${base}/.well-known/test`)).body, "metadata");
      const denied = yield* postInitialize(base);
      assert.strictEqual(denied.status, 401);
      assert.strictEqual(denied.headers["www-authenticate"], 'Bearer resource_metadata="/.well-known/test"');

      // Concurrent sessions each see their own principal.
      const [alice, bob] = yield* Effect.all([
        connect(base, { authorization: "Bearer alice" }),
        connect(base, { authorization: "Bearer bob" }),
      ]);
      const whoami = (client: Client) =>
        Effect.promise(() => client.callTool({ name: "whoami", arguments: {} })).pipe(
          Effect.map((result) => JSON.parse(textOf(result))),
        );
      const results = yield* Effect.all([whoami(alice), whoami(bob), whoami(alice), whoami(bob)], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(results, [
        { subject: "alice", accounts: ["main"] },
        { subject: "bob", accounts: ["savings"] },
        { subject: "alice", accounts: ["main"] },
        { subject: "bob", accounts: ["savings"] },
      ]);
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

describe("session owners", () => {
  const limits = { maxTracked: 3, maxPerSubject: 2, idleMs: 1000 };

  it("counts sessions being ended against the server limit until McpServer has ended them", () => {
    const owners = makeSessionOwners(limits);
    for (const [subject, session] of [["a", "a1"], ["b", "b1"], ["c", "c1"]] as const) {
      const admission = owners.admit(subject, 0);
      assert.strictEqual(admission._tag, "Admitted");
      if (admission._tag === "Admitted") owners.settle(admission.reservation, subject, session, "2025-11-25", 0);
    }
    assert.strictEqual(owners.admit("d", 500)._tag, "ServerFull");
    const admission = owners.admit("d", 2000);
    if (admission._tag !== "Admitted" || admission.evicted === undefined) return assert.fail("expected an eviction");
    assert.strictEqual(admission.evicted.session, "a1");
    assert.strictEqual(admission.evicted.slot.protocolVersion, "2025-11-25");
    // a1 (being ended) and d's reservation both count.
    assert.strictEqual(owners.size(), 4);
    assert.strictEqual(owners.use("a1", "a", 2000), undefined);
    owners.ended(admission.evicted, true);
    owners.settle(admission.reservation, "d", "d1", undefined, 2000);
    assert.strictEqual(owners.size(), 3);
  });

  it("keeps a session that could not be ended, and never ends a busy one", () => {
    const owners = makeSessionOwners(limits);
    const first = owners.admit("a", 0);
    if (first._tag === "Admitted") owners.settle(first.reservation, "a", "a1", undefined, 0);
    const second = owners.admit("a", 0);
    if (second._tag === "Admitted") owners.settle(second.reservation, "a", "a2", undefined, 0);
    const busy = owners.use("a2", "a", 0);
    assert.isDefined(busy);
    const admission = owners.admit("a", 5000);
    assert.strictEqual(admission._tag, "Admitted");
    if (admission._tag !== "Admitted" || admission.evicted === undefined) return assert.fail("expected an eviction");
    assert.strictEqual(admission.evicted.session, "a1");
    owners.ended(admission.evicted, false);
    owners.settle(admission.reservation, "a", undefined, undefined, 5000);
    assert.isDefined(owners.use("a1", "a", 5000));
    // Both sessions are now busy: nothing can be ended.
    assert.strictEqual(owners.admit("a", 10_000)._tag, "SubjectFull");
  });
});
