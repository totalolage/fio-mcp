#!/usr/bin/env node
import { NodeRuntime, NodeStdio, NodeTerminal } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import {
  AppLive,
  AppLoggerLive,
  backup,
  CommandFailed,
  hashPasswordCommand,
  listClients,
  revokeAllTokens,
  revokeClient,
} from "./app.js";
import { makeRedactor, stderrLogger } from "./redaction.js";

const USAGE = [
  "usage: fio-mcp                      serve MCP (FIO_MCP_TRANSPORT=stdio|http)",
  "       fio-mcp backup <dest>        copy the database to <dest>",
  "       fio-mcp hash-password        read the admin password (no echo), print its hash",
  "       fio-mcp clients list         list registered OAuth clients",
  "       fio-mcp clients revoke <id>  remove a client and revoke its tokens",
  "       fio-mcp tokens revoke-all    revoke every OAuth grant",
].join("\n");

const serve = Layer.launch(AppLive);

const backupTo = (dest: string) =>
  backup(dest).pipe(
    Effect.tap(({ bytes }) => Effect.logInfo(`backup written to ${dest} (${bytes} bytes)`)),
    Effect.asVoid,
  );

/** Commands that read the configuration (and log through the redacting logger). */
const configured = (
  args: ReadonlyArray<string>,
):
  | Effect.Effect<
      void,
      | Effect.Error<typeof serve>
      | Effect.Error<ReturnType<typeof backup>>
      | Effect.Error<typeof listClients>
      | Effect.Error<typeof revokeAllTokens>
      | CommandFailed
    >
  | undefined => {
  const [name, arg, ...rest] = args;
  if (args.length === 0) return serve;
  if (name === "backup" && arg !== undefined && arg !== "" && rest.length === 0) return backupTo(arg);
  if (name === "clients" && arg === "list" && rest.length === 0) return listClients;
  if (name === "clients" && arg === "revoke" && rest.length === 1 && rest[0] !== "") return revokeClient(rest[0] ?? "");
  if (name === "tokens" && arg === "revoke-all" && rest.length === 0) return revokeAllTokens;
  return undefined;
};

/** No arguments serves MCP; the other commands run once and exit. */
const command = (args: ReadonlyArray<string>) => {
  if (args.length === 1 && args[0] === "hash-password") {
    // Needs no configuration: the hash is created before the server is set up.
    return hashPasswordCommand().pipe(Effect.provide(Layer.mergeAll(NodeStdio.layer, NodeTerminal.layer)));
  }
  const run = configured(args);
  return run === undefined ? Effect.fail(new CommandFailed({ message: USAGE })) : run.pipe(Effect.provide(AppLoggerLive));
};

const program = command(process.argv.slice(2)).pipe(
  // Before configuration is loaded no secrets are known; ConfigError messages
  // are value-free by construction.
  Effect.tapError((error) => Effect.logError(error.message)),
  Effect.provide(Logger.layer([stderrLogger(makeRedactor([]))])),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
