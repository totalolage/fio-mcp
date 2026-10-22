import { NodeFileSystem, NodeStdio } from "@effect/platform-node";
import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { Accounts } from "./accounts.js";
import { AppConfig } from "./config.js";
import { FioApiLive } from "./fio-api-live.js";
import { FioToolsLive, SERVER_INSTRUCTIONS } from "./mcp/fio-tools.js";
import { RateLimiter } from "./rate-limiter.js";
import { LoggerLive, Redactor } from "./redaction.js";

export const SERVER_NAME = "fio-mcp";
export const SERVER_VERSION = "0.2.0";

/** MCP protocol revisions offered to clients, newest first. */
export const MCP_PROTOCOLS = [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26] as const;

/** Configuration, redaction and logging. Everything else builds on this. */
export const BaseLive = Layer.mergeAll(Redactor.layer, Accounts.layer, RateLimiter.layer).pipe(
  Layer.provideMerge(AppConfig.layer),
  Layer.provide(NodeFileSystem.layer),
);

export const ServicesLive = FioApiLive.pipe(Layer.provideMerge(BaseLive));

export const ToolsLive = FioToolsLive;

const StdioServerLive = McpServer.layerStdio({
  name: SERVER_NAME,
  version: SERVER_VERSION,
  instructions: SERVER_INSTRUCTIONS,
  protocols: MCP_PROTOCOLS,
}).pipe(Layer.provide(NodeStdio.layer));

export const StdioAppLive = ToolsLive.pipe(Layer.provide(StdioServerLive), Layer.provide(ServicesLive));

/** The redacting stderr logger, for everything the app layers fork. */
export const AppLoggerLive = LoggerLive.pipe(
  Layer.provide(Redactor.layer),
  Layer.provide(AppConfig.layer),
  Layer.provide(NodeFileSystem.layer),
);

