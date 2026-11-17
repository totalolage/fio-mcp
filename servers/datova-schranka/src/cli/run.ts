import type { ConfigError } from "@mcps/core/config/env.js";
import { makeRedactor, Redactor } from "@mcps/core/redaction.js";
import { Effect, type FileSystem, Layer, type Stdio, type Terminal } from "effect";
import { DatabaseLive } from "../app/database.js";
import { AppConfig } from "../config.js";
import { AuditLog } from "../domain/audit-log.js";
import type { DomainStoreError } from "../domain/errors.js";
import {
  hashPasswordCommand,
  listClientsCommand,
  resetAdminPasswordCommand,
  revokeAllTokensCommand,
  revokeClientCommand,
  totpInitCommand,
} from "./admin.js";
import { PURGE_USAGE, parsePurgeArgs, purgeAuditCommand } from "./audit.js";
import { backupDatabase } from "./backup.js";
import { CommandFailed } from "./io.js";

export const CLI_USAGE = [
  "usage: datova-schranka [serve]              serve MCP over HTTP with OAuth",
  "       datova-schranka backup <dest>        copy the database to <dest> (not the ZFO files)",
  "       datova-schranka hash-password        read the admin password (no echo), print its hash",
  "       datova-schranka totp-init            print a new admin TOTP secret and its otpauth:// URI (stores nothing)",
  "       datova-schranka clients list         list registered OAuth clients",
  "       datova-schranka clients revoke <id>  remove a client and revoke its tokens",
  "       datova-schranka tokens revoke-all    revoke every OAuth grant",
  "       datova-schranka reset-admin-password [--set]",
  "                                            drop the password set at /admin (the hash file applies again),",
  "                                            or with --set store a new one read like hash-password",
  `       ${PURGE_USAGE}`,
  "                                            delete audit rows of days (UTC) before the date (kept 365 days at least)",
].join("\n");

/** What a one-shot command fails with; every message is value-free and printable. */
export type CliError = CommandFailed | ConfigError | DomainStoreError;

/** What the caller provides (main.ts: NodeStdio, NodeTerminal, NodeFileSystem). */
export type CliRequirements = Stdio.Stdio | Terminal.Terminal | FileSystem.FileSystem;

/**
 * Commands on the server's database read the whole configuration, like
 * Fio's (its Database.Live requires AppConfig.Live). They open and migrate
 * the database but do not take the instance lease: they run beside a
 * serving process, as Fio's do.
 */
const DatabaseCli = DatabaseLive.pipe(Layer.provide(AppConfig.Default));

const onDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, DatabaseCli);

/** AuditLog over the database. No box is loaded, so no box secret can reach it; its redactor knows none. */
const AuditLogCli = AuditLog.Default.pipe(
  Layer.provideMerge(DatabaseCli),
  Layer.provide(Layer.succeed(Redactor, Redactor.of(makeRedactor([])))),
);

const backup = (destination: string) =>
  backupDatabase(destination).pipe(
    Effect.tap(({ bytes }) => Effect.logInfo(`backup written to ${destination} (${bytes} bytes)`)),
    Effect.asVoid,
  );

const command = (args: ReadonlyArray<string>): Effect.Effect<void, CliError, CliRequirements> | undefined => {
  const [name, arg, ...rest] = args;
  // Need no configuration: they run before the server is set up.
  if (name === "hash-password" && args.length === 1) return hashPasswordCommand();
  if (name === "totp-init" && args.length === 1) return totpInitCommand();
  if (name === "backup" && arg !== undefined && arg !== "" && rest.length === 0) return onDatabase(backup(arg));
  if (name === "clients" && arg === "list" && rest.length === 0) return onDatabase(listClientsCommand());
  if (name === "clients" && arg === "revoke" && rest.length === 1 && rest[0] !== "") {
    return onDatabase(revokeClientCommand(rest[0] ?? ""));
  }
  if (name === "tokens" && arg === "revoke-all" && rest.length === 0) return onDatabase(revokeAllTokensCommand());
  if (name === "reset-admin-password" && arg === undefined) return onDatabase(resetAdminPasswordCommand(false));
  if (name === "reset-admin-password" && arg === "--set" && rest.length === 0) {
    return onDatabase(resetAdminPasswordCommand(true));
  }
  if (name === "audit") {
    const before = parsePurgeArgs(args.slice(1));
    return before === undefined ? undefined : Effect.provide(purgeAuditCommand(before), AuditLogCli);
  }
  return undefined;
};

/**
 * Runs one one-shot command (`args` without the program name); anything
 * else fails with CLI_USAGE. main.ts serves for no arguments or `serve` and
 * calls this otherwise; it prints the failure's message and exits non-zero.
 */
export const runCli = (args: ReadonlyArray<string>): Effect.Effect<void, CliError, CliRequirements> =>
  command(args) ?? Effect.fail(new CommandFailed({ message: CLI_USAGE }));
