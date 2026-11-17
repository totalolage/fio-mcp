import { ToolPolicy, type ToolPolicyShape } from "@mcps/core/mcp/grants.js";
import type { Layer } from "effect";
import { BOX_PARAMETER, type ToolSpec } from "./tool-group.js";

/**
 * Core's tool policy for the given tool specs (the union of every tool
 * group's specs): the scopes each tool needs, which tools take no box, and
 * `box` as the resource parameter. HTTP tools/list hides a tool without a
 * spec; its handler still authorizes every call (src/mcp/call.ts).
 */
export const toolPolicy = (specs: ReadonlyArray<ToolSpec>): ToolPolicyShape => {
  const byName = new Map(specs.map((spec) => [spec.name, spec] as const));
  return {
    scopes: (tool) => byName.get(tool)?.scopes ?? [],
    resourceless: (tool) => byName.get(tool)?.resourceless === true,
    resourceParameter: BOX_PARAMETER,
    listed: (tool) => byName.has(tool),
  };
};

/** The ToolPolicy service for the given tool specs. */
export const toolPolicyLayer = (specs: ReadonlyArray<ToolSpec>): Layer.Layer<ToolPolicy> =>
  ToolPolicy.layer(toolPolicy(specs));
