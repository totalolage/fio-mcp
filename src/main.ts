#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { AppLive, AppLoggerLive, backup, CommandFailed } from "./app.js";
import { makeRedactor, stderrLogger } from "./redaction.js";

const USAGE = "usage: fio-mcp            serve MCP (FIO_MCP_TRANSPORT=stdio|http)\n       fio-mcp backup <dest>  copy the cache database to <dest>";

const serve = Layer.launch(AppLive);

/** No arguments serves MCP; `backup <dest>` runs the backup and exits. */
const command = (
  args: ReadonlyArray<string>,
): Effect.Effect<void, Effect.Error<typeof serve> | Effect.Error<ReturnType<typeof backup>> | CommandFailed> => {
  if (args.length === 0) return serve;
  const [name, dest, ...rest] = args;
  if (name === "backup" && dest !== undefined && dest !== "" && rest.length === 0) {
    return backup(dest).pipe(
      Effect.tap(({ bytes }) => Effect.logInfo(`backup written to ${dest} (${bytes} bytes)`)),
      Effect.asVoid,
    );
  }
  return Effect.fail(new CommandFailed({ message: USAGE }));
};

const program = command(process.argv.slice(2)).pipe(
  Effect.provide(AppLoggerLive),
  // Before configuration is loaded no secrets are known; ConfigError messages
  // are value-free by construction.
  Effect.tapError((error) => Effect.logError(error.message)),
  Effect.provide(Logger.layer([stderrLogger(makeRedactor([]))])),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
