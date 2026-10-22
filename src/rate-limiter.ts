import { Clock, Context, DateTime, Deferred, Effect, Layer, Predicate, Queue, Ref, Result, SynchronizedRef } from "effect";
import { AppConfig } from "./config.js";
import { RateLimited, type TokenBusy } from "./errors.js";

/**
 * Per-token request pacing. FIO allows one request per token every 30 s for
 * any operation and answers HTTP 409 otherwise.
 *
 * Each token has one dispatcher and two FIFO queues. Interactive calls (tool
 * calls) always go before background calls (cache sync), so a long backfill
 * never sits ahead of a user's question. Starts are at least `intervalMs`
 * apart.
 *
 * Interactive calls have a wait budget (`maxWaitMs` from arrival). A call that
 * cannot start within it fails with a retry-after hint instead of hanging past
 * the MCP client's timeout: at arrival when the projected start is already too
 * late, or later when a 409 pushes the queue back. Background calls wait as
 * long as it takes.
 *
 * On HTTP 409 (token used elsewhere within the window) the token is blocked
 * for a full interval, which delays everyone queued, and the call retries
 * once at the front of its queue if that still fits its budget.
 */

export type Priority = "interactive" | "background";

export interface RateLimiterOptions {
  /** Minimum spacing between request starts. */
  readonly intervalMs: number;
  /** Longest an interactive call may spend waiting before failing fast. */
  readonly maxWaitMs: number;
}

export interface RateLimitState {
  readonly intervalSeconds: number;
  /** Seconds until a newly arriving interactive call could start (0 = now). */
  readonly nextSlotInSeconds: number;
  /** Interactive calls waiting for a slot. */
  readonly queued: number;
  /** Background (sync) calls waiting for a slot. */
  readonly queuedBackground: number;
  /** ISO time of the last HTTP 409, or null if none. */
  readonly last409At: string | null;
}

interface Waiter {
  /** Latest acceptable start (epoch ms); past it an interactive call fails fast. */
  readonly deadline: number;
  readonly grant: Deferred.Deferred<void, RateLimited>;
}

interface TokenState {
  readonly lastStart: number;
  readonly blockedUntil: number;
  readonly last409At: number | undefined;
  readonly interactive: ReadonlyArray<Waiter>;
  readonly background: ReadonlyArray<Waiter>;
}

interface DispatchStep {
  /** Interactive waiters that can no longer start within budget, with their projected wait. */
  readonly rejected: ReadonlyArray<readonly [Waiter, number]>;
  readonly grant: Waiter | undefined;
  /** Milliseconds until the next slot opens, when no grant was possible yet. */
  readonly waitMs: number | undefined;
}

interface TokenLimiter {
  readonly state: Ref.Ref<TokenState>;
  /** Wakes the dispatcher after arrivals, cancellations, and 409 blocks. */
  readonly wake: Queue.Queue<void>;
}

const CONFLICT_REASON = "FIO returned HTTP 409 (the token was used elsewhere within the last 30 s).";
const SECOND_CONFLICT_REASON = "FIO returned HTTP 409 twice; another client is probably using this token.";

export interface RateLimiterShape {
  /**
   * Runs `request` in the token's next slot. A `TokenBusy` failure (HTTP 409)
   * is consumed: the token is blocked for an interval and the request retried
   * once, or the call fails with `RateLimited`.
   */
  readonly run: <A, E, R>(
    key: string,
    priority: Priority,
    request: Effect.Effect<A, E | TokenBusy, R>,
  ) => Effect.Effect<A, Exclude<E, TokenBusy> | RateLimited, R>;
  readonly state: (key: string) => Effect.Effect<RateLimitState>;
}

const initialState: TokenState = {
  lastStart: Number.NEGATIVE_INFINITY,
  blockedUntil: 0,
  last409At: undefined,
  interactive: [],
  background: [],
};

export const makeRateLimiter = Effect.fn("RateLimiter.make")(function* (options: RateLimiterOptions) {
  const scope = yield* Effect.scope;
  const limiters = yield* SynchronizedRef.make(new Map<string, TokenLimiter>());
  const { intervalMs, maxWaitMs } = options;

  const readyAt = (s: TokenState) => Math.max(s.lastStart + intervalMs, s.blockedUntil);

  const tooLate = (waitMs: number, reason?: string) =>
    new RateLimited({
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      reason:
        reason ??
        `FIO allows one request per ${Math.round(intervalMs / 1000)} s per token and the next free slot is ${Math.ceil(waitMs / 1000)} s away.`,
    });

  /**
   * One dispatcher step, decided atomically on the current state: drop the
   * interactive waiters a 409 pushed past their budget, then either grant the
   * next slot or report how long until it opens. Arrivals that happen while
   * the dispatcher runs are never lost, because nothing is decided on a
   * stale snapshot.
   */
  const step = (now: number) =>
    (s: TokenState): [DispatchStep, TokenState] => {
      if (s.interactive.length === 0 && s.background.length === 0) {
        return [{ rejected: [], grant: undefined, waitMs: undefined }, s];
      }
      const ready = readyAt(s);
      const start = Math.max(now, ready);
      const rejected: Array<readonly [Waiter, number]> = [];
      const survivors: Array<Waiter> = [];
      for (const waiter of s.interactive) {
        const projected = start + survivors.length * intervalMs;
        if (projected > waiter.deadline) rejected.push([waiter, projected - now]);
        else survivors.push(waiter);
      }
      const pruned: TokenState = { ...s, interactive: survivors };
      if (ready > now) return [{ rejected, grant: undefined, waitMs: ready - now }, pruned];
      const [head, ...rest] = survivors.length > 0 ? survivors : s.background;
      if (head === undefined) return [{ rejected, grant: undefined, waitMs: undefined }, pruned];
      const queues = survivors.length > 0 ? { interactive: rest } : { background: rest };
      return [{ rejected, grant: head, waitMs: undefined }, { ...pruned, ...queues, lastStart: now }];
    };

  /** Hands out slots; fails interactive waiters a 409 pushed past their budget. */
  const dispatch = (limiter: TokenLimiter): Effect.Effect<never> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { rejected, grant, waitMs } = yield* Ref.modify(limiter.state, step(now));
      for (const [waiter, waitFor] of rejected) yield* Deferred.fail(waiter.grant, tooLate(waitFor));
      if (grant !== undefined) {
        yield* Deferred.succeed(grant.grant, undefined);
        return;
      }
      // Sleep until the slot opens or something changes (arrival, cancellation, 409).
      yield* waitMs === undefined
        ? Queue.take(limiter.wake)
        : Queue.take(limiter.wake).pipe(Effect.timeoutOrElse({ duration: waitMs, orElse: () => Effect.void }));
    }).pipe(Effect.forever);

  const limiterFor = (key: string) =>
    SynchronizedRef.modifyEffect(limiters, (map) => {
      const existing = map.get(key);
      if (existing !== undefined) return Effect.succeed([existing, map] as const);
      return Effect.gen(function* () {
        const limiter: TokenLimiter = {
          state: yield* Ref.make(initialState),
          wake: yield* Queue.sliding<void>(1),
        };
        yield* Effect.forkIn(dispatch(limiter), scope);
        return [limiter, new Map(map).set(key, limiter)] as const;
      });
    });

  const signal = (limiter: TokenLimiter) => Queue.offer(limiter.wake, undefined).pipe(Effect.asVoid);

  const acquire = Effect.fnUntraced(function* (
    limiter: TokenLimiter,
    priority: Priority,
    deadline: number,
    front: boolean,
    reason?: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const s = yield* Ref.get(limiter.state);
    const ahead = priority === "interactive" && !front ? s.interactive.length : 0;
    const projected = Math.max(now, readyAt(s)) + ahead * intervalMs;
    if (projected > deadline) return yield* tooLate(projected - now, reason);
    const waiter: Waiter = { deadline, grant: yield* Deferred.make<void, RateLimited>() };
    const queue = priority === "interactive" ? "interactive" : "background";
    const leave = Ref.update(limiter.state, (current) => ({
      ...current,
      interactive: current.interactive.filter((w) => w !== waiter),
      background: current.background.filter((w) => w !== waiter),
    })).pipe(Effect.andThen(signal(limiter)));
    // Enqueue without interruption, then wait interruptibly: an interrupted
    // caller always leaves the queue, so no orphan waiter takes a slot.
    yield* Effect.uninterruptibleMask((restore) =>
      Ref.update(limiter.state, (current) => ({
        ...current,
        [queue]: front ? [waiter, ...current[queue]] : [...current[queue], waiter],
      })).pipe(
        Effect.andThen(signal(limiter)),
        Effect.andThen(restore(Deferred.await(waiter.grant)).pipe(Effect.onInterrupt(() => leave))),
      ),
    );
  });

  const block = Effect.fnUntraced(function* (limiter: TokenLimiter) {
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(limiter.state, (current) => ({
      ...current,
      last409At: now,
      blockedUntil: Math.max(current.blockedUntil, now + intervalMs),
    }));
    yield* signal(limiter);
  });

  const run = Effect.fnUntraced(function* <A, E, R>(
    key: string,
    priority: Priority,
    request: Effect.Effect<A, E | TokenBusy, R>,
  ): Effect.fn.Return<A, Exclude<E, TokenBusy> | RateLimited, R> {
    const limiter = yield* limiterFor(key);
    const arrival = yield* Clock.currentTimeMillis;
    const deadline = priority === "interactive" ? arrival + maxWaitMs : Number.POSITIVE_INFINITY;
    yield* acquire(limiter, priority, deadline, false);
    for (const attempt of [1, 2]) {
      const outcome = yield* Effect.result(request);
      if (Result.isSuccess(outcome)) return outcome.success;
      const failure = outcome.failure;
      if (!Predicate.isTagged(failure, "TokenBusy")) return yield* Effect.fail(failure as Exclude<E, TokenBusy>);
      yield* block(limiter);
      if (attempt === 1) yield* acquire(limiter, priority, deadline, true, CONFLICT_REASON);
    }
    return yield* new RateLimited({ retryAfterSeconds: Math.ceil(intervalMs / 1000), reason: SECOND_CONFLICT_REASON });
  });

  const state = Effect.fnUntraced(function* (key: string) {
      const limiter = yield* limiterFor(key);
      const now = yield* Clock.currentTimeMillis;
      const s = yield* Ref.get(limiter.state);
      const projected = Math.max(now, readyAt(s)) + s.interactive.length * intervalMs;
      return {
        intervalSeconds: intervalMs / 1000,
        nextSlotInSeconds: Math.ceil(Math.max(0, projected - now) / 1000),
        queued: s.interactive.length,
        queuedBackground: s.background.length,
        last409At: s.last409At === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(s.last409At)),
      } satisfies RateLimitState;
  });

  return { run, state } satisfies RateLimiterShape;
});

export class RateLimiter extends Context.Service<RateLimiter, RateLimiterShape>()("fio-mcp/RateLimiter") {
  static readonly layer = Layer.effect(
    RateLimiter,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return RateLimiter.of(
        yield* makeRateLimiter({ intervalMs: config.rateLimitIntervalMs, maxWaitMs: config.maxWaitMs }),
      );
    }),
  );

  static readonly layerFrom = (options: RateLimiterOptions) =>
    Layer.effect(RateLimiter, Effect.map(makeRateLimiter(options), RateLimiter.of));
}

