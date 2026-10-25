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

/** A request that records its label and start time. */
const labelled = Effect.fnUntraced(function* () {
  const starts = yield* Ref.make<ReadonlyArray<readonly [string, number]>>([]);
  const t0 = yield* Clock.currentTimeMillis;
  const job = (label: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.tap((t) => Ref.update(starts, (s) => [...s, [label, t - t0] as const])),
      Effect.as(label),
    );
  return { starts, job };
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

  it.effect("lets a starved background call in once it has waited the time bound", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 1_000_000 });
      const { starts, job } = yield* labelled();
      yield* rl.run(KEY, "interactive", Effect.succeed("first"));
      const bg = yield* Effect.forkChild(rl.run(KEY, "background", job("bg")));
      const fg = yield* Effect.forEach(["i1", "i2", "i3"], (v) => Effect.forkChild(rl.run(KEY, "interactive", job(v))));
      yield* settle;
      yield* TestClock.adjust(120_000);
      yield* Effect.forEach([bg, ...fg], Fiber.join);
      // i1 overtakes it at 30 s; by 60 s it has waited 60 s and goes before i2.
      assert.deepStrictEqual(yield* Ref.get(starts), [
        ["i1", 30_000],
        ["bg", 60_000],
        ["i2", 90_000],
        ["i3", 120_000],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a starved background call in after the interactive calls that may overtake it", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 1_000_000, backgroundMaxWaitMs: 600_000 });
      const { starts, job } = yield* labelled();
      yield* rl.run(KEY, "interactive", Effect.succeed("first"));
      const bg = yield* Effect.forkChild(rl.run(KEY, "background", job("bg")));
      const fg = yield* Effect.forEach(["i1", "i2", "i3"], (v) => Effect.forkChild(rl.run(KEY, "interactive", job(v))));
      yield* settle;
      yield* TestClock.adjust(120_000);
      yield* Effect.forEach([bg, ...fg], Fiber.join);
      // Two interactive calls overtake it; the third waits for it.
      assert.deepStrictEqual(yield* Ref.get(starts), [
        ["i1", 30_000],
        ["i2", 60_000],
        ["bg", 90_000],
        ["i3", 120_000],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps each priority class in arrival order while the bound interleaves them", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 1_000_000 });
      const { starts, job } = yield* labelled();
      yield* rl.run(KEY, "interactive", Effect.succeed("first"));
      const background = yield* Effect.forEach(["b1", "b2"], (v) => Effect.forkChild(rl.run(KEY, "background", job(v))));
      const interactive = yield* Effect.forEach(["i1", "i2", "i3"], (v) =>
        Effect.forkChild(rl.run(KEY, "interactive", job(v))),
      );
      yield* settle;
      yield* TestClock.adjust(150_000);
      yield* Effect.forEach([...background, ...interactive], Fiber.join);
      // b2's wait counts from b1's start, so it does not jump ahead of i2.
      assert.deepStrictEqual(yield* Ref.get(starts), [
        ["i1", 30_000],
        ["b1", 60_000],
        ["i2", 90_000],
        ["b2", 120_000],
        ["i3", 150_000],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails an interactive call fast at arrival when a due background call takes its slot", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
      const { starts, job } = yield* labelled();
      yield* rl.run(KEY, "interactive", Effect.succeed("first"));
      const bg = yield* Effect.forkChild(rl.run(KEY, "background", job("bg")));
      yield* TestClock.adjust(10_000);
      const i1 = yield* Effect.forkChild(rl.run(KEY, "interactive", job("i1")));
      yield* settle;
      yield* TestClock.adjust(20_000);
      assert.strictEqual(yield* Fiber.join(i1), "i1");
      yield* TestClock.adjust(10_000);
      // At 40 s the 60 s slot belongs to the background call, so i2 would start at 90 s.
      assert.strictEqual((yield* rl.state(KEY)).nextSlotInSeconds, 50);
      const error = yield* Effect.flip(rl.run(KEY, "interactive", job("i2")));
      assert.instanceOf(error, RateLimited);
      assert.strictEqual(error.retryAfterSeconds, 50);
      yield* TestClock.adjust(20_000);
      assert.strictEqual(yield* Fiber.join(bg), "bg");
      assert.deepStrictEqual(yield* Ref.get(starts), [
        ["i1", 30_000],
        ["bg", 60_000],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("scales the default time bound with the interval", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 60_000, maxWaitMs: 1_000_000 });
      const { starts, job } = yield* labelled();
      yield* rl.run(KEY, "interactive", Effect.succeed("first"));
      const background = yield* Effect.forEach(["b1", "b2"], (v) => Effect.forkChild(rl.run(KEY, "background", job(v))));
      const interactive = yield* Effect.forEach(["i1", "i2", "i3"], (v) =>
        Effect.forkChild(rl.run(KEY, "interactive", job(v))),
      );
      yield* settle;
      yield* TestClock.adjust(300_000);
      yield* Effect.forEach([...background, ...interactive], Fiber.join);
      // With a 60 s interval the bound is 120 s, so background calls do not take every slot.
      assert.deepStrictEqual(yield* Ref.get(starts), [
        ["i1", 60_000],
        ["b1", 120_000],
        ["i2", 180_000],
        ["b2", 240_000],
        ["i3", 300_000],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("counts overtakes for the next background call only from its own arrival", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
      const { starts, job } = yield* labelled();
      yield* rl.run(KEY, "interactive", Effect.succeed("first"));
      yield* TestClock.adjust(1_000);
      const b1 = yield* Effect.forkChild(rl.run(KEY, "background", job("b1")));
      yield* TestClock.adjust(9_000);
      const i1 = yield* Effect.forkChild(rl.run(KEY, "interactive", job("i1")));
      yield* settle;
      yield* TestClock.adjust(21_000);
      assert.strictEqual(yield* Fiber.join(i1), "i1");
      // b2 arrives at 31 s, after i1 overtook b1.
      const b2 = yield* Effect.forkChild(rl.run(KEY, "background", job("b2")));
      yield* TestClock.adjust(9_000);
      const i2 = yield* Effect.forkChild(rl.run(KEY, "interactive", job("i2")));
      yield* settle;
      yield* TestClock.adjust(20_000);
      assert.strictEqual(yield* Fiber.join(i2), "i2");
      yield* TestClock.adjust(1_000);
      yield* Fiber.interrupt(b1);
      // b2 has been overtaken once and waited 59 s by the 90 s slot, so i3 still gets it.
      yield* TestClock.adjust(9_000);
      assert.strictEqual((yield* rl.state(KEY)).nextSlotInSeconds, 20);
      const i3 = yield* Effect.forkChild(rl.run(KEY, "interactive", job("i3")));
      yield* settle;
      yield* TestClock.adjust(50_000);
      yield* Effect.forEach([i3, b2], Fiber.join);
      assert.deepStrictEqual(yield* Ref.get(starts), [
        ["i1", 30_000],
        ["i2", 60_000],
        ["i3", 90_000],
        ["b2", 120_000],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails a queued interactive call when a 409 delays its slot past a background call's bound", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 40_000, backgroundMaxWaitMs: 70_000 });
      const { starts, job } = yield* labelled();
      yield* rl.run(KEY, "interactive", Effect.succeed("first"));
      const bg = yield* Effect.forkChild(rl.run(KEY, "background", job("bg")));
      // i1 starts at 30 s and gets a 409 at 40 s, blocking the token until 70 s.
      const { request } = yield* flaky(5, 10_000);
      yield* TestClock.adjust(10_000);
      const i1 = yield* Effect.forkChild(Effect.flip(rl.run(KEY, "interactive", request)));
      yield* settle;
      yield* TestClock.adjust(25_000);
      // i2 arrives at 35 s for the 60 s slot, which fits its 75 s deadline.
      const i2 = yield* Effect.forkChild(Effect.flip(rl.run(KEY, "interactive", job("i2"))));
      yield* settle;
      assert.strictEqual((yield* rl.state(KEY)).queued, 1);
      yield* TestClock.adjust(5_000);
      yield* settle;
      // By 70 s the background call has waited 70 s and takes that slot; i2 would start at 100 s.
      assert.instanceOf(yield* Fiber.join(i1), RateLimited);
      const error = yield* Fiber.join(i2);
      assert.instanceOf(error, RateLimited);
      assert.strictEqual(error.retryAfterSeconds, 60);
      yield* TestClock.adjust(30_000);
      assert.strictEqual(yield* Fiber.join(bg), "bg");
      assert.deepStrictEqual(yield* Ref.get(starts), [["bg", 70_000]]);
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

  it.effect("settles every caller when arrivals race a 409 that pushes queued calls past their budget", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 40_000 });
      // A holds the first slot and gets a 409 after 1 s, blocking the token until 31 s.
      const { request } = yield* flaky(5, 1_000);
      const a = yield* Effect.forkChild(Effect.exit(rl.run(KEY, "interactive", request)));
      yield* settle;
      // Waves of callers arrive before, at, and after the 409; each either runs or fails fast.
      const callers: Array<Fiber.Fiber<Exit.Exit<number, RateLimited>>> = [];
      for (const at of [0, 500, 1_000, 1_000, 1_500, 2_000]) {
        yield* TestClock.setTime(at);
        for (let i = 0; i < 3; i++) {
          callers.push(yield* Effect.forkChild(Effect.exit(rl.run(KEY, "interactive", Effect.succeed(i)))));
          callers.push(yield* Effect.forkChild(Effect.exit(rl.run(KEY, "background", Effect.succeed(i)))));
        }
        yield* Effect.yieldNow;
      }
      yield* settle;
      yield* TestClock.adjust(30 * 60_000);
      yield* settle;
      // A caller left waiting forever would hang here and fail the test by timeout.
      yield* Fiber.join(a);
      const exits = yield* Effect.forEach(callers, Fiber.join);
      assert.strictEqual(exits.length, callers.length);
      const state = yield* rl.state(KEY);
      assert.strictEqual(state.queued + state.queuedBackground, 0);
    }).pipe(Effect.scoped),
  );
});

describe("forgetting a token no account uses", () => {
  it.effect("keeps a token whose interval is still running and drops it once it passed", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 30_000, maxWaitMs: 5_000 });
      assert.strictEqual(yield* rl.run(KEY, "interactive", Effect.succeed(1)), 1);
      // Removed and re-added within the interval: the spacing still holds.
      yield* rl.forget(KEY);
      const early = yield* Effect.exit(rl.run(KEY, "interactive", Effect.succeed(2)));
      assert.isTrue(Exit.isFailure(early));
      yield* TestClock.adjust("30 seconds");
      yield* rl.forget(KEY);
      assert.strictEqual((yield* rl.state(KEY)).nextSlotInSeconds, 0);
      assert.strictEqual(yield* rl.run(KEY, "interactive", Effect.succeed(3)), 3);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a token while a call holds it, even once its interval passed", () =>
    Effect.gen(function* () {
      const rl = yield* limiter({ intervalMs: 1_000, maxWaitMs: 5_000 });
      // A request that takes longer than the interval, then gets a 409 and retries.
      const { calls, request } = yield* flaky(1, 3_000);
      const call = yield* Effect.forkChild(rl.run(KEY, "interactive", request));
      yield* settle;
      yield* TestClock.adjust("2 seconds");
      // Removed meanwhile: the call still holds the token's limiter, so it stays.
      yield* rl.forget(KEY);
      yield* TestClock.adjust("10 seconds");
      yield* settle;
      assert.deepStrictEqual(call.pollUnsafe(), Exit.succeed("ok"));
      assert.strictEqual(yield* Ref.get(calls), 2);
      // Done: now it is dropped.
      yield* rl.forget(KEY);
      assert.strictEqual((yield* rl.state(KEY)).nextSlotInSeconds, 0);
    }).pipe(Effect.scoped),
  );
});
