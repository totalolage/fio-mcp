import { Clock, DateTime, Effect, Queue, Redacted, Schema, Stdio, Stream, Terminal } from "effect";
import { hashPassword, type ScryptParams } from "./crypto.js";
import { makeOAuthStore } from "./store.js";

/**
 * Admin commands: `hash-password` (needs no configuration) and the OAuth
 * client and token commands, which work on the server's database while the
 * server runs (revocations take effect on the next request).
 */

export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  message: Schema.String,
}) {}

export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;

const write = (sink: "stdout" | "stderr", text: string) =>
  Effect.flatMap(Stdio.Stdio, (stdio) =>
    Stream.run(Stream.make(text), sink === "stdout" ? stdio.stdout() : stdio.stderr()),
  ).pipe(Effect.mapError(() => new CommandFailed({ message: `could not write to ${sink}` })));

const cancelled = new CommandFailed({ message: "cancelled" });

/** Reads one line from the terminal in raw mode: nothing is echoed. */
const readHidden = Effect.fnUntraced(function* (prompt: string) {
  yield* write("stderr", prompt);
  const terminal = yield* Terminal.Terminal;
  const input = yield* terminal.readInput;
  let password = "";
  while (true) {
    const event = yield* Queue.take(input).pipe(Effect.mapError(() => cancelled));
    if (event.key.ctrl && (event.key.name === "c" || event.key.name === "d")) return yield* cancelled;
    if (event.key.name === "return" || event.key.name === "enter") break;
    if (event.key.name === "backspace") {
      password = Array.from(password).slice(0, -1).join("");
      continue;
    }
    if (event.input._tag === "Some" && !event.key.ctrl && !event.key.meta) password += event.input.value;
  }
  yield* write("stderr", "\n");
  return Redacted.make(password);
}, Effect.scoped);

/** Standard input up to EOF, without one trailing newline (`printf %s pw |` or `echo pw |`). */
const readPiped = Effect.flatMap(Stdio.Stdio, (stdio) =>
  stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.mapError(() => new CommandFailed({ message: "could not read the password from standard input" })),
    Effect.map((text) => Redacted.make(text.replace(/\r?\n$/, ""))),
  ),
);

/**
 * `fio-mcp hash-password`: reads the admin password without echo (twice on
 * a terminal, once from a pipe) and prints its scrypt hash for
 * FIO_MCP_ADMIN_PASSWORD_HASH_FILE on standard output.
 */
export const hashPasswordCommand = Effect.fn("cli.hashPassword")(function* (params?: ScryptParams) {
  const stdio = yield* Stdio.Stdio;
  const interactive = yield* stdio.stdinIsTerminal;
  const password = interactive ? yield* readHidden("Admin password: ") : yield* readPiped;
  const length = Array.from(Redacted.value(password)).length;
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    return yield* new CommandFailed({
      message: `the password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`,
    });
  }
  if (interactive) {
    const again = yield* readHidden("Repeat the password: ");
    if (Redacted.value(again) !== Redacted.value(password)) {
      return yield* new CommandFailed({ message: "the passwords do not match" });
    }
  }
  const hash = yield* hashPassword(password, params).pipe(Effect.mapError((error) => new CommandFailed({ message: error.message })));
  yield* write("stdout", `${hash}\n`);
});

const iso = (millis: number | null) => (millis === null ? "never" : DateTime.formatIso(DateTime.makeUnsafe(millis)));

/** `fio-mcp clients list`: one line per registered client. */
export const listClientsCommand = Effect.fn("cli.listClients")(function* () {
  const store = yield* makeOAuthStore();
  const clients = yield* store.listClients(yield* Clock.currentTimeMillis);
  if (clients.length === 0) return yield* write("stdout", "No registered clients.\n");
  const lines = clients.map((client) =>
    [
      client.clientId,
      `name=${JSON.stringify(client.clientName ?? "")}`,
      `registered=${iso(client.createdAt)}`,
      `last_authorized=${iso(client.lastUsedAt)}`,
      `active_grants=${client.liveGrants}`,
      `redirect_uris=${client.redirectUris.join(",")}`,
    ].join("  "),
  );
  yield* write("stdout", `${lines.join("\n")}\n`);
});

/** `fio-mcp clients revoke <id>`: deletes the client with all its grants and tokens. */
export const revokeClientCommand = Effect.fn("cli.revokeClient")(function* (clientId: string) {
  const store = yield* makeOAuthStore();
  if (!(yield* store.deleteClient(clientId))) {
    return yield* new CommandFailed({ message: `no registered client ${clientId} (see fio-mcp clients list)` });
  }
  yield* write("stdout", `Revoked client ${clientId} and all its tokens.\n`);
});

/** `fio-mcp tokens revoke-all`: every client must authorize again. */
export const revokeAllTokensCommand = Effect.fn("cli.revokeAllTokens")(function* () {
  const store = yield* makeOAuthStore();
  const revoked = yield* store.revokeAll(yield* Clock.currentTimeMillis);
  yield* write("stdout", `Revoked ${revoked} active grants; every client must authorize again.\n`);
});
