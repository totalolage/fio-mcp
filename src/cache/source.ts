import { DateTime, Effect, Option } from "effect";
import type { Account } from "../accounts.js";
import type { CacheError, FioRequestError, InvalidInput } from "../errors.js";
import type { FioApiShape } from "../fio-api.js";
import type { NormalizedStatement, StatementInfo } from "../statement.js";
import { type DayRange, minDate, pragueToday } from "./dates.js";
import type { CachedStatement, Freshness } from "./service.js";
import { coveredBy } from "./store.js";

/*
 * Where a date-range read comes from: the cache or FIO. Private to the
 * Transactions module, which exposes the choice as `transactions`.
 */

/** auto: the cache when every day is servable, else FIO; cache: the cache only; fio: always FIO. */
export type Source = "auto" | "cache" | "fio";

export type TransactionsResult =
  | ({ readonly source: "cache" } & CachedStatement)
  | ({ readonly source: "fio" } & NormalizedStatement & { readonly freshness: Freshness });

/** What source selection needs from the enabled cache. */
export interface CacheReadPath {
  readonly boundAccount: (account: Account) => Effect.Effect<string, InvalidInput | CacheError>;
  readonly servable: (accountKey: string, range: DayRange) => Effect.Effect<boolean, CacheError>;
  readonly read: (account: Account, range: DayRange) => Effect.Effect<CachedStatement, InvalidInput | CacheError>;
  readonly writeThrough: (account: Account, statement: NormalizedStatement, range: DayRange) => Effect.Effect<void>;
}

/** Freshness of a FIO answer: the requested days up to today that its header covers. */
const liveFreshness = Effect.fnUntraced(function* (range: DayRange, info: StatementInfo) {
  const now = DateTime.formatIso(yield* DateTime.now);
  const effective: DayRange = { from: range.from, to: minDate(range.to, yield* pragueToday) };
  if (effective.from > effective.to) {
    // Only future days: nothing can be booked yet.
    return {
      lastSyncAt: now,
      coveredFrom: null,
      coveredTo: null,
      coveredRanges: [],
      oldestFetchAt: now,
      historyLimited: false,
      complete: true,
    } satisfies Freshness;
  }
  const covered = coveredBy(effective, info);
  return {
    lastSyncAt: now,
    coveredFrom: covered?.from ?? null,
    coveredTo: covered?.to ?? null,
    coveredRanges: covered === undefined ? [] : [covered],
    oldestFetchAt: now,
    historyLimited: false,
    complete: covered !== undefined && covered.from === effective.from && covered.to === effective.to,
  } satisfies Freshness;
});

/** Asks FIO for the range and hands the answer to `remember`. */
export const fromFio = (
  fio: FioApiShape,
  remember: (account: Account, statement: NormalizedStatement, range: DayRange) => Effect.Effect<void>,
) =>
  Effect.fnUntraced(function* (account: Account, range: DayRange) {
    const statement = yield* fio.periods(account, range.from, range.to);
    yield* remember(account, statement, range);
    return { source: "fio", ...statement, freshness: yield* liveFreshness(range, statement.info) } satisfies TransactionsResult;
  });

/** Source selection over the enabled cache; a FIO answer is written through. */
export const selectSource = (fio: FioApiShape, cache: CacheReadPath) => {
  const live = fromFio(fio, cache.writeThrough);

  /** Whether auto may answer from the cache; cache trouble means "ask FIO". */
  const canServe = Effect.fnUntraced(function* (account: Account, range: DayRange) {
    const accountKey = yield* Effect.option(cache.boundAccount(account));
    if (Option.isNone(accountKey)) return false;
    return yield* cache.servable(accountKey.value, range).pipe(Effect.orElseSucceed(() => false));
  });

  return Effect.fn("Transactions.transactions")(function* (
    account: Account,
    range: DayRange,
    source: Source,
  ): Effect.fn.Return<TransactionsResult, InvalidInput | CacheError | FioRequestError> {
    if (source === "cache") return { source: "cache", ...(yield* cache.read(account, range)) };
    if (source === "auto" && (yield* canServe(account, range))) {
      const cached = yield* Effect.option(cache.read(account, range));
      if (Option.isSome(cached)) return { source: "cache", ...cached.value };
    }
    return yield* live(account, range);
  });
};
