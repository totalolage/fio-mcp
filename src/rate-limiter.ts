import { Clock, Context, DateTime, Deferred, Effect, Fiber, Layer, Predicate, Queue, Ref, Result, SynchronizedRef } from "effect";
import { AppConfig } from "./config.js";
import { RateLimited, type TokenBusy } from "./errors.js";

/**
 * Per-token request pacing. FIO allows one request per token every 30 s for
 * any operation and answers HTTP 409 otherwise.
 *
 * Each token has one dispatcher and two FIFO queues. Interactive calls (tool
 * calls) go before background calls (cache sync), so a long backfill never
 * sits ahead of a user's question. Starts are at least `intervalMs` apart.
 *
 * Priority is bounded so that steady tool calls cannot starve sync: the
 * background head takes the next slot once `backgroundMaxOvertakes`
 * interactive calls have started ahead of it, or once it has waited
 * `backgroundMaxWaitMs`, whichever comes first. Both count from its arrival
 * or the previous background start, whichever is later.
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
  /** Interactive starts that may overtake the background head (default 2). */
  readonly backgroundMaxOvertakes?: number;
  /** Wait after which the background head goes next (default two intervals). */
  readonly backgroundMaxWaitMs?: number;
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
  /** When the call joined its queue (epoch ms). */
  readonly enqueuedAt: number;
  /** `TokenState.interactiveStarts` when the call joined its queue. */
  readonly startsBefore: number;
  readonly grant: Deferred.Deferred<void, RateLimited>;
}

interface TokenState {
  readonly lastStart: number;
  readonly blockedUntil: number;
  readonly last409At: number | undefined;
  /** Interactive calls started so far; overtakes are counted against it. */
  readonly interactiveStarts: number;
  readonly lastBackgroundStart: number;
  /** `interactiveStarts` at the last background start. */
  readonly startsBeforeLastBackground: number;
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
  readonly dispatcher: Fiber.Fiber<never>;
  /**
   * Calls of `run` that hold this limiter, from looking it up to their end.
   * Counted under the limiters lock, as `forget` checks it: a call that
   * already holds a limiter never finds it dropped (and its dispatcher gone).
   */
  users: number;
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
  /**
   * Drops the state of a token no account uses any more (removed or
   * replaced at /admin). A token with calls in flight or waiting keeps it,
   * so its spacing still holds. Using the key again starts afresh.
   */
  readonly forget: (key: string) => Effect.Effect<void>;
}

const initialState: TokenState = {
  lastStart: Number.NEGATIVE_INFINITY,
  blockedUntil: 0,
  last409At: undefined,
  interactiveStarts: 0,
  lastBackgroundStart: Number.NEGATIVE_INFINITY,
  startsBeforeLastBackground: 0,
  interactive: [],
  background: [],
};

export const makeRateLimiter = Effect.fn("RateLimiter.make")(function* (options: RateLimiterOptions) {
  const scope = yield* Effect.scope;
  const limiters = yield* SynchronizedRef.make(new Map<string, TokenLimiter>());
  const { intervalMs, maxWaitMs, backgroundMaxOvertakes = 2, backgroundMaxWaitMs = 2 * intervalMs } = options;

  const readyAt = (s: TokenState) => Math.max(s.lastStart + intervalMs, s.blockedUntil);

  /**
   * When the background head's wait began (its arrival or the previous
   * background start) and how many interactive calls have started since.
   */
  const headWait = (s: TokenState) => {
    const head = s.background[0];
    return {
      since: Math.max(head?.enqueuedAt ?? 0, s.lastBackgroundStart),
      overtaken: s.interactiveStarts - Math.max(head?.startsBefore ?? 0, s.startsBeforeLastBackground),
    };
  };

  const backgroundDue = (overtaken: number, waitedMs: number) =>
    overtaken >= backgroundMaxOvertakes || waitedMs >= backgroundMaxWaitMs;

  /**
   * Projected start of an interactive call with `ahead` interactive calls in
   * front of it, including the background calls the bound lets in first.
   */
  const projectStart = (s: TokenState, now: number, ahead: number) => {
    let at = Math.max(now, readyAt(s));
    let interactive = ahead;
    let background = s.background.length;
    let { since, overtaken } = headWait(s);
    for (;;) {
      if (background > 0 && backgroundDue(overtaken, at - since)) {
        background--;
        overtaken = 0;
        since = at;
      } else if (interactive > 0) {
        interactive--;
        if (background > 0) overtaken++;
      } else {
        return at;
      }
      at += intervalMs;
    }
  };

  const tooLate = (waitMs: number, reason?: string) =>
    new RateLimited({
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      reason:
        reason ??
        `FIO allows one request per ${Math.round(intervalMs / 1000)} s per token and the next free slot is ${Math.ceil(waitMs / 1000)} s away.`,
    });

  /**
   * One dispatcher step, decided atomically on the current state: drop the
   * interactive waiters a 409 or a due background call pushed past their
   * budget, then either grant the next slot or report how long until it
   * opens. Arrivals that happen while the dispatcher runs are never lost,
   * because nothing is decided on a stale snapshot.
   */
  const step = (now: number) =>
    (s: TokenState): [DispatchStep, TokenState] => {
      if (s.interactive.length === 0 && s.background.length === 0) {
        return [{ rejected: [], grant: undefined, waitMs: undefined }, s];
      }
      const ready = readyAt(s);
      const rejected: Array<readonly [Waiter, number]> = [];
      const survivors: Array<Waiter> = [];
      for (const waiter of s.interactive) {
        const projected = projectStart(s, now, survivors.length);
        if (projected > waiter.deadline) rejected.push([waiter, projected - now]);
        else survivors.push(waiter);
      }
      const pruned: TokenState = { ...s, interactive: survivors };
      if (ready > now) return [{ rejected, grant: undefined, waitMs: ready - now }, pruned];
      const [background, ...laterBackground] = s.background;
      const wait = headWait(s);
      if (background !== undefined && (survivors.length === 0 || backgroundDue(wait.overtaken, now - wait.since))) {
        const next: TokenState = {
          ...pruned,
          background: laterBackground,
          lastStart: now,
          lastBackgroundStart: now,
          startsBeforeLastBackground: s.interactiveStarts,
        };
        return [{ rejected, grant: background, waitMs: undefined }, next];
      }
      const [head, ...rest] = survivors;
      if (head === undefined) return [{ rejected, grant: undefined, waitMs: undefined }, pruned];
      const next: TokenState = { ...pruned, interactive: rest, lastStart: now, interactiveStarts: s.interactiveStarts + 1 };
      return [{ rejected, grant: head, waitMs: undefined }, next];
    };

  /** Hands out slots; fails interactive waiters a 409 pushed past their budget. */
  const dispatch = (limiter: Pick<TokenLimiter, "state" | "wake">): Effect.Effect<never> =>
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

  /** The token's limiter, made on first use; `use` makes the caller one of its `users`. */
  const limiterFor = (key: string, use = false) =>
    SynchronizedRef.modifyEffect(
      limiters,
      Effect.fnUntraced(function* (map) {
        let limiter = map.get(key);
        let next = map;
        if (limiter === undefined) {
          const state = yield* Ref.make(initialState);
          const wake = yield* Queue.sliding<void>(1);
          limiter = { state, wake, dispatcher: yield* Effect.forkIn(dispatch({ state, wake }), scope), users: 0 };
          next = new Map(map).set(key, limiter);
        }
        if (use) limiter.users += 1;
        return [limiter, next] as const;
      }),
    );

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
    const projected = priority === "interactive" ? projectStart(s, now, ahead) : now;
    if (projected > deadline) return yield* tooLate(projected - now, reason);
    const grant = yield* Deferred.make<void, RateLimited>();
    const queue = priority === "interactive" ? "interactive" : "background";
    const leave = Ref.update(limiter.state, (current) => ({
      ...current,
      interactive: current.interactive.filter((w) => w.grant !== grant),
      background: current.background.filter((w) => w.grant !== grant),
    })).pipe(Effect.andThen(signal(limiter)));
    // Enqueue without interruption, then wait interruptibly: an interrupted
    // caller always leaves the queue, so no orphan waiter takes a slot.
    yield* Effect.uninterruptibleMask((restore) =>
      Ref.update(limiter.state, (current) => {
        const waiter: Waiter = { deadline, enqueuedAt: now, startsBefore: current.interactiveStarts, grant };
        return { ...current, [queue]: front ? [waiter, ...current[queue]] : [...current[queue], waiter] };
      }).pipe(
        Effect.andThen(signal(limiter)),
        Effect.andThen(restore(Deferred.await(grant)).pipe(Effect.onInterrupt(() => leave))),
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
    return yield* Effect.acquireUseRelease(
      limiterFor(key, true),
      (limiter) => limited(limiter, priority, request),
      (limiter) =>
        Effect.sync(() => {
          limiter.users -= 1;
        }),
    );
  });

  const limited = Effect.fnUntraced(function* <A, E, R>(
    limiter: TokenLimiter,
    priority: Priority,
    request: Effect.Effect<A, E | TokenBusy, R>,
  ): Effect.fn.Return<A, Exclude<E, TokenBusy> | RateLimited, R> {
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
      const projected = projectStart(s, now, s.interactive.length);
      return {
        intervalSeconds: intervalMs / 1000,
        nextSlotInSeconds: Math.ceil(Math.max(0, projected - now) / 1000),
        queued: s.interactive.length,
        queuedBackground: s.background.length,
        last409At: s.last409At === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(s.last409At)),
      } satisfies RateLimitState;
  });

  const forget = (key: string) =>
    SynchronizedRef.updateEffect(limiters, (map) => {
      const limiter = map.get(key);
      if (limiter === undefined) return Effect.succeed(map);
      return Effect.gen(function* () {
        const s = yield* Ref.get(limiter.state);
        const now = yield* Clock.currentTimeMillis;
        // Busy: a call holds it (waiting, running, or retrying after a 409), or the
        // interval since its last request has not passed yet.
        if (limiter.users > 0 || readyAt(s) > now) return map;
        yield* Fiber.interrupt(limiter.dispatcher);
        const next = new Map(map);
        next.delete(key);
        return next;
      });
    });

  return { run, state, forget } satisfies RateLimiterShape;
});

export class RateLimiter extends Context.Service<RateLimiter, RateLimiterShape>()("fio-mcp/RateLimiter") {
  static readonly Default = Layer.effect(
    RateLimiter,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return RateLimiter.of(
        yield* makeRateLimiter({ intervalMs: config.rateLimitIntervalMs, maxWaitMs: config.maxWaitMs }),
      );
    }),
  );

  static readonly Live = RateLimiter.Default.pipe(Layer.provide(AppConfig.Live));
}

