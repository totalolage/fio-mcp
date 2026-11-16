import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Redacted, Ref } from "effect";
import { AccountChangesLive } from "../src/account-runtime.js";
import { type Account, Accounts, tokenFingerprint } from "../src/accounts.js";
import { makeAccountAdmin } from "../src/admin/accounts.js";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import { Transactions } from "../src/cache/service.js";
import { accountSeedOf } from "../src/config.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { Redactor } from "../src/redaction.js";
import { account, config, setNow, settle, TOKEN_A, TOKEN_B } from "./support/cache.js";
import { seededConfig } from "./support/config.js";
import { testDatabase } from "./support/database.js";
import { fakeFio } from "./support/fio-api.js";

const ADMIN_KEY = Redacted.make(new Uint8Array(32).fill(7));
const TOKEN_C = "c".repeat(64);
const FP_B = tokenFingerprint(Redacted.make(TOKEN_B));
const FP_C = tokenFingerprint(Redacted.make(TOKEN_C));

/** The token's job in this process, as get_cache_status reports it; null when there is none. */
const jobOf = (acc: Account) =>
  Effect.gen(function* () {
    const [status] = yield* Effect.orDie((yield* Transactions).status([acc]));
    return status?.job ?? null;
  });

describe("following account changes made at /admin", () => {
  it.effect("a removal handled after the token came back leaves its new job and rate limiter alone", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(() => Effect.never);
      // The rate limiter records what it is told to forget. Forgetting `other`'s token holds the
      // change follower until `release`, so the changes after it queue up behind it; forgetting
      // `spare`'s token, removed last, signals that the follower handled everything before it.
      const forgotten = yield* Ref.make<ReadonlyArray<string>>([]);
      const [held, release, done] = [yield* Deferred.make<void>(), yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const limiter = Layer.mock(RateLimiter, {
        forget: (key) =>
          Effect.gen(function* () {
            yield* Ref.update(forgotten, (keys) => [...keys, key]);
            if (key === FP_B) {
              yield* Deferred.succeed(held, undefined);
              yield* Deferred.await(release);
            }
            if (key === FP_C) yield* Deferred.succeed(done, undefined);
          }),
      });
      const cfg = config({
        accounts: [
          { name: "main", token: Redacted.make(TOKEN_A), accountNumber: undefined, currency: undefined },
          { name: "other", token: Redacted.make(TOKEN_B), accountNumber: undefined, currency: undefined },
          { name: "spare", token: Redacted.make(TOKEN_C), accountNumber: undefined, currency: undefined },
        ],
      });
      const layer = AccountChangesLive.pipe(
        Layer.provideMerge(Transactions.Default),
        Layer.provideMerge(Accounts.stored(ADMIN_KEY, accountSeedOf(cfg.accounts))),
        Layer.provideMerge(testDatabase(":memory:", SERVER_MIGRATIONS)),
        Layer.provideMerge(Layer.mergeAll(Redactor.Default, fio.layer, limiter)),
        Layer.provideMerge(seededConfig(cfg)),
      );
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const admin = yield* makeAccountAdmin(ADMIN_KEY);
        yield* settle;
        yield* admin.remove((yield* account("other")).id, false);
        yield* Deferred.await(held);

        // While the follower is held: main is removed and added again with the same token,
        // and a sync job (sync_transactions) starts for it, with someone waiting for it.
        yield* admin.remove((yield* account("main")).id, false);
        yield* admin.add({ name: "main", token: TOKEN_A, accountNumber: undefined, currency: undefined });
        const main = yield* account("main");
        const started = yield* Effect.orDie(cache.sync(main, { kind: "backfill" }));
        assert.isTrue(started.started);
        const waiting = yield* Effect.forkChild(cache.sync(main, { kind: "resume" }, 3_600_000), { startImmediately: true });
        yield* settle;

        // The follower now handles the removal, then the re-add, then spare's removal.
        yield* admin.remove((yield* account("spare")).id, false);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(done);
        const job = yield* jobOf(main);
        assert.strictEqual(job?.status, "running");
        assert.isNull(job?.lastError ?? null);
        assert.isUndefined(waiting.pollUnsafe(), "the job someone waits for was stopped");
        assert.deepStrictEqual(yield* Ref.get(forgotten), [FP_B, FP_C]);
        yield* Fiber.interrupt(waiting);
      }).pipe(Effect.provide(layer));
    }),
  );
});
