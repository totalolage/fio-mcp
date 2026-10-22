#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { log } from "./redact.js";
import { createFioServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, toolNames } = createFioServer(config);
  await server.connect(new StdioServerTransport());
  const summary = config.accounts.map((a) => `${a.name} [${[...a.permissions].join(",")}]`).join("; ");
  log.info(`ready; accounts: ${summary}; tools: ${toolNames().join(", ")}`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) log.error(error.message);
  else log.error("fatal:", error);
  process.exit(1);
});
