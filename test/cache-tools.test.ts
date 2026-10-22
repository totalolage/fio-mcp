import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Ref } from "effect";
import { TestClock } from "effect/testing";
import { Accounts, makeAccounts } from "../src/accounts.js";
import { CACHE_DISABLED, NOT_VERIFIED } from "../src/cache/service.js";
import { AppConfig } from "../src/config.js";
import { type CacheError, InvalidInput, type PermissionDenied } from "../src/errors.js";
import { FioApi } from "../src/fio-api.js";
import { makeCacheHandlers, makeCacheToolkit } from "../src/mcp/cache-tools.js";
import { makeFioHandlers, makeFioToolkit } from "../src/mcp/fio-tools.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { Redactor } from "../src/redaction.js";
import { LocalPrincipalLive } from "../src/transport/principal.js";
import {
  account,
  cacheLayer,
  config,
  disabledCacheLayer,
  enabledCache,
  fakeFio,
  type PeriodsScript,
  serveFrom,
  setNow,
  statement,
  TODAY,
  tx,
} from "./support/cache.js";

const limiter = RateLimiter.layerFrom({ intervalMs: 30_000, maxWaitMs: 25_000 });

const cacheTools = Effect.suspend(() => makeCacheHandlers(makeCacheToolkit(["main"])));
const fioTools = Effect.suspend(() => makeFioHandlers(makeFioToolkit(["main"]))).pipe(Effect.provide(limiter));

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

/** Caches the fixture for COVERED through write-through, as get_transactions source=fio would. */
const seed = Effect.gen(function* () {
  const cache = yield* enabledCache;
  yield* cache.writeThrough(yield* account(), statement(COVERED.from, COVERED.to, fixture), COVERED);
});

const ids = (rows: unknown) => (rows as ReadonlyArray<{ id: number }>).map((r) => r.id);

describe("cache query tools", () => {
  it.effect("search filters, pages and orders cached movements", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        yield* seed;
        const tools = yield* cacheTools;
        const search = (args: Parameters<typeof tools.search_transactions>[0]) => tools.search_transactions(args);
        assert.deepStrictEqual(ids((yield* search({ direction: "out", minAmount: 100 })).transactions), [7, 1]);
        assert.deepStrictEqual(ids((yield* search({ counterparty: "albert" })).transactions), [4, 3, 1]);
        assert.deepStrictEqual(ids((yield* search({ counterparty: "999/2010" })).transactions), [7]);
        assert.deepStrictEqual(ids((yield* search({ text: "RENT" })).transactions), [7]);
        assert.deepStrictEqual(ids((yield* search({ text: "nakup" })).transactions), [1]);
        assert.deepStrictEqual(ids((yield* search({ variableSymbol: "2026001" })).transactions), [2]);
        assert.deepStrictEqual(ids((yield* search({ type: "Platba kartou", maxAmount: 0.15 })).transactions), [3]);
        assert.deepStrictEqual(ids((yield* search({ currency: "eur" })).transactions), [5]);
        assert.deepStrictEqual(ids((yield* search({ dateFrom: "2026-02-01", dateTo: "2026-02-28", direction: "in" })).transactions), [5]);
        const page = yield* search({ order: "asc", limit: 2, offset: 1 });
        assert.deepStrictEqual(ids(page.transactions), [2, 3]);
        assert.strictEqual(page.total, 6);
        assert.strictEqual(page.source, "cache");
        const freshness = page.freshness as { complete: boolean; coveredRanges: unknown; lastSyncAt: unknown };
        assert.isTrue(freshness.complete);
        assert.deepStrictEqual(freshness.coveredRanges, [COVERED]);

        const invalid = yield* Effect.flip(search({ minAmount: 10, maxAmount: 1 }));
        assert.instanceOf(invalid, InvalidInput);
        assert.instanceOf(yield* Effect.flip(search({ dateFrom: "2026-02-02", dateTo: "2026-02-01" })), InvalidInput);
        assert.instanceOf(yield* Effect.flip(search({ dateFrom: "2026-11-01" })), InvalidInput);
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.api), LocalPrincipalLive)));
    }),
  );

  it.effect("summaries group by month, counterparty and type, split by currency, in exact cents", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        yield* seed;
        const tools = yield* cacheTools;
        const byMonth = yield* tools.summarize_transactions({ groupBy: "month" });
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

        const byCounterparty = yield* tools.summarize_transactions({ groupBy: "counterparty", direction: "out" });
        assert.deepStrictEqual(byCounterparty.groups, [
          { key: "999/2010", currency: "CZK", count: 1, income: 0, expense: 1000, net: -1000 },
          { key: "Albert Praha", currency: "CZK", count: 3, income: 0, expense: 100.4, net: -100.4 },
        ]);

        const byType = yield* tools.summarize_transactions({ groupBy: "type", limit: 1, offset: 0 });
        assert.strictEqual(byType.totalGroups, 4);
        assert.deepStrictEqual(byType.groups, [
          { key: "Příjem", currency: "CZK", count: 1, income: 2500, expense: 0, net: 2500 },
        ]);
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.api), LocalPrincipalLive)));
    }),
  );

  it.effect("freshness reports gaps in the requested range", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        yield* seed;
        const tools = yield* cacheTools;
        const result = yield* tools.search_transactions({ dateFrom: "2025-12-01", dateTo: "2026-12-31" });
        assert.deepStrictEqual(result.freshness, {
          lastSyncAt: null,
          coveredFrom: COVERED.from,
          coveredTo: TODAY,
          coveredRanges: [COVERED],
          oldestFetchAt: "2026-10-22T10:00:00.000Z",
          historyLimited: false,
          complete: false,
        });
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.api), LocalPrincipalLive)));
    }),
  );

  it.effect("status and sync report per account", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const tools = yield* cacheTools;
        const before = yield* tools.get_cache_status();
        const [unverified] = before.accounts as ReadonlyArray<{ verified: boolean }>;
        assert.isFalse(unverified?.verified);

        const synced = yield* tools.sync_transactions({ mode: "backfill", from: "2026-01-01" });
        const job = synced.job as { status: string; requests: number; kind: string };
        assert.strictEqual(job.status, "completed");
        assert.strictEqual(job.kind, "backfill");
        assert.deepStrictEqual(
          (yield* Ref.get(fio.calls)).map((c) => [c.from, c.to, c.priority]),
          [["2026-01-01", TODAY, "background"]],
        );

        const after = yield* tools.get_cache_status();
        const [status] = after.accounts as ReadonlyArray<Record<string, unknown>>;
        assert.strictEqual(status?.verified, true);
        assert.strictEqual(status?.rowCount, 6);
        assert.deepStrictEqual(status?.coveredRanges, [COVERED]);
        assert.deepStrictEqual(status?.lastKnownBalance, { amount: 1000, currency: "CZK", date: TODAY });
        assert.strictEqual((status?.sync as { lastSuccessAt: string } | undefined)?.lastSuccessAt, "2026-10-22T10:00:00.000Z");

        assert.instanceOf(yield* Effect.flip(tools.sync_transactions({ from: "2026-01-01" })), InvalidInput);
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.api), LocalPrincipalLive)));
    }),
  );
});

describe("get_transactions with the cache", () => {
  it.effect("auto asks FIO when the range is not cached, writes through, then answers from the cache", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const tools = yield* fioTools;
        const args = { dateFrom: "2026-10-01", dateTo: TODAY };
        const first = yield* tools.get_transactions(args);
        assert.strictEqual(first.source, "fio");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 1);
        assert.strictEqual((yield* Ref.get(fio.calls))[0]?.priority, undefined);

        const second = yield* tools.get_transactions(args);
        assert.strictEqual(second.source, "cache");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 1);
        assert.strictEqual((second.info as { closingBalance: unknown }).closingBalance, null);
        assert.deepStrictEqual((second as { lastKnownBalance?: unknown }).lastKnownBalance, { amount: 1000, date: TODAY });
        assert.isTrue((second.freshness as { complete: boolean }).complete);

        // An hour later today's data is no longer fresh and not yet settled.
        yield* TestClock.adjust(61 * 60_000);
        assert.strictEqual((yield* tools.get_transactions(args)).source, "fio");

        // Older days fetched more than overlapDays after them are settled.
        const old = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
        assert.strictEqual((yield* tools.get_transactions(old)).source, "fio");
        yield* TestClock.adjust(24 * 60 * 60_000);
        assert.strictEqual((yield* tools.get_transactions(old)).source, "cache");

        // source=fio always asks FIO.
        const calls = (yield* Ref.get(fio.calls)).length;
        assert.strictEqual((yield* tools.get_transactions({ ...old, source: "fio" })).source, "fio");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, calls + 1);
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.api), LocalPrincipalLive)));
    }),
  );

  it.effect("auto keeps asking FIO while its response has a movement without an ID", () =>
    Effect.gen(function* () {
      yield* setNow();
      const malformed: PeriodsScript = (call) =>
        Effect.succeed(statement(call.from, call.to, [tx(1, "2026-10-05", -10), tx(2, "2026-10-06", 20, { id: null })]));
      const fio = yield* fakeFio(malformed);
      yield* Effect.gen(function* () {
        const tools = yield* fioTools;
        const args = { dateFrom: "2026-10-01", dateTo: TODAY };
        assert.strictEqual((yield* tools.get_transactions(args)).source, "fio");
        assert.strictEqual((yield* tools.get_transactions(args)).source, "fio");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 2);
        // Nothing was stored, so the cache is not even bound to the token.
        assert.instanceOf(yield* Effect.flip(tools.get_transactions({ ...args, source: "cache" })), InvalidInput);
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.api), LocalPrincipalLive)));
    }),
  );

  it.effect("source=cache never calls FIO and needs a verified binding", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const tools = yield* fioTools;
        const unverified = yield* Effect.flip(
          tools.get_transactions({ dateFrom: "2026-01-01", dateTo: TODAY, source: "cache" }),
        );
        assert.instanceOf(unverified, InvalidInput);
        assert.strictEqual(unverified.message, NOT_VERIFIED);
        yield* seed;
        const partial = yield* tools.get_transactions({ dateFrom: "2025-06-01", dateTo: "2026-01-31", source: "cache" });
        assert.strictEqual(partial.source, "cache");
        assert.deepStrictEqual(ids(partial.transactions), [1, 2]);
        assert.isFalse((partial.freshness as { complete: boolean }).complete);
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 0);
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.api), LocalPrincipalLive)));
    }),
  );

  it.effect("statement and new-movement results are stored without coverage", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      const api = {
        ...fio.api,
        statement: () => Effect.succeed(statement("2026-01-01", "2026-01-31", [fixture[0]!, fixture[1]!])),
        last: () => Effect.succeed(statement("2026-10-01", TODAY, [tx(42, TODAY, 5)])),
      };
      yield* Effect.gen(function* () {
        const tools = yield* fioTools;
        yield* tools.get_statement({ year: 2026, number: 1 });
        yield* tools.get_new_transactions({});
        const cache = yield* enabledCache;
        const key = yield* cache.boundAccount(yield* account());
        assert.strictEqual((yield* cache.store.stats(key)).rowCount, 3);
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), []);
        // Unfiltered queries reach back to the earliest stored movement, not just covered days.
        const found = yield* (yield* cacheTools).search_transactions({});
        assert.deepStrictEqual(ids(found.transactions), [42, 2, 1]);
        assert.isFalse((found.freshness as { complete: boolean }).complete);
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), api), LocalPrincipalLive)));
    }),
  );

  it.effect("live freshness follows the period FIO's header reports", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio((call, n) =>
        Effect.map(serveFrom(fixture)(call, n), (s) => ({ ...s, info: { ...s.info, dateStart: "2026-02-01" } })),
      );
      yield* Effect.gen(function* () {
        const tools = yield* fioTools;
        const result = yield* tools.get_transactions({ dateFrom: "2026-01-01", dateTo: "2026-12-31", source: "fio" });
        const freshness = result.freshness as { complete: boolean; coveredRanges: unknown };
        assert.isFalse(freshness.complete);
        assert.deepStrictEqual(freshness.coveredRanges, [{ from: "2026-02-01", to: TODAY }]);
        const future = yield* tools.get_transactions({ dateFrom: "2026-11-01", dateTo: "2026-11-30", source: "fio" });
        assert.deepStrictEqual(future.freshness, {
          lastSyncAt: "2026-10-22T10:00:00.000Z",
          coveredFrom: null,
          coveredTo: null,
          coveredRanges: [],
          oldestFetchAt: "2026-10-22T10:00:00.000Z",
          historyLimited: false,
          complete: true,
        });
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.api), LocalPrincipalLive)));
    }),
  );
});

describe("cache disabled", () => {
  it.effect("cache tools answer that the cache is disabled; get_transactions uses FIO", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const cache = yield* cacheTools;
        const runs: ReadonlyArray<Effect.Effect<object, InvalidInput | CacheError | PermissionDenied>> = [
          cache.search_transactions({}),
          cache.summarize_transactions({ groupBy: "month" }),
          cache.get_cache_status(),
          cache.sync_transactions({}),
        ];
        for (const run of runs) {
          const error = yield* Effect.flip(run);
          assert.instanceOf(error, InvalidInput);
          assert.strictEqual(error.message, CACHE_DISABLED);
        }
        const tools = yield* fioTools;
        const args = { dateFrom: "2026-01-01", dateTo: TODAY };
        assert.strictEqual((yield* tools.get_transactions(args)).source, "fio");
        assert.strictEqual((yield* tools.get_transactions(args)).source, "fio");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 2);
        const error = yield* Effect.flip(tools.get_transactions({ ...args, source: "cache" }));
        assert.strictEqual(error.message, CACHE_DISABLED);
      }).pipe(Effect.provide(Layer.mergeAll(disabledCacheLayer(config(), fio.api), LocalPrincipalLive)));
    }),
  );

  it.effect("get_transactions works without the cache layer wired at all", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      const cfg = config();
      const layer = Layer.mergeAll(
        Layer.effect(Accounts, Effect.map(makeAccounts(cfg.accounts), Accounts.of)),
        Redactor.layerFrom(cfg.secrets.map(Redacted.value)),
        Layer.succeed(FioApi, fio.api),
      ).pipe(Layer.provideMerge(AppConfig.layerFrom(cfg)));
      yield* Effect.gen(function* () {
        const tools = yield* fioTools;
        const result = yield* tools.get_transactions({ dateFrom: "2026-01-01", dateTo: TODAY });
        assert.strictEqual(result.source, "fio");
        assert.strictEqual(result.transactionCount, 6);
      }).pipe(Effect.provide(Layer.mergeAll(layer, LocalPrincipalLive)));
    }),
  );
});
