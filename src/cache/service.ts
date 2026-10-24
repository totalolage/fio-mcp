import { Clock, Context, DateTime, Effect, Layer, Option, Schedule } from "effect";
import { type Account, Accounts } from "../accounts.js";
import { AppConfig } from "../config.js";
import { type CacheError, type FioRequestError, InvalidInput } from "../errors.js";
import { FioApi } from "../fio-api.js";
import type { NormalizedStatement, StatementInfo, Transaction } from "../statement.js";
import { addDays, type DayRange, minDate, pragueDateOf, pragueToday, rangeLength } from "./dates.js";
import { Database } from "./db.js";
import { fromFio, type Source, selectSource, type TransactionsResult } from "./source.js";
import {
  type CachedAccount,
  type GroupBy,
  makeCacheStore,
  type PendingRange,
  type SummaryGroup,
  type TransactionFilters,
} from "./store.js";
import { historyUnlockMessage, type JobProgress, makeCacheSync, type StartRequest } from "./sync.js";

export type { Source, TransactionsResult } from "./source.js";
export type { GroupBy, SummaryGroup, TransactionFilters } from "./store.js";
export { historyUnlockMessage, type JobProgress, type StartRequest, type SyncRequest } from "./sync.js";

/**
 * The transaction cache as the tools see it. With FIO_CACHE_ENABLED=false
 * the `Disabled` adapter answers date-range reads from FIO and no database
 * is opened.
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

export interface SearchQuery extends TransactionFilters {
  readonly limit: number;
  readonly offset: number;
  readonly order: "asc" | "desc";
}

export interface SearchResult {
  /** Every match, not just this page. */
  readonly total: number;
  readonly transactions: ReadonlyArray<Transaction>;
  /** For the date range searched. */
  readonly freshness: Freshness;
}

export interface SummaryQuery extends TransactionFilters {
  readonly groupBy: GroupBy;
  readonly limit: number;
  readonly offset: number;
}

export interface SummaryResult {
  readonly totalGroups: number;
  readonly groups: ReadonlyArray<SummaryGroup>;
  /** Per currency, over every match. */
  readonly totals: ReadonlyArray<Omit<SummaryGroup, "key">>;
  readonly freshness: Freshness;
}

/** A sync job's progress, times as ISO strings. */
export type JobStatus = Omit<JobProgress, "startedAt" | "finishedAt"> & {
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
};

export interface SyncStatus {
  readonly lastSuccessAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastError: string | null;
  readonly pending: ReadonlyArray<PendingRange>;
  readonly blocked: ReadonlyArray<DayRange>;
  readonly failedDays: ReadonlyArray<string>;
  readonly backfillTarget: string | null;
  readonly historyLimited: boolean;
  readonly historyLimitedSince: string | null;
  /** The owner's steps to unlock older history, while it is limited. */
  readonly historyUnlock?: string;
}

/** One account's cache state; `verified: false` until a FIO response bound the token to a bank account. */
export type AccountCacheStatus =
  | {
      readonly name: string;
      readonly verified: false;
      readonly note: string;
      readonly sync: SyncStatus;
      readonly job: JobStatus | null;
    }
  | {
      readonly name: string;
      readonly verified: true;
      readonly verifiedAt: string | null;
      readonly bankAccount: string;
      readonly iban: string | null;
      readonly currency: string | null;
      readonly lastKnownBalance: {
        readonly amount: number;
        readonly currency: string | null;
        readonly date: string | null;
      } | null;
      readonly coveredRanges: ReadonlyArray<DayRange>;
      readonly rowCount: number;
      readonly earliestMovement: string | null;
      readonly latestMovement: string | null;
      readonly sync: SyncStatus;
      readonly job: JobStatus | null;
    };

export type SyncOutcome =
  /** `resume` found nothing pending, so no job runs. */
  | { readonly started: false }
  | {
      readonly started: true;
      /** A job for this token was already running and the request joined it. */
      readonly joined: boolean;
      readonly job: JobStatus;
    };

export interface TransactionsShape {
  /** Date-range movements from the cache or FIO, by `source`; a FIO answer is written through. */
  readonly transactions: (
    account: Account,
    range: DayRange,
    source: Source,
  ) => Effect.Effect<TransactionsResult, InvalidInput | CacheError | FioRequestError>;
  /** Stores movements from a FIO read that is not a date range (statement, last). Never fails. */
  readonly record: (account: Account, statement: NormalizedStatement) => Effect.Effect<void>;
  /** One page of cached movements. `dateFrom` defaults to the first cached day, `dateTo` to today. */
  readonly search: (account: Account, query: SearchQuery) => Effect.Effect<SearchResult, InvalidInput | CacheError>;
  /** Grouped totals of cached movements, with the same filters and defaults as `search`. */
  readonly summarize: (account: Account, query: SummaryQuery) => Effect.Effect<SummaryResult, InvalidInput | CacheError>;
  /** Each account's cache state, in order. Disabled: fails even for no accounts. */
  readonly status: (
    accounts: ReadonlyArray<Account>,
  ) => Effect.Effect<ReadonlyArray<AccountCacheStatus>, InvalidInput | CacheError>;
  /**
   * Starts or joins the token's sync job. With `waitMs`, waits up to that
   * long and returns the job's progress then; without, returns at once.
   */
  readonly sync: (account: Account, request: StartRequest, waitMs?: number) => Effect.Effect<SyncOutcome, InvalidInput>;
}

export const NOT_VERIFIED =
  "The cache is not verified for this token yet; run sync_transactions (or get_transactions with source=fio) first.";

export const CACHE_DISABLED = "The local transaction cache is disabled (FIO_CACHE_ENABLED=false).";

const iso = (millis: number | null) => (millis === null ? null : DateTime.formatIso(DateTime.makeUnsafe(millis)));

const jobStatus = (job: JobProgress): JobStatus => ({
  ...job,
  startedAt: iso(job.startedAt),
  finishedAt: iso(job.finishedAt),
});

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

const makeTransactions = Effect.fn("Transactions.make")(function* () {
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

  const freshness = Effect.fn("Transactions.freshness")(function* (
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

  const servable = Effect.fn("Transactions.servable")(function* (accountKey: string, range: DayRange) {
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

  const read = Effect.fn("Transactions.read")(function* (account: Account, range: DayRange) {
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

  const writeThrough = Effect.fn("Transactions.writeThrough")(function* (
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

  const record = Effect.fn("Transactions.record")(function* (account: Account, statement: NormalizedStatement) {
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

  const unlockMessage = historyUnlockMessage(config.rateLimitIntervalMs);

  const checkFilters = (filters: TransactionFilters) => {
    if (filters.dateFrom !== undefined && filters.dateTo !== undefined && filters.dateFrom > filters.dateTo) {
      return Effect.fail(new InvalidInput({ detail: "dateFrom must not be after dateTo." }));
    }
    if (filters.minAmount !== undefined && filters.maxAmount !== undefined && filters.minAmount > filters.maxAmount) {
      return Effect.fail(new InvalidInput({ detail: "minAmount must not be greater than maxAmount." }));
    }
    return Effect.void;
  };

  /** The first cached day: covered or holding a movement (statements are stored without coverage). */
  const earliestCached = Effect.fnUntraced(function* (accountKey: string, fallback: string) {
    const covered = yield* store.coveredRanges(accountKey);
    const { earliestMovement } = yield* store.stats(accountKey);
    const candidates = [covered[0]?.from, earliestMovement ?? undefined].filter((d): d is string => d !== undefined);
    return candidates.reduce(minDate, fallback);
  });

  /** The verified bank account key and the filters with their date range filled in. */
  const scope = Effect.fnUntraced(function* (account: Account, filters: TransactionFilters) {
    yield* checkFilters(filters);
    const accountKey = yield* boundAccount(account);
    const today = yield* pragueToday;
    const to = filters.dateTo ?? today;
    const from = filters.dateFrom ?? (yield* earliestCached(accountKey, to));
    if (from > to) {
      return yield* new InvalidInput({ detail: `dateFrom must not be after dateTo (default today, ${today}).` });
    }
    const range: DayRange = { from, to };
    return { accountKey, range, filters: { ...filters, dateFrom: from, dateTo: to } };
  });

  const search = Effect.fn("Transactions.search")(function* (account: Account, query: SearchQuery) {
    const { limit, offset, order, ...filters } = query;
    const scoped = yield* scope(account, filters);
    const found = yield* store.search(scoped.accountKey, scoped.filters, { limit, offset, order });
    return { ...found, freshness: yield* freshness(account, scoped.accountKey, scoped.range) } satisfies SearchResult;
  });

  const summarize = Effect.fn("Transactions.summarize")(function* (account: Account, query: SummaryQuery) {
    const { groupBy, limit, offset, ...filters } = query;
    const scoped = yield* scope(account, filters);
    const summary = yield* store.summarize(scoped.accountKey, scoped.filters, groupBy, { limit, offset });
    return { ...summary, freshness: yield* freshness(account, scoped.accountKey, scoped.range) } satisfies SummaryResult;
  });

  const accountStatus = Effect.fnUntraced(function* (account: Account) {
    const state = yield* store.syncState(account.tokenFingerprint);
    const binding = yield* store.binding(account.tokenFingerprint);
    const job = Option.getOrNull(Option.map(yield* sync.progress(account), jobStatus));
    const syncStatus: SyncStatus = {
      lastSuccessAt: iso(state.lastSuccessAt),
      lastAttemptAt: iso(state.lastAttemptAt),
      lastError: state.lastError,
      pending: state.pending,
      blocked: state.blocked,
      failedDays: state.failedDays,
      backfillTarget: state.backfillTarget,
      historyLimited: state.historyLimited,
      historyLimitedSince: iso(state.historyLimitedSince),
      ...(state.historyLimited ? { historyUnlock: unlockMessage } : {}),
    };
    if (Option.isNone(binding)) {
      return {
        name: account.name,
        verified: false,
        note: "Not verified for this token yet; run sync_transactions.",
        sync: syncStatus,
        job,
      } satisfies AccountCacheStatus;
    }
    const key = binding.value.accountKey;
    const cached = Option.getOrUndefined(yield* store.account(key));
    return {
      name: account.name,
      verified: true,
      verifiedAt: iso(binding.value.verifiedAt),
      bankAccount: cached === undefined ? key : `${cached.accountId}/${cached.bankId}`,
      iban: cached?.iban ?? null,
      currency: cached?.currency ?? null,
      lastKnownBalance:
        cached === undefined || cached.balance === null
          ? null
          : { amount: cached.balance, currency: cached.currency, date: cached.balanceDate },
      coveredRanges: yield* store.coveredRanges(key),
      ...(yield* store.stats(key)),
      sync: syncStatus,
      job,
    } satisfies AccountCacheStatus;
  });

  const status = Effect.fn("Transactions.status")(function* (accounts: ReadonlyArray<Account>) {
    return yield* Effect.forEach(accounts, (account) => accountStatus(account));
  });

  const startSync = Effect.fn("Transactions.sync")(function* (
    account: Account,
    request: StartRequest,
    waitMs?: number,
  ) {
    const started = yield* sync.start(account, request);
    if (Option.isNone(started)) return { started: false } satisfies SyncOutcome;
    const job =
      waitMs === undefined
        ? started.value.progress
        : Option.getOrElse(yield* sync.awaitJob(account, waitMs), () => started.value.progress);
    return { started: true, joined: started.value.joined, job: jobStatus(job) } satisfies SyncOutcome;
  });

  return {
    transactions: selectSource(fio, { boundAccount, servable, read, writeThrough }),
    record,
    search,
    summarize,
    status,
    sync: startSync,
  } satisfies TransactionsShape;
});

export class Transactions extends Context.Service<Transactions, TransactionsShape>()(
  "fio-mcp/Transactions",
) {
  /** The enabled cache on the SqlClient in context (tests provide an in-memory one). */
  static readonly Default = Layer.effect(Transactions, makeTransactions());

  /** FIO_CACHE_ENABLED=false: date-range reads go to FIO, nothing is stored, cache-only reads fail. */
  static readonly Disabled = Layer.effect(
    Transactions,
    Effect.gen(function* () {
      const live = fromFio(yield* FioApi, () => Effect.void);
      const disabled = Effect.fail(new InvalidInput({ detail: CACHE_DISABLED }));
      return {
        transactions: (account, range, source) => (source === "cache" ? disabled : live(account, range)),
        record: () => Effect.void,
        search: () => disabled,
        summarize: () => disabled,
        status: () => disabled,
        sync: () => disabled,
      } satisfies TransactionsShape;
    }),
  );

  /**
   * The cache from configuration: on the server's database (FIO_DB_PATH)
   * when enabled, otherwise `Disabled` without touching disk.
   */
  static readonly Live = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return config.cache.enabled
        ? Transactions.Default.pipe(Layer.provide(Database.Live))
        : Transactions.Disabled;
    }),
  ).pipe(Layer.provide(Layer.mergeAll(FioApi.Live, AppConfig.Live)));
}

/** One request per token (accounts may share a token); a failure is logged and the next token goes on. */
const syncAll = Effect.fn("CacheSync.syncAll")(function* (
  cache: TransactionsShape,
  accounts: ReadonlyArray<Account>,
  request: StartRequest,
) {
  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.tokenFingerprint)) continue;
    seen.add(account.tokenFingerprint);
    yield* cache
      .sync(account, request)
      .pipe(Effect.catch((error) => Effect.logWarning(`cache sync ${account.name}: ${error.message}`)));
  }
});

/**
 * Background sync: at startup (cache.syncOnStartup, or to resume an
 * interrupted job) and every cache.syncIntervalMinutes when that is above 0.
 * Forked into the layer's scope; MCP initialization never waits for it.
 */
export const CacheSyncLive: Layer.Layer<never, never, Transactions | Accounts | AppConfig> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    if (!config.cache.enabled) return;
    const cache = yield* Transactions;
    const accounts = yield* Accounts;
    yield* Effect.forkScoped(syncAll(cache, accounts.list, { kind: config.cache.syncOnStartup ? "startup" : "resume" }));
    const minutes = config.cache.syncIntervalMinutes;
    if (minutes > 0) {
      const periodic = syncAll(cache, accounts.list, { kind: "incremental" });
      yield* Effect.forkScoped(
        Effect.sleep(`${minutes} minutes`).pipe(Effect.andThen(Effect.repeat(periodic, Schedule.spaced(`${minutes} minutes`)))),
      );
    }
  }),
);
