import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Redacted, Ref } from "effect";
import { TestClock } from "effect/testing";
import { type Account, Accounts, accountsFromConfig, makeAccounts } from "../../src/accounts.js";
import { databaseLayer } from "../../src/cache/db.js";
import { TransactionCache, TransactionCacheFromSql } from "../../src/cache/service.js";
import {
  AppConfig,
  type AppConfigShape,
  type CacheConfig,
  DEFAULT_BACKFILL_FROM,
  DEFAULT_CACHE_MAX_AGE_MINUTES,
  DEFAULT_OVERLAP_DAYS,
} from "../../src/config.js";
import type { FioRequestError } from "../../src/errors.js";
import { FioApi, type FioApiShape } from "../../src/fio-api.js";
import { Redactor } from "../../src/redaction.js";
import type { NormalizedStatement, Transaction } from "../../src/statement.js";

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

export interface PeriodCall {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly priority: string | undefined;
}

/** Answers /periods from `respond`; every other endpoint dies. Records each call. */
export type PeriodsScript = (
  call: PeriodCall,
  n: number,
) => Effect.Effect<NormalizedStatement, FioRequestError>;

export const fakeFio = Effect.fnUntraced(function* (initial: PeriodsScript) {
  const calls = yield* Ref.make<ReadonlyArray<PeriodCall>>([]);
  const script = yield* Ref.make(initial);
  const periods: FioApiShape["periods"] = (account, from, to, priority) =>
    Effect.gen(function* () {
      const call = { token: Redacted.value(account.token), from, to, priority };
      const n = (yield* Ref.getAndUpdate(calls, (c) => [...c, call])).length;
      return yield* (yield* Ref.get(script))(call, n);
    });
  const unused = () => Effect.die("not scripted");
  const api: FioApiShape = {
    periods,
    periodsRaw: unused,
    statement: unused,
    statementRaw: unused,
    last: unused,
    setLastId: unused,
    setLastDate: unused,
    lastStatement: unused,
    merchantRaw: unused,
    importXml: unused,
  };
  return { api, calls, setScript: (next: PeriodsScript) => Ref.set(script, next) };
});

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
const baseLayer = (cfg: AppConfigShape, fio: FioApiShape) =>
  Layer.mergeAll(
    Layer.effect(Accounts, Effect.map(makeAccounts(accountsFromConfig(cfg.accounts)), Accounts.of)),
    Redactor.layerFrom(cfg.secrets.map(Redacted.value)),
    Layer.succeed(FioApi, fio),
  ).pipe(Layer.provideMerge(AppConfig.layerFrom(cfg)));

export const cacheLayer = (cfg: AppConfigShape, fio: FioApiShape) =>
  TransactionCacheFromSql.pipe(
    Layer.provideMerge(databaseLayer(cfg.cache.dbPath).pipe(Layer.provide(NodeFileSystem.layer))),
    Layer.provideMerge(baseLayer(cfg, fio)),
  );

/** The same services with FIO_CACHE_ENABLED=false: no database at all. */
export const disabledCacheLayer = (cfg: AppConfigShape, fio: FioApiShape) =>
  TransactionCache.disabled.pipe(Layer.provideMerge(baseLayer({ ...cfg, cache: { ...cfg.cache, enabled: false } }, fio)));

export const enabledCache = Effect.gen(function* () {
  const cache = yield* TransactionCache;
  if (!cache.enabled) return yield* Effect.die("cache disabled");
  return cache;
});

export const account = Effect.fnUntraced(function* (name = "main") {
  const accounts = yield* Accounts;
  return yield* Effect.orDie(accounts.resolve(name));
});

/** Lets forked fibers run up to their next suspension. */
export const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

export type { Account };
