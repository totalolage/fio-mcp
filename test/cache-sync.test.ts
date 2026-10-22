import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Redacted, Ref } from "effect";
import { TestClock } from "effect/testing";
import { tokenFingerprint } from "../src/accounts.js";
import { addDays } from "../src/cache/dates.js";
import { CacheSyncLive } from "../src/cache/service.js";
import { historyUnlockMessage, type SyncRequest } from "../src/cache/sync.js";
import {
  FioServerError,
  HISTORY_UNLOCK_STEPS,
  HistoryAuthorizationRequired,
  RateLimited,
  TooManyItems,
} from "../src/errors.js";
import {
  account,
  cacheLayer,
  config,
  enabledCache,
  fakeFio,
  NOW,
  type PeriodsScript,
  serveFrom,
  setNow,
  settle,
  statement,
  TODAY,
  TOKEN_A,
  tx,
} from "./support/cache.js";

const RECENT_START = addDays(TODAY, -89);
const DAY_MS = 86_400_000;

const movements = [tx(1, "2003-05-01", -100), tx(2, "2025-03-03", 250), tx(3, "2026-10-20", -42.5), tx(4, TODAY, 1000)];

/** HTTP 422 for anything older than the last 90 days; otherwise `inner`. */
const historyLocked =
  (inner: PeriodsScript): PeriodsScript =>
  (call, n) =>
    call.from < RECENT_START ? Effect.fail(new HistoryAuthorizationRequired()) : inner(call, n);

const TOKEN_FP = tokenFingerprint(Redacted.make(TOKEN_A));

const runToEnd = Effect.fnUntraced(function* (request: SyncRequest) {
  const cache = yield* enabledCache;
  const acc = yield* account();
  yield* cache.sync.start(acc, request);
  const job = yield* cache.sync.awaitJob(acc, 3_600_000);
  return Option.getOrThrow(job);
});

const ranges = (calls: ReadonlyArray<{ from: string; to: string }>) => calls.map((c) => `${c.from}..${c.to}`);

describe("cache sync", () => {
  it.effect("backfills the whole range in one background request", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      yield* Effect.gen(function* () {
        const job = yield* runToEnd({ kind: "backfill" });
        assert.strictEqual(job.status, "completed");
        assert.strictEqual(job.requests, 1);
        assert.strictEqual(job.rowsWritten, 4);
        const calls = yield* Ref.get(fio.calls);
        assert.deepStrictEqual(calls, [{ token: TOKEN_A, from: "2000-01-01", to: TODAY, priority: "background" }]);
        const cache = yield* enabledCache;
        const key = yield* cache.boundAccount(yield* account());
        assert.strictEqual(key, "2000000001/2010");
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [{ from: "2000-01-01", to: TODAY }]);
        assert.strictEqual((yield* cache.store.stats(key)).rowCount, 4);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("splits on HTTP 413 newest first and skips a single day that is still too large", () =>
    Effect.gen(function* () {
      yield* setNow();
      const bigDay = "2025-03-03";
      const script: PeriodsScript = (call, n) => {
        const days = (Date.parse(call.to) - Date.parse(call.from)) / DAY_MS + 1;
        const containsBigDay = call.from <= bigDay && call.to >= bigDay;
        return days > 2000 || containsBigDay ? Effect.fail(new TooManyItems()) : serveFrom(movements)(call, n);
      };
      const fio = yield* fakeFio(script);
      yield* Effect.gen(function* () {
        const job = yield* runToEnd({ kind: "backfill" });
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(job.failedDays, [bigDay]);
        const calls = yield* Ref.get(fio.calls);
        assert.deepStrictEqual(ranges(calls.slice(0, 1)), [`2000-01-01..${TODAY}`]);
        // The first split's newer half comes next, ending today.
        assert.strictEqual(calls[1]?.to, TODAY);
        assert.isTrue((calls[1]?.from ?? "") > "2013-01-01");
        // Every 413 is followed by the newer half of that range.
        for (let i = 0; i < calls.length - 1; i++) {
          const call = calls[i];
          const next = calls[i + 1];
          if (call === undefined || next === undefined || call.from === call.to) continue;
          const days = (Date.parse(call.to) - Date.parse(call.from)) / DAY_MS + 1;
          if (days > 2000 || (call.from <= bigDay && call.to >= bigDay)) assert.strictEqual(next.to, call.to);
        }
        assert.isTrue(calls.some((c) => c.from === bigDay && c.to === bigDay));
        const cache = yield* enabledCache;
        const key = yield* cache.boundAccount(yield* account());
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [
          { from: "2000-01-01", to: "2025-03-02" },
          { from: "2025-03-04", to: TODAY },
        ]);
        // The skipped day stays out of later automatic backfills.
        const before = calls.length;
        yield* runToEnd({ kind: "backfill" });
        assert.strictEqual((yield* Ref.get(fio.calls)).length, before);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("falls back to 90 days on HTTP 422, and a later backfill retries the blocked range first", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(historyLocked(serveFrom(movements)));
      yield* Effect.gen(function* () {
        const job = yield* runToEnd({ kind: "backfill" });
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [`2000-01-01..${TODAY}`, `${RECENT_START}..${TODAY}`]);
        assert.isTrue(job.historyLimited);
        assert.deepStrictEqual(job.blocked, [{ from: "2000-01-01", to: addDays(RECENT_START, -1) }]);
        const message = historyUnlockMessage(30_000);
        assert.strictEqual(job.lastError, message);
        assert.include(message, HISTORY_UNLOCK_STEPS);
        assert.include(
          message,
          "Then call sync_transactions with mode=backfill within 10 minutes; each request takes 30 s, so about 20 chunks fit in one unlock.",
        );
        const cache = yield* enabledCache;
        const state = yield* cache.store.syncState(TOKEN_FP);
        assert.isTrue(state.historyLimited);
        assert.isNotNull(state.historyLimitedSince);

        // Still locked: one request, then a clean stop.
        yield* Ref.set(fio.calls, []);
        const locked = yield* runToEnd({ kind: "backfill" });
        assert.strictEqual(locked.status, "completed");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [`2000-01-01..${addDays(RECENT_START, -1)}`]);
        assert.deepStrictEqual(locked.blocked, [{ from: "2000-01-01", to: addDays(RECENT_START, -1) }]);

        // Unlocked: the blocked range is fetched and the limit clears.
        yield* fio.setScript(serveFrom(movements));
        yield* Ref.set(fio.calls, []);
        const unlocked = yield* runToEnd({ kind: "backfill" });
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [`2000-01-01..${addDays(RECENT_START, -1)}`]);
        assert.isFalse(unlocked.historyLimited);
        assert.deepStrictEqual(unlocked.blocked, []);
        const key = yield* cache.boundAccount(yield* account());
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [{ from: "2000-01-01", to: TODAY }]);
        assert.strictEqual((yield* cache.store.stats(key)).rowCount, 4);
        assert.isFalse((yield* cache.store.syncState(TOKEN_FP)).historyLimited);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("startup retries blocked history first, then runs incremental even when it is still locked", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(historyLocked(serveFrom(movements)));
      const cfg = config({ cache: { syncOnStartup: true } });
      yield* Effect.gen(function* () {
        yield* runToEnd({ kind: "backfill" });
        yield* Ref.set(fio.calls, []);
        yield* TestClock.adjust(60 * 60_000);
        // "Restart": the startup layer forks its job without blocking the build.
        yield* Effect.gen(function* () {
          yield* settle;
          const cache = yield* enabledCache;
          const job = Option.getOrThrow(yield* cache.sync.awaitJob(yield* account(), 3_600_000));
          assert.strictEqual(job.kind, "startup");
          assert.strictEqual(job.status, "completed");
          assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [
            `2000-01-01..${addDays(RECENT_START, -1)}`,
            `${addDays(TODAY, -10)}..${TODAY}`,
          ]);
          assert.isTrue(job.historyLimited);
        }).pipe(Effect.provide(CacheSyncLive));
      }).pipe(Effect.provide(cacheLayer(cfg, fio.api)));
    }),
  );

  it.effect("startup with an unlocked history backfills the blocked range and skips a redundant incremental", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      const cfg = config({ cache: { syncOnStartup: true } });
      yield* Effect.gen(function* () {
        yield* settle;
        const cache = yield* enabledCache;
        const job = Option.getOrThrow(yield* cache.sync.awaitJob(yield* account(), 3_600_000));
        assert.strictEqual(job.status, "completed");
        // A fresh cache: one backfill request covers today, so no incremental follows.
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [`2000-01-01..${TODAY}`]);
      }).pipe(Effect.provide(CacheSyncLive.pipe(Layer.provideMerge(cacheLayer(cfg, fio.api)))));
    }),
  );

  it.effect("resumes persisted pending ranges after a restart", () =>
    Effect.gen(function* () {
      yield* setNow();
      const dbPath = join(mkdtempSync(join(tmpdir(), "fio-cache-")), "fio.sqlite");
      const tooBig: PeriodsScript = (call, n) =>
        (Date.parse(call.to) - Date.parse(call.from)) / DAY_MS + 1 > 4000
          ? Effect.fail(new TooManyItems())
          : serveFrom(movements)(call, n);
      // First run: two 413 splits, one success, then FIO fails.
      const first = yield* fakeFio((call, n) =>
        n === 4 ? Effect.fail(new FioServerError({ status: 503, excerpt: "" })) : tooBig(call, n),
      );
      const pending = yield* Effect.gen(function* () {
        const job = yield* runToEnd({ kind: "backfill" });
        assert.strictEqual(job.status, "failed");
        assert.include(job.lastError ?? "", "503");
        const cache = yield* enabledCache;
        const state = yield* cache.store.syncState(TOKEN_FP);
        assert.isAbove(state.pending.length, 0);
        assert.strictEqual(state.mode, "backfill");
        return state.pending;
      }).pipe(Effect.provide(cacheLayer(config({ cache: { dbPath } }), first.api)));

      // Second run on the same file: startup (syncOnStartup=false) resumes exactly the pending ranges.
      const second = yield* fakeFio(tooBig);
      yield* Effect.gen(function* () {
        yield* settle;
        const cache = yield* enabledCache;
        const job = Option.getOrThrow(yield* cache.sync.awaitJob(yield* account(), 3_600_000));
        assert.strictEqual(job.status, "completed");
        const calls = yield* Ref.get(second.calls);
        assert.deepStrictEqual(ranges(calls.slice(0, pending.length)), ranges(pending));
        const key = yield* cache.boundAccount(yield* account());
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [{ from: "2000-01-01", to: TODAY }]);
        assert.deepStrictEqual((yield* cache.store.syncState(TOKEN_FP)).pending, []);
      }).pipe(Effect.provide(CacheSyncLive.pipe(Layer.provideMerge(cacheLayer(config({ cache: { dbPath } }), second.api)))));
    }),
  );

  it.effect("incremental re-fetches the overlap window and picks up a late-booked movement", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      yield* Effect.gen(function* () {
        yield* runToEnd({ kind: "backfill" });
        yield* setNow(NOW + 3 * DAY_MS);
        const late = tx(5, "2026-10-21", -77);
        yield* fio.setScript(serveFrom([...movements, late]));
        yield* Ref.set(fio.calls, []);
        const job = yield* runToEnd({ kind: "incremental" });
        assert.strictEqual(job.status, "completed");
        // Window: [newest covered (2026-10-22) - 10 days, today (2026-10-25)].
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), ["2026-10-12..2026-10-25"]);
        const cache = yield* enabledCache;
        const key = yield* cache.boundAccount(yield* account());
        const found = yield* cache.store.transactionsIn(key, { from: "2026-10-21", to: "2026-10-21" });
        assert.deepStrictEqual(
          found.map((t) => t.id),
          [5],
        );
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("incremental never reaches before the earliest covered day; with no coverage it backfills", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        yield* cache.writeThrough(acc, yield* serveFrom(movements)({ token: "", from: "2026-10-20", to: TODAY, priority: undefined }, 0), {
          from: "2026-10-20",
          to: TODAY,
        });
        yield* runToEnd({ kind: "incremental" });
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [`2026-10-20..${TODAY}`]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
      yield* Ref.set(fio.calls, []);
      yield* Effect.gen(function* () {
        const job = yield* runToEnd({ kind: "incremental" });
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [`2000-01-01..${TODAY}`]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("runs one job per token; a second request joins the running one", () =>
    Effect.gen(function* () {
      yield* setNow();
      const gate = yield* Deferred.make<void>();
      const fio = yield* fakeFio((call, n) => Effect.andThen(Deferred.await(gate), serveFrom(movements)(call, n)));
      const cfg = config({
        accounts: [
          { name: "main", token: Redacted.make(TOKEN_A), accountNumber: undefined, currency: undefined },
          { name: "alias", token: Redacted.make(TOKEN_A), accountNumber: undefined, currency: undefined },
        ],
      });
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const main = yield* account("main");
        const alias = yield* account("alias");
        const first = yield* cache.sync.start(main, { kind: "backfill" });
        yield* settle;
        const second = yield* cache.sync.start(main, { kind: "incremental" });
        const third = yield* cache.sync.start(alias, { kind: "backfill" });
        assert.isFalse(first.joined);
        assert.isTrue(second.joined);
        assert.isTrue(third.joined);
        assert.strictEqual(second.progress.kind, "backfill");
        assert.strictEqual(second.progress.status, "running");
        yield* Deferred.succeed(gate, undefined);
        const done = Option.getOrThrow(yield* cache.sync.awaitJob(main, 3_600_000));
        assert.strictEqual(done.status, "completed");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 1);
        // Finished: the next request starts a new job.
        assert.isFalse((yield* cache.sync.start(alias, { kind: "incremental" })).joined);
      }).pipe(Effect.provide(cacheLayer(cfg, fio.api)));
    }),
  );

  it.effect("waits and retries as long as the token stays busy instead of failing the job", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio((call, n) =>
        n < 8 ? Effect.fail(new RateLimited({ retryAfterSeconds: 30, reason: "busy" })) : serveFrom(movements)(call, n),
      );
      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runToEnd({ kind: "backfill" }));
        for (let i = 0; i < 8; i++) {
          yield* settle;
          yield* TestClock.adjust(30_000);
        }
        const job = yield* Fiber.join(fiber);
        assert.strictEqual(job.status, "completed");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 9);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("a single day over 50,000 movements inside unlocked history leaves blocked and is not retried", () =>
    Effect.gen(function* () {
      yield* setNow();
      const bigDay = "2010-06-15";
      const fio = yield* fakeFio(historyLocked(serveFrom(movements)));
      yield* Effect.gen(function* () {
        yield* runToEnd({ kind: "backfill" });
        yield* fio.setScript((call, n) =>
          call.from <= bigDay && call.to >= bigDay ? Effect.fail(new TooManyItems()) : serveFrom(movements)(call, n),
        );
        const unlocked = yield* runToEnd({ kind: "backfill" });
        assert.deepStrictEqual(unlocked.failedDays, [bigDay]);
        assert.deepStrictEqual(unlocked.blocked, []);
        assert.isFalse(unlocked.historyLimited);
        yield* Ref.set(fio.calls, []);
        yield* runToEnd({ kind: "backfill" });
        assert.deepStrictEqual(yield* Ref.get(fio.calls), []);
        // An explicit retry of failed days asks for it again.
        yield* runToEnd({ kind: "backfill", retryFailed: true });
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [`${bigDay}..${bigDay}`]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("a response whose header covers less leaves the rest uncovered for the next backfill", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio((call, n) =>
        Effect.map(serveFrom(movements)(call, n), (s) => ({
          ...s,
          info: { ...s.info, dateStart: call.from < "2005-01-01" ? "2005-01-01" : call.from },
        })),
      );
      yield* Effect.gen(function* () {
        const job = yield* runToEnd({ kind: "backfill" });
        assert.strictEqual(job.status, "completed");
        const cache = yield* enabledCache;
        const key = yield* cache.boundAccount(yield* account());
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [{ from: "2005-01-01", to: TODAY }]);
        yield* Ref.set(fio.calls, []);
        yield* runToEnd({ kind: "backfill" });
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), ["2000-01-01..2004-12-31"]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("a response with a movement lacking an ID fails the job and leaves coverage, rows and pending unchanged", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      yield* Effect.gen(function* () {
        yield* runToEnd({ kind: "backfill" });
        yield* setNow(NOW + 3 * DAY_MS);
        yield* fio.setScript((call) =>
          Effect.succeed(statement(call.from, call.to, [tx(3, "2026-10-20", -1), tx(9, "2026-10-24", 5, { id: null })])),
        );
        const job = yield* runToEnd({ kind: "incremental" });
        assert.strictEqual(job.status, "failed");
        assert.include(job.lastError ?? "", "without a movement ID or date");
        const cache = yield* enabledCache;
        const key = yield* cache.boundAccount(yield* account());
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [{ from: "2000-01-01", to: TODAY }]);
        const kept = yield* cache.store.transactionsIn(key, { from: "2026-10-20", to: "2026-10-25" });
        assert.deepStrictEqual(
          kept.map((t) => [t.id, t.amount]),
          [
            [3, -42.5],
            [4, 1000],
          ],
        );
        // The window stays pending for the next run.
        assert.deepStrictEqual((yield* cache.store.syncState(TOKEN_FP)).pending, [{ from: "2026-10-12", to: "2026-10-25" }]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("periodic sync runs incremental every syncIntervalMinutes", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      const cfg = config({ cache: { syncIntervalMinutes: 15 } });
      yield* Effect.gen(function* () {
        yield* runToEnd({ kind: "backfill" });
        yield* Ref.set(fio.calls, []);
        yield* Effect.gen(function* () {
          yield* settle;
          assert.strictEqual((yield* Ref.get(fio.calls)).length, 0);
          yield* TestClock.adjust(15 * 60_000);
          yield* settle;
          yield* TestClock.adjust(15 * 60_000);
          yield* settle;
          assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [
            `${addDays(TODAY, -10)}..${TODAY}`,
            `${addDays(TODAY, -10)}..${TODAY}`,
          ]);
        }).pipe(Effect.provide(CacheSyncLive));
      }).pipe(Effect.provide(cacheLayer(cfg, fio.api)));
    }),
  );
});
