import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { Account } from "../src/accounts.js";
import { CACHE_DISABLED, NOT_VERIFIED, type SearchQuery, Transactions } from "../src/cache/service.js";
import { InvalidInput } from "../src/errors.js";
import {
  account,
  cacheLayer,
  config,
  disabledCacheLayer,
  seedPending,
  seedRange,
  serveFrom,
  setNow,
  statement,
  TODAY,
  TOKEN_B,
  tx,
  verifiedStatus,
} from "./support/cache.js";
import { fakeFio, type PeriodsScript } from "./support/fio-api.js";

const fixture = [
  tx(1, "2026-01-05", -100.1, {
    counterpartyName: "Albert Praha",
    counterpartyAccount: "123",
    counterpartyBankCode: "0100",
    type: "Platba kartou",
    messageForRecipient: "nakup",
  }),
  tx(2, "2026-01-20", 2500, { counterpartyName: "Employer s.r.o.", variableSymbol: "2026001", type: "Příjem" }),
  tx(3, "2026-02-03", -0.1, { counterpartyName: "Albert Praha", type: "Platba kartou" }),
  tx(4, "2026-02-03", -0.2, { counterpartyName: "Albert Praha", type: "Platba kartou" }),
  tx(5, "2026-02-10", 50, { counterpartyName: "Foreign GmbH", currency: "EUR", type: "Příjem" }),
  tx(7, "2026-03-01", -1000, { counterpartyAccount: "999", counterpartyBankCode: "2010", comment: "Rent March" }),
];

const COVERED = { from: "2026-01-01", to: TODAY };

/** Caches the fixture for COVERED, as get_transactions source=fio would. */
const seed = Effect.gen(function* () {
  yield* seedRange(yield* account(), statement(COVERED.from, COVERED.to, fixture), COVERED);
});

const ids = (rows: ReadonlyArray<{ readonly id: number | null }>) => rows.map((r) => r.id);

const ranges = (calls: ReadonlyArray<{ from: string; to: string }>) => calls.map((c) => `${c.from}..${c.to}`);

const PAGE = { limit: 100, offset: 0, order: "desc" } as const;

/** Every answer is `statement` itself, whatever range was asked for. */
const answer =
  (fixed: ReturnType<typeof statement>): PeriodsScript =>
  () =>
    Effect.succeed(fixed);

describe("Transactions.transactions", () => {
  it.effect("auto asks FIO when the range is not cached, writes through, then answers from the cache", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acct = yield* account();
        const range = { from: "2026-10-01", to: TODAY };
        const first = yield* cache.transactions(acct, range, "auto");
        assert.strictEqual(first.source, "fio");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 1);
        assert.strictEqual((yield* Ref.get(fio.calls))[0]?.priority, undefined);

        const second = yield* cache.transactions(acct, range, "auto");
        assert.strictEqual(second.source, "cache");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 1);
        assert.strictEqual(second.info.closingBalance, null);
        assert.deepStrictEqual(second.source === "cache" ? second.lastKnownBalance : undefined, {
          amount: 1000,
          date: TODAY,
        });
        assert.isTrue(second.freshness.complete);

        // An hour later today's data is no longer fresh and not yet settled.
        yield* TestClock.adjust(61 * 60_000);
        assert.strictEqual((yield* cache.transactions(acct, range, "auto")).source, "fio");

        // Older days fetched more than overlapDays after them are settled.
        const old = { from: "2026-09-01", to: "2026-09-30" };
        assert.strictEqual((yield* cache.transactions(acct, old, "auto")).source, "fio");
        yield* TestClock.adjust(24 * 60 * 60_000);
        assert.strictEqual((yield* cache.transactions(acct, old, "auto")).source, "cache");

        // source=fio always asks FIO.
        const calls = (yield* Ref.get(fio.calls)).length;
        assert.strictEqual((yield* cache.transactions(acct, old, "fio")).source, "fio");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, calls + 1);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("auto keeps asking FIO while its response has a movement without an ID", () =>
    Effect.gen(function* () {
      yield* setNow();
      const malformed: PeriodsScript = (call) =>
        Effect.succeed(statement(call.from, call.to, [tx(1, "2026-10-05", -10), tx(2, "2026-10-06", 20, { id: null })]));
      const fio = yield* fakeFio(malformed);
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acct = yield* account();
        const range = { from: "2026-10-01", to: TODAY };
        assert.strictEqual((yield* cache.transactions(acct, range, "auto")).source, "fio");
        assert.strictEqual((yield* cache.transactions(acct, range, "auto")).source, "fio");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 2);
        // Nothing was stored, so the cache is not even bound to the token.
        assert.instanceOf(yield* Effect.flip(cache.transactions(acct, range, "cache")), InvalidInput);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("source=cache never calls FIO and needs a verified binding", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acct = yield* account();
        const unverified = yield* Effect.flip(cache.transactions(acct, COVERED, "cache"));
        assert.instanceOf(unverified, InvalidInput);
        assert.strictEqual(unverified.message, NOT_VERIFIED);
        yield* seed;
        const partial = yield* cache.transactions(acct, { from: "2025-06-01", to: "2026-01-31" }, "cache");
        assert.strictEqual(partial.source, "cache");
        assert.deepStrictEqual(ids(partial.transactions), [1, 2]);
        assert.isFalse(partial.freshness.complete);
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 0);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("live freshness follows the period FIO's header reports", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio((call, n) =>
        Effect.map(serveFrom(fixture)(call, n), (s) => ({ ...s, info: { ...s.info, dateStart: "2026-02-01" } })),
      );
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acct = yield* account();
        const result = yield* cache.transactions(acct, { from: "2026-01-01", to: "2026-12-31" }, "fio");
        assert.isFalse(result.freshness.complete);
        assert.deepStrictEqual(result.freshness.coveredRanges, [{ from: "2026-02-01", to: TODAY }]);
        const future = yield* cache.transactions(acct, { from: "2026-11-01", to: "2026-11-30" }, "fio");
        assert.deepStrictEqual(future.freshness, {
          lastSyncAt: "2026-10-22T10:00:00.000Z",
          coveredFrom: null,
          coveredTo: null,
          coveredRanges: [],
          oldestFetchAt: "2026-10-22T10:00:00.000Z",
          historyLimited: false,
          complete: true,
        });
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("a refetch overwrites by movement ID and never duplicates", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([tx(1, "2026-10-20", -10), tx(2, "2026-10-21", 20)]));
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acc = yield* account();
        const range = { from: "2026-10-20", to: TODAY };
        yield* cache.transactions(acc, range, "fio");
        yield* fio.setScript(
          serveFrom([tx(1, "2026-10-20", -10, { comment: "edited" }), tx(2, "2026-10-21", 20), tx(3, TODAY, 30)]),
        );
        yield* cache.transactions(acc, range, "fio");
        const rows = (yield* cache.transactions(acc, range, "cache")).transactions;
        assert.deepStrictEqual(
          rows.map((r) => [r.id, r.comment]),
          [
            [1, "edited"],
            [2, null],
            [3, null],
          ],
        );
        assert.strictEqual((yield* verifiedStatus(acc)).rowCount, 3);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("records coverage only for the period FIO's header reports, never after today", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(answer(statement("2026-10-15", "2026-10-20", [])));
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acc = yield* account();
        yield* cache.transactions(acc, { from: "2026-10-10", to: TODAY }, "fio");
        assert.deepStrictEqual((yield* verifiedStatus(acc)).coveredRanges, [{ from: "2026-10-15", to: "2026-10-20" }]);
        yield* fio.setScript(answer(statement("2026-10-21", "2026-12-31", [])));
        yield* cache.transactions(acc, { from: "2026-10-21", to: "2026-12-31" }, "fio");
        assert.deepStrictEqual((yield* verifiedStatus(acc)).coveredRanges, [{ from: "2026-10-15", to: TODAY }]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("binds data to the token: a new token, or a name re-pointed to another account, sees no stale rows", () =>
    Effect.gen(function* () {
      yield* setNow();
      const path = join(mkdtempSync(join(tmpdir(), "fio-cache-")), "fio.sqlite");
      const range = { from: "2026-10-20", to: TODAY };
      // Token A fetches account 2000000001.
      const first = yield* fakeFio(serveFrom([tx(1, "2026-10-21", -10)]));
      yield* Effect.gen(function* () {
        const acc = yield* account();
        yield* (yield* Transactions).transactions(acc, range, "fio");
        assert.strictEqual((yield* verifiedStatus(acc)).bankAccount, "2000000001/2010");
      }).pipe(Effect.provide(cacheLayer(config({ cache: { dbPath: path } }), first.layer)));

      // "main" now uses token B, which belongs to account 3000000002.
      const repointed = config({
        cache: { dbPath: path },
        accounts: [{ name: "main", token: Redacted.make(TOKEN_B), accountNumber: undefined, currency: undefined }],
      });
      const second = yield* fakeFio(serveFrom([tx(7, TODAY, 70)], "3000000002"));
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acc = yield* account();
        const unverified = yield* Effect.flip(cache.transactions(acc, range, "cache"));
        assert.instanceOf(unverified, InvalidInput);
        assert.strictEqual(unverified.message, NOT_VERIFIED);
        yield* cache.transactions(acc, range, "fio");
        const read = yield* cache.transactions(acc, range, "cache");
        assert.deepStrictEqual(ids(read.transactions), [7]);
        assert.strictEqual(read.info.accountId, "3000000002");
      }).pipe(Effect.provide(cacheLayer(repointed, second.layer)));
    }),
  );

  it.effect("a FIO answer without account identity is returned but stores nothing", () =>
    Effect.gen(function* () {
      yield* setNow();
      const anonymous = statement("2026-10-20", TODAY, [tx(1, TODAY, 1)]);
      const fio = yield* fakeFio(answer({ ...anonymous, info: { ...anonymous.info, accountId: null } }));
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acc = yield* account();
        const result = yield* cache.transactions(acc, { from: "2026-10-20", to: TODAY }, "fio");
        assert.strictEqual(result.transactionCount, 1);
        const [status] = yield* cache.status([acc]);
        assert.isFalse(status?.verified);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("a FIO answer with a movement lacking an ID or date stores nothing and covers no day", () =>
    Effect.gen(function* () {
      yield* setNow();
      const earlier = { from: "2026-10-20", to: "2026-10-20" };
      const fio = yield* fakeFio(serveFrom([tx(1, "2026-10-20", -10)]));
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acc = yield* account();
        yield* cache.transactions(acc, earlier, "fio");
        const range = { from: "2026-10-20", to: TODAY };
        for (const broken of [tx(3, TODAY, 5, { id: null }), tx(4, TODAY, 5, { date: null })]) {
          yield* fio.setScript(
            answer(statement(range.from, range.to, [tx(1, "2026-10-20", -999), tx(2, "2026-10-21", 20), broken])),
          );
          assert.strictEqual((yield* cache.transactions(acc, range, "fio")).transactionCount, 3);
        }
        assert.deepStrictEqual((yield* verifiedStatus(acc)).coveredRanges, [earlier]);
        const read = yield* cache.transactions(acc, range, "cache");
        assert.deepStrictEqual(
          read.transactions.map((t) => [t.id, t.amount]),
          [[1, -10]],
        );
        assert.isFalse(read.freshness.complete);
        // Not servable, so auto asks FIO.
        assert.strictEqual((yield* cache.transactions(acc, range, "auto")).source, "fio");
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );
});

describe("Transactions.record", () => {
  it.effect("stores statement and new-movement results without coverage", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acct = yield* account();
        yield* cache.record(acct, statement("2026-01-01", "2026-01-31", [fixture[0]!, fixture[1]!]));
        yield* cache.record(acct, statement("2026-10-01", TODAY, [tx(42, TODAY, 5)]));
        const status = yield* verifiedStatus(acct);
        assert.strictEqual(status.rowCount, 3);
        assert.deepStrictEqual(status.coveredRanges, []);
        // Unfiltered queries reach back to the earliest stored movement, not just covered days.
        const found = yield* cache.search(acct, PAGE);
        assert.deepStrictEqual(ids(found.transactions), [42, 2, 1]);
        assert.isFalse(found.freshness.complete);
        // Without coverage the range is never servable: auto still asks FIO.
        assert.strictEqual((yield* cache.transactions(acct, { from: "2026-01-01", to: "2026-01-31" }, "auto")).source, "fio");
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );
});

describe("Transactions.search and summarize", () => {
  it.effect("search filters, pages and orders cached movements", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        yield* seed;
        const cache = yield* Transactions;
        const acc = yield* account();
        const search = (query: Partial<SearchQuery>) => cache.search(acc, { ...PAGE, ...query });
        assert.deepStrictEqual(ids((yield* search({ direction: "out", minAmount: 100 })).transactions), [7, 1]);
        assert.deepStrictEqual(ids((yield* search({ counterparty: "albert" })).transactions), [4, 3, 1]);
        assert.deepStrictEqual(ids((yield* search({ counterparty: "999/2010" })).transactions), [7]);
        assert.deepStrictEqual(ids((yield* search({ text: "RENT" })).transactions), [7]);
        assert.deepStrictEqual(ids((yield* search({ text: "nakup" })).transactions), [1]);
        assert.deepStrictEqual(ids((yield* search({ variableSymbol: "2026001" })).transactions), [2]);
        assert.deepStrictEqual(ids((yield* search({ type: "Platba kartou", maxAmount: 0.15 })).transactions), [3]);
        assert.deepStrictEqual(ids((yield* search({ currency: "eur" })).transactions), [5]);
        assert.deepStrictEqual(
          ids((yield* search({ dateFrom: "2026-02-01", dateTo: "2026-02-28", direction: "in" })).transactions),
          [5],
        );
        const page = yield* search({ order: "asc", limit: 2, offset: 1 });
        assert.deepStrictEqual(ids(page.transactions), [2, 3]);
        assert.strictEqual(page.total, 6);
        assert.isTrue(page.freshness.complete);
        assert.deepStrictEqual(page.freshness.coveredRanges, [COVERED]);

        assert.instanceOf(yield* Effect.flip(search({ minAmount: 10, maxAmount: 1 })), InvalidInput);
        assert.instanceOf(yield* Effect.flip(search({ dateFrom: "2026-02-02", dateTo: "2026-02-01" })), InvalidInput);
        // The default dateTo is today.
        assert.instanceOf(yield* Effect.flip(search({ dateFrom: "2026-11-01" })), InvalidInput);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("search freshness reports gaps in the requested range", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        yield* seed;
        const cache = yield* Transactions;
        const result = yield* cache.search(yield* account(), { ...PAGE, dateFrom: "2025-12-01", dateTo: "2026-12-31" });
        assert.deepStrictEqual(result.freshness, {
          lastSyncAt: null,
          coveredFrom: COVERED.from,
          coveredTo: TODAY,
          coveredRanges: [COVERED],
          oldestFetchAt: "2026-10-22T10:00:00.000Z",
          historyLimited: false,
          complete: false,
        });
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("summaries group by month, counterparty and type, split by currency, in exact cents", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        yield* seed;
        const cache = yield* Transactions;
        const acc = yield* account();
        const page = { limit: 100, offset: 0 };
        const byMonth = yield* cache.summarize(acc, { groupBy: "month", ...page });
        assert.deepStrictEqual(byMonth.groups, [
          { key: "2026-01", currency: "CZK", count: 2, income: 2500, expense: 100.1, net: 2399.9 },
          { key: "2026-02", currency: "CZK", count: 2, income: 0, expense: 0.3, net: -0.3 },
          { key: "2026-02", currency: "EUR", count: 1, income: 50, expense: 0, net: 50 },
          { key: "2026-03", currency: "CZK", count: 1, income: 0, expense: 1000, net: -1000 },
        ]);
        assert.deepStrictEqual(byMonth.totals, [
          { currency: "CZK", count: 5, income: 2500, expense: 1100.4, net: 1399.6 },
          { currency: "EUR", count: 1, income: 50, expense: 0, net: 50 },
        ]);
        assert.strictEqual(byMonth.totalGroups, 4);
        assert.isTrue(byMonth.freshness.complete);

        const byCounterparty = yield* cache.summarize(acc, { groupBy: "counterparty", direction: "out", ...page });
        assert.deepStrictEqual(byCounterparty.groups, [
          { key: "999/2010", currency: "CZK", count: 1, income: 0, expense: 1000, net: -1000 },
          { key: "Albert Praha", currency: "CZK", count: 3, income: 0, expense: 100.4, net: -100.4 },
        ]);

        const byType = yield* cache.summarize(acc, { groupBy: "type", limit: 1, offset: 0 });
        assert.strictEqual(byType.totalGroups, 4);
        assert.deepStrictEqual(byType.groups, [
          { key: "Příjem", currency: "CZK", count: 1, income: 2500, expense: 0, net: 2500 },
        ]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );
});

describe("Transactions.status and sync", () => {
  it.effect("a backfill verifies the token and status reports what it stored", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acc = yield* account();
        const [before] = yield* cache.status([acc]);
        assert.isFalse(before?.verified);
        assert.isNull(before?.job);

        const outcome = yield* cache.sync(acc, { kind: "backfill", from: "2026-01-01" }, 25_000);
        assert.isTrue(outcome.started);
        if (outcome.started) {
          assert.isFalse(outcome.joined);
          assert.strictEqual(outcome.job.status, "completed");
          assert.strictEqual(outcome.job.kind, "backfill");
          assert.strictEqual(outcome.job.startedAt, "2026-10-22T10:00:00.000Z");
        }
        assert.deepStrictEqual(
          (yield* Ref.get(fio.calls)).map((c) => [c.from, c.to, c.priority]),
          [["2026-01-01", TODAY, "background"]],
        );

        const after = yield* verifiedStatus(acc);
        assert.strictEqual(after.rowCount, 6);
        assert.deepStrictEqual(after.coveredRanges, [COVERED]);
        assert.deepStrictEqual(after.lastKnownBalance, { amount: 1000, currency: "CZK", date: TODAY });
        assert.strictEqual(after.sync.lastSuccessAt, "2026-10-22T10:00:00.000Z");
        assert.strictEqual(after.job?.status, "completed");
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );

  it.effect("resume starts nothing without pending ranges, and otherwise finishes them in their mode", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acc: Account = yield* account();
        assert.deepStrictEqual(yield* cache.sync(acc, { kind: "resume" }, 25_000), { started: false });
        assert.deepStrictEqual(yield* Ref.get(fio.calls), []);

        yield* seed;
        yield* seedPending(acc, "refresh", [{ from: "2026-03-01", to: "2026-03-01", replace: true }]);
        const outcome = yield* cache.sync(acc, { kind: "resume" }, 25_000);
        assert.isTrue(outcome.started);
        if (outcome.started) {
          assert.strictEqual(outcome.job.kind, "refresh");
          assert.strictEqual(outcome.job.status, "completed");
        }
        assert.deepStrictEqual(ranges(yield* Ref.get(fio.calls)), ["2026-03-01..2026-03-01"]);
        assert.deepStrictEqual((yield* verifiedStatus(acc)).sync.pending, []);
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );
});

describe("Transactions.Disabled", () => {
  it.effect("reads date ranges from FIO every time, stores nothing, and refuses cache-only calls", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const cache = yield* Transactions;
        const acct = yield* account();
        const range = { from: "2026-01-01", to: TODAY };
        const first = yield* cache.transactions(acct, range, "auto");
        assert.strictEqual(first.source, "fio");
        assert.strictEqual(first.transactionCount, 6);
        yield* cache.record(acct, statement("2026-10-01", TODAY, [tx(42, TODAY, 5)]));
        assert.strictEqual((yield* cache.transactions(acct, range, "auto")).source, "fio");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 2);
        const refusals = [
          Effect.flip(cache.transactions(acct, range, "cache")),
          Effect.flip(cache.search(acct, PAGE)),
          Effect.flip(cache.summarize(acct, { groupBy: "month", limit: 1, offset: 0 })),
          Effect.flip(cache.status([])),
          Effect.flip(cache.sync(acct, { kind: "incremental" })),
        ];
        for (const refusal of refusals) {
          const error = yield* refusal;
          assert.instanceOf(error, InvalidInput);
          assert.strictEqual(error.message, CACHE_DISABLED);
        }
      }).pipe(Effect.provide(disabledCacheLayer(config(), fio.layer)));
    }),
  );
});
