import { createHash } from "node:crypto";
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { makeSettingsStore, SETTING } from "../account-store.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../oauth/cli.js";
import {
  DEFAULT_SCRYPT,
  formatPasswordHash,
  hashPassword,
  type PasswordHash,
  PasswordHashError,
  parsePasswordHash,
  type ScryptParams,
} from "../oauth/crypto.js";
import { DEFAULT_THROTTLE, type LoginResult, makeLoginGuard, PasswordUnavailable, type ThrottlePolicy } from "../oauth/login.js";
import { matchingTotpStep, TOTP_WINDOW, totpStep } from "./totp.js";

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
 *
 * With FIO_MCP_ADMIN_TOTP_SECRET_FILE set, a sign-in also needs the current
 * RFC 6238 code, checked in the same permit right after the password. A
 * wrong or missing code is a counted failure, and an accepted code (its
 * 30 s step) is never accepted again by `signIn` or `verifyTotp`.
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
  /**
   * A sign-in check (throttled, counted); Accepted carries the stamp of the
   * hash the password matched. With TOTP enabled, `code` must be a current,
   * unused code; it is ignored otherwise.
   */
  readonly signIn: (address: string, password: Redacted.Redacted<string>, code?: string) => Effect.Effect<LoginResult<string>>;
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
  /** True when FIO_MCP_ADMIN_TOTP_SECRET_FILE is configured. */
  readonly totpEnabled: boolean;
  /**
   * Second factor on its own, for an already signed-in admin action.
   * Throttled and counted per `address` in the same LoginGuard as sign-ins.
   * A wrong or missing code counts as a failed attempt. An accepted code is
   * single-use, and this replay memory is shared with sign-in.
   * When TOTP is disabled, it returns Accepted at once and counts nothing.
   */
  readonly verifyTotp: (address: string, code: string | undefined) => Effect.Effect<LoginResult<void>>;
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

/**
 * `scrypt` hashes a changed password; tests pass cheaper parameters.
 * `totpSecret` (FIO_MCP_ADMIN_TOTP_SECRET_FILE) turns on the second factor.
 */
export const makeAdminPassword = Effect.fn("AdminPassword.make")(function* (
  bootstrap: Redacted.Redacted<PasswordHash>,
  throttle: ThrottlePolicy = DEFAULT_THROTTLE,
  scrypt: ScryptParams = DEFAULT_SCRYPT,
  totpSecret?: Redacted.Redacted<Uint8Array>,
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

  /** Accepted TOTP steps, kept while they are inside the window; only read and written under the guard's permit. */
  const usedSteps = new Set<number>();

  /** True for a current code whose step was not accepted before; that step is then used up. */
  const acceptCode = (secret: Redacted.Redacted<Uint8Array>, code: string | undefined) =>
    Effect.map(Clock.currentTimeMillis, (millis) => {
      const seconds = Math.floor(millis / 1000);
      const oldest = totpStep(seconds) - TOTP_WINDOW;
      for (const step of usedSteps) if (step < oldest) usedSteps.delete(step);
      const step = code === undefined ? undefined : matchingTotpStep(Redacted.value(secret), code, seconds);
      if (step === undefined || usedSteps.has(step)) return false;
      usedSteps.add(step);
      return true;
    });

  const signIn = (address: string, password: Redacted.Redacted<string>, code?: string) =>
    guard.attemptThen(
      address,
      password,
      (verified) => Effect.succeed(stampOf(Redacted.value(verified))),
      totpSecret === undefined ? undefined : acceptCode(totpSecret, code),
    );

  const verifyTotp = (address: string, code: string | undefined): Effect.Effect<LoginResult<void>> =>
    totpSecret === undefined
      ? Effect.succeed({ _tag: "Accepted", value: undefined })
      : guard.attemptFactor(address, acceptCode(totpSecret, code));

  /** Hashes and stores `next`; returns its stamp. */
  const store = (next: Redacted.Redacted<string>) =>
    hashPassword(next, scrypt).pipe(
      Effect.tap((line) => settings.put(SETTING.adminPasswordHash, line)),
      Effect.map(stampOfLine),
      Effect.tapError((error) => Effect.logError(`admin password: the change failed: ${error.message}`)),
      Effect.mapError(() => new PasswordChangeFailed()),
    );

  const change = (address: string, password: Redacted.Redacted<string>, next: Redacted.Redacted<string>) =>
    guard.attemptThen(address, password, () => store(next)).pipe(
      Effect.tap((result) => (result._tag === "Accepted" ? Effect.logInfo("admin password: changed at /admin") : Effect.void)),
    );

  return { signIn, stamp, change, totpEnabled: totpSecret !== undefined, verifyTotp } satisfies AdminPasswordShape;
});

export class AdminPassword extends Context.Service<AdminPassword, AdminPasswordShape>()("fio-mcp/admin/AdminPassword") {
  static readonly layer = (
    bootstrap: Redacted.Redacted<PasswordHash>,
    throttle?: ThrottlePolicy,
    scrypt?: ScryptParams,
    totpSecret?: Redacted.Redacted<Uint8Array>,
  ): Layer.Layer<AdminPassword, never, SqlClient.SqlClient> =>
    Layer.effect(AdminPassword, Effect.map(makeAdminPassword(bootstrap, throttle, scrypt, totpSecret), AdminPassword.of));
}
