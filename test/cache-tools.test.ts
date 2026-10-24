import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { CACHE_DISABLED } from "../src/cache/service.js";
import { type CacheError, InvalidInput, type PermissionDenied } from "../src/errors.js";
import { makeCacheHandlers, makeCacheToolkit } from "../src/mcp/cache-tools.js";
import { LocalPrincipalLive } from "../src/transport/principal.js";
import {
  account,
  cacheLayer,
  config,
  disabledCacheLayer,
  seedRange,
  serveFrom,
  setNow,
  statement,
  TODAY,
  tx,
} from "./support/cache.js";
import { fakeFio } from "./support/fio-api.js";

const cacheTools = Effect.suspend(() => makeCacheHandlers(makeCacheToolkit(["main"])));

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

const ids = (rows: unknown) => (rows as ReadonlyArray<{ id: number }>).map((r) => r.id);

// Query semantics are tested on Transactions (test/transactions.test.ts);
// these cases cover argument defaults, validation and the result envelope.
describe("cache query tools", () => {
  it.effect("search_transactions pages with defaults and reports the cache as its source", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        yield* seed;
        const tools = yield* cacheTools;
        const all = yield* tools.search_transactions({});
        assert.strictEqual(all.account, "main");
        assert.strictEqual(all.source, "cache");
        assert.strictEqual(all.limit, 100);
        assert.strictEqual(all.offset, 0);
        assert.strictEqual(all.returned, 6);
        assert.deepStrictEqual(ids(all.transactions), [7, 5, 4, 3, 2, 1]);
        const page = yield* tools.search_transactions({ order: "asc", limit: 2, offset: 1, counterparty: "albert" });
        assert.deepStrictEqual(ids(page.transactions), [3, 4]);
        assert.strictEqual(page.total, 3);
        assert.strictEqual(page.returned, 2);
        assert.isTrue((page.freshness as { complete: boolean }).complete);
        assert.instanceOf(yield* Effect.flip(tools.search_transactions({ minAmount: 10, maxAmount: 1 })), InvalidInput);
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.layer), LocalPrincipalLive)));
    }),
  );

  it.effect("summarize_transactions returns the grouping with its totals", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        yield* seed;
        const tools = yield* cacheTools;
        const byType = yield* tools.summarize_transactions({ groupBy: "type", limit: 1 });
        assert.strictEqual(byType.source, "cache");
        assert.strictEqual(byType.groupBy, "type");
        assert.strictEqual(byType.totalGroups, 4);
        assert.deepStrictEqual(byType.groups, [
          { key: "Příjem", currency: "CZK", count: 1, income: 2500, expense: 0, net: 2500 },
        ]);
        assert.strictEqual((byType.totals as ReadonlyArray<unknown>).length, 2);
        assert.isTrue((byType.freshness as { complete: boolean }).complete);
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.layer), LocalPrincipalLive)));
    }),
  );

  it.effect("get_cache_status lists the settings and each account's status", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        yield* seed;
        const tools = yield* cacheTools;
        const result = yield* tools.get_cache_status();
        assert.strictEqual(result.dbPath, ":memory:");
        assert.deepStrictEqual(result.settings, {
          syncOnStartup: false,
          syncIntervalMinutes: 0,
          backfillFrom: "2000-01-01",
          overlapDays: 10,
          maxAgeMinutes: 60,
        });
        const [status] = result.accounts as ReadonlyArray<Record<string, unknown>>;
        assert.strictEqual(status?.name, "main");
        assert.strictEqual(status?.verified, true);
        assert.strictEqual(status?.rowCount, 6);
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.layer), LocalPrincipalLive)));
    }),
  );

  it.effect("sync_transactions validates its arguments before any FIO call, then reports the job", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const tools = yield* cacheTools;
        const invalid = [
          { from: "2026-01-01" },
          { mode: "backfill" as const, from: "2026-10-23" },
          { refresh: { from: "2026-03-01", to: TODAY }, mode: "backfill" as const },
          { refresh: { from: "2026-03-01", to: TODAY }, from: "2026-03-01" },
          { refresh: { from: TODAY, to: "2026-03-01" } },
          { refresh: { from: "2026-10-23", to: "2026-10-30" } },
        ];
        for (const args of invalid) assert.instanceOf(yield* Effect.flip(tools.sync_transactions(args)), InvalidInput);
        assert.deepStrictEqual(yield* Ref.get(fio.calls), []);

        const synced = yield* tools.sync_transactions({ mode: "backfill", from: "2026-01-01" });
        assert.strictEqual(synced.account, "main");
        assert.isFalse(synced.joinedRunningJob);
        assert.strictEqual(synced.note, "The sync completed.");
        const job = synced.job as { status: string; kind: string; startedAt: string };
        assert.strictEqual(job.status, "completed");
        assert.strictEqual(job.kind, "backfill");
        assert.strictEqual(job.startedAt, "2026-10-22T10:00:00.000Z");
        assert.deepStrictEqual(
          (yield* Ref.get(fio.calls)).map((c) => [c.from, c.to, c.priority]),
          [["2026-01-01", TODAY, "background"]],
        );

        const refreshed = yield* tools.sync_transactions({ refresh: { from: "2026-03-01", to: TODAY } });
        assert.strictEqual((refreshed.job as { kind: string }).kind, "refresh");
      }).pipe(Effect.provide(Layer.mergeAll(cacheLayer(config(), fio.layer), LocalPrincipalLive)));
    }),
  );
});

describe("cache disabled", () => {
  it.effect("cache tools answer that the cache is disabled", () =>
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
      }).pipe(Effect.provide(Layer.mergeAll(disabledCacheLayer(config(), fio.layer), LocalPrincipalLive)));
    }),
  );
});
