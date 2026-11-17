/**
 * A second app on core: "data boxes" with scopes demo:read / demo:write,
 * resources named by a `box` parameter, and one tool that takes no box.
 * It uses only core's seams (Resources, ToolPolicy, grants, registration,
 * grant-filtered tools/list), so a new server needs no core changes.
 */

import { assert, describe, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Exit, Layer, Schema, SubscriptionRef, type Types } from "effect";
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServer, HttpServerRequest, type HttpServerResponse } from "effect/http";
import {
  coveredResources,
  holdsScopes,
  isListed,
  missingScopes,
  requireResource,
  requireScopes,
  ToolPolicy,
  type ToolPolicyShape,
} from "../src/mcp/grants.js";
import { ToolListChangesLive, toolsForResources } from "../src/mcp/registration.js";
import { type Resource, Resources } from "../src/resources.js";
import { grantedTools, grantProtocols } from "../src/transport/grant-tools.js";
import { CurrentPrincipal, NO_PRINCIPAL, type Principal } from "../src/transport/principal.js";

const READ = "demo:read";
const WRITE = "demo:write";

const OFFICE: Resource = { id: "box-a1", label: "office" };
const HOME: Resource = { id: "box-b2", label: "home" };
const TRAVEL: Resource = { id: "box-c3", label: "travel" };

const POLICY: ToolPolicyShape = {
  scopes: (tool) => (tool === "send_message" ? [READ, WRITE] : [READ]),
  resourceless: (tool) => tool === "server_status",
  resourceParameter: "box",
};

const PRINCIPALS = {
  reader: { subject: "reader", scopes: [READ], resources: [OFFICE.id] },
  writer: { subject: "writer", scopes: [READ, WRITE], resources: "all" },
  boxless: { subject: "boxless", scopes: [READ, WRITE], resources: [] },
  stale: { subject: "stale", scopes: [READ], resources: ["box-gone"] },
} satisfies Record<string, Principal>;

class Denied extends Schema.TaggedError<Denied>()("Denied", { reason: Schema.String }) {}

const makeToolkit = (labels: ReadonlyArray<string>) => {
  const box = Schema.Literals(labels).annotate({ description: "Name of the data box." });
  return Toolkit.make(
    Tool.make("list_messages", {
      description: "Lists the messages in a box.",
      parameters: Schema.Struct({ box }),
      success: Schema.Struct({ box: Schema.String }),
      failure: Denied,
      failureMode: "error",
    }),
    Tool.make("send_message", {
      description: "Sends a message from a box.",
      parameters: Schema.Struct({ box, text: Schema.String }),
      success: Schema.Struct({ sent: Schema.String }),
      failure: Denied,
      failureMode: "error",
    }),
    Tool.make("server_status", {
      description: "Reports the server status.",
      parameters: Tool.EmptyParams,
      success: Schema.Struct({ ok: Schema.Boolean }),
      failure: Denied,
      failureMode: "error",
    }),
  );
};

/** The app's own checks, on core's primitives and its own errors. */
const permittedBox = Effect.fnUntraced(function* (label: string, scopes: ReadonlyArray<string>) {
  yield* requireScopes(scopes, (missing) => new Denied({ reason: `missing ${missing.join(" and ")}` }));
  const resources = yield* Resources;
  const box = (yield* resources.list).find((resource) => resource.label === label);
  if (box === undefined) return yield* new Denied({ reason: `no box ${label}` });
  yield* requireResource(box.id, () => new Denied({ reason: `box ${label} not granted` }));
  return box;
});

const BoxToolsLive = toolsForResources((labels) => {
  const toolkit = makeToolkit(labels);
  const handlers = Effect.map(Effect.context<Resources>(), (context) =>
    toolkit.of({
      list_messages: ({ box }) => permittedBox(box, [READ]).pipe(Effect.as({ box }), Effect.provideContext(context)),
      send_message: ({ box, text }) =>
        permittedBox(box, [READ, WRITE]).pipe(Effect.as({ sent: `${box}: ${text}` }), Effect.provideContext(context)),
      server_status: () =>
        requireScopes([READ], (missing) => new Denied({ reason: `missing ${missing.join(" and ")}` })).pipe(Effect.as({ ok: true })),
    }),
  );
  return McpServer.registerToolkit(toolkit).pipe(Effect.provide(toolkit.toLayer(handlers)));
}, "demo: could not update the tools after a box change");

/** Stands in for an authenticating transport: the principal named by the bearer token. */
const principalFromBearer = HttpRouter.middleware(
  Effect.succeed(
    Effect.fnUntraced(function* (httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      const principal: Principal | undefined = PRINCIPALS[bearer as keyof typeof PRINCIPALS];
      return yield* Effect.provideService(httpEffect, CurrentPrincipal, principal ?? NO_PRINCIPAL);
    }),
  ),
);

const PROTOCOLS = [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26] as const;

/** The demo server on an in-process web handler; `boxes` drives Resources. */
const startDemo = async (boxes: SubscriptionRef.SubscriptionRef<ReadonlyArray<Resource>>) => {
  const resources = Layer.succeed(
    Resources,
    Resources.of({ list: SubscriptionRef.get(boxes), changes: SubscriptionRef.changes(boxes) }),
  );
  const mcp = Layer.unwrap(
    Effect.gen(function* () {
      const current = yield* Resources;
      const policy = yield* ToolPolicy;
      return McpServer.layerHttp({
        name: "demo-boxes",
        version: "0.0.0",
        protocols: grantProtocols(PROTOCOLS, current.list, policy),
        path: "/mcp",
      }).pipe(Layer.provide(principalFromBearer.layer));
    }),
  );
  const app = Layer.mergeAll(BoxToolsLive, ToolListChangesLive).pipe(
    Layer.provideMerge(mcp),
    Layer.provide(Layer.mergeAll(resources, ToolPolicy.layer(POLICY))),
    Layer.provide(HttpServer.layerServices),
  );
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  const clients: Array<Client> = [];
  const connect = async (bearer: string) => {
    const client = new Client({ name: bearer, version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://demo.test/mcp"), {
        fetch: (url, init) => web.handler(new Request(url, init)),
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      }),
    );
    clients.push(client);
    return client;
  };
  const close = async () => {
    for (const client of clients) await client.close();
    await web.dispose();
  };
  return { connect, close };
};

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"];

const boxEnums = (tools: Listed) =>
  Object.fromEntries(
    tools.map((tool) => [tool.name, (tool.inputSchema.properties?.box as { enum?: Array<string> } | undefined)?.enum]),
  );

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");

describe("grants (demo app)", () => {
  it.effect("checks scopes and resources with the app's own denial", () =>
    Effect.gen(function* () {
      const reader = PRINCIPALS.reader;
      assert.isTrue(holdsScopes(reader, [READ]));
      assert.isFalse(holdsScopes(reader, [READ, WRITE]));
      assert.deepStrictEqual(missingScopes(reader, [READ, WRITE]), [WRITE]);
      assert.deepStrictEqual(coveredResources(reader, [OFFICE, HOME]), [OFFICE]);
      assert.deepStrictEqual(coveredResources(PRINCIPALS.writer, [OFFICE, HOME]), [OFFICE, HOME]);

      const asReader = <A, E>(effect: Effect.Effect<A, E>) => Effect.exit(Effect.provideService(effect, CurrentPrincipal, reader));
      const scopeExit = yield* asReader(requireScopes([READ, WRITE], (missing) => new Denied({ reason: missing.join(",") })));
      assert.deepStrictEqual(scopeExit, Exit.fail(new Denied({ reason: WRITE })));
      assert.isTrue(Exit.isSuccess(yield* asReader(requireScopes([READ], () => new Denied({ reason: "x" })))));
      assert.isTrue(Exit.isSuccess(yield* asReader(requireResource(OFFICE.id, () => new Denied({ reason: "x" })))));
      const boxExit = yield* asReader(requireResource(HOME.id, () => new Denied({ reason: "home" })));
      assert.deepStrictEqual(boxExit, Exit.fail(new Denied({ reason: "home" })));
      // The default principal (a call that missed the transport's guard) holds nothing.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(requireScopes([READ], () => new Denied({ reason: "x" })))));
    }),
  );

  it("grantedTools narrows the resource parameter by label and drops what the grant lacks", () => {
    const tool = (name: string, properties: Record<string, object> = {}) =>
      McpSchema.Tool.make({ name, inputSchema: { type: "object", properties } });
    const box = { type: "string", enum: [OFFICE.label, HOME.label] };
    const tools = [
      tool("list_messages", { box }),
      tool("send_message", { box, text: { type: "string" } }),
      tool("server_status"),
    ];
    const visible = (principal: Principal) => grantedTools(tools, principal, [OFFICE, HOME], POLICY);
    const enums = (principal: Principal) =>
      Object.fromEntries(
        visible(principal).map((tool) => [tool.name, (tool.inputSchema.properties?.box as { enum?: unknown })?.enum]),
      );
    assert.deepStrictEqual(enums(PRINCIPALS.reader), { list_messages: ["office"], server_status: undefined });
    assert.deepStrictEqual(enums(PRINCIPALS.writer), {
      list_messages: ["office", "home"],
      send_message: ["office", "home"],
      server_status: undefined,
    });
    // A grant covering no box (or only a box that is gone) keeps the box-less tool only.
    assert.deepStrictEqual(enums(PRINCIPALS.boxless), { server_status: undefined });
    assert.deepStrictEqual(enums(PRINCIPALS.stale), { server_status: undefined });
    assert.deepStrictEqual(visible(NO_PRINCIPAL), []);
  });

  it("a tool the policy does not list is hidden from every grant's tools/list", () => {
    const tool = (name: string, properties: Record<string, object> = {}) =>
      McpSchema.Tool.make({ name, inputSchema: { type: "object", properties } });
    const box = { type: "string", enum: [OFFICE.label] };
    const tools = [tool("list_messages", { box }), tool("server_status")];
    const hiding: ToolPolicyShape = { ...POLICY, listed: (name) => name !== "server_status" };
    assert.isTrue(isListed(POLICY, "server_status"));
    assert.isFalse(isListed(hiding, "server_status"));
    assert.deepStrictEqual(
      grantedTools(tools, PRINCIPALS.writer, [OFFICE], hiding).map((t) => t.name),
      ["list_messages"],
    );
    assert.deepStrictEqual(
      grantedTools(tools, PRINCIPALS.writer, [OFFICE], POLICY).map((t) => t.name),
      ["list_messages", "server_status"],
    );
  });


  it("serves tools/list per grant over HTTP, follows box changes, and the app checks every call", async () => {
    const boxes = Effect.runSync(SubscriptionRef.make<ReadonlyArray<Resource>>([OFFICE, HOME]));
    const demo = await startDemo(boxes);
    try {
      const reader = await demo.connect("reader");
      const writer = await demo.connect("writer");
      assert.deepStrictEqual(boxEnums((await reader.listTools()).tools), {
        list_messages: ["office"],
        server_status: undefined,
      });
      assert.deepStrictEqual(boxEnums((await writer.listTools()).tools), {
        list_messages: ["office", "home"],
        send_message: ["office", "home"],
        server_status: undefined,
      });

      // Listing is discovery only: hidden tools and boxes are still refused by the app.
      const send = await reader.callTool({ name: "send_message", arguments: { box: "office", text: "hi" } });
      assert.isTrue(send.isError === true);
      assert.include(textOf(send), "missing demo:write");
      const home = await reader.callTool({ name: "list_messages", arguments: { box: "home" } });
      assert.isTrue(home.isError === true);
      assert.include(textOf(home), "box home not granted");
      const sent = await writer.callTool({ name: "send_message", arguments: { box: "home", text: "hi" } });
      assert.notStrictEqual(sent.isError, true);
      assert.include(textOf(sent), "home: hi");

      // A new box re-registers the tools with the new labels.
      Effect.runSync(SubscriptionRef.set(boxes, [OFFICE, HOME, TRAVEL]));
      await Effect.runPromise(Effect.yieldNow);
      assert.deepStrictEqual(boxEnums((await writer.listTools()).tools).list_messages, ["office", "home", "travel"]);
      assert.deepStrictEqual(boxEnums((await reader.listTools()).tools).list_messages, ["office"]);
    } finally {
      await demo.close();
    }
  });
});
