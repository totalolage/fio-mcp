import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import * as NodeTerminal from "@effect/platform-node/NodeTerminal";
import { ToolListChangesLive } from "@mcps/core/mcp/registration.js";
import { serveHttp } from "@mcps/core/transport/http.js";
import { LocalPrincipalLive } from "@mcps/core/transport/principal.js";
import type { ServerInfo } from "@mcps/core/transport/server-info.js";
import { layerStdio } from "@mcps/core/transport/stdio.js";
import { Effect, Layer } from "effect";
import { McpProtocol } from "effect/ai";
import { AccountChangesLive } from "./account-runtime.js";
import { Accounts } from "./accounts.js";
import { backupDatabase, Database } from "./cache/db.js";
import { CacheSyncLive, Transactions } from "./cache/service.js";
import { AppConfig, type HttpTransportConfig } from "./config.js";
import { FioApi } from "./fio-api.js";
import { CACHE_INSTRUCTIONS, CacheToolsLive } from "./mcp/cache-tools.js";
import { FioToolsLive, SERVER_INSTRUCTIONS } from "./mcp/fio-tools.js";
import { ConfiguredToolPolicy } from "./mcp/tool-policy.js";
import { listClientsCommand, resetAdminPasswordCommand, revokeAllTokensCommand, revokeClientCommand } from "./oauth/cli.js";
import { PaymentControls } from "./payment-controls.js";
import { RateLimiter } from "./rate-limiter.js";
import { LoggerLive, RedactorLive } from "./redaction.js";
import { authFromConfig, TRUSTED_PROXIES_SETTING } from "./transport/auth.js";

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

// Composition points. Each layer below is built once per process and shared by
// every MCP session (stdio has one; HTTP has one per client).

/**
 * One instance per process: one rate limiter per token, one FIO client, one
 * SQLite cache. With FIO_CACHE_ENABLED=false the cache opens no database
 * (in HTTP mode with OAuth the accounts and authFromConfig still open it).
 * Every member closes its own requirements (mergeAll feeds no member from
 * another); they, and authFromConfig's OAuth server and admin UI, share one
 * AppConfig, Accounts, RateLimiter, Transactions and database because one
 * build memoizes each layer by reference. Core sees the accounts as
 * `Resources` and the tool scopes (and FIO_MCP_MARKER_TOOLS) as `ToolPolicy`.
 */
export const ServicesLive = Layer.mergeAll(
  AppConfig.Live,
  RedactorLive,
  Accounts.Live,
  Accounts.resources.pipe(Layer.provide(Accounts.Live)),
  ConfiguredToolPolicy.pipe(Layer.provide(AppConfig.Live)),
  RateLimiter.Live,
  FioApi.Live,
  Transactions.Live,
  PaymentControls.Live,
);

/** Tool registrations, re-registered (with `tools/list_changed`) when the accounts change. */
export const ToolsLive = Layer.mergeAll(FioToolsLive, CacheToolsLive, ToolListChangesLive);

/**
 * Long-running background work: startup and periodic cache sync, and
 * following account changes made at /admin. Layers here fork instead of
 * running inline, so the transport answers `initialize` without waiting
 * for FIO.
 */
export const BackgroundLive = Layer.mergeAll(CacheSyncLive, AccountChangesLive);

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

export const HttpAppLive = (config: HttpTransportConfig) =>
  withServices(
    serveHttp(ToolsLive, authFromConfig, SERVER_INFO, { ...config, trustedProxiesSetting: TRUSTED_PROXIES_SETTING }),
  );

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
  backupDatabase(dest).pipe(Effect.provide(Layer.mergeAll(Database.Live, NodeFileSystem.layer)));

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(Database.Live, NodeStdio.layer)));

/** `fio-mcp clients list` / `clients revoke <id>` / `tokens revoke-all` on the server's database. */
export const listClients = withDatabase(listClientsCommand());
export const revokeClient = (clientId: string) => withDatabase(revokeClientCommand(clientId));
export const revokeAllTokens = withDatabase(revokeAllTokensCommand());
/** `fio-mcp reset-admin-password [--set]`: back to the hash file, or a new password from the terminal or stdin. */
export const resetAdminPassword = (set: boolean) =>
  withDatabase(resetAdminPasswordCommand(set)).pipe(Effect.provide(NodeTerminal.layer));

/** The redacting stderr logger, for everything the app layers fork. */
export const AppLoggerLive = LoggerLive.pipe(Layer.provide(RedactorLive));
