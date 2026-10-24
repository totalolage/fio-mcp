import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { TestClock } from "effect/testing";
import { CACHE_DISABLED, NOT_VERIFIED, TransactionCache } from "../src/cache/service.js";
import { InvalidInput } from "../src/errors.js";
import {
  account,
  cacheLayer,
  config,
  disabledCacheLayer,
  enabledCache,
  serveFrom,
  setNow,
  statement,
  TODAY,
  tx,
} from "./support/cache.js";
import { fakeFio, type PeriodsScript } from "./support/fio-api.js";

const fixture = [
  tx(1, "2026-01-05", -100.1, { counterpartyName: "Albert Praha", type: "Platba kartou" }),
  tx(2, "2026-01-20", 2500, { counterpartyName: "Employer s.r.o.", type: "Příjem" }),
  tx(3, "2026-02-03", -0.1, { counterpartyName: "Albert Praha", type: "Platba kartou" }),
  tx(4, "2026-02-03", -0.2, { counterpartyName: "Albert Praha", type: "Platba kartou" }),
  tx(5, "2026-02-10", 50, { counterpartyName: "Foreign GmbH", currency: "EUR", type: "Příjem" }),
  tx(7, "2026-03-01", -1000, { counterpartyAccount: "999", counterpartyBankCode: "2010", comment: "Rent March" }),
];

const ids = (rows: ReadonlyArray<{ readonly id: number | null }>) => rows.map((r) => r.id);

describe("TransactionCache.transactions", () => {
  it.effect("auto asks FIO when the range is not cached, writes through, then answers from the cache", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const cache = yield* TransactionCache;
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
        const cache = yield* TransactionCache;
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
        const cache = yield* TransactionCache;
        const acct = yield* account();
        const unverified = yield* Effect.flip(cache.transactions(acct, { from: "2026-01-01", to: TODAY }, "cache"));
        assert.instanceOf(unverified, InvalidInput);
        assert.strictEqual(unverified.message, NOT_VERIFIED);
        const covered = { from: "2026-01-01", to: TODAY };
        const enabled = yield* enabledCache;
        yield* enabled.writeThrough(acct, statement(covered.from, covered.to, fixture), covered);
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
        const cache = yield* TransactionCache;
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
});

describe("TransactionCache.record", () => {
  it.effect("stores statement and new-movement results without coverage", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        const cache = yield* TransactionCache;
        const acct = yield* account();
        yield* cache.record(acct, statement("2026-01-01", "2026-01-31", [fixture[0]!, fixture[1]!]));
        yield* cache.record(acct, statement("2026-10-01", TODAY, [tx(42, TODAY, 5)]));
        const enabled = yield* enabledCache;
        const key = yield* enabled.boundAccount(acct);
        assert.strictEqual((yield* enabled.store.stats(key)).rowCount, 3);
        assert.deepStrictEqual(yield* enabled.store.coveredRanges(key), []);
        // Without coverage the range is never servable: auto still asks FIO.
        assert.strictEqual((yield* cache.transactions(acct, { from: "2026-01-01", to: "2026-01-31" }, "auto")).source, "fio");
      }).pipe(Effect.provide(cacheLayer(config(), fio.layer)));
    }),
  );
});

describe("TransactionCache.Disabled", () => {
  it.effect("reads date ranges from FIO every time, stores nothing, and refuses source=cache", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom(fixture));
      yield* Effect.gen(function* () {
        const cache = yield* TransactionCache;
        const acct = yield* account();
        const range = { from: "2026-01-01", to: TODAY };
        const first = yield* cache.transactions(acct, range, "auto");
        assert.strictEqual(first.source, "fio");
        assert.strictEqual(first.transactionCount, 6);
        yield* cache.record(acct, statement("2026-10-01", TODAY, [tx(42, TODAY, 5)]));
        assert.strictEqual((yield* cache.transactions(acct, range, "auto")).source, "fio");
        assert.strictEqual((yield* Ref.get(fio.calls)).length, 2);
        const error = yield* Effect.flip(cache.transactions(acct, range, "cache"));
        assert.instanceOf(error, InvalidInput);
        assert.strictEqual(error.message, CACHE_DISABLED);
      }).pipe(Effect.provide(disabledCacheLayer(config(), fio.layer)));
    }),
  );
});
