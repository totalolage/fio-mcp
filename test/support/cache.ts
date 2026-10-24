
import { Clock, Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { type Account, Accounts } from "../../src/accounts.js";
import type { DayRange } from "../../src/cache/dates.js";
import { TransactionCache } from "../../src/cache/service.js";
import { makeCacheStore, type PendingRange, type SyncMode } from "../../src/cache/store.js";
import { type AppConfigShape, type CacheConfig, DEFAULT_BACKFILL_FROM, DEFAULT_CACHE_MAX_AGE_MINUTES, DEFAULT_OVERLAP_DAYS, MAX_RESPONSE_BYTES } from "../../src/config.js";
import type { FioApi } from "../../src/fio-api.js";
import { Redactor } from "../../src/redaction.js";
import type { NormalizedStatement, Transaction } from "../../src/statement.js";
import { seededConfig } from "./config.js";
import { testDatabase } from "./database.js";
import type { PeriodsScript } from "./fio-api.js";

export const TOKEN_A = "a".repeat(64);
export const TOKEN_B = "b".repeat(64);

/** 2026-10-22 12:00 in Prague. */
export const NOW = Date.UTC(2026, 9, 22, 10, 0, 0);
export const TODAY = "2026-10-22";

export const setNow = (millis: number = NOW) => TestClock.setTime(millis);

export function config(
  overrides: { readonly cache?: Partial<CacheConfig>; readonly accounts?: AppConfigShape["accounts"] } = {},
): AppConfigShape {
  const accounts = overrides.accounts ?? [
    { name: "main", token: Redacted.make(TOKEN_A), accountNumber: undefined, currency: undefined },
  ];
  return {
    accounts,
    secrets: accounts.map((a) => a.token),
    baseUrl: "https://fio.invalid",
    rateLimitIntervalMs: 30_000,
    maxWaitMs: 25_000,
    requestTimeoutMs: 20_000,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    transport: { kind: "stdio" },
    cache: {
      enabled: true,
      dbPath: ":memory:",
      syncOnStartup: false,
      syncIntervalMinutes: 0,
      backfillFrom: DEFAULT_BACKFILL_FROM,
      overlapDays: DEFAULT_OVERLAP_DAYS,
      maxAgeMinutes: DEFAULT_CACHE_MAX_AGE_MINUTES,
      ...overrides.cache,
    },
  };
}

export function tx(id: number, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction {
  return {
    id,
    date,
    amount,
    currency: "CZK",
    counterpartyAccount: null,
    counterpartyName: null,
    counterpartyBankCode: null,
    counterpartyBankName: null,
    counterpartyBic: null,
    constantSymbol: null,
    variableSymbol: null,
    specificSymbol: null,
    userIdentification: null,
    messageForRecipient: null,
    type: null,
    executedBy: null,
    details: null,
    comment: null,
    instructionId: null,
    payerReference: null,
    ...extra,
  };
}

export function statement(
  from: string,
  to: string,
  transactions: ReadonlyArray<Transaction>,
  accountId = "2000000001",
): NormalizedStatement {
  return {
    info: {
      accountId,
      bankId: "2010",
      currency: "CZK",
      iban: `CZ00${accountId}`,
      bic: "FIOBCZPPXXX",
      openingBalance: 0,
      closingBalance: 1000,
      dateStart: from,
      dateEnd: to,
      yearList: null,
      idList: null,
      idFrom: null,
      idTo: null,
      idLastDownload: null,
    },
    transactionCount: transactions.length,
    transactions: [...transactions],
  };
}

/** Every range succeeds with the movements dated inside it. */
export const serveFrom =
  (movements: ReadonlyArray<Transaction>, accountId?: string): PeriodsScript =>
  (call) =>
    Effect.succeed(
      statement(
        call.from,
        call.to,
        movements.filter((m) => m.date !== null && m.date >= call.from && m.date <= call.to),
        accountId,
      ),
    );

/** Base services for cache tests: config, accounts, redactor, the DB at cache.dbPath (":memory:" by default), and the cache. */
const baseLayer = (cfg: AppConfigShape, fio: Layer.Layer<FioApi>) =>
  Layer.mergeAll(Accounts.Default, Redactor.Default, fio).pipe(Layer.provideMerge(seededConfig(cfg)));

export const cacheLayer = (cfg: AppConfigShape, fio: Layer.Layer<FioApi>) =>
  TransactionCache.Default.pipe(
    Layer.provideMerge(testDatabase(cfg.cache.dbPath)),
    Layer.provideMerge(baseLayer(cfg, fio)),
  );

/** The same services with FIO_CACHE_ENABLED=false: no database at all. */
export const disabledCacheLayer = (cfg: AppConfigShape, fio: Layer.Layer<FioApi>) =>
  TransactionCache.Disabled.pipe(Layer.provideMerge(baseLayer({ ...cfg, cache: { ...cfg.cache, enabled: false } }, fio)));

/** The account's cache status; dies unless the token is verified. */
export const verifiedStatus = Effect.fnUntraced(function* (acc: Account) {
  const [status] = yield* (yield* TransactionCache).status([acc]);
  if (status === undefined || !status.verified) return yield* Effect.die("cache not verified");
  return status;
});

/*
 * Setup through the cache's internal store, on the test's SqlClient, for
 * states the scripted FIO cannot produce. Assertions go through
 * TransactionCache.
 */

/** Stores `statement` as FIO's answer for `range`, as a write-through does. */
export const seedRange = Effect.fnUntraced(function* (acc: Account, statement: NormalizedStatement, range: DayRange) {
  const store = yield* makeCacheStore();
  const fetchedAt = yield* Clock.currentTimeMillis;
  yield* Effect.orDie(
    store.commit({ accountName: acc.name, tokenFingerprint: acc.tokenFingerprint, statement, coverage: range, fetchedAt }),
  );
});

/** Persists an interrupted job: its mode and pending ranges. */
export const seedPending = Effect.fnUntraced(function* (
  acc: Account,
  mode: SyncMode,
  pending: ReadonlyArray<PendingRange>,
) {
  const store = yield* makeCacheStore();
  const state = yield* Effect.orDie(store.syncState(acc.tokenFingerprint));
  yield* Effect.orDie(store.putSyncState(acc.tokenFingerprint, { ...state, mode, pending }));
});

export const account = Effect.fnUntraced(function* (name = "main") {
  const accounts = yield* Accounts;
  return yield* Effect.orDie(accounts.resolve(name));
});

/** Lets forked fibers run up to their next suspension. */
export const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

export type { Account };
