import type { AdminTab } from "@mcps/core/admin/tab.js";
import { InstanceLease, runLeased } from "@mcps/core/instance-lease.js";
import { ToolListChangesLive, toolsForResources } from "@mcps/core/mcp/registration.js";
import { stripMarks } from "@mcps/core/mcp/untrusted.js";
import { loggerLayer, Redactor } from "@mcps/core/redaction.js";
import { serveHttp } from "@mcps/core/transport/http.js";
import type { ServerInfo } from "@mcps/core/transport/server-info.js";
import { Effect, Layer } from "effect";
import { McpProtocol } from "effect/ai";
import { AppConfig, DomainLive } from "../config.js";
import { AuditLog } from "../domain/audit-log.js";
import { BoxClients } from "../domain/box-clients.js";
import { BoxLocks } from "../domain/box-locks.js";
import { BoxRegistry } from "../domain/boxes.js";
import { storeFailure } from "../domain/errors.js";
import { ReadService } from "../domain/read-service.js";
import { RecipientTiers } from "../domain/recipient-tiers.js";
import { ZfoStore } from "../domain/zfo-store.js";
import { toolPolicyLayer } from "../mcp/policy.js";
import { SERVER_NAME, SERVER_VERSION } from "../mcp/server-info.js";
import type { ToolGroup } from "../mcp/tool-group.js";
import { APP_IDENTITY } from "../oauth/identity.js";
import { AdminPasswordLive, authLive, TRUSTED_PROXIES_SETTING } from "./auth.js";
import { CheckedDatabaseLive } from "./database.js";
import {
  adminTabs,
  BackgroundLive,
  type ExtensionRequirements,
  ExtensionServicesLive,
  TOOL_GROUPS,
} from "./extensions.js";

/**
 * The datova-schranka server: the app services built once per process, the
 * extensions' tool groups behind core's HTTP transport with OAuth, the admin
 * UI, and the extensions' background work, all under the instance lease.
 * Each layer below is a single value, so one build shares it by reference:
 * the lease and the services get one database, the redacting logger and
 * every tool, tab and HTTP response one Redactor.
 */

/** MCP protocol revisions offered to clients, newest first. */
export const MCP_PROTOCOLS = [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26] as const;

export const SERVER_INFO: ServerInfo = {
  name: SERVER_NAME,
  version: SERVER_VERSION,
  instructions:
    "Tools for Czech data boxes (datové schránky, ISDS). Each tool that works on a box takes the box's label as `box`; only the boxes this connection was granted are offered.",
  protocols: MCP_PROTOCOLS,
};

/** The /mcp request body cap: 20 MB of attachments as base64 plus the envelope (R6). */
export const MAX_MCP_BODY_BYTES = 32 * 1024 * 1024;

/**
 * What the app serves on top of its services (src/app/extensions.ts gives
 * the production set, FEATURES; tests pass their own).
 */
export interface Features {
  /** Registered for the current box labels and again when they change; their specs make the ToolPolicy. */
  readonly toolGroups: ReadonlyArray<ToolGroup<ExtensionRequirements>>;
  /** Admin tabs after core's built-in ones. */
  readonly adminTabs: Effect.Effect<ReadonlyArray<AdminTab>, never, ExtensionRequirements>;
  /**
   * Long-running work, built after the instance lease is held, concurrently
   * with the listener: work that must finish before requests are served
   * (e.g. startup recovery) belongs in ExtensionServicesLive instead.
   */
  readonly background: Layer.Layer<never, never, ExtensionRequirements>;
}

export const FEATURES: Features = { toolGroups: TOOL_GROUPS, adminTabs, background: BackgroundLive };

/**
 * One instance per process: the logger and the app layers build it from the
 * same memo map (main.ts provides AppLoggerLive around the server), so a box
 * secret BoxRegistry registers at runtime is redacted in logs, tool output
 * and HTTP responses alike.
 */
export const RedactorLive = Redactor.layer(Effect.succeed([]));

/** Writes redacted logfmt lines to stderr, without excerpt markers. */
export const AppLoggerLive = loggerLayer(stripMarks).pipe(Layer.provide(RedactorLive));

/**
 * The database checked against the configuration (environment, data key);
 * the instance lease and the app services share it.
 */
export const DatabaseServicesLive = CheckedDatabaseLive.pipe(Layer.provide(DomainLive));

/**
 * Every AppServices member, built once: one BoxLocks for BoxRegistry and
 * BoxClients (a box's ISDS calls and its credential changes are serialised
 * together), and BoxRegistry on the checked database, so it opens box
 * credentials only after the data key was verified. BoxRegistry registers
 * the box secrets with the Redactor as it loads them. IsdsTransports comes
 * from the caller (IsdsTransports.Live in main.ts).
 */
export const AppServicesLive = ReadService.Default.pipe(
  Layer.provideMerge(Layer.mergeAll(BoxClients.Default, RecipientTiers.Default, AuditLog.Default, ZfoStore.Default)),
  Layer.provideMerge(BoxRegistry.Default),
  Layer.provideMerge(Layer.mergeAll(RedactorLive, DomainLive, BoxLocks.Default, DatabaseServicesLive)),
);

/** Every group's tools, registered for the current box labels and again (with tools/list_changed) when they change. */
const toolsLive = (groups: ReadonlyArray<ToolGroup<ExtensionRequirements>>) =>
  Layer.mergeAll(
    toolsForResources(
      (labels) => Effect.forEach(groups, (group) => group.register(labels), { discard: true }),
      "datova-schranka: registering the tools for the changed data boxes failed",
    ),
    ToolListChangesLive,
  );

/**
 * The services behind the transport: the app services, the extensions'
 * services, the boxes as core Resources, the admin password, and the tool
 * policy from every group's specs (box as the resource parameter).
 */
const servicesLive = (features: Features) =>
  Layer.mergeAll(
    ExtensionServicesLive,
    BoxRegistry.resources,
    AdminPasswordLive,
    toolPolicyLayer(features.toolGroups.flatMap((group) => group.specs)),
  ).pipe(Layer.provideMerge(AppServicesLive));

/**
 * The HTTP server with OAuth (no stdio, no unauthenticated mode, R5) and
 * the background work, over the services, from AppConfig. Its context keeps
 * the services and the HttpServer (tests read the bound port). Needs
 * AppConfig, FileSystem and IsdsTransports.
 */
export const httpApp = (features: Features) =>
  Layer.mergeAll(
    Layer.unwrap(
      Effect.gen(function* () {
        const { http } = yield* AppConfig;
        return serveHttp(toolsLive(features.toolGroups), authLive(features.adminTabs), SERVER_INFO, {
          host: http.host,
          port: http.port,
          allowedOrigins: http.allowedOrigins,
          allowedHosts: http.allowedHosts,
          trustedProxies: http.trustedProxies,
          trustedProxiesSetting: TRUSTED_PROXIES_SETTING,
          maxBodyBytes: MAX_MCP_BODY_BYTES,
          // download_message's attachment blobs are exact bytes: withhold a result redaction would alter (R4).
          protectEmbeddedResources: true,
        });
      }),
    ),
    features.background,
  ).pipe(Layer.provideMerge(servicesLive(features)));

/**
 * The single-instance lease on the app's database (DatabaseServicesLive:
 * the same build as the services'), so two servers never share one.
 */
export const LeaseLive = InstanceLease.layer({ appName: APP_IDENTITY.name, onSqlFailure: storeFailure }).pipe(
  Layer.provide(DatabaseServicesLive),
);

/**
 * Serves until interrupted or the lease is lost. core's runLeased takes the
 * lease before it builds httpApp, so nothing but the checked database (which
 * the lease needs) starts before the lease is held: no BoxRegistry, no
 * listener, no background work.
 */
export const serve = (features: Features) => runLeased(httpApp(features), LeaseLive);
