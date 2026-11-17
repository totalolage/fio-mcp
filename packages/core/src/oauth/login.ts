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
  /**
   * Too many failures from this address, or (`busy`) another check is
   * running; try again later. A busy attempt is not counted as a failure.
   */
  | { readonly _tag: "Throttled"; readonly retryAfterSeconds: number; readonly busy?: true }
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
    options?: AttemptOptions,
  ) => Effect.Effect<LoginResult<A>, E>;
  /**
   * A second factor on its own (no password), throttled, counted and
   * one-at-a-time like a sign-in: false is a counted failure.
   */
  readonly attemptFactor: (address: string, factor: Effect.Effect<boolean>) => Effect.Effect<LoginResult<void>>;
}

export interface AttemptOptions {
  /** Runs in the same permit after a correct password; false makes the attempt a counted failure. */
  readonly secondFactor?: Effect.Effect<boolean> | undefined;
  /**
   * Success leaves the address's failure count as it is: the check did not
   * cover every factor (a password-only check while a second factor is on),
   * so it must not wipe the failures the second factor collected.
   */
  readonly keepFailures?: boolean | undefined;
}

/** What a guarded check found; `Wrong` is counted as a failure. */
type Verdict<V> =
  | { readonly _tag: "Verified"; readonly value: V }
  | { readonly _tag: "Wrong"; readonly secondFactor: boolean }
  | { readonly _tag: "Unavailable" };

/**
 * `expected` is read for every check: the admin password can change while
 * the server runs (/admin, `<app> reset-admin-password`). When it fails,
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

  /** Runs `judge` behind the address's throttle, counting `Wrong`; `accepted` follows a `Verified`. */
  const check = Effect.fnUntraced(function* <V, A, E>(
    address: string,
    judge: Effect.Effect<Verdict<V>>,
    accepted: (value: V) => Effect.Effect<A, E>,
    keepFailures: boolean,
  ): Effect.fn.Return<LoginResult<A>, E> {
    const before = yield* Clock.currentTimeMillis;
    const entry = current(address, before);
    if (entry !== undefined && entry.nextAllowedAt > before) {
      return { _tag: "Throttled", retryAfterSeconds: Math.ceil((entry.nextAllowedAt - before) / 1000) } satisfies LoginResult<A>;
    }
    const verdict = yield* judge;
    if (verdict._tag === "Unavailable") return { _tag: "Unavailable" } satisfies LoginResult<A>;
    const now = yield* Clock.currentTimeMillis;
    if (verdict._tag === "Verified") {
      if (!keepFailures) failures.delete(address);
      return { _tag: "Accepted", value: yield* accepted(verdict.value) } satisfies LoginResult<A>;
    }
    const failed = recordFailure(address, now);
    const wait = failed.nextAllowedAt - now;
    const tracked = failures.size;
    // A wrong code after a right password means the password is known: say so (no address, no code).
    if (verdict.secondFactor) yield* Effect.logWarning("oauth: admin second-factor code wrong, missing or reused");
    yield* failed.count >= policy.lockoutFailures
      ? Effect.logWarning(
          `oauth: admin login failed ${failed.count} times in a row from one address; it is locked out for ${Math.ceil(wait / 1000)} s (${tracked} addresses with recent failures)`,
        )
      : Effect.logWarning(
          `oauth: admin login failed (${failed.count} in a row from one address; next attempt allowed in ${Math.ceil(wait / 1000)} s; ${tracked} addresses with recent failures)`,
        );
    return { _tag: "Rejected" } satisfies LoginResult<A>;
  });

  /** The password against the expected hash, then `secondFactor` if given. */
  const verifyPasswordThen = (
    password: Redacted.Redacted<string>,
    secondFactor: Effect.Effect<boolean> | undefined,
  ): Effect.Effect<Verdict<Redacted.Redacted<PasswordHash>>> =>
    Effect.gen(function* () {
      const hash = yield* Effect.result(expected);
      if (Result.isFailure(hash)) {
        yield* Effect.logError("admin password: the expected hash could not be read; sign-in is refused until it is fixed");
        return { _tag: "Unavailable" } as const;
      }
      const ok = yield* verify(password, Redacted.value(hash.success)).pipe(Effect.orElseSucceed(() => false));
      if (!ok) return { _tag: "Wrong", secondFactor: false } as const;
      if (secondFactor !== undefined && !(yield* secondFactor)) return { _tag: "Wrong", secondFactor: true } as const;
      return { _tag: "Verified", value: hash.success } as const;
    });

  /** Another check holds the permit: turned away at once, not counted. */
  const busy = <A>(): LoginResult<A> => ({ _tag: "Throttled", retryAfterSeconds: 1, busy: true });

  // Uninterruptible once admitted: scrypt keeps running natively after an
  // interruption (a dropped connection), so the permit is held and the
  // failure counted until it ends.
  const guarded = <V, A, E>(
    address: string,
    judge: Effect.Effect<Verdict<V>>,
    accepted: (value: V) => Effect.Effect<A, E>,
    keepFailures = false,
  ): Effect.Effect<LoginResult<A>, E> =>
    lock.withPermitsIfAvailable(1)(Effect.uninterruptible(check(address, judge, accepted, keepFailures))).pipe(
      Effect.map(Option.getOrElse(() => busy<A>())),
    );

  const attemptThen = <A, E>(
    address: string,
    password: Redacted.Redacted<string>,
    accepted: (verified: Redacted.Redacted<PasswordHash>) => Effect.Effect<A, E>,
    options: AttemptOptions = {},
  ): Effect.Effect<LoginResult<A>, E> =>
    guarded(address, verifyPasswordThen(password, options.secondFactor), accepted, options.keepFailures === true);

  const attempt = (address: string, password: Redacted.Redacted<string>): Effect.Effect<LoginResult> =>
    attemptThen(address, password, Effect.succeed);

  const attemptFactor = (address: string, factor: Effect.Effect<boolean>): Effect.Effect<LoginResult<void>> =>
    guarded(
      address,
      Effect.map(factor, (ok): Verdict<void> => (ok ? { _tag: "Verified", value: undefined } : { _tag: "Wrong", secondFactor: true })),
      () => Effect.void,
    );

  return { attempt, attemptThen, attemptFactor } satisfies LoginGuard;
});
