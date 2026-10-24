import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Redacted, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { tokenFingerprint } from "../src/accounts.js";
import { addDays, type DayRange } from "../src/cache/dates.js";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import { CacheSyncLive, historyUnlockMessage, type SyncRequest, Transactions } from "../src/cache/service.js";
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
  NOW,
  seedPending,
  seedRange,
  serveFrom,
  setNow,
  settle,
  statement,
  TODAY,
  TOKEN_A,
  tx,
  verifiedStatus,
} from "./support/cache.js";
import { testDatabase } from "./support/database.js";
import { fakeFio, type PeriodsScript } from "./support/fio-api.js";

const RECENT_START = addDays(TODAY, -89);
const DAY_MS = 86_400_000;

const movements = [tx(1, "2003-05-01", -100), tx(2, "2025-03-03", 250), tx(3, "2026-10-20", -42.5), tx(4, TODAY, 1000)];

/** HTTP 422 for anything older than the last 90 days; otherwise `inner`. */
const historyLocked =
  (inner: PeriodsScript): PeriodsScript =>
  (call, n) =>
    call.from < RECENT_START ? Effect.fail(new HistoryAuthorizationRequired()) : inner(call, n);

const TOKEN_FP = tokenFingerprint(Redacted.make(TOKEN_A));

/** Starts (or joins) a job and waits for it to finish. */
const runToEnd = Effect.fnUntraced(function* (request: SyncRequest) {
  const cache = yield* Transactions;
  const outcome = yield* Effect.orDie(cache.sync(yield* account(), request, 3_600_000));
  if (!outcome.started) return yield* Effect.die("no job started");
  return outcome.job;
});

/** The background layer's job: joins it while it runs, then reads the token's latest job. */
const backgroundJob = Effect.gen(function* () {
  yield* settle;
  const cache = yield* Transactions;
  const acc = yield* account();
  yield* Effect.orDie(cache.sync(acc, { kind: "resume" }, 3_600_000));
  const [status] = yield* Effect.orDie(cache.status([acc]));
  if (status?.job == null) return yield* Effect.die("no job");
  return status.job;
});

/** Cached movements in `range`, from the cache only. */
const cachedIn = (range: DayRange) =>
  Effect.gen(function* () {
    const cache = yield* Transactions;
    return (yield* Effect.orDie(cache.transactions(yield* account(), range, "cache"))).transactions;
  });

/** The token's persisted sync state as get_cache_status reports it. */
const syncStatus = Effect.gen(function* () {
  const [status] = yield* Effect.orDie((yield* Transactions).status([yield* account()]));
  if (status === undefined) return yield* Effect.die("no status");
  return status.sync;
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
        const status = yield* verifiedStatus(yield* account());
        assert.strictEqual(status.bankAccount, "2000000001/2010");
        assert.deepStrictEqual(status.coveredRanges, [{ from: "2000-01-01", to: TODAY }]);
        assert.strictEqual(status.rowCount, 4);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
        assert.deepStrictEqual((yield* verifiedStatus(yield* account())).coveredRanges, [
          { from: "2000-01-01", to: "2025-03-02" },
          { from: "2025-03-04", to: TODAY },
        ]);
        // The skipped day stays out of later automatic backfills.
        const before = calls.length;
        yield* runToEnd({ kind: "backfill" });
        assert.strictEqual((yield* Ref.get(fio.calls)).length, before);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
        const state = yield* syncStatus;
        assert.isTrue(state.historyLimited);
        assert.isNotNull(state.historyLimitedSince);
        assert.strictEqual(state.historyUnlock, message);

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
        const status = yield* verifiedStatus(yield* account());
        assert.deepStrictEqual(status.coveredRanges, [{ from: "2000-01-01", to: TODAY }]);
        assert.strictEqual(status.rowCount, 4);
        assert.isFalse(status.sync.historyLimited);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
          const job = yield* backgroundJob;
          assert.strictEqual(job.kind, "startup");
          assert.strictEqual(job.status, "completed");
          assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [
            `2000-01-01..${addDays(RECENT_START, -1)}`,
            `${addDays(TODAY, -10)}..${TODAY}`,
          ]);
          assert.isTrue(job.historyLimited);
        }).pipe(Effect.provide(CacheSyncLive));
      }).pipe(Effect.provide(cacheLayer(cfg, fio.layer)));
    }),
  );

  it.effect("startup with an unlocked history backfills the blocked range and skips a redundant incremental", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      const cfg = config({ cache: { syncOnStartup: true } });
      yield* Effect.gen(function* () {
        const job = yield* backgroundJob;
        assert.strictEqual(job.status, "completed");
        // A fresh cache: one backfill request covers today, so no incremental follows.
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [`2000-01-01..${TODAY}`]);
      }).pipe(Effect.provide(CacheSyncLive.pipe(Layer.provideMerge(cacheLayer(cfg, fio.layer)))));
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
        const state = yield* syncStatus;
        assert.isAbove(state.pending.length, 0);
        assert.isTrue(state.pending.every((range) => !range.replace));
        return state.pending;
      }).pipe(Effect.provide(cacheLayer(config({ cache: { dbPath } }), first.layer)));

      // Second run on the same file: startup (syncOnStartup=false) resumes exactly the pending ranges.
      const second = yield* fakeFio(tooBig);
      yield* Effect.gen(function* () {
        const job = yield* backgroundJob;
        assert.strictEqual(job.status, "completed");
        assert.strictEqual(job.kind, "backfill");
        const calls = yield* Ref.get(second.calls);
        assert.deepStrictEqual(ranges(calls.slice(0, pending.length)), ranges(pending));
        const status = yield* verifiedStatus(yield* account());
        assert.deepStrictEqual(status.coveredRanges, [{ from: "2000-01-01", to: TODAY }]);
        assert.deepStrictEqual(status.sync.pending, []);
      }).pipe(Effect.provide(CacheSyncLive.pipe(Layer.provideMerge(cacheLayer(config({ cache: { dbPath } }), second.layer)))));
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
        const found = yield* cachedIn({ from: "2026-10-21", to: "2026-10-21" });
        assert.deepStrictEqual(
          found.map((t) => t.id),
          [5],
        );
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("incremental never reaches before the earliest covered day; with no coverage it backfills", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(movements));
      yield* Effect.gen(function* () {
        const covered = { from: "2026-10-20", to: TODAY };
        const answer = yield* serveFrom(movements)({ token: "", ...covered, priority: undefined }, 0);
        yield* seedRange(yield* account(), answer, covered);
        yield* runToEnd({ kind: "incremental" });
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [`2026-10-20..${TODAY}`]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
      yield* Ref.set(fio.calls, []);
      yield* Effect.gen(function* () {
        const job = yield* runToEnd({ kind: "incremental" });
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [`2000-01-01..${TODAY}`]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
        const cache = yield* Transactions;
        const main = yield* account("main");
        const alias = yield* account("alias");
        const start = (acc: typeof main, request: SyncRequest, waitMs?: number) =>
          Effect.flatMap(Effect.orDie(cache.sync(acc, request, waitMs)), (outcome) =>
            outcome.started ? Effect.succeed(outcome) : Effect.die("no job started"),
          );
        const first = yield* start(main, { kind: "backfill" });
        yield* settle;
        const second = yield* start(main, { kind: "incremental" });
        const third = yield* start(alias, { kind: "backfill" });
        assert.isFalse(first.joined);
        assert.isTrue(second.joined);
        assert.isTrue(third.joined);
        assert.strictEqual(second.job.kind, "backfill");
        assert.strictEqual(second.job.status, "running");
        yield* Deferred.succeed(gate, undefined);
        // Resume joins the job if it still runs; either way it then reports that job.
        yield* Effect.orDie(cache.sync(main, { kind: "resume" }, 3_600_000));
        const [status] = yield* Effect.orDie(cache.status([main]));
        assert.strictEqual(status?.job?.status, "completed");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 1);
        // Finished: the next request starts a new job.
        assert.isFalse((yield* start(alias, { kind: "incremental" })).joined);
      }).pipe(Effect.provide(cacheLayer(cfg, fio.layer)));
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
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
        assert.deepStrictEqual((yield* verifiedStatus(yield* account())).coveredRanges, [{ from: "2005-01-01", to: TODAY }]);
        yield* Ref.set(fio.calls, []);
        yield* runToEnd({ kind: "backfill" });
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), ["2000-01-01..2004-12-31"]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
        const status = yield* verifiedStatus(yield* account());
        assert.deepStrictEqual(status.coveredRanges, [{ from: "2000-01-01", to: TODAY }]);
        const kept = yield* cachedIn({ from: "2026-10-20", to: "2026-10-25" });
        assert.deepStrictEqual(
          kept.map((t) => [t.id, t.amount]),
          [
            [3, -42.5],
            [4, 1000],
          ],
        );
        // The window stays pending for the next run.
        assert.deepStrictEqual(status.sync.pending, [
          { from: "2026-10-12", to: "2026-10-25", replace: false },
        ]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
        const recent = { from: "2026-10-15", to: TODAY };
        const amounts = Effect.map(cachedIn(recent), (rows) => rows.map((t) => [t.id, t.amount]));

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
        const status = yield* verifiedStatus(yield* account());
        assert.strictEqual(status.rowCount, 4);
        assert.deepStrictEqual(status.coveredRanges, [{ from: "2000-01-01", to: TODAY }]);
        assert.deepStrictEqual(status.sync.pending, []);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
        const rows = yield* cachedIn({ from: "2026-10-10", to: TODAY });
        assert.deepStrictEqual(
          rows.map((t) => [t.id, t.amount]),
          [
            [3, -50],
            [4, 999],
          ],
        );
        assert.deepStrictEqual((yield* verifiedStatus(yield* account())).coveredRanges, [{ from: "2000-01-01", to: TODAY }]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
        assert.deepStrictEqual(yield* cachedIn({ from: "2025-03-01", to: "2025-03-31" }), []);
        assert.deepStrictEqual((yield* syncStatus).pending, []);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
        assert.deepStrictEqual((yield* syncStatus).pending, [{ from: "2025-03-01", to: "2025-03-31", replace: true }]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
        assert.deepStrictEqual((yield* syncStatus).pending, [{ from: "2026-10-15", to: TODAY, replace: true }]);
      }).pipe(Effect.provide(cacheLayer(config({ cache: { dbPath } }), first.layer)));

      // Movement 4 was cancelled meanwhile; the resumed job still deletes it.
      const second = yield* fakeFio(serveFrom(movements.filter((m) => m.id !== 4)));
      yield* Effect.gen(function* () {
        const job = yield* backgroundJob;
        assert.strictEqual(job.status, "completed");
        assert.strictEqual(job.kind, "refresh");
        assert.deepStrictEqual(ranges(yield* Ref.get(second.calls)), [`2026-10-15..${TODAY}`]);
        const rows = yield* cachedIn({ from: "2026-10-15", to: TODAY });
        assert.deepStrictEqual(
          rows.map((t) => t.id),
          [3],
        );
      }).pipe(Effect.provide(CacheSyncLive.pipe(Layer.provideMerge(cacheLayer(config({ cache: { dbPath } }), second.layer)))));
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
        const acc = yield* account();
        yield* seedRange(acc, statement(a.from, a.to, [tx(1, a.from, 1)]), a);
        yield* seedRange(acc, statement(b.from, b.to, [tx(2, b.from, 2), tx(3, b.from, 3)]), b);
        yield* seedPending(acc, "backfill", [{ ...a, replace: false }]);
        const job = yield* runToEnd({ kind: "refresh", range: b });
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), ["2026-10-16..2026-10-16", "2026-10-15..2026-10-15"]);
        const rows = yield* cachedIn({ from: a.from, to: b.to });
        assert.deepStrictEqual(
          rows.map((t) => t.id),
          [1, 2],
        );
        assert.deepStrictEqual((yield* syncStatus).pending, []);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("a refresh inside a pending backfill range replaces only the requested days", () =>
    Effect.gen(function* () {
      yield* setNow();
      const span = { from: "2026-10-14", to: "2026-10-18" };
      // FIO no longer lists movements 1, 3 and 4; only day 16 is asked to be refreshed.
      const fio = yield* fakeFio(serveFrom([tx(2, "2026-10-16", 2)]));
      yield* Effect.gen(function* () {
        const acc = yield* account();
        const cached = [tx(1, "2026-10-14", 1), tx(2, "2026-10-16", 2), tx(3, "2026-10-16", 3), tx(4, "2026-10-18", 4)];
        yield* seedRange(acc, statement(span.from, span.to, cached), span);
        yield* seedPending(acc, "backfill", [{ ...span, replace: false }]);
        const job = yield* runToEnd({ kind: "refresh", range: { from: "2026-10-16", to: "2026-10-16" } });
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), [
          "2026-10-17..2026-10-18",
          "2026-10-16..2026-10-16",
          "2026-10-14..2026-10-15",
        ]);
        const rows = yield* cachedIn(span);
        assert.deepStrictEqual(
          rows.map((t) => t.id),
          [1, 2, 4],
        );
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
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
        const acc = yield* account();
        yield* seedRange(acc, statement(a.from, a.to, [tx(1, a.from, 1)]), a);
        yield* seedRange(acc, statement(b.from, b.to, [tx(2, b.from, 2), tx(3, b.from, 3)]), b);
        yield* seedPending(acc, "backfill", [{ ...a, replace: false }]);
        assert.strictEqual((yield* runToEnd({ kind: "refresh", range: b })).status, "failed");
        assert.deepStrictEqual((yield* syncStatus).pending, [
          { ...b, replace: true },
          { ...a, replace: false },
        ]);
      }).pipe(Effect.provide(cacheLayer(config({ cache: { dbPath } }), first.layer)));

      // After a restart FIO lists movement 2 only: B drops movement 3, A keeps movement 1.
      const second = yield* fakeFio(serveFrom([tx(2, b.from, 2)]));
      yield* Effect.gen(function* () {
        const job = yield* backgroundJob;
        assert.strictEqual(job.status, "completed");
        assert.deepStrictEqual(ranges(yield* Ref.get(second.calls)), ["2026-10-16..2026-10-16", "2026-10-15..2026-10-15"]);
        const rows = yield* cachedIn({ from: a.from, to: b.to });
        assert.deepStrictEqual(
          rows.map((t) => t.id),
          [1, 2],
        );
        assert.deepStrictEqual((yield* syncStatus).pending, []);
      }).pipe(Effect.provide(CacheSyncLive.pipe(Layer.provideMerge(cacheLayer(config({ cache: { dbPath } }), second.layer)))));
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
      }).pipe(Effect.provide(testDatabase(dbPath, beforeMigration)));

      // FIO still lists B's movement, but returns no movement for A.
      const fio = yield* fakeFio(serveFrom([tx(2, b.from, 2)]));
      yield* Effect.gen(function* () {
        const job = yield* backgroundJob;
        assert.strictEqual(job.status, "completed");
        assert.strictEqual(job.kind, "refresh");
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), ["2026-10-16..2026-10-16", "2026-10-15..2026-10-15"]);
        const rows = yield* cachedIn({ from: a.from, to: b.to });
        assert.deepStrictEqual(
          rows.map((row) => row.id),
          [1, 2],
        );
      }).pipe(Effect.provide(CacheSyncLive.pipe(Layer.provideMerge(cacheLayer(config({ cache: { dbPath } }), fio.layer)))));
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
      }).pipe(Effect.provide(cacheLayer(cfg, fio.layer)));
    }),
  );
});
