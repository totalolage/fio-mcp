import { createHash } from "node:crypto";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { makeSettingsStore, SETTING } from "../account-store.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../oauth/cli.js";
import { formatPasswordHash, hashPassword, type PasswordHash, PasswordHashError, parsePasswordHash } from "../oauth/crypto.js";
import { DEFAULT_THROTTLE, type LoginResult, makeLoginGuard, PasswordUnavailable, type ThrottlePolicy } from "../oauth/login.js";

/**
 * The admin password, shared by the OAuth sign-in (/login) and the admin UI
 * (/admin): one LoginGuard, so both count failures per address together and
 * share the one-at-a-time scrypt slot.
 *
 * Source: the hash stored in the database once the password was changed at
 * /admin (or set with `fio-mcp reset-admin-password --set`), otherwise the
 * bootstrap hash from FIO_MCP_ADMIN_PASSWORD_HASH_FILE. Read on every check,
 * so a change or a CLI reset applies at once.
 *
 * `stamp` identifies the current hash. Signed-in sessions (admin and OAuth)
 * remember it and end when it changes: changing the password signs out
 * every other session.
 */

export class InvalidNewPassword extends Schema.TaggedError<InvalidNewPassword>()("InvalidNewPassword", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Hashing or storing the new password failed; the cause is logged. */
export class PasswordChangeFailed extends Schema.TaggedError<PasswordChangeFailed>()("PasswordChangeFailed", {}) {
  override get message(): string {
    return "The new password could not be stored. The old password still applies. See the server log.";
  }
}

export interface AdminPasswordShape {
  /** A sign-in check (throttled, counted); Accepted carries the stamp of the hash the password matched. */
  readonly signIn: (address: string, password: Redacted.Redacted<string>) => Effect.Effect<LoginResult<string>>;
  /** Identifies the current hash; changes with the password. */
  readonly stamp: Effect.Effect<string, PasswordUnavailable>;
  /**
   * Checks `current` like a sign-in (throttled, counted) and, when it is
   * right, stores the hash of `next` (same scrypt parameters as
   * `hash-password`) within the same scrypt slot. Accepted carries the new
   * hash's stamp.
   */
  readonly change: (
    address: string,
    current: Redacted.Redacted<string>,
    next: Redacted.Redacted<string>,
  ) => Effect.Effect<LoginResult<string>, PasswordChangeFailed>;
}

/** 12 to 1024 characters, as `hash-password` requires. */
export const checkNewPassword = (next: string, confirm: string): InvalidNewPassword | undefined => {
  const length = Array.from(next).length;
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    return new InvalidNewPassword({ detail: `The new password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.` });
  }
  if (next !== confirm) return new InvalidNewPassword({ detail: "The new passwords do not match." });
  return undefined;
};

const stampOfLine = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 32);
const stampOf = (hash: PasswordHash) => stampOfLine(formatPasswordHash(hash));

export const makeAdminPassword = Effect.fn("AdminPassword.make")(function* (
  bootstrap: Redacted.Redacted<PasswordHash>,
  throttle: ThrottlePolicy = DEFAULT_THROTTLE,
) {
  const settings = yield* makeSettingsStore();

  const current = Effect.gen(function* () {
    const stored = yield* settings.get(SETTING.adminPasswordHash).pipe(Effect.mapError(() => new PasswordUnavailable()));
    if (Option.isNone(stored)) return bootstrap;
    const parsed = parsePasswordHash(stored.value);
    if (parsed instanceof PasswordHashError) {
      yield* Effect.logError(
        `admin password: the hash stored in the database ${parsed.detail}; run \`fio-mcp reset-admin-password\``,
      );
      return yield* new PasswordUnavailable();
    }
    return Redacted.make(parsed);
  });

  const guard = yield* makeLoginGuard(current, throttle);

  const stamp = Effect.map(current, (hash) => stampOf(Redacted.value(hash)));

  const signIn = (address: string, password: Redacted.Redacted<string>) =>
    guard.attemptThen(address, password, (verified) => Effect.succeed(stampOf(Redacted.value(verified))));

  /** Hashes and stores `next`; returns its stamp. */
  const store = (next: Redacted.Redacted<string>) =>
    hashPassword(next).pipe(
      Effect.tap((line) => settings.put(SETTING.adminPasswordHash, line)),
      Effect.map(stampOfLine),
      Effect.tapError((error) => Effect.logError(`admin password: the change failed: ${error.message}`)),
      Effect.mapError(() => new PasswordChangeFailed()),
    );

  const change = (address: string, password: Redacted.Redacted<string>, next: Redacted.Redacted<string>) =>
    guard.attemptThen(address, password, () => store(next)).pipe(
      Effect.tap((result) => (result._tag === "Accepted" ? Effect.logInfo("admin password: changed at /admin") : Effect.void)),
    );

  return { signIn, stamp, change } satisfies AdminPasswordShape;
});

export class AdminPassword extends Context.Service<AdminPassword, AdminPasswordShape>()("fio-mcp/admin/AdminPassword") {
  static readonly layer = (
    bootstrap: Redacted.Redacted<PasswordHash>,
    throttle?: ThrottlePolicy,
  ): Layer.Layer<AdminPassword, never, SqlClient.SqlClient> =>
    Layer.effect(AdminPassword, Effect.map(makeAdminPassword(bootstrap, throttle), AdminPassword.of));
}
