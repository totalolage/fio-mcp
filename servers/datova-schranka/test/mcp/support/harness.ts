import { ToolPolicy } from "@mcps/core/mcp/grants.js";
import { makeRedactor, Redactor } from "@mcps/core/redaction.js";
import { type Resource, Resources } from "@mcps/core/resources.js";
import { grantProtocols } from "@mcps/core/transport/grant-tools.js";
import { CurrentPrincipal, NO_PRINCIPAL, type Principal } from "@mcps/core/transport/principal.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Context, Effect, Exit, Layer, Scope, Stream, type Types } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter, HttpServer, HttpServerRequest, type HttpServerResponse } from "effect/http";
import { type AuditEntry, AuditLog } from "../../../src/domain/audit-log.js";
import { type Box, BoxRegistry } from "../../../src/domain/boxes.js";
import { DomainConfig, type DomainConfigShape } from "../../../src/domain/config.js";
import { BoxNotFound } from "../../../src/domain/errors.js";
import { ReadService } from "../../../src/domain/read-service.js";
import { toolPolicyLayer } from "../../../src/mcp/policy.js";
import { readToolGroup } from "../../../src/mcp/read-tools.js";
import { READ_SCOPE } from "../../../src/mcp/tool-group.js";
import { memoryDatabase } from "../../domain/support/database.js";
import { type ReadReplies, readBoxClients } from "../../domain/support/read-box-clients.js";
import { readTestBox } from "../../domain/support/read-box-registry.js";
import { readZfoStore } from "../../domain/support/read-zfo-store.js";

export const BOX_ID = "box_AAAAAAAAAAAAAAAAAAAAAA";
export const OTHER_BOX_ID = "box_BBBBBBBBBBBBBBBBBBBBBB";
export const DB_ID = "xyz9876";
export const OTHER_DB_ID = "abc1234";
export const LABEL = "Office";
export const OTHER_LABEL = "Home";
export const CONSENT_VERSION = "2026-11-17.1";

export const testBox = (id: string, dbId: string, label: string): Box => ({
  ...readTestBox(id, dbId),
  label,
  owner: { dbID: dbId, firmName: `${label} s.r.o.`, ic: "12345678", dbType: "PO" },
});

export const BOX = testBox(BOX_ID, DB_ID, LABEL);
export const OTHER_BOX = testBox(OTHER_BOX_ID, OTHER_DB_ID, OTHER_LABEL);

/** An OAuth grant principal as core's HTTP guard provides it. */
export const grant = (
  subject: string,
  options: {
    readonly scopes?: ReadonlyArray<string>;
    readonly boxes?: ReadonlyArray<string>;
    readonly consent?: string | null;
  } = {},
): Principal => ({
  subject,
  clientId: `client-${subject}`,
  scopes: options.scopes ?? [READ_SCOPE],
  resources: options.boxes ?? [BOX_ID],
  settings: {
    deliveryConsentVersion: options.consent === undefined ? CONSENT_VERSION : options.consent,
    deliveryConsentedAt: null,
  },
});

/** BoxRegistry over a mutable list of loaded boxes; only list and get are used by the tools. */
const testRegistry = (boxes: Array<Box>) => {
  const unused = Effect.die("test registry: not used by the tools");
  return Layer.succeed(
    BoxRegistry,
    BoxRegistry.of({
      list: Effect.sync(() => [...boxes]),
      changes: Stream.empty,
      skipped: Effect.succeed([]),
      get: (boxId) => {
        const box = boxes.find((candidate) => candidate.id === boxId);
        return box === undefined ? Effect.fail(new BoxNotFound({ boxId })) : Effect.succeed(box);
      },
      add: () => unused,
      relabel: () => unused,
      replaceCredentials: () => unused,
      testConnection: () => unused,
      remove: () => unused,
      credentials: () => unused,
    }),
  );
};

/** Stands in for core's HTTP guard: the principal named by the bearer token. */
const principalFromBearer = (principals: Readonly<Record<string, Principal>>) =>
  HttpRouter.middleware(
    Effect.succeed(
      Effect.fnUntraced(function* (httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
        return yield* Effect.provideService(httpEffect, CurrentPrincipal, principals[bearer] ?? NO_PRINCIPAL);
      }),
    ),
  );

const PROTOCOLS = [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26] as const;

export interface StartOptions {
  /** Loaded boxes (the registry's list); BOX by default. The fake ISDS serves the first one. */
  readonly boxes?: ReadonlyArray<Box>;
  /** Labels the tools are registered for; the boxes' labels by default. */
  readonly labels?: ReadonlyArray<string>;
  readonly replies?: ReadReplies;
  /** Secrets registered with the Redactor. */
  readonly secrets?: ReadonlyArray<string>;
  readonly config?: Partial<Pick<DomainConfigShape, "attachmentInlineMaxBytes" | "responseInlineMaxBytes">>;
  readonly principals: Readonly<Record<string, Principal>>;
}

export interface ToolResult {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly resource?: { readonly uri: string; readonly mimeType?: string; readonly blob?: string };
  }>;
  readonly structuredContent?: unknown;
}

/**
 * The read tools on an in-process MCP server (core's grant-filtered HTTP
 * protocols, real ReadService and AuditLog over SQLite, fake ISDS
 * transport). `connect(bearer)` is an SDK client calling as that principal.
 */
export const startTools = async (options: StartOptions) => {
  const boxes = [...(options.boxes ?? [BOX])];
  const log: Array<string> = [];
  const clients = readBoxClients(boxes[0]?.id ?? BOX_ID, options.replies ?? {}, log);
  const zfo = readZfoStore(log);
  const infrastructure = Layer.mergeAll(
    memoryDatabase(),
    Layer.succeed(Redactor, makeRedactor(options.secrets ?? [])),
    DomainConfig.layer({ dataDir: "/unused", ...options.config }),
    testRegistry(boxes),
    clients.layer,
    zfo.layer,
  );
  const services = ReadService.Default.pipe(Layer.provideMerge(AuditLog.Default.pipe(Layer.provideMerge(infrastructure))));
  const scope = Scope.makeUnsafe();
  const context: Context.Context<ReadService | AuditLog | BoxRegistry | Redactor | DomainConfig> = await Effect.runPromise(
    Layer.buildWithScope(services, scope),
  );

  const resources: ReadonlyArray<Resource> = boxes.map((box) => ({ id: box.id, label: box.label }));
  const mcp = Layer.unwrap(
    Effect.gen(function* () {
      const current = yield* Resources;
      const policy = yield* ToolPolicy;
      return McpServer.layerHttp({
        name: "datova-schranka-test",
        version: "0.0.0",
        protocols: grantProtocols(PROTOCOLS, current.list, policy),
        path: "/mcp",
      }).pipe(Layer.provide(principalFromBearer(options.principals).layer));
    }),
  );
  const tools = Layer.effectDiscard(readToolGroup.register(options.labels ?? boxes.map((box) => box.label)));
  const app = tools.pipe(
    Layer.provideMerge(mcp),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Resources, Resources.of({ list: Effect.succeed(resources), changes: Stream.empty })),
        toolPolicyLayer(readToolGroup.specs),
      ),
    ),
    Layer.provide(Layer.succeedContext(context)),
    Layer.provide(HttpServer.layerServices),
  );
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  const connected: Array<Client> = [];
  const connect = async (bearer: string) => {
    const client = new Client({ name: bearer, version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://datova-schranka.test/mcp"), {
        fetch: (url, init) => web.handler(new Request(url, init)),
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      }),
    );
    connected.push(client);
    return {
      client,
      tools: async () => (await client.listTools()).tools,
      call: async (name: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: args })) as unknown as ToolResult,
    };
  };
  const audit = async (): Promise<ReadonlyArray<AuditEntry>> =>
    (await Effect.runPromise(AuditLog.use((l) => l.list({ limit: 500 })).pipe(Effect.provide(context)))).entries;
  return {
    connect,
    audit,
    log,
    zfoWrites: zfo.writes,
    /** Unloads a box (as if removed) without registering the tools again. */
    unload: (boxId: string) => {
      const at = boxes.findIndex((box) => box.id === boxId);
      if (at >= 0) boxes.splice(at, 1);
    },
    close: async () => {
      for (const client of connected) await client.close();
      await web.dispose();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};

export type Harness = Awaited<ReturnType<typeof startTools>>;

/** Text of the first content block. */
export const textOf = (result: ToolResult): string => result.content[0]?.text ?? "";
