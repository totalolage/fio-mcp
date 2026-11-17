import type { AdminTab } from "@mcps/core/admin/tab.js";
import type { Migrations } from "@mcps/core/migrations.js";
import { Effect, Layer } from "effect";
import type { ToolGroup } from "../mcp/tool-group.js";
import type { AppServices } from "./services.js";

/**
 * The single place features plug into the app. The app runs these
 * migrations after its own, registers every tool group and builds the tool
 * policy from their specs, renders the admin tabs in this order, and builds
 * the extension services and background layers over the app services.
 */

/** Services an extension adds for its own tools, tabs and background work. */
export type ExtensionServices = never;

/** What tool groups, tabs and background layers may require. */
export type ExtensionRequirements = AppServices | ExtensionServices;

/** Extra migrations (send: 0201+). */
export const EXTENSION_MIGRATIONS: Migrations = {};

/** Every MCP tool group the server registers. */
export const TOOL_GROUPS: ReadonlyArray<ToolGroup<ExtensionRequirements>> = [];

/** Admin tabs after core's built-in ones, in display order. */
export const adminTabs: Effect.Effect<ReadonlyArray<AdminTab>, never, ExtensionRequirements> = Effect.all([]);

/** Services the extensions provide to tools, tabs and background layers. */
export const ExtensionServicesLive: Layer.Layer<ExtensionServices, never, AppServices> = Layer.empty;

/** Long-running work (sweeps, reconciliation); built only after the instance lease is held. */
export const BackgroundLive: Layer.Layer<never, never, ExtensionRequirements> = Layer.empty;
