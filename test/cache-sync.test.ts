import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Redacted, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { StoredAccountsLive } from "../src/account-store.js";
import { Accounts, tokenFingerprint } from "../src/accounts.js";
import { makeAccountAdmin } from "../src/admin/accounts.js";
import { addDays } from "../src/cache/dates.js";
import { databaseLayer, SERVER_MIGRATIONS } from "../src/cache/db.js";
import { CacheSyncLive, TransactionCacheFromSql } from "../src/cache/service.js";
import { historyUnlockMessage, type SyncRequest } from "../src/cache/sync.js";
import { AppConfig, accountSeedOf } from "../src/config.js";
import {
  FioServerError,
  HISTORY_UNLOCK_STEPS,
  HistoryAuthorizationRequired,
  RateLimited,
  TooManyItems,
} from "../src/errors.js";
import { FioApi, type FioApiShape } from "../src/fio-api.js";
import { Redactor } from "../src/redaction.js";
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
  TOKEN_B,
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
        assert.deepStrictEqual((yield* cache.store.syncState(TOKEN_FP)).pending, [
          { from: "2026-10-12", to: "2026-10-25", replace: false },
        ]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("refresh re-downloads covered days, replaces changed movements and deletes dropped ones; backfill skips them", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      yield* Effect.gen(function* () {
        yield* runToEnd({ kind: "backfill" });
        // FIO changed movement 3, cancelled movement 4 and booked movement 6 late.
        const changed = [movements[0]!, movements[1]!, tx(3, "2026-10-20", -50), tx(6, "2026-10-21", 7)];
        yield* fio.setScript(serveFrom(changed));
        yield* Ref.set(fio.calls, []);
        const cache = yield* enabledCache;
        const key = yield* cache.boundAccount(yield* account());
        const recent = { from: "2026-10-15", to: TODAY };
        const amounts = Effect.map(cache.store.transactionsIn(key, recent), (rows) => rows.map((t) => [t.id, t.amount]));

        // A normal sync still skips covered days.
        assert.strictEqual((yield* runToEnd({ kind: "backfill", from: "2026-10-01" })).status, "completed");
        assert.deepStrictEqual(yield* Ref.get(fio.calls), []);
        assert.deepStrictEqual(yield* amounts, [
          [3, -42.5],
          [4, 1000],
        ]);

        const job = yield* runToEnd({ kind: "refresh", range: { from: "2026-10-15", to: "2026-10-30" } });
        assert.strictEqual(job.status, "completed");
        assert.strictEqual(job.kind, "refresh");
        // Days after today are not asked for; the request waits at background priority.
        assert.deepStrictEqual(yield* Ref.get(fio.calls), [
          { token: TOKEN_A, from: "2026-10-15", to: TODAY, priority: "background" },
        ]);
        assert.deepStrictEqual(yield* amounts, [
          [3, -50],
          [6, 7],
        ]);
        // Days outside the refreshed range keep their rows.
        assert.strictEqual((yield* cache.store.stats(key)).rowCount, 4);
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [{ from: "2000-01-01", to: TODAY }]);
        assert.deepStrictEqual((yield* cache.store.syncState(TOKEN_FP)).pending, []);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("refresh splits on HTTP 413 like the backfill and replaces every part", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      yield* Effect.gen(function* () {
        yield* runToEnd({ kind: "backfill" });
        const changed = [tx(3, "2026-10-20", -50), tx(4, TODAY, 999)];
        yield* fio.setScript((call, n) =>
          (Date.parse(call.to) - Date.parse(call.from)) / DAY_MS + 1 > 4 ? Effect.fail(new TooManyItems()) : serveFrom(changed)(call, n),
        );
        yield* Ref.set(fio.calls, []);
        const job = yield* runToEnd({ kind: "refresh", range: { from: "2026-10-10", to: TODAY } });
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(job.failedDays, []);
        const calls = yield* Ref.get(fio.calls);
        assert.deepStrictEqual(ranges(calls.slice(0, 2)), [`2026-10-10..${TODAY}`, `2026-10-17..${TODAY}`]);
        assert.isTrue(calls.every((c) => c.priority === "background"));
        const cache = yield* enabledCache;
        const key = yield* cache.boundAccount(yield* account());
        const rows = yield* cache.store.transactionsIn(key, { from: "2026-10-10", to: TODAY });
        assert.deepStrictEqual(
          rows.map((t) => [t.id, t.amount]),
          [
            [3, -50],
            [4, 999],
          ],
        );
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [{ from: "2000-01-01", to: TODAY }]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("an incremental sync finishes an interrupted refresh as a refresh first", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      yield* Effect.gen(function* () {
        yield* runToEnd({ kind: "backfill" });
        yield* fio.setScript(() => Effect.fail(new FioServerError({ status: 503, excerpt: "" })));
        assert.strictEqual((yield* runToEnd({ kind: "refresh", range: { from: "2025-03-01", to: "2025-03-31" } })).status, "failed");
        // Movement 2 was cancelled meanwhile.
        yield* fio.setScript(serveFrom(movements.filter((m) => m.id !== 2)));
        yield* Ref.set(fio.calls, []);
        const job = yield* runToEnd({ kind: "incremental" });
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), ["2025-03-01..2025-03-31", `2026-10-12..${TODAY}`]);
        const cache = yield* enabledCache;
        const key = yield* cache.boundAccount(yield* account());
        assert.deepStrictEqual(yield* cache.store.transactionsIn(key, { from: "2025-03-01", to: "2025-03-31" }), []);
        const state = yield* cache.store.syncState(TOKEN_FP);
        assert.deepStrictEqual(state.pending, []);
        assert.strictEqual(state.mode, null);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("while an interrupted refresh keeps failing, other jobs stop before touching its ranges", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      yield* Effect.gen(function* () {
        yield* runToEnd({ kind: "backfill" });
        yield* fio.setScript(() => Effect.fail(new FioServerError({ status: 503, excerpt: "" })));
        yield* runToEnd({ kind: "refresh", range: { from: "2025-03-01", to: "2025-03-31" } });
        yield* Ref.set(fio.calls, []);
        const job = yield* runToEnd({ kind: "incremental" });
        assert.strictEqual(job.status, "failed");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), ["2025-03-01..2025-03-31"]);
        const state = yield* (yield* enabledCache).store.syncState(TOKEN_FP);
        assert.strictEqual(state.mode, "refresh");
        assert.deepStrictEqual(state.pending, [{ from: "2025-03-01", to: "2025-03-31", replace: true }]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("an interrupted refresh resumes as a refresh after a restart", () =>
    Effect.gen(function* () {
      yield* setNow();
      const dbPath = join(mkdtempSync(join(tmpdir(), "fio-cache-")), "fio.sqlite");
      const first = yield* fakeFio(serveFrom(movements));
      yield* Effect.gen(function* () {
        yield* runToEnd({ kind: "backfill" });
        yield* first.setScript(() => Effect.fail(new FioServerError({ status: 503, excerpt: "" })));
        const job = yield* runToEnd({ kind: "refresh", range: { from: "2026-10-15", to: TODAY } });
        assert.strictEqual(job.status, "failed");
        const state = yield* (yield* enabledCache).store.syncState(TOKEN_FP);
        assert.strictEqual(state.mode, "refresh");
        assert.deepStrictEqual(state.pending, [{ from: "2026-10-15", to: TODAY, replace: true }]);
      }).pipe(Effect.provide(cacheLayer(config({ cache: { dbPath } }), first.api)));

      // Movement 4 was cancelled meanwhile; the resumed job still deletes it.
      const second = yield* fakeFio(serveFrom(movements.filter((m) => m.id !== 4)));
      yield* Effect.gen(function* () {
        yield* settle;
        const cache = yield* enabledCache;
        const job = Option.getOrThrow(yield* cache.sync.awaitJob(yield* account(), 3_600_000));
        assert.strictEqual(job.status, "completed");
        assert.strictEqual(job.kind, "refresh");
        assert.deepStrictEqual(ranges(yield* Ref.get(second.calls)), [`2026-10-15..${TODAY}`]);
        const key = yield* cache.boundAccount(yield* account());
        const rows = yield* cache.store.transactionsIn(key, { from: "2026-10-15", to: TODAY });
        assert.deepStrictEqual(
          rows.map((t) => t.id),
          [3],
        );
      }).pipe(Effect.provide(CacheSyncLive.pipe(Layer.provideMerge(cacheLayer(config({ cache: { dbPath } }), second.api)))));
    }),
  );

  it.effect("a refresh replaces only its own days while finishing another job's pending range as an upsert", () =>
    Effect.gen(function* () {
      yield* setNow();
      const a = { from: "2026-10-15", to: "2026-10-15" };
      const b = { from: "2026-10-16", to: "2026-10-16" };
      // FIO no longer lists movement 3 on day B, and returns nothing for day A.
      const fio = yield* fakeFio(serveFrom([tx(2, b.from, 2)]));
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        yield* cache.writeThrough(acc, statement(a.from, a.to, [tx(1, a.from, 1)]), a);
        yield* cache.writeThrough(acc, statement(b.from, b.to, [tx(2, b.from, 2), tx(3, b.from, 3)]), b);
        const key = yield* cache.boundAccount(acc);
        yield* cache.store.putSyncState(TOKEN_FP, {
          ...(yield* cache.store.syncState(TOKEN_FP)),
          mode: "backfill",
          pending: [{ ...a, replace: false }],
        });
        const job = yield* runToEnd({ kind: "refresh", range: b });
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), ["2026-10-16..2026-10-16", "2026-10-15..2026-10-15"]);
        const rows = yield* cache.store.transactionsIn(key, { from: a.from, to: b.to });
        assert.deepStrictEqual(
          rows.map((t) => t.id),
          [1, 2],
        );
        assert.deepStrictEqual((yield* cache.store.syncState(TOKEN_FP)).pending, []);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("a refresh inside a pending backfill range replaces only the requested days", () =>
    Effect.gen(function* () {
      yield* setNow();
      const span = { from: "2026-10-14", to: "2026-10-18" };
      // FIO no longer lists movements 1, 3 and 4; only day 16 is asked to be refreshed.
      const fio = yield* fakeFio(serveFrom([tx(2, "2026-10-16", 2)]));
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        const cached = [tx(1, "2026-10-14", 1), tx(2, "2026-10-16", 2), tx(3, "2026-10-16", 3), tx(4, "2026-10-18", 4)];
        yield* cache.writeThrough(acc, statement(span.from, span.to, cached), span);
        const key = yield* cache.boundAccount(acc);
        yield* cache.store.putSyncState(TOKEN_FP, {
          ...(yield* cache.store.syncState(TOKEN_FP)),
          mode: "backfill",
          pending: [{ ...span, replace: false }],
        });
        const job = yield* runToEnd({ kind: "refresh", range: { from: "2026-10-16", to: "2026-10-16" } });
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [
          "2026-10-17..2026-10-18",
          "2026-10-16..2026-10-16",
          "2026-10-14..2026-10-15",
        ]);
        const rows = yield* cache.store.transactionsIn(key, span);
        assert.deepStrictEqual(
          rows.map((t) => t.id),
          [1, 2, 4],
        );
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("an interrupted refresh that also held a backfill range resumes each range in its own mode", () =>
    Effect.gen(function* () {
      yield* setNow();
      const dbPath = join(mkdtempSync(join(tmpdir(), "fio-cache-")), "fio.sqlite");
      const a = { from: "2026-10-15", to: "2026-10-15" };
      const b = { from: "2026-10-16", to: "2026-10-16" };
      const first = yield* fakeFio(() => Effect.fail(new FioServerError({ status: 503, excerpt: "" })));
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        yield* cache.writeThrough(acc, statement(a.from, a.to, [tx(1, a.from, 1)]), a);
        yield* cache.writeThrough(acc, statement(b.from, b.to, [tx(2, b.from, 2), tx(3, b.from, 3)]), b);
        yield* cache.store.putSyncState(TOKEN_FP, {
          ...(yield* cache.store.syncState(TOKEN_FP)),
          mode: "backfill",
          pending: [{ ...a, replace: false }],
        });
        assert.strictEqual((yield* runToEnd({ kind: "refresh", range: b })).status, "failed");
        const state = yield* cache.store.syncState(TOKEN_FP);
        assert.strictEqual(state.mode, "refresh");
        assert.deepStrictEqual(state.pending, [
          { ...b, replace: true },
          { ...a, replace: false },
        ]);
      }).pipe(Effect.provide(cacheLayer(config({ cache: { dbPath } }), first.api)));

      // After a restart FIO lists movement 2 only: B drops movement 3, A keeps movement 1.
      const second = yield* fakeFio(serveFrom([tx(2, b.from, 2)]));
      yield* Effect.gen(function* () {
        yield* settle;
        const cache = yield* enabledCache;
        const job = Option.getOrThrow(yield* cache.sync.awaitJob(yield* account(), 3_600_000));
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(ranges(yield* Ref.get(second.calls)), ["2026-10-16..2026-10-16", "2026-10-15..2026-10-15"]);
        const key = yield* cache.boundAccount(yield* account());
        const rows = yield* cache.store.transactionsIn(key, { from: a.from, to: b.to });
        assert.deepStrictEqual(
          rows.map((t) => t.id),
          [1, 2],
        );
        const state = yield* cache.store.syncState(TOKEN_FP);
        assert.deepStrictEqual(state.pending, []);
        assert.strictEqual(state.mode, null);
      }).pipe(Effect.provide(CacheSyncLive.pipe(Layer.provideMerge(cacheLayer(config({ cache: { dbPath } }), second.api)))));
    }),
  );

  it.effect("legacy mixed refresh ranges resume without deleting cached movements after migration", () =>
    Effect.gen(function* () {
      yield* setNow();
      const dbPath = join(mkdtempSync(join(tmpdir(), "fio-cache-")), "fio.sqlite");
      const a = { from: "2026-10-15", to: "2026-10-15" };
      const b = { from: "2026-10-16", to: "2026-10-16" };
      const accountKey = "2000000001/2010";
      const beforeMigration = Object.fromEntries(Object.entries(SERVER_MIGRATIONS).filter(([id]) => id < "0003"));

      // The old schema stores the refresh mode and pending ranges without per-range replace flags.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO accounts (account_key, account_id, bank_id, updated_at)
          VALUES (${accountKey}, '2000000001', '2010', ${NOW})
        `;
        yield* sql`
          INSERT INTO bindings (token_fingerprint, account_key, account_name, verified_at)
          VALUES (${TOKEN_FP}, ${accountKey}, 'main', ${NOW})
        `;
        yield* sql`
          INSERT INTO transactions (account_key, movement_id, date, amount, currency, raw_json, first_seen_at, updated_at)
          VALUES
            (${accountKey}, 1, ${a.from}, 1, 'CZK', '{}', ${NOW}, ${NOW}),
            (${accountKey}, 2, ${b.from}, 2, 'CZK', '{}', ${NOW}, ${NOW})
        `;
        yield* sql`
          INSERT INTO sync_state (token_fingerprint, account_key, mode, pending_json)
          VALUES (${TOKEN_FP}, ${accountKey}, 'refresh', ${JSON.stringify([b, a])})
        `;
      }).pipe(Effect.provide(databaseLayer(dbPath, beforeMigration).pipe(Layer.provide(NodeFileSystem.layer))));

      // FIO still lists B's movement, but returns no movement for A.
      const fio = yield* fakeFio(serveFrom([tx(2, b.from, 2)]));
      yield* Effect.gen(function* () {
        yield* settle;
        const cache = yield* enabledCache;
        const job = Option.getOrThrow(yield* cache.sync.awaitJob(yield* account(), 3_600_000));
        assert.strictEqual(job.status, "completed");
        assert.strictEqual(job.kind, "refresh");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), ["2026-10-16..2026-10-16", "2026-10-15..2026-10-15"]);
        const key = yield* cache.boundAccount(yield* account());
        const rows = yield* cache.store.transactionsIn(key, { from: a.from, to: b.to });
        assert.deepStrictEqual(
          rows.map((row) => row.id),
          [1, 2],
        );
      }).pipe(Effect.provide(CacheSyncLive.pipe(Layer.provideMerge(cacheLayer(config({ cache: { dbPath } }), fio.api)))));
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

describe("cancelling a removed token's sync", () => {
  it.effect("stops the running job and wakes whoever waits for it", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(() => Effect.never);
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        yield* cache.sync.start(acc, { kind: "backfill" });
        yield* settle;
        const waiting = yield* Effect.forkChild(cache.sync.awaitJob(acc, 3_600_000), { startImmediately: true });
        yield* settle;
        yield* cache.sync.cancel(acc.tokenFingerprint);
        const job = Option.getOrThrow(yield* Fiber.join(waiting));
        assert.strictEqual(job.status, "failed");
        assert.include(job.lastError ?? "", "removed");
        // Forgotten: nothing runs for it any more, and a later start begins anew.
        assert.isTrue(Option.isNone(yield* cache.sync.progress(acc)));
        yield* cache.sync.cancel(acc.tokenFingerprint);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );
});

describe("retiring a token removed at /admin", () => {
  it.effect("stops its job, refuses new jobs, and drops its writes until it is reinstated", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(() => Effect.never);
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        const fp = acc.tokenFingerprint;
        yield* cache.sync.start(acc, { kind: "backfill" });
        yield* settle;
        // Built before the retirement, run after it and the purge.
        const lateState = cache.store.putSyncState(fp, yield* cache.store.syncState(fp));
        yield* cache.retire(fp);
        assert.isTrue(Option.isNone(yield* cache.sync.progress(acc)));
        // A pass that read the accounts before the removal starts nothing.
        const refused = yield* cache.sync.start(acc, { kind: "incremental" });
        assert.strictEqual(refused.progress.status, "failed");
        assert.include(refused.progress.lastError ?? "", "removed");
        assert.isTrue(Option.isNone(yield* cache.sync.progress(acc)));
        // A write admitted before the removal, landing after it (and after a purge), stores nothing.
        const late = { accountName: acc.name, tokenFingerprint: fp, statement: statement(TODAY, TODAY, [tx(1, TODAY, 5)]), fetchedAt: NOW };
        yield* cache.store.purgeTokens([fp], new Set());
        assert.strictEqual((yield* cache.store.commit(late)).rowsWritten, 0);
        yield* lateState;
        assert.isTrue(Option.isNone(yield* cache.store.binding(fp)));
        const sql = yield* SqlClient.SqlClient;
        const [rows] = yield* sql<{ n: number }>`SELECT (SELECT COUNT(*) FROM transactions) + (SELECT COUNT(*) FROM sync_state) AS n`;
        assert.strictEqual(rows?.n, 0);
        // Added again: accepted again.
        yield* cache.reinstate(fp);
        assert.strictEqual((yield* cache.store.commit(late)).rowsWritten, 1);
        const started = yield* cache.sync.start(acc, { kind: "incremental" });
        assert.strictEqual(started.progress.status, "running");
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  const ADMIN_KEY = Redacted.make(new Uint8Array(32).fill(5));
  /** The cache on the server's database, with the accounts stored in it (as in HTTP mode with OAuth). */
  const adminLayer = (api: FioApiShape) => {
    const cfg = config();
    return TransactionCacheFromSql.pipe(
      Layer.provideMerge(StoredAccountsLive(ADMIN_KEY, accountSeedOf(cfg.accounts))),
      Layer.provideMerge(databaseLayer(":memory:", SERVER_MIGRATIONS).pipe(Layer.provide(NodeFileSystem.layer))),
      Layer.provideMerge(Layer.mergeAll(Redactor.layerFrom([]), Layer.succeed(FioApi, api), AppConfig.layerFrom(cfg))),
    );
  };

  it.effect("removing an account with purge stops writes for every token it had, not only the current one", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(() => Effect.never);
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const admin = yield* makeAccountAdmin(ADMIN_KEY);
        const sql = yield* SqlClient.SqlClient;
        const before = yield* account();
        const old = before.tokenFingerprint;
        const write = (rowId: number) => ({
          accountName: before.name,
          tokenFingerprint: old,
          statement: statement(TODAY, TODAY, [tx(rowId, TODAY, 5)]),
          fetchedAt: NOW,
        });
        assert.strictEqual((yield* cache.store.commit(write(1))).rowsWritten, 1);
        yield* admin.rotate(before.id, TOKEN_B);
        // A process that did not see the token replaced (the retired set is in memory) still runs a job for it.
        yield* cache.reinstate(old);
        yield* cache.sync.start(before, { kind: "backfill" });
        yield* settle;
        assert.strictEqual(Option.getOrUndefined(yield* cache.sync.progress(before))?.status, "running");
        const lateState = cache.store.putSyncState(old, yield* cache.store.syncState(old));

        const removed = yield* admin.remove(before.id, true);
        assert.deepStrictEqual(removed.cache, { kind: "purged", deleted: 1, accounts: [], unattributed: 0 });
        // The old token's job was stopped and its late writes store nothing.
        assert.isTrue(Option.isNone(yield* cache.sync.progress(before)));
        assert.strictEqual((yield* cache.store.commit(write(2))).rowsWritten, 0);
        yield* lateState;
        const [left] = yield* sql<{ n: number }>`
          SELECT (SELECT COUNT(*) FROM transactions) + (SELECT COUNT(*) FROM bindings) + (SELECT COUNT(*) FROM sync_state) AS n
        `;
        assert.strictEqual(left?.n, 0);
        assert.deepStrictEqual(yield* (yield* Accounts).list, []);
      }).pipe(Effect.provide(adminLayer(fio.api)));
    }),
  );

  it.effect("removing an account with purge keeps accepting writes for a token another account uses", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(() => Effect.never);
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const admin = yield* makeAccountAdmin(ADMIN_KEY);
        const before = yield* account();
        const old = before.tokenFingerprint;
        const shared = tokenFingerprint(Redacted.make(TOKEN_B));
        const write = (accountName: string, tokenFingerprint: string, rowId: number, accountId: string) => ({
          accountName,
          tokenFingerprint,
          statement: statement(TODAY, TODAY, [tx(rowId, TODAY, 5)], accountId),
          fetchedAt: NOW,
        });
        assert.strictEqual((yield* cache.store.commit(write("main", old, 1, "2000000001"))).rowsWritten, 1);
        yield* admin.rotate(before.id, TOKEN_B);
        yield* admin.add({ name: "beta", token: TOKEN_B, accountNumber: undefined, currency: undefined });
        assert.strictEqual((yield* cache.store.commit(write("beta", shared, 2, "2000000002"))).rowsWritten, 1);

        const removed = yield* admin.remove(before.id, true);
        assert.deepStrictEqual(removed.cache, { kind: "purged", deleted: 1, accounts: ["beta"], unattributed: 0 });
        // Only main had the old token: its writes stop. beta's token still writes.
        assert.strictEqual((yield* cache.store.commit(write("main", old, 3, "2000000001"))).rowsWritten, 0);
        assert.strictEqual((yield* cache.store.commit(write("beta", shared, 4, "2000000002"))).rowsWritten, 1);
        const beta = (yield* (yield* Accounts).list).find((candidate) => candidate.name === "beta");
        if (beta === undefined) return assert.fail("beta is gone");
        assert.strictEqual((yield* cache.sync.start(beta, { kind: "incremental" })).progress.status, "running");
      }).pipe(Effect.provide(adminLayer(fio.api)));
    }),
  );

  it.effect("a purge that fails removes nothing: the account, its token history and its writes stay", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(() => Effect.never);
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const admin = yield* makeAccountAdmin(ADMIN_KEY);
        const sql = yield* SqlClient.SqlClient;
        const main = yield* account();
        const write = (rowId: number) => ({
          accountName: main.name,
          tokenFingerprint: main.tokenFingerprint,
          statement: statement(TODAY, TODAY, [tx(rowId, TODAY, 5)]),
          fetchedAt: NOW,
        });
        yield* cache.store.commit(write(1));
        yield* admin.rotate(main.id, TOKEN_B);
        // The purge's last statement for a bank account fails.
        yield* sql`DROP TABLE accounts`;
        const failed = yield* Effect.flip(admin.remove(main.id, true));
        assert.strictEqual(failed._tag, "CacheError");
        yield* sql`CREATE TABLE accounts (account_key TEXT PRIMARY KEY, account_id TEXT NOT NULL, bank_id TEXT NOT NULL, iban TEXT, bic TEXT, currency TEXT, balance REAL, balance_date TEXT, updated_at INTEGER NOT NULL)`;
        assert.deepStrictEqual((yield* (yield* Accounts).list).map((some) => some.name), ["main"]);
        const [left] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM transactions`;
        assert.strictEqual(left?.n, 1);
        // The current token writes again; removing again (now succeeding) still reaches the replaced token's data.
        const current = { ...write(2), tokenFingerprint: tokenFingerprint(Redacted.make(TOKEN_B)) };
        assert.strictEqual((yield* cache.store.commit(current)).rowsWritten, 1);
        const removed = yield* admin.remove(main.id, true);
        assert.deepStrictEqual(removed.cache, { kind: "purged", deleted: 1, accounts: [], unattributed: 0 });
        const [after] = yield* sql<{ n: number }>`SELECT (SELECT COUNT(*) FROM transactions) + (SELECT COUNT(*) FROM bindings) AS n`;
        assert.strictEqual(after?.n, 0);
      }).pipe(Effect.provide(adminLayer(fio.api)));
    }),
  );
});
