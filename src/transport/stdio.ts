// McpServer.layerStdio is built on the Stdio service, which effect marks unstable.
// @effect-diagnostics unstableApiUsage:off
import { Effect, Layer, Sink, Stdio } from "effect";
import { McpServer } from "effect/ai";
import { Redactor } from "../redaction.js";
import { makeFrameRedactor } from "./frame-redaction.js";
import type { ServerInfo } from "./server-info.js";

/**
 * Wraps the surrounding `Stdio` so every chunk written to stdout is redacted
 * (see frame-redaction.ts). Logs never use this service; they go to
 * process.stderr through the redacting logger.
 */
export const RedactingStdio: Layer.Layer<Stdio.Stdio, never, Stdio.Stdio | Redactor> = Layer.effect(
  Stdio.Stdio,
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const frames = makeFrameRedactor(yield* Redactor);
    return Stdio.make({
      args: stdio.args,
      stdinIsTerminal: stdio.stdinIsTerminal,
      stdoutIsTerminal: stdio.stdoutIsTerminal,
      stderrIsTerminal: stdio.stderrIsTerminal,
      stdin: stdio.stdin,
      stderr: (options) => stdio.stderr(options),
      stdout: (options) => Sink.mapInput(stdio.stdout(options), frames.chunk),
    });
  }),
);

/** MCP over stdin/stdout with a redacting stdout. Needs a platform `Stdio`. */
export const layerStdio = (info: ServerInfo) =>
  McpServer.layerStdio(info).pipe(Layer.provide(RedactingStdio));
