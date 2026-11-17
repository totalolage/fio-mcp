#!/usr/bin/env node
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import * as NodeTerminal from "@effect/platform-node/NodeTerminal";
import { stripMarks } from "@mcps/core/mcp/untrusted.js";
import { makeRedactor, stderrLogger } from "@mcps/core/redaction.js";
import { Effect, Layer, Logger } from "effect";
import { AppLoggerLive, FEATURES, serve } from "./app/app.js";
import { type CliError, runCli } from "./cli/run.js";
import { AppConfig } from "./config.js";
import { IsdsTransports } from "./domain/isds-transports.js";

/** `datova-schranka` or `datova-schranka serve`: the server, under the instance lease, with the redacting logger. */
const server = serve(FEATURES).pipe(
  Effect.provide(Layer.mergeAll(AppLoggerLive, AppConfig.Live, NodeFileSystem.layer, IsdsTransports.Live)),
);

/** Anything else is a one-shot command (src/cli/run.ts), which takes no lease. */
const command = (args: ReadonlyArray<string>): Effect.Effect<void, CliError | Effect.Error<typeof server>> =>
  args.length === 0 || (args.length === 1 && args[0] === "serve")
    ? server
    : runCli(args).pipe(Effect.provide(Layer.mergeAll(NodeStdio.layer, NodeTerminal.layer, NodeFileSystem.layer)));

const program = command(process.argv.slice(2)).pipe(
  // Every failure message is value-free (ConfigError, CommandFailed, the
  // lease's); this logger knows no secret yet, the server's own logs go
  // through AppLoggerLive.
  Effect.tapError((error) => Effect.logError(error.message)),
  Effect.provide(Logger.layer([stderrLogger(makeRedactor([]), stripMarks)])),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
