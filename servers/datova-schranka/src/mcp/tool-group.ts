import type { Effect } from "effect";
import type { McpServer } from "effect/ai";

/** OAuth scopes this server grants. */
export const READ_SCOPE = "isds:read";
export const SEND_SCOPE = "isds:send";
export type IsdsScope = typeof READ_SCOPE | typeof SEND_SCOPE;

/** Name of the box input every box-bound tool takes; core narrows its enum to the granted labels. */
export const BOX_PARAMETER = "box";

/**
 * What the tool policy needs to know about one tool: the scopes it requires
 * and whether it works without a box. Every tool not marked resourceless
 * takes the `box` input.
 */
export interface ToolSpec {
  readonly name: string;
  readonly scopes: ReadonlyArray<IsdsScope>;
  readonly resourceless?: boolean;
}

/**
 * One group of MCP tools (read tools, send tools, ...). The app registers
 * every group for the current box labels at startup and again whenever the
 * labels change, and builds the tool policy from the union of their specs.
 * `register` registers the group's tools on the MCP server (a Toolkit via
 * McpServer.registerToolkit, or raw tools via McpServer.addTool).
 */
export interface ToolGroup<R> {
  readonly specs: ReadonlyArray<ToolSpec>;
  readonly register: (labels: ReadonlyArray<string>) => Effect.Effect<void, never, McpServer.McpServer | R>;
}
