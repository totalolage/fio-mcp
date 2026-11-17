import { ToolPolicy, type ToolPolicyShape } from "@mcps/core/mcp/grants.js";
import { Effect, Layer } from "effect";
import { AppConfig, type MarkerTools } from "../config.js";
import { MARKER_TOOLS, TOOL_POLICY } from "./permissions.js";

/**
 * TOOL_POLICY for the configured FIO_MCP_MARKER_TOOLS (SEC-10): `disabled`
 * hides the marker tools from HTTP tools/list for every grant (stdio leaves
 * them unregistered instead, src/mcp/fio-tools.ts). A call by name over
 * HTTP still reaches the tool, which refuses it (requireMarkerTools).
 */
export const toolPolicyFor = (config: { readonly markerTools?: MarkerTools | undefined }): ToolPolicyShape =>
  config.markerTools === "disabled" ? { ...TOOL_POLICY, listed: (tool) => !MARKER_TOOLS.has(tool) } : TOOL_POLICY;

/** The ToolPolicy service for the app's configuration; needs AppConfig. */
export const ConfiguredToolPolicy: Layer.Layer<ToolPolicy, never, AppConfig> = Layer.effect(
  ToolPolicy,
  Effect.map(Effect.service(AppConfig), (config) => ToolPolicy.of(toolPolicyFor(config))),
);
