import { NodeFileSystem, NodeStdio } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { McpProtocol } from "effect/ai";
import { Accounts } from "./accounts.js";
import { backupDatabase, DatabaseLive } from "./cache/db.js";
import { CacheLive, CacheSyncLive } from "./cache/service.js";
import { AppConfig, type HttpAuthConfig } from "./config.js";
import { FioApiLive } from "./fio-api-live.js";
import { CACHE_INSTRUCTIONS, CacheToolsLive } from "./mcp/cache-tools.js";
import { FioToolsLive, SERVER_INSTRUCTIONS } from "./mcp/fio-tools.js";
import { listClientsCommand, revokeAllTokensCommand, revokeClientCommand } from "./oauth/cli.js";
import { OAuthLive } from "./oauth/server.js";
import { RateLimiter } from "./rate-limiter.js";
import { LoggerLive, Redactor } from "./redaction.js";
import { Auth } from "./transport/auth.js";
import { type HttpTransportConfig, serveHttp } from "./transport/http.js";
import { LocalPrincipalLive } from "./transport/principal.js";
import type { ServerInfo } from "./transport/server-info.js";
import { layerStdio } from "./transport/stdio.js";

export { CommandFailed, hashPasswordCommand } from "./oauth/cli.js";

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
export const BaseLive = Layer.mergeAll(AppConfig.Live, Redactor.Live, Accounts.Live, RateLimiter.Live);

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

// stdio has one trusted local client: full access, captured when the tools register.
export const StdioAppLive = withServices(
  ToolsLive.pipe(
    Layer.provide(LocalPrincipalLive),
    Layer.provide(layerStdio(SERVER_INFO)),
    Layer.provide(NodeStdio.layer),
  ),
);

const UNAUTHENTICATED_WARNING =
  "SECURITY WARNING: FIO_MCP_ALLOW_UNAUTHENTICATED=true. /mcp accepts every request without authentication and gives it full access to every account, including payment orders. Anyone who can reach this port can use your bank tools. Set FIO_MCP_PUBLIC_URL and FIO_MCP_ADMIN_PASSWORD_HASH_FILE to require OAuth.";

/** /mcp authentication: the embedded OAuth server, or (escape hatch) none. */
export const httpAuthLive = (auth: HttpAuthConfig, trustedProxies: HttpTransportConfig["trustedProxies"]) =>
  auth.kind === "oauth"
    ? OAuthLive({ publicUrl: auth.publicUrl, passwordHash: auth.passwordHash, trustedProxies }).pipe(
        Layer.provide(DatabaseLive),
        Layer.provide(NodeFileSystem.layer),
      )
    : Layer.merge(Auth.layerOpen, Layer.effectDiscard(Effect.logWarning(UNAUTHENTICATED_WARNING)));

export const HttpAppLive = (config: HttpTransportConfig) =>
  withServices(serveHttp(ToolsLive, httpAuthLive(config.auth, config.trustedProxies), SERVER_INFO, config));

/** The transport selected by FIO_MCP_TRANSPORT. */
export const AppLive = Layer.unwrap(
  Effect.gen(function* () {
    const { transport } = yield* AppConfig;
    return transport.kind === "http" ? HttpAppLive(transport) : StdioAppLive;
  }),
).pipe(Layer.provide(AppConfig.Live));

/**
 * `fio-mcp backup <dest>`: writes a consistent copy of the live cache
 * database to `dest` with `VACUUM INTO` (safe while the server runs).
 */
export const backup = (dest: string) =>
  backupDatabase(dest).pipe(
    Effect.provide(
      DatabaseLive.pipe(Layer.provideMerge(AppConfig.Live), Layer.provideMerge(NodeFileSystem.layer)),
    ),
  );

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        DatabaseLive.pipe(Layer.provideMerge(AppConfig.Live), Layer.provideMerge(NodeFileSystem.layer)),
        NodeStdio.layer,
      ),
    ),
  );

/** `fio-mcp clients list` / `clients revoke <id>` / `tokens revoke-all` on the server's database. */
export const listClients = withDatabase(listClientsCommand());
export const revokeClient = (clientId: string) => withDatabase(revokeClientCommand(clientId));
export const revokeAllTokens = withDatabase(revokeAllTokensCommand());

/** The redacting stderr logger, for everything the app layers fork. */
export const AppLoggerLive = LoggerLive.pipe(Layer.provide(Redactor.Live));
