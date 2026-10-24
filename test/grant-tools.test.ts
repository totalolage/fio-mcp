import { assert, describe, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Cause, Context, Deferred, Effect, Exit, Layer, Redacted } from "effect";
import { McpProtocol, McpSchema } from "effect/ai";
import { HttpServer } from "effect/http";
import { toAccount, tokenFingerprint } from "../src/accounts.js";
import { MCP_PROTOCOLS, SERVER_INFO, ToolsLive } from "../src/app.js";
import { makeCacheToolkit } from "../src/mcp/cache-tools.js";
import { makeFioToolkit } from "../src/mcp/fio-tools.js";
import { ACCOUNTLESS_TOOLS, PAYMENT_TOOLS, SCOPE_PAYMENTS, SCOPE_READ } from "../src/mcp/permissions.js";
import { Auth, Unauthorized } from "../src/transport/auth.js";
import { grantedTools, grantProtocols } from "../src/transport/grant-tools.js";
import { type HttpTransportConfig, serveHttp } from "../src/transport/http.js";
import type { Principal } from "../src/transport/principal.js";
import { ACCOUNT_NAMES, FIO_TOKEN, SAVINGS_TOKEN, testConfig, testServices } from "./support/transport.js";

const MAIN = tokenFingerprint(Redacted.make(FIO_TOKEN));
const SAVINGS = tokenFingerprint(Redacted.make(SAVINGS_TOKEN));

/** Bearer token → grant. */
const PRINCIPALS: Record<string, Principal> = {
  // Read-only, main only.
  alice: { subject: "alice", scopes: [SCOPE_READ], accountFingerprints: [MAIN] },
  // Everything.
  bob: { subject: "bob", scopes: [SCOPE_READ, SCOPE_PAYMENTS], accountFingerprints: [MAIN, SAVINGS] },
  // Granted a token that has since been rotated: no configured account left.
  carol: { subject: "carol", scopes: [SCOPE_READ, SCOPE_PAYMENTS], accountFingerprints: ["0".repeat(32)] },
};

const FakeAuth = Layer.succeed(
  Auth,
  Auth.of({
    authenticate: (request) => {
      const principal = PRINCIPALS[(request.headers.authorization ?? "").replace(/^Bearer /, "")];
      return principal === undefined ? Effect.fail(new Unauthorized({ challenge: "Bearer" })) : Effect.succeed(principal);
    },
  }),
);

const config: HttpTransportConfig = {
  kind: "http",
  host: "127.0.0.1",
  port: 0,
  auth: { kind: "unauthenticated" },
  allowedOrigins: [],
  allowedHosts: [],
  trustedProxies: [],
};

const startServer = Effect.fnUntraced(function* () {
  const release = yield* Deferred.make<void>();
  const app = serveHttp(ToolsLive, FakeAuth, SERVER_INFO, config).pipe(Layer.provide(testServices(testConfig(config), release)));
  const context = yield* Layer.build(app);
  const address = Context.get(context, HttpServer.HttpServer).address;
  const port = "port" in address ? address.port : 0;
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
  return `http://127.0.0.1:${port}`;
});

/** Offers `offered` in `initialize` instead of the SDK's latest revision. */
class PinnedTransport extends StreamableHTTPClientTransport {
  constructor(
    url: URL,
    options: StreamableHTTPClientTransportOptions,
    private readonly offered: string | undefined,
  ) {
    super(url, options);
  }

  override send(message: JSONRPCMessage, options?: Parameters<StreamableHTTPClientTransport["send"]>[1]) {
    if (this.offered === undefined || !("method" in message) || message.method !== "initialize") {
      return super.send(message, options);
    }
    return super.send({ ...message, params: { ...message.params, protocolVersion: this.offered } }, options);
  }
}

/** An SDK client for `bearer`, closed with the scope; `protocolVersion` pins the offered revision. */
const connect = (base: string, bearer: string, protocolVersion?: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new Client({ name: bearer, version: "0.0.0" });
      const transport = new PinnedTransport(
        new URL("/mcp", base),
        { requestInit: { headers: { authorization: `Bearer ${bearer}` } } },
        protocolVersion,
      );
      yield* Effect.tryPromise(() => client.connect(transport));
      return { client, transport };
    }),
    ({ client }) => Effect.promise(() => client.close()),
  );

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"];

const list = (client: Client) => Effect.promise(() => client.listTools()).pipe(Effect.map((result) => result.tools));

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  Effect.promise(() => client.callTool({ name, arguments: args })).pipe(
    Effect.map((result) => ({
      isError: result.isError === true,
      text: (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n"),
    })),
  );

const ALL_TOOLS = [...Object.keys(makeFioToolkit(ACCOUNT_NAMES).tools), ...Object.keys(makeCacheToolkit(ACCOUNT_NAMES).tools)].sort();
// Spelled out, not derived from PAYMENT_TOOLS: a new tool must be classified here.
const READ_TOOLS = [
  "export_transactions",
  "get_cache_status",
  "get_last_statement",
  "get_new_transactions",
  "get_server_status",
  "get_statement",
  "get_transactions",
  "search_transactions",
  "set_download_marker",
  "summarize_transactions",
  "sync_transactions",
];
const DENIED = /^You don't have permissions to do that\./;
const ORDER = { type: "domestic", amount: 100, accountTo: "2212-2000000699", bankCode: "0300", date: "2025-11-03" };

const namesOf = (tools: Listed) => tools.map((tool) => tool.name).sort();

/** Asserts every account-taking tool offers exactly `accounts`, and no other tool has the parameter. */
const assertAccounts = (tools: Listed, accounts: ReadonlyArray<string>) => {
  for (const tool of tools) {
    const account = tool.inputSchema.properties?.account;
    if (ACCOUNTLESS_TOOLS.has(tool.name)) {
      assert.isUndefined(account, tool.name);
      continue;
    }
    assert.deepStrictEqual(account, { type: "string", enum: accounts, description: "Name of the account to use." }, tool.name);
    assert.include(tool.inputSchema.required ?? [], "account", tool.name);
  }
};

describe("tools/list follows the HTTP session's grant", () => {
  it.live("gives concurrent sessions their own tools and account enums", () =>
    Effect.gen(function* () {
      const base = yield* startServer();
      const [alice, bob] = yield* Effect.all([connect(base, "alice"), connect(base, "bob")], { concurrency: "unbounded" });
      const rounds = yield* Effect.all(
        Array.from({ length: 5 }, () => Effect.all([list(alice.client), list(bob.client)], { concurrency: "unbounded" })),
        { concurrency: "unbounded" },
      );
      for (const [aliceTools, bobTools] of rounds) {
        assert.deepStrictEqual(namesOf(aliceTools), READ_TOOLS);
        assertAccounts(aliceTools, ["main"]);
        assert.deepStrictEqual(namesOf(bobTools), ALL_TOOLS);
        assertAccounts(bobTools, ["main", "savings"]);
      }
    }).pipe(Effect.scoped),
  );

  it.live("refuses hidden payment tools by name and allows them with fio:payments", () =>
    Effect.gen(function* () {
      const base = yield* startServer();
      const alice = yield* connect(base, "alice");
      const bob = yield* connect(base, "bob");
      const calls = {
        preview_payment_orders: { account: "main", orders: [ORDER] },
        submit_payment_orders: { account: "main", orders: [ORDER], confirm: true },
      };
      assert.deepStrictEqual(Object.keys(calls).sort(), [...PAYMENT_TOOLS].sort());
      for (const [name, args] of Object.entries(calls)) {
        const denied = yield* call(alice.client, name, args);
        assert.isTrue(denied.isError, name);
        assert.match(denied.text, DENIED, name);
        assert.include(denied.text, SCOPE_PAYMENTS, name);
      }
      const preview = yield* call(bob.client, "preview_payment_orders", { account: "main", orders: [ORDER] });
      assert.isFalse(preview.isError, preview.text);
    }).pipe(Effect.scoped),
  );

  it.live("hides the account tools from a grant that covers no configured account", () =>
    Effect.gen(function* () {
      const base = yield* startServer();
      const carol = yield* connect(base, "carol");
      assert.deepStrictEqual(namesOf(yield* list(carol.client)), [...ACCOUNTLESS_TOOLS].sort());
      const hidden = yield* call(carol.client, "get_last_statement", { account: "main" });
      assert.isTrue(hidden.isError);
      assert.match(hidden.text, DENIED);
      assert.include(hidden.text, '"main"');
    }).pipe(Effect.scoped),
  );

  // grant-tools.ts relies on Effect's unstable adapter API; each offered
  // revision is pinned so an Effect upgrade that changes it fails here.
  for (const protocol of MCP_PROTOCOLS) {
    it.live(`filters tools/list and keeps per-call checks on MCP ${protocol.protocolVersion}`, () =>
      Effect.gen(function* () {
        const base = yield* startServer();
        const alice = yield* connect(base, "alice", protocol.protocolVersion);
        const tools = yield* list(alice.client);
        // The revision the server answered with, sent on every later request.
        assert.strictEqual(alice.transport.protocolVersion, protocol.protocolVersion);
        assert.deepStrictEqual(namesOf(tools), READ_TOOLS);
        for (const tool of tools) {
          if (!ACCOUNTLESS_TOOLS.has(tool.name)) {
            assert.deepStrictEqual(tool.inputSchema.properties?.account, { type: "string", enum: ["main"], description: "Name of the account to use." }, tool.name);
          }
        }
        const hidden = yield* call(alice.client, "submit_payment_orders", { account: "main", orders: [ORDER], confirm: true });
        assert.isTrue(hidden.isError);
        assert.match(hidden.text, DENIED);
        const bob = yield* connect(base, "bob", protocol.protocolVersion);
        assert.deepStrictEqual(namesOf(yield* list(bob.client)), ALL_TOOLS);
      }).pipe(Effect.scoped),
    );
  }
});

describe("grantedTools", () => {
  const tool = (name: string, properties: Record<string, object> = {}) =>
    McpSchema.Tool.make({ name, inputSchema: { type: "object", properties } });
  const accounts = [
    toAccount({ name: "main", token: Redacted.make(FIO_TOKEN), accountNumber: undefined, currency: undefined }, "env:0"),
  ];

  it("lists exactly the configured tools as read tools or payment tools", () => {
    assert.deepStrictEqual([...PAYMENT_TOOLS].sort(), ["preview_payment_orders", "submit_payment_orders"]);
    assert.deepStrictEqual([...READ_TOOLS, ...PAYMENT_TOOLS].sort(), ALL_TOOLS);
  });

  it("hides a tool whose account parameter has no enum to narrow", () => {
    const granted: Principal = { subject: "x", scopes: [SCOPE_READ], accountFingerprints: [MAIN] };
    const tools = [tool("get_last_statement", { account: { anyOf: [{ const: "main" }, { const: "savings" }] } })];
    assert.deepStrictEqual(grantedTools(tools, granted, accounts), []);
  });

  it("hides account tools without an account parameter when the only account is not granted", () => {
    const tools = [tool("get_last_statement"), tool("get_server_status")];
    const rotated: Principal = { subject: "x", scopes: [SCOPE_READ], accountFingerprints: [SAVINGS] };
    assert.deepStrictEqual(
      grantedTools(tools, rotated, accounts).map((t) => t.name),
      ["get_server_status"],
    );
    const granted: Principal = { subject: "x", scopes: [SCOPE_READ], accountFingerprints: [MAIN] };
    assert.deepStrictEqual(grantedTools(tools, granted, accounts), tools);
  });
});

describe("grantProtocols", () => {
  const install = (adapter: McpProtocol.ProtocolAdapter, core: unknown) => {
    const [granted] = grantProtocols([adapter], Effect.succeed([]));
    // Only the guards run before the stock handlers would need their services.
    return Effect.exit((granted as McpProtocol.AnyProtocolAdapter<string, never>).installHandlers(core, undefined, undefined));
  };

  it.effect("fails at handler installation when the core has no tools.list", () =>
    Effect.gen(function* () {
      const exit = yield* install(McpProtocol.v2025_11_25, { tools: {} });
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    }),
  );

  it.effect("refuses stateless revisions, which are not offered or tested", () =>
    Effect.gen(function* () {
      const exit = yield* install(McpProtocol.v2026_07_28, { tools: { list: () => Effect.succeed([]) } });
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    }),
  );
});
