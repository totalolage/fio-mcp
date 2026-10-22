#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { AppLoggerLive, StdioAppLive } from "./app.js";
import { makeRedactor, stderrLogger } from "./redaction.js";

const program = Effect.gen(function* () {
  yield* Effect.logInfo("starting MCP server on stdio");
  return yield* Layer.launch(StdioAppLive);
}).pipe(
  Effect.provide(AppLoggerLive),
  // Before configuration is loaded no secrets are known; ConfigError messages
  // are value-free by construction.
  Effect.tapError((error) => Effect.logError(error.message)),
  Effect.provide(Logger.layer([stderrLogger(makeRedactor([]))])),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
