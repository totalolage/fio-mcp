import { Clock, Context, DateTime, Effect, type FileSystem, Layer, Option, Schedule } from "effect";
import type { SqlClient } from "effect/sql";
import { type Account, Accounts } from "../accounts.js";
import { AppConfig, type AppConfigShape } from "../config.js";
import { type CacheError, InvalidInput } from "../errors.js";
import { FioApi } from "../fio-api.js";
import type { NormalizedStatement, StatementInfo, Transaction } from "../statement.js";
import { addDays, type DayRange, minDate, pragueDateOf, pragueToday, rangeLength } from "./dates.js";
import { DatabaseLive } from "./db.js";
import { type CachedAccount, type CacheStore, makeCacheStore, type SyncMode } from "./store.js";
import { type CacheSyncShape, makeCacheSync, type SyncRequest } from "./sync.js";

/**
 * The transaction cache as the tools see it. With FIO_CACHE_ENABLED=false
 * the service is `{ enabled: false }` and no database is opened.
 */

/** How complete and current cache-served data is, for the requested range. */
export interface Freshness {
  /** The last successful sync request for this token (ISO), if any. */
  readonly lastSyncAt: string | null;
  /** First and last covered day within the requested range. */
  readonly coveredFrom: string | null;
  readonly coveredTo: string | null;
  readonly coveredRanges: ReadonlyArray<DayRange>;
  /** The oldest fetch time (ISO) among the covered days in the range. */
  readonly oldestFetchAt: string | null;
  /** Older history is blocked until the owner unlocks it in Internetbanking. */
  readonly historyLimited: boolean;
  /** Every day of the range (up to today) is covered. */
  readonly complete: boolean;
}

export interface CachedStatement {
  readonly info: StatementInfo;
  readonly transactionCount: number;
  readonly transactions: ReadonlyArray<Transaction>;
  readonly lastKnownBalance: { readonly amount: number; readonly date: string | null } | null;
  readonly freshness: Freshness;
}

export interface EnabledCache {
  readonly enabled: true;
  readonly store: CacheStore;
  readonly sync: CacheSyncShape;
  /** The bank account this token's data is bound to; InvalidInput until a FIO response verified it. */
  readonly boundAccount: (account: Account) => Effect.Effect<string, InvalidInput | CacheError>;
  readonly freshness: (account: Account, accountKey: string, range: DayRange) => Effect.Effect<Freshness, CacheError>;
  /** Every day of the range is covered and settled (fetched ≥ overlapDays after it) or fresh (within maxAgeMinutes). */
  readonly servable: (accountKey: string, range: DayRange) => Effect.Effect<boolean, CacheError>;
  readonly read: (account: Account, range: DayRange) => Effect.Effect<CachedStatement, InvalidInput | CacheError>;
  /** Stores a FIO /periods response for `range`; failures are logged, never raised. */
  readonly writeThrough: (account: Account, statement: NormalizedStatement, range: DayRange) => Effect.Effect<void>;
  /** Stores movements from a response that is not a full date range (no coverage); failures are logged. */
  readonly record: (account: Account, statement: NormalizedStatement) => Effect.Effect<void>;
}

export type TransactionCacheShape = { readonly enabled: false } | EnabledCache;

export class TransactionCache extends Context.Service<TransactionCache, TransactionCacheShape>()(
  "fio-mcp/TransactionCache",
) {
  static readonly disabled = Layer.succeed(TransactionCache, { enabled: false });
}

export const NOT_VERIFIED =
  "The cache is not verified for this token yet; run sync_transactions (or get_transactions with source=fio) first.";

export const CACHE_DISABLED = "The local transaction cache is disabled (FIO_CACHE_ENABLED=false).";

const iso = (millis: number | null) => (millis === null ? null : DateTime.formatIso(DateTime.makeUnsafe(millis)));

function cachedInfo(account: Option.Option<CachedAccount>, range: DayRange): StatementInfo {
  const a = Option.getOrUndefined(account);
  return {
    accountId: a?.accountId ?? null,
    bankId: a?.bankId ?? null,
    currency: a?.currency ?? null,
    iban: a?.iban ?? null,
    bic: a?.bic ?? null,
    openingBalance: null,
    closingBalance: null,
    dateStart: range.from,
    dateEnd: range.to,
    yearList: null,
    idList: null,
    idFrom: null,
    idTo: null,
    idLastDownload: null,
  };
}

export const makeTransactionCache = Effect.fn("TransactionCache.make")(function* () {
  const config = yield* AppConfig;
  const fio = yield* FioApi;
  const store = yield* makeCacheStore();
  const sync = yield* makeCacheSync(store, fio, config);
  const { overlapDays, maxAgeMinutes } = config.cache;

  const boundAccount = (account: Account) =>
    Effect.flatMap(store.binding(account.tokenFingerprint), (binding) =>
      Option.match(binding, {
        onNone: () => Effect.fail(new InvalidInput({ detail: NOT_VERIFIED })),
        onSome: (b) => Effect.succeed(b.accountKey),
      }),
    );

  /** The range up to today; days after today have no movements yet. */
  const clamp = (range: DayRange, today: string): DayRange => ({ from: range.from, to: minDate(range.to, today) });

  const freshness = Effect.fn("TransactionCache.freshness")(function* (
    account: Account,
    accountKey: string,
    range: DayRange,
  ) {
    const today = yield* pragueToday;
    const effective = clamp(range, today);
    const state = yield* store.syncState(account.tokenFingerprint);
    const days = effective.from <= effective.to ? yield* store.coverageIn(accountKey, effective) : [];
    const ranges = effective.from <= effective.to ? yield* store.coveredRanges(accountKey, effective) : [];
    const oldest = days.reduce<number | null>((min, d) => (min === null || d.fetchedAt < min ? d.fetchedAt : min), null);
    return {
      lastSyncAt: iso(state.lastSuccessAt),
      coveredFrom: ranges[0]?.from ?? null,
      coveredTo: ranges.at(-1)?.to ?? null,
      coveredRanges: ranges,
      oldestFetchAt: iso(oldest),
      historyLimited: state.historyLimited,
      complete: days.length === rangeLength(effective),
    } satisfies Freshness;
  });

  const servable = Effect.fn("TransactionCache.servable")(function* (accountKey: string, range: DayRange) {
    const today = yield* pragueToday;
    const now = yield* Clock.currentTimeMillis;
    const effective = clamp(range, today);
    if (effective.from > effective.to) return false;
    const days = yield* store.coverageIn(accountKey, effective);
    if (days.length !== rangeLength(effective)) return false;
    return days.every(
      (d) => pragueDateOf(d.fetchedAt) >= addDays(d.day, overlapDays) || now - d.fetchedAt <= maxAgeMinutes * 60_000,
    );
  });

  const read = Effect.fn("TransactionCache.read")(function* (account: Account, range: DayRange) {
    const accountKey = yield* boundAccount(account);
    const transactions = yield* store.transactionsIn(accountKey, range);
    const cached = yield* store.account(accountKey);
    const known = Option.getOrUndefined(cached);
    return {
      info: cachedInfo(cached, range),
      transactionCount: transactions.length,
      transactions,
      lastKnownBalance:
        known === undefined || known.balance === null ? null : { amount: known.balance, date: known.balanceDate },
      freshness: yield* freshness(account, accountKey, range),
    } satisfies CachedStatement;
  });

  const logged = (what: string) => (effect: Effect.Effect<unknown, CacheError | { readonly message: string }>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catch((error) => Effect.logWarning(`cache: could not store ${what}: ${error.message}`)),
    );

  const writeThrough = Effect.fn("TransactionCache.writeThrough")(function* (
    account: Account,
    statement: NormalizedStatement,
    range: DayRange,
  ) {
    const today = yield* pragueToday;
    const now = yield* Clock.currentTimeMillis;
    const effective = clamp(range, today);
    yield* logged("the fetched range")(
      store.commit({
        accountName: account.name,
        tokenFingerprint: account.tokenFingerprint,
        statement,
        coverage: effective.from <= effective.to ? effective : undefined,
        fetchedAt: now,
      }),
    );
  });

  const record = Effect.fn("TransactionCache.record")(function* (account: Account, statement: NormalizedStatement) {
    const now = yield* Clock.currentTimeMillis;
    yield* logged("movements")(
      store.commit({
        accountName: account.name,
        tokenFingerprint: account.tokenFingerprint,
        statement,
        fetchedAt: now,
      }),
    );
  });

  return {
    enabled: true,
    store,
    sync,
    boundAccount,
    freshness,
    servable,
    read,
    writeThrough,
    record,
  } satisfies EnabledCache;
});

/** The enabled cache on an existing SqlClient (tests provide an in-memory one). */
export const TransactionCacheFromSql: Layer.Layer<
  TransactionCache,
  never,
  SqlClient.SqlClient | AppConfig | FioApi
> = Layer.effect(TransactionCache, Effect.map(makeTransactionCache(), TransactionCache.of));

/**
 * The cache on a database the caller provides (e.g. `DatabaseLive`, shared
 * with other users of the file); `{ enabled: false }` when the cache is off.
 */
export const CacheOnDatabaseLive: Layer.Layer<TransactionCache, never, SqlClient.SqlClient | AppConfig | FioApi> =
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return config.cache.enabled ? TransactionCacheFromSql : TransactionCache.disabled;
    }),
  );

/**
 * The cache from configuration with its own database: opens and migrates
 * FIO_DB_PATH when the cache is enabled, otherwise `{ enabled: false }`
 * without touching disk.
 */
export const CacheLive: Layer.Layer<TransactionCache, CacheError, AppConfig | FileSystem.FileSystem | FioApi> =
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return config.cache.enabled ? TransactionCacheFromSql.pipe(Layer.provide(DatabaseLive)) : TransactionCache.disabled;
    }),
  );

const syncAll = Effect.fn("CacheSync.syncAll")(function* (
  cache: EnabledCache,
  accounts: ReadonlyArray<Account>,
  choose: (account: Account) => Effect.Effect<Option.Option<Parameters<CacheSyncShape["start"]>[1]>, CacheError>,
) {
  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.tokenFingerprint)) continue;
    seen.add(account.tokenFingerprint);
    const request = yield* choose(account).pipe(
      Effect.catch((error) => Effect.as(Effect.logWarning(`cache sync ${account.name}: ${error.message}`), Option.none())),
    );
    if (Option.isSome(request)) yield* cache.sync.start(account, request.value);
  }
});

const resumeRequest = (mode: SyncMode | null): SyncRequest => {
  switch (mode) {
    case "incremental":
      return { kind: "incremental" };
    case "refresh":
      return { kind: "refresh" };
    default:
      return { kind: "backfill" };
  }
};

/** What startup runs for one token: the full startup sync, or only an interrupted job. */
const startupRequest = (cache: EnabledCache, config: AppConfigShape) => (account: Account) =>
  config.cache.syncOnStartup
    ? Effect.succeedSome({ kind: "startup" as const })
    : Effect.map(cache.store.syncState(account.tokenFingerprint), (state) =>
        state.pending.length > 0 ? Option.some(resumeRequest(state.mode)) : Option.none(),
      );

/**
 * Background sync: at startup (cache.syncOnStartup, or to resume an
 * interrupted job) and every cache.syncIntervalMinutes when that is above 0.
 * Forked into the layer's scope; MCP initialization never waits for it.
 */
export const CacheSyncLive: Layer.Layer<never, never, TransactionCache | Accounts | AppConfig> = Layer.effectDiscard(
  Effect.gen(function* () {
    const cache = yield* TransactionCache;
    if (!cache.enabled) return;
    const accounts = yield* Accounts;
    const config = yield* AppConfig;
    yield* Effect.forkScoped(syncAll(cache, accounts.list, startupRequest(cache, config)));
    const minutes = config.cache.syncIntervalMinutes;
    if (minutes > 0) {
      const periodic = syncAll(cache, accounts.list, () => Effect.succeedSome({ kind: "incremental" as const }));
      yield* Effect.forkScoped(
        Effect.sleep(`${minutes} minutes`).pipe(Effect.andThen(Effect.repeat(periodic, Schedule.spaced(`${minutes} minutes`)))),
      );
    }
  }),
);
