import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { BoxLocks } from "../../src/domain/box-locks.js";

/** Holds `boxId` until `release` completes; `entered` completes once the permit is held. */
const hold = Effect.fn("hold")(function* (locks: BoxLocks["Service"], boxId: string, events: Array<string>, name: string) {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const fiber = yield* locks
    .withBox(
      boxId,
      Effect.sync(() => events.push(`${name}:start`)).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Effect.sync(() => events.push(`${name}:end`))),
      ),
    )
    .pipe(Effect.forkChild);
  yield* Deferred.await(entered);
  return { fiber, release: Deferred.succeed(release, undefined) };
});

describe("BoxLocks", () => {
  it.effect("runs one box's effects one at a time and other boxes alongside", () =>
    Effect.gen(function* () {
      const locks = yield* BoxLocks;
      const events: Array<string> = [];
      const a = yield* hold(locks, "b1", events, "a");

      const waiting = yield* locks
        .withBox("b1", Effect.sync(() => events.push("b")))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* locks.withBox("b2", Effect.sync(() => events.push("other")));
      assert.deepStrictEqual(events, ["a:start", "other"]);
      assert.isUndefined(waiting.pollUnsafe());

      yield* a.release;
      yield* Fiber.join(a.fiber);
      yield* Fiber.join(waiting);
      assert.deepStrictEqual(events, ["a:start", "other", "a:end", "b"]);
    }).pipe(Effect.provide(BoxLocks.Default)),
  );

  it.effect("keeps the box exclusive after a waiter is interrupted and after the box goes idle", () =>
    Effect.gen(function* () {
      const locks = yield* BoxLocks;
      const events: Array<string> = [];
      const a = yield* hold(locks, "b1", events, "a");
      const interrupted = yield* locks
        .withBox("b1", Effect.sync(() => events.push("never")))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(interrupted);

      const waiting = yield* locks
        .withBox("b1", Effect.sync(() => events.push("b")))
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.isUndefined(waiting.pollUnsafe());
      yield* a.release;
      yield* Fiber.join(a.fiber);
      yield* Fiber.join(waiting);

      // Idle now: a new holder gets a fresh permit, and it still excludes the next caller.
      const c = yield* hold(locks, "b1", events, "c");
      const after = yield* locks
        .withBox("b1", Effect.sync(() => events.push("d")))
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.isUndefined(after.pollUnsafe());
      yield* c.release;
      yield* Fiber.join(c.fiber);
      yield* Fiber.join(after);
      assert.deepStrictEqual(events, ["a:start", "a:end", "b", "c:start", "c:end", "d"]);
    }).pipe(Effect.provide(BoxLocks.Default)),
  );
});
