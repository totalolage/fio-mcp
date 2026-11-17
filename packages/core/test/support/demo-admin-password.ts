/**
 * A demo app's admin password, built straight from core: an in-memory
 * PasswordStore, cheap scrypt parameters and an optional TOTP secret.
 */
import { Effect, Option, Redacted, Ref } from "effect";
import { makeAdminPassword, type PasswordStore } from "../../src/admin/password.js";
import { totpCode } from "../../src/admin/totp.js";
import type { AppIdentity } from "../../src/app-identity.js";
import { hashPassword, PasswordHashError, parsePasswordHash } from "../../src/oauth/crypto.js";
import type { ThrottlePolicy } from "../../src/oauth/login.js";

export const DEMO_IDENTITY: AppIdentity = { name: "demo-mcp", idPrefix: "demo" };
export const PASSWORD = "correct horse battery staple";
export const ADDRESS = "203.0.113.7";
/** 20 fixed bytes, so codes are reproducible. */
export const SECRET = Uint8Array.from({ length: 20 }, (_, index) => index + 1);

const FAST_SCRYPT = { ln: 14, r: 8, p: 1 } as const;

/** One free failure, then a minute's wait: a second failure throttles the next attempt. */
export const STRICT_THROTTLE: ThrottlePolicy = {
  freeFailures: 1,
  baseDelayMs: 60_000,
  lockoutFailures: 10,
  lockoutMs: 15 * 60_000,
  forgetAfterMs: 24 * 60 * 60_000,
  maxEntries: 100,
};

/** The code for the step `offset` steps from now. */
export const codeAt = (offset = 0) => totpCode(SECRET, Math.floor(Date.now() / 1000) + offset * 30);

export interface DemoPasswordOptions {
  readonly totp?: boolean;
  readonly throttle?: ThrottlePolicy;
}

export const makeDemoPassword = (options: DemoPasswordOptions = {}) =>
  Effect.gen(function* () {
    const line = yield* hashPassword(Redacted.make(PASSWORD), FAST_SCRYPT);
    const bootstrap = parsePasswordHash(line, DEMO_IDENTITY);
    if (bootstrap instanceof PasswordHashError) return yield* Effect.die(bootstrap);
    const stored = yield* Ref.make(Option.none<string>());
    const store: PasswordStore = { get: Ref.get(stored), put: (next) => Ref.set(stored, Option.some(next)) };
    const password = yield* makeAdminPassword(store, {
      app: DEMO_IDENTITY,
      bootstrap: Redacted.make(bootstrap),
      scrypt: FAST_SCRYPT,
      throttle: options.throttle,
      totpSecret: options.totp === true ? Redacted.make(SECRET) : undefined,
    });
    return { password, stored };
  });
