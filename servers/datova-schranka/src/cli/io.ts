import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@mcps/core/admin/password.js";
import { hashPassword, type ScryptParams } from "@mcps/core/oauth/crypto.js";
import { Effect, Queue, Redacted, Schema, Stdio, Stream, Terminal } from "effect";

/** A one-shot command failed; `message` is printed as is (never a secret). */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  message: Schema.String,
}) {}

export const write = (sink: "stdout" | "stderr", text: string) =>
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

/** Reads a new admin password (twice on a terminal, once from a pipe) and returns its scrypt hash line. */
export const readNewPasswordHash = Effect.fnUntraced(function* (params?: ScryptParams) {
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
  return yield* hashPassword(password, params).pipe(Effect.mapError((error) => new CommandFailed({ message: error.message })));
});
