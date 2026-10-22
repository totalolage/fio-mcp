import { NodeFileSystem, NodeStdio } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol } from "effect/ai";
import { Accounts } from "./accounts.js";
import { backupDatabase, DatabaseLive } from "./cache/db.js";
import { CacheLive, CacheSyncLive } from "./cache/service.js";
import { AppConfig } from "./config.js";
import { FioApiLive } from "./fio-api-live.js";
import { CACHE_INSTRUCTIONS, CacheToolsLive } from "./mcp/cache-tools.js";
import { FioToolsLive, SERVER_INSTRUCTIONS } from "./mcp/fio-tools.js";
import { RateLimiter } from "./rate-limiter.js";
import { LoggerLive, Redactor } from "./redaction.js";
import { Auth } from "./transport/auth.js";
import { type HttpTransportConfig, serveHttp } from "./transport/http.js";
import type { ServerInfo } from "./transport/server-info.js";
import { layerStdio } from "./transport/stdio.js";

export const SERVER_NAME = "fio-mcp";
export const SERVER_VERSION = "0.2.0";

/** MCP protocol revisions offered to clients, newest first. */
export const MCP_PROTOCOLS = [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26] as const;

export const SERVER_INFO: ServerInfo = {
  name: SERVER_NAME,
  version: SERVER_VERSION,
  instructions: `${SERVER_INSTRUCTIONS} ${CACHE_INSTRUCTIONS}`,
  protocols: MCP_PROTOCOLS,
};

/** Configuration, redaction and logging. Everything else builds on this. */
export const BaseLive = Layer.mergeAll(Redactor.layer, Accounts.layer, RateLimiter.layer).pipe(
  Layer.provideMerge(AppConfig.layer),
  Layer.provide(NodeFileSystem.layer),
);

// Composition points. Each layer below is built once per process and shared by
// every MCP session (stdio has one; HTTP has one per client).

/**
 * One instance per process: one rate limiter per token, one FIO client, one
 * SQLite cache. With FIO_CACHE_ENABLED=false the cache opens no database.
 */
export const ServicesLive = CacheLive.pipe(
  Layer.provideMerge(FioApiLive.pipe(Layer.provideMerge(BaseLive))),
  Layer.provide(NodeFileSystem.layer),
);

/** Tool registrations (`McpServer.toolkit(...)` layers). */
export const ToolsLive = Layer.mergeAll(FioToolsLive, CacheToolsLive);

/**
 * Long-running background work: startup and periodic cache sync. Layers here
 * fork instead of running inline, so the transport answers `initialize`
 * without waiting for FIO.
 */
export const BackgroundLive = CacheSyncLive;

/** Tools and background work on a shared services graph, behind a transport. */
const withServices = <A, E, R>(transport: Layer.Layer<A, E, R>) =>
  Layer.mergeAll(transport, BackgroundLive).pipe(Layer.provide(ServicesLive));

export const StdioAppLive = withServices(
  ToolsLive.pipe(Layer.provide(layerStdio(SERVER_INFO)), Layer.provide(NodeStdio.layer)),
);

export const HttpAppLive = (config: HttpTransportConfig) =>
  withServices(serveHttp(ToolsLive, Auth.layerFrom(config.authToken), SERVER_INFO, config));

/** The transport selected by FIO_MCP_TRANSPORT. */
export const AppLive = Layer.unwrap(
  Effect.gen(function* () {
    const { transport } = yield* AppConfig;
    return transport.kind === "http" ? HttpAppLive(transport) : StdioAppLive;
  }),
).pipe(Layer.provide(AppConfig.layer), Layer.provide(NodeFileSystem.layer));

export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  message: Schema.String,
}) {}

/**
 * `fio-mcp backup <dest>`: writes a consistent copy of the live cache
 * database to `dest` with `VACUUM INTO` (safe while the server runs).
 */
export const backup = (dest: string) =>
  backupDatabase(dest).pipe(
    Effect.provide(
      DatabaseLive.pipe(Layer.provideMerge(AppConfig.layer), Layer.provideMerge(NodeFileSystem.layer)),
    ),
  );

/** The redacting stderr logger, for everything the app layers fork. */
export const AppLoggerLive = LoggerLive.pipe(
  Layer.provide(Redactor.layer),
  Layer.provide(AppConfig.layer),
  Layer.provide(NodeFileSystem.layer),
);
