import { Clock, Effect, Option, Redacted, Semaphore } from "effect";
import { type PasswordHash, verifyPassword } from "./crypto.js";

/**
 * Admin password checks with failed-login throttling per client address.
 * One check runs at a time (scrypt needs 128 MiB); a request that arrives
 * while another is being checked is turned away instead of queued, so a
 * flood cannot pile up memory or slip past the throttle. Logs carry counts
 * only: no address, no password.
 */

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

export type LoginResult =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "Rejected" }
  /** Too many failures from this address, or another check is running; try again later. */
  | { readonly _tag: "Throttled"; readonly retryAfterSeconds: number };

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
  readonly attempt: (address: string, password: Redacted.Redacted<string>) => Effect.Effect<LoginResult>;
}

export const makeLoginGuard = Effect.fn("LoginGuard.make")(function* (
  expected: Redacted.Redacted<PasswordHash>,
  policy: ThrottlePolicy = DEFAULT_THROTTLE,
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

  const check = Effect.fnUntraced(function* (address: string, password: Redacted.Redacted<string>) {
    const before = yield* Clock.currentTimeMillis;
    const entry = current(address, before);
    if (entry !== undefined && entry.nextAllowedAt > before) {
      return { _tag: "Throttled", retryAfterSeconds: Math.ceil((entry.nextAllowedAt - before) / 1000) } satisfies LoginResult;
    }
    const ok = yield* verifyPassword(password, Redacted.value(expected)).pipe(Effect.orElseSucceed(() => false));
    const now = yield* Clock.currentTimeMillis;
    if (ok) {
      failures.delete(address);
      return { _tag: "Accepted" } satisfies LoginResult;
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
    return { _tag: "Rejected" } satisfies LoginResult;
  });

  // Uninterruptible once admitted: scrypt keeps running natively after an
  // interruption (a dropped connection), so the permit is held and the
  // failure counted until it ends.
  const attempt = (address: string, password: Redacted.Redacted<string>): Effect.Effect<LoginResult> =>
    lock.withPermitsIfAvailable(1)(Effect.uninterruptible(check(address, password))).pipe(
      Effect.map(Option.getOrElse((): LoginResult => ({ _tag: "Throttled", retryAfterSeconds: 1 }))),
    );

  return { attempt } satisfies LoginGuard;
});
