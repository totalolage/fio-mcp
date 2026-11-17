import type { AdminTab } from "@mcps/core/admin/tab.js";
import type { Migrations } from "@mcps/core/migrations.js";
import { Effect, Layer } from "effect";
import { auditTab } from "../admin/audit-tab.js";
import { boxesTab } from "../admin/boxes-tab.js";
import { filingsTab } from "../admin/filings-tab.js";
import { recipientsTab } from "../admin/recipients-tab.js";
import type { SendService } from "../domain/send/api.js";
import { type SendAuthority, sendAuthorityLayer } from "../domain/send/authority.js";
import { SendBackground } from "../domain/send/background.js";
import { SEND_MIGRATIONS } from "../domain/send/migrations.js";
import { sendServiceLayer } from "../domain/send/service.js";
import { readToolGroup } from "../mcp/read-tools.js";
import { sendToolGroup } from "../mcp/send-tools.js";
import type { ToolGroup } from "../mcp/tool-group.js";
import type { AppServices } from "./services.js";

/**
 * The single place features plug into the app. The app runs these
 * migrations after its own, registers every tool group and builds the tool
 * policy from their specs, renders the admin tabs in this order, and builds
 * the extension services and background layers over the app services.
 */

/** Services an extension adds for its own tools, tabs and background work. */
export type ExtensionServices = SendService | SendAuthority;

/** What tool groups, tabs and background layers may require. */
export type ExtensionRequirements = AppServices | ExtensionServices;

/** Extra migrations (send: 0201+). */
export const EXTENSION_MIGRATIONS: Migrations = SEND_MIGRATIONS;

/** Every MCP tool group the server registers. */
export const TOOL_GROUPS: ReadonlyArray<ToolGroup<ExtensionRequirements>> = [readToolGroup, sendToolGroup];

/**
 * Admin tabs after core's built-in ones, in display order. The boxes tab is
 * built once and stays first (it serialises box writes on that one
 * instance); send inserts recipients and filings between boxes and audit.
 */
export const adminTabs: Effect.Effect<ReadonlyArray<AdminTab>, never, ExtensionRequirements> = Effect.all([
  boxesTab,
  recipientsTab,
  filingsTab,
  auditTab,
]);

/**
 * Services the extensions provide to tools, tabs and background layers.
 * Built after the instance lease is held and before the listeners start, so
 * startup work that must finish before requests are served (send: recover
 * 'dispatching' filings) runs while this layer is acquired.
 */
export const ExtensionServicesLive: Layer.Layer<ExtensionServices, never, AppServices> = sendServiceLayer.pipe(
  Layer.provideMerge(sendAuthorityLayer),
  // Startup recovery runs while SendService is built; if it cannot, the server must not start.
  Layer.orDie,
);

/**
 * Long-running work (sweeps, reconciliation); built only after the instance
 * lease is held, alongside the listeners.
 */
export const BackgroundLive: Layer.Layer<never, never, ExtensionRequirements> = SendBackground;
