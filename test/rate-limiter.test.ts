import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { FioBadRequest, RateLimited, TokenBusy } from "../src/errors.js";
import { makeRateLimiter, type RateLimiterOptions } from "../src/rate-limiter.js";

const KEY = "token-a";

/** A request that records its start time and returns `value`. */
const recorder = Effect.fnUntraced(function* () {
  const starts = yield* Ref.make<ReadonlyArray<number>>([]);
  const t0 = yield* Clock.currentTimeMillis;
  const job = <A>(value: A) =>
    Clock.currentTimeMillis.pipe(
      Effect.tap((t) => Ref.update(starts, (s) => [...s, t - t0])),
      Effect.as(value),
    );
  return { starts, job };
});

/** A request that fails with 409 for the first `conflicts` calls, after `delayMs`. */
const flaky = Effect.fnUntraced(function* (conflicts: number, delayMs = 0) {
  const calls = yield* Ref.make(0);
  const request = Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(calls, (c) => c + 1);
    if (delayMs > 0) yield* Effect.sleep(delayMs);
    if (n <= conflicts) return yield* new TokenBusy();
    return "ok";
  });
  return { calls, request };
});

const limiter = (options: RateLimiterOptions) => makeRateLimiter(options);

/** Lets forked fibers run up to their next suspension. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

describe("RateLimiter", () => {
  it.effect("spaces request starts by the interval and runs them in order", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 100_000 });
      const { starts, job } = yield* recorder();
      const fibers = yield* Effect.forEach(["a", "b", "c"], (v) => Effect.forkChild(rl.run(KEY, "interactive", job(v))));
      yield* settle;
      yield* TestClock.adjust(60_000);
      const results = yield* Effect.forEach(fibers, Fiber.join);
      assert.deepStrictEqual(results, ["a", "b", "c"]);
      assert.deepStrictEqual(yield* Ref.get(starts), [0, 30_000, 60_000]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not wait when the interval has already passed", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
      yield* rl.run(KEY, "interactive", Effect.succeed(1));
      yield* TestClock.adjust(31_000);
      const fiber = yield* Effect.forkChild(rl.run(KEY, "interactive", Effect.succeed(2)));
      yield* settle;
      assert.deepStrictEqual(yield* Fiber.join(fiber), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("fails fast with retry-after when the queue wait would exceed the cap", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
      yield* rl.run(KEY, "interactive", Effect.succeed("first"));
      yield* TestClock.adjust(2_000);
      const calls = yield* Ref.make(0);
      const error = yield* Effect.flip(rl.run(KEY, "interactive", Ref.update(calls, (n) => n + 1)));
      assert.instanceOf(error, RateLimited);
      assert.strictEqual(error.retryAfterSeconds, 28);
      assert.match(error.message, /retry after 28 s/i);
      assert.strictEqual(yield* Ref.get(calls), 0);
      // The rejected call did not reserve a slot.
      assert.strictEqual((yield* rl.state(KEY)).nextSlotInSeconds, 28);
    }).pipe(Effect.scoped),
  );

  it.effect("queues a call whose wait fits within the cap", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
      yield* rl.run(KEY, "interactive", Effect.succeed("first"));
      yield* TestClock.adjust(10_000);
      const calls = yield* Ref.make(0);
      const fiber = yield* Effect.forkChild(rl.run(KEY, "interactive", Ref.updateAndGet(calls, (n) => n + 1)));
      yield* settle;
      assert.strictEqual((yield* rl.state(KEY)).queued, 1);
      yield* TestClock.adjust(19_999);
      yield* settle;
      assert.strictEqual(yield* Ref.get(calls), 0);
      yield* TestClock.adjust(1);
      assert.strictEqual(yield* Fiber.join(fiber), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("retries once after HTTP 409 when the back-off fits the budget", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 40_000 });
      const { calls, request } = yield* flaky(1);
      const t0 = yield* Clock.currentTimeMillis;
      const fiber = yield* Effect.forkChild(rl.run(KEY, "interactive", request));
      yield* settle;
      assert.strictEqual(yield* Ref.get(calls), 1);
      yield* TestClock.adjust(29_999);
      yield* settle;
      assert.strictEqual(yield* Ref.get(calls), 1);
      yield* TestClock.adjust(1);
      assert.strictEqual(yield* Fiber.join(fiber), "ok");
      assert.strictEqual(yield* Ref.get(calls), 2);
      assert.strictEqual((yield* Clock.currentTimeMillis) - t0, 30_000);
      assert.isString((yield* rl.state(KEY)).last409At);
    }).pipe(Effect.scoped),
  );

  it.effect("fails fast after HTTP 409 when the back-off would exceed the budget", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
      const { calls, request } = yield* flaky(5);
      const error = yield* Effect.flip(rl.run(KEY, "interactive", request));
      assert.instanceOf(error, RateLimited);
      assert.match(error.message, /409/);
      assert.strictEqual(error.retryAfterSeconds, 30);
      assert.strictEqual(yield* Ref.get(calls), 1);
      // Later callers also see the token as busy.
      assert.strictEqual((yield* rl.state(KEY)).nextSlotInSeconds, 30);
    }).pipe(Effect.scoped),
  );

  it.effect("gives up after a second 409", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 60_000 });
      const { calls, request } = yield* flaky(5);
      const fiber = yield* Effect.forkChild(Effect.flip(rl.run(KEY, "interactive", request)));
      yield* settle;
      yield* TestClock.adjust(30_000);
      const error = yield* Fiber.join(fiber);
      assert.instanceOf(error, RateLimited);
      assert.match(error.message, /twice/);
      assert.strictEqual(yield* Ref.get(calls), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("delays already-queued calls when a 409 arrives later", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 40_000 });
      const { starts, job } = yield* recorder();
      // A starts at 0 and gets a 409 after 15 s.
      const { request } = yield* flaky(5, 15_000);
      const a = yield* Effect.forkChild(Effect.flip(rl.run(KEY, "interactive", request)));
      yield* settle;
      yield* TestClock.adjust(10_000);
      // B arrives at 10 s and would normally start at 30 s.
      const b = yield* Effect.forkChild(rl.run(KEY, "interactive", job("b")));
      yield* settle;
      yield* TestClock.adjust(5_000);
      yield* settle;
      // A's retry would start at 45 s, past its 40 s budget: it fails fast.
      assert.instanceOf(yield* Fiber.join(a), RateLimited);
      yield* TestClock.adjust(20_000);
      yield* settle;
      assert.deepStrictEqual(yield* Ref.get(starts), []);
      yield* TestClock.adjust(10_000);
      assert.strictEqual(yield* Fiber.join(b), "b");
      assert.deepStrictEqual(yield* Ref.get(starts), [45_000]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails a queued call fast when a 409 pushes it past its budget", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
      const { starts, job } = yield* recorder();
      // A starts at 0 and gets a 409 at 1 s; its retry (31 s) does not fit 25 s.
      const { request } = yield* flaky(5, 1_000);
      const a = yield* Effect.forkChild(Effect.flip(rl.run(KEY, "interactive", request)));
      yield* settle;
      // B arrives at 0.5 s, expecting the 30 s slot (29.5 s wait > 25 s): fails at arrival.
      yield* TestClock.adjust(500);
      const early = yield* Effect.flip(rl.run(KEY, "interactive", job("early")));
      assert.instanceOf(early, RateLimited);
      yield* TestClock.adjust(9_500);
      yield* settle;
      assert.instanceOf(yield* Fiber.join(a), RateLimited);
      // C arrives at 10 s; the token is blocked until 31 s (21 s wait): it fits.
      const c = yield* Effect.forkChild(rl.run(KEY, "interactive", job("c")));
      yield* settle;
      yield* TestClock.adjust(21_000);
      assert.strictEqual(yield* Fiber.join(c), "c");
      assert.deepStrictEqual(yield* Ref.get(starts), [31_000]);
    }).pipe(Effect.scoped),
  );

  it.effect("passes other errors through without retrying", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 60_000 });
      const calls = yield* Ref.make(0);
      const request = Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(Effect.fail(new FioBadRequest({ excerpt: "" }))));
      const error = yield* Effect.flip(rl.run(KEY, "interactive", request));
      assert.instanceOf(error, FioBadRequest);
      assert.strictEqual(yield* Ref.get(calls), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("stops waiting when the caller is interrupted, freeing its place", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 60_000 });
      yield* rl.run(KEY, "interactive", Effect.succeed(1));
      const calls = yield* Ref.make(0);
      const fiber = yield* Effect.forkChild(rl.run(KEY, "interactive", Ref.update(calls, (n) => n + 1)));
      yield* settle;
      yield* TestClock.adjust(5_000);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual((yield* rl.state(KEY)).queued, 0);
      yield* TestClock.adjust(60_000);
      yield* settle;
      assert.strictEqual(yield* Ref.get(calls), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("serves interactive calls before queued background calls", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 40_000 });
      const { starts, job } = yield* recorder();
      yield* rl.run(KEY, "interactive", Effect.succeed("first"));
      const bg = yield* Effect.forkChild(rl.run(KEY, "background", job("bg")));
      yield* settle;
      yield* TestClock.adjust(1_000);
      const fg = yield* Effect.forkChild(rl.run(KEY, "interactive", job("fg")));
      yield* settle;
      yield* TestClock.adjust(29_000);
      assert.strictEqual(yield* Fiber.join(fg), "fg");
      yield* TestClock.adjust(30_000);
      assert.strictEqual(yield* Fiber.join(bg), "bg");
      assert.deepStrictEqual(yield* Ref.get(starts), [30_000, 60_000]);
    }).pipe(Effect.scoped),
  );

  it.effect("background calls wait past the interactive budget", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 0 });
      yield* rl.run(KEY, "interactive", Effect.succeed("first"));
      const bg = yield* Effect.forkChild(rl.run(KEY, "background", Effect.succeed("bg")));
      yield* settle;
      yield* TestClock.adjust(30_000);
      assert.deepStrictEqual(yield* Fiber.await(bg), Exit.succeed("bg"));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps tokens independent and lets accounts share a key", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
      yield* rl.run("a", "interactive", Effect.succeed(1));
      // Another token starts immediately.
      assert.strictEqual(yield* rl.run("b", "interactive", Effect.succeed(2)), 2);
      // The same token (shared by two accounts) is busy.
      assert.instanceOf(yield* Effect.flip(rl.run("a", "interactive", Effect.succeed(3))), RateLimited);
    }).pipe(Effect.scoped),
  );
});
