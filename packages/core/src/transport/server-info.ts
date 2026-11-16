import type { McpProtocol } from "effect/ai";

/** What the MCP server announces at initialization; shared by both transports. */
export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly instructions: string;
  readonly protocols: readonly [McpProtocol.ProtocolAdapter, ...Array<McpProtocol.ProtocolAdapter>];
}
