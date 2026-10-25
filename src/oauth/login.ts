import { Clock, Effect, Option, Redacted, Result, Schema, Semaphore } from "effect";
import { type PasswordHash, type PasswordHashError, verifyPassword } from "./crypto.js";

/**
 * Admin password checks with failed-login throttling per client address.
 * One check runs at a time across all addresses (scrypt needs 128 MiB with
 * the hash-password defaults, at most 256 MiB); a request that arrives
 * while another is being checked is turned away instead of queued, so a
 * flood cannot pile up memory or slip past the throttle. Logs carry counts
 * only: no address, no password.
 */

/** The stored admin password hash could not be read or parsed; the cause is logged. */
export class PasswordUnavailable extends Schema.TaggedError<PasswordUnavailable>()("PasswordUnavailable", {}) {
  override get message(): string {
    return "The admin password could not be checked. See the server log.";
  }
}

export interface ThrottlePolicy {
  /** Consecutive failures allowed without delay. */
  readonly freeFailures: number;
  /** Delay after the first failure beyond the free ones; doubles per further failure. */
  readonly baseDelayMs: number;
  /** Consecutive failures that lock the address out. */
  readonly lockoutFailures: number;
  readonly lockoutMs: number;
  /** An address with no failure for this long starts over. */
  readonly forgetAfterMs: number;
  /** Tracked addresses; the stalest are dropped beyond this. */
  readonly maxEntries: number;
}

export const DEFAULT_THROTTLE: ThrottlePolicy = {
  freeFailures: 5,
  baseDelayMs: 1_000,
  lockoutFailures: 10,
  lockoutMs: 15 * 60_000,
  forgetAfterMs: 24 * 60 * 60_000,
  maxEntries: 10_000,
};

/** `value`: the verified hash (`attempt`) or what `attemptThen`'s continuation returned. */
export type LoginResult<A = Redacted.Redacted<PasswordHash>> =
  | { readonly _tag: "Accepted"; readonly value: A }
  | { readonly _tag: "Rejected" }
  /** Too many failures from this address, or another check is running; try again later. */
  | { readonly _tag: "Throttled"; readonly retryAfterSeconds: number }
  /** The expected hash could not be read (logged); nothing was checked or counted. */
  | { readonly _tag: "Unavailable" };

interface Failures {
  readonly count: number;
  readonly lastFailureAt: number;
  readonly nextAllowedAt: number;
}

/** Delay before the next attempt after `count` consecutive failures. */
export const delayAfter = (policy: ThrottlePolicy, count: number): number => {
  if (count >= policy.lockoutFailures) return policy.lockoutMs;
  if (count <= policy.freeFailures) return 0;
  return policy.baseDelayMs * 2 ** (count - policy.freeFailures - 1);
};

export interface LoginGuard {
  /** Accepted carries the hash the password was verified against. */
  readonly attempt: (address: string, password: Redacted.Redacted<string>) => Effect.Effect<LoginResult>;
  /**
   * Like `attempt`; after a correct password, runs `accepted` with the
   * verified hash while still holding the check's permit (e.g. hashing a
   * new password, so it takes the same one-at-a-time scrypt slot).
   */
  readonly attemptThen: <A, E>(
    address: string,
    password: Redacted.Redacted<string>,
    accepted: (verified: Redacted.Redacted<PasswordHash>) => Effect.Effect<A, E>,
  ) => Effect.Effect<LoginResult<A>, E>;
}

/**
 * `expected` is read for every check: the admin password can change while
 * the server runs (/admin, `fio-mcp reset-admin-password`). When it fails,
 * the attempt is Unavailable: no password is accepted.
 */
export const makeLoginGuard = Effect.fn("LoginGuard.make")(function* (
  expected: Effect.Effect<Redacted.Redacted<PasswordHash>, PasswordUnavailable>,
  policy: ThrottlePolicy = DEFAULT_THROTTLE,
  verify: (password: Redacted.Redacted<string>, hash: PasswordHash) => Effect.Effect<boolean, PasswordHashError> = verifyPassword,
) {
  const failures = new Map<string, Failures>();
  const lock = yield* Semaphore.make(1);

  const current = (address: string, now: number): Failures | undefined => {
    const entry = failures.get(address);
    if (entry !== undefined && now - entry.lastFailureAt > policy.forgetAfterMs) {
      failures.delete(address);
      return undefined;
    }
    return entry;
  };

  const recordFailure = (address: string, now: number): Failures => {
    const count = (current(address, now)?.count ?? 0) + 1;
    const entry = { count, lastFailureAt: now, nextAllowedAt: now + delayAfter(policy, count) };
    failures.delete(address);
    failures.set(address, entry);
    while (failures.size > policy.maxEntries) {
      const oldest = failures.keys().next();
      if (oldest.done === true) break;
      failures.delete(oldest.value);
    }
    return entry;
  };

  const check = Effect.fnUntraced(function* <A, E>(
    address: string,
    password: Redacted.Redacted<string>,
    accepted: (verified: Redacted.Redacted<PasswordHash>) => Effect.Effect<A, E>,
  ): Effect.fn.Return<LoginResult<A>, E> {
    const before = yield* Clock.currentTimeMillis;
    const entry = current(address, before);
    if (entry !== undefined && entry.nextAllowedAt > before) {
      return { _tag: "Throttled", retryAfterSeconds: Math.ceil((entry.nextAllowedAt - before) / 1000) } satisfies LoginResult<A>;
    }
    const hash = yield* Effect.result(expected);
    if (Result.isFailure(hash)) {
      yield* Effect.logError("admin password: the expected hash could not be read; sign-in is refused until it is fixed");
      return { _tag: "Unavailable" } satisfies LoginResult<A>;
    }
    const ok = yield* verify(password, Redacted.value(hash.success)).pipe(Effect.orElseSucceed(() => false));
    const now = yield* Clock.currentTimeMillis;
    if (ok) {
      failures.delete(address);
      return { _tag: "Accepted", value: yield* accepted(hash.success) } satisfies LoginResult<A>;
    }
    const failed = recordFailure(address, now);
    const wait = failed.nextAllowedAt - now;
    const tracked = failures.size;
    yield* failed.count >= policy.lockoutFailures
      ? Effect.logWarning(
          `oauth: admin login failed ${failed.count} times in a row from one address; it is locked out for ${Math.ceil(wait / 1000)} s (${tracked} addresses with recent failures)`,
        )
      : Effect.logWarning(
          `oauth: admin login failed (${failed.count} in a row from one address; next attempt allowed in ${Math.ceil(wait / 1000)} s; ${tracked} addresses with recent failures)`,
        );
    return { _tag: "Rejected" } satisfies LoginResult<A>;
  });

  // Uninterruptible once admitted: scrypt keeps running natively after an
  // interruption (a dropped connection), so the permit is held and the
  // failure counted until it ends.
  const attemptThen = <A, E>(
    address: string,
    password: Redacted.Redacted<string>,
    accepted: (verified: Redacted.Redacted<PasswordHash>) => Effect.Effect<A, E>,
  ): Effect.Effect<LoginResult<A>, E> =>
    lock.withPermitsIfAvailable(1)(Effect.uninterruptible(check(address, password, accepted))).pipe(
      Effect.map(Option.getOrElse((): LoginResult<A> => ({ _tag: "Throttled", retryAfterSeconds: 1 }))),
    );

  const attempt = (address: string, password: Redacted.Redacted<string>): Effect.Effect<LoginResult> =>
    attemptThen(address, password, Effect.succeed);

  return { attempt, attemptThen } satisfies LoginGuard;
});
