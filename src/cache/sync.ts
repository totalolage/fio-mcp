import { type Cause, Clock, Deferred, Duration, Effect, Option, Ref, Result, Schedule, SynchronizedRef } from "effect";
import type { Account } from "../accounts.js";
import type { AppConfigShape } from "../config.js";
import { type CacheError, type FioRequestError, HISTORY_UNLOCK_STEPS } from "../errors.js";
import type { FioApiShape } from "../fio-api.js";
import {
  addDays,
  type DayRange,
  intersect,
  maxDate,
  normalizeRanges,
  pragueToday,
  rangeLength,
  splitNewestFirst,
  subtractDays,
} from "./dates.js";
import type { CacheStore, SyncState } from "./store.js";

/**
 * Background sync of FIO movements into the cache, one job per token at a
 * time. Only `/periods` date ranges are fetched (never the `last` marker,
 * which other programs using the token rely on), at background priority, so
 * interactive tool calls always go first.
 *
 * Backfill fetches every uncovered day from the target date to today, the
 * whole span in one request when FIO allows. HTTP 413 (over 50,000
 * movements) splits a range in halves, newest first; a single day that is
 * still too large is recorded as failed and skipped. HTTP 422 (history older
 * than 90 days is locked) moves the older parts to `blocked` and continues
 * with the last 90 days. Ranges older than 90 days go first, so a fresh
 * history unlock is spent on them. Pending ranges are saved after every
 * request, so a restarted server resumes.
 *
 * Incremental sync re-fetches [newest covered day − overlapDays, today],
 * which picks up late bookings and edits.
 */

/** FIO serves this many most recent days without a history unlock. */
export const UNLOCKED_HISTORY_DAYS = 90;
/** Length of one Internetbanking history unlock. */
const UNLOCK_SECONDS = 600;
const MAX_RETRIES = 5;

export type SyncRequest =
  | {
      readonly kind: "backfill";
      readonly from?: string | undefined;
      /** Also retry single days that earlier exceeded 50,000 movements. */
      readonly retryFailed?: boolean | undefined;
    }
  | { readonly kind: "incremental" }
  /** Startup: backfill whatever is missing (blocked history first), then incremental. */
  | { readonly kind: "startup" };

export interface JobProgress {
  readonly account: string;
  readonly kind: SyncRequest["kind"];
  readonly status: "running" | "completed" | "failed";
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly requests: number;
  readonly rangesDone: number;
  readonly rowsWritten: number;
  readonly current: DayRange | null;
  readonly pending: ReadonlyArray<DayRange>;
  readonly blocked: ReadonlyArray<DayRange>;
  readonly failedDays: ReadonlyArray<string>;
  readonly historyLimited: boolean;
  readonly lastError: string | null;
}

export interface StartResult {
  readonly progress: JobProgress;
  /** True when a job for this token was already running and the request joined it. */
  readonly joined: boolean;
}

export interface CacheSyncShape {
  /** Starts a job for the account's token, or returns the one already running. */
  readonly start: (account: Account, request: SyncRequest) => Effect.Effect<StartResult>;
  /** Waits up to `timeoutMs` for the token's current job; its progress either way. */
  readonly awaitJob: (account: Account, timeoutMs: number) => Effect.Effect<Option.Option<JobProgress>>;
  /** The running or most recent job of the account's token in this process. */
  readonly progress: (account: Account) => Effect.Effect<Option.Option<JobProgress>>;
}

/** What to tell the owner when older history is blocked. */
export function historyUnlockMessage(rateLimitIntervalMs: number): string {
  const seconds = Math.round(rateLimitIntervalMs / 1000);
  return `${HISTORY_UNLOCK_STEPS} Then call sync_transactions with mode=backfill within 10 minutes; each request takes ${seconds} s, so about ${Math.floor(UNLOCK_SECONDS / seconds)} chunks fit in one unlock.`;
}

/** Older-than-90-days ranges first (they need an unlock), each group newest first. */
export function fetchOrder(ranges: ReadonlyArray<DayRange>, recentStart: string): ReadonlyArray<DayRange> {
  return [...ranges].sort((a, b) => {
    const aOld = a.from < recentStart;
    const bOld = b.from < recentStart;
    if (aOld !== bOld) return aOld ? -1 : 1;
    if (a.to === b.to) return 0;
    return a.to > b.to ? -1 : 1;
  });
}

/** `ranges` minus every day of `remove`. */
function subtractRange(ranges: ReadonlyArray<DayRange>, remove: DayRange): ReadonlyArray<DayRange> {
  return ranges.flatMap((range) => {
    const parts: Array<DayRange> = [];
    if (range.from < remove.from) parts.push({ from: range.from, to: minDay(range.to, addDays(remove.from, -1)) });
    if (range.to > remove.to) parts.push({ from: maxDate(range.from, addDays(remove.to, 1)), to: range.to });
    return parts;
  });
}

const minDay = (a: string, b: string) => (a < b ? a : b);

function withoutPending(ranges: ReadonlyArray<DayRange>, pending: ReadonlyArray<DayRange>): ReadonlyArray<DayRange> {
  return pending.reduce((parts, p) => subtractRange(parts, p), ranges);
}

interface RunningJob {
  readonly account: Account;
  readonly progress: Ref.Ref<JobProgress>;
  readonly done: Deferred.Deferred<JobProgress>;
}

export const makeCacheSync = Effect.fn("CacheSync.make")(function* (
  store: CacheStore,
  fio: FioApiShape,
  config: AppConfigShape,
) {
  const scope = yield* Effect.scope;
  const jobs = yield* SynchronizedRef.make(new Map<string, RunningJob>());
  const { overlapDays } = config.cache;
  const unlockMessage = historyUnlockMessage(config.rateLimitIntervalMs);

  const fetchRange = (account: Account, range: DayRange) =>
    fio.periods(account, range.from, range.to, "background").pipe(
      // Background calls wait without a budget; RateLimited here means FIO
      // kept answering 409 (another program uses the token). Wait and retry.
      Effect.retry({
        while: (error: FioRequestError) => error._tag === "RateLimited" || error._tag === "FioTransportError",
        times: MAX_RETRIES,
        schedule: Schedule.spaced(Duration.millis(config.rateLimitIntervalMs)),
      }),
      Effect.result,
    );

  const runJob = Effect.fn("CacheSync.job")(function* (account: Account, request: SyncRequest, progress: Ref.Ref<JobProgress>) {
    const fp = account.tokenFingerprint;
    const startedAt = yield* Clock.currentTimeMillis;
    const today = yield* pragueToday;
    const recentStart = addDays(today, -(UNLOCKED_HISTORY_DAYS - 1));
    const recent: DayRange = { from: recentStart, to: today };
    const older: DayRange = { from: "0000-01-01", to: addDays(recentStart, -1) };
    let state: SyncState = yield* store.syncState(fp);
    let accountKey: string | undefined =
      state.accountKey ?? Option.getOrUndefined(Option.map(yield* store.binding(fp), (b) => b.accountKey));

    const report = (patch: Partial<JobProgress>) =>
      Ref.update(progress, (p) => ({
        ...p,
        pending: state.pending,
        blocked: state.blocked,
        failedDays: state.failedDays,
        historyLimited: state.historyLimited,
        lastError: state.lastError,
        ...patch,
      }));

    const save = Effect.fnUntraced(function* (next: SyncState) {
      const historyLimited = next.blocked.length > 0;
      state = {
        ...next,
        historyLimited,
        historyLimitedSince: historyLimited ? (next.historyLimitedSince ?? (yield* Clock.currentTimeMillis)) : null,
      };
      yield* store.putSyncState(fp, state);
      yield* report({});
    });

    /** Fetches `queue` front to back. Returns false when an unexpected error stopped it. */
    const drain = Effect.fnUntraced(function* (initial: ReadonlyArray<DayRange>, mode: SyncState["mode"]) {
      let queue = initial;
      yield* save({ ...state, pending: queue, mode, lastError: state.blocked.length > 0 ? unlockMessage : null });
      while (queue.length > 0) {
        const [range, ...rest] = queue;
        if (range === undefined) break;
        yield* report({ current: range });
        const outcome = yield* fetchRange(account, range);
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.update(progress, (p) => ({ ...p, requests: p.requests + 1 }));
        if (Result.isSuccess(outcome)) {
          const statement = outcome.success;
          const blocked = subtractRange(state.blocked, range);
          const next: SyncState = {
            ...state,
            pending: rest,
            mode: rest.length > 0 ? mode : null,
            blocked,
            lastAttemptAt: now,
            lastSuccessAt: now,
            // While older history stays blocked, the unlock steps remain the open problem.
            lastError: blocked.length > 0 ? unlockMessage : null,
            rowsWritten: state.rowsWritten + statement.transactionCount,
          };
          const committed = yield* Effect.result(
            store.commit({
              accountName: account.name,
              tokenFingerprint: fp,
              statement,
              coverage: range,
              fetchedAt: now,
              syncState: { ...next, historyLimited: next.blocked.length > 0 },
            }),
          );
          if (Result.isFailure(committed)) {
            yield* save({ ...state, lastAttemptAt: now, lastError: committed.failure.message });
            return false;
          }
          accountKey = committed.success.accountKey;
          state = { ...next, accountKey };
          yield* save(state);
          yield* Ref.update(progress, (p) => ({
            ...p,
            rangesDone: p.rangesDone + 1,
            rowsWritten: p.rowsWritten + committed.success.rowsWritten,
          }));
          yield* Effect.logInfo(
            `cache sync ${account.name}: ${range.from}..${range.to} stored ${committed.success.rowsWritten} movements`,
          );
          queue = rest;
          continue;
        }
        const error = outcome.failure;
        if (error._tag === "TooManyItems") {
          if (rangeLength(range) === 1) {
            yield* Effect.logWarning(`cache sync ${account.name}: ${range.from} has over 50,000 movements; skipped`);
            queue = rest;
            yield* save({ ...state, pending: queue, failedDays: [...state.failedDays, range.from], lastAttemptAt: now });
          } else {
            queue = [...splitNewestFirst(range), ...rest];
            yield* save({ ...state, pending: queue, lastAttemptAt: now });
          }
          continue;
        }
        if (error._tag === "HistoryAuthorizationRequired") {
          yield* Effect.logWarning(`cache sync ${account.name}: history before ${recentStart} is locked (HTTP 422)`);
          let blocked: ReadonlyArray<DayRange>;
          if (range.from >= recentStart) {
            // FIO refused even the recent window; do not loop on it.
            blocked = normalizeRanges([...state.blocked, range]);
            queue = rest;
          } else {
            const all = [range, ...rest];
            blocked = normalizeRanges([
              ...state.blocked,
              ...all.flatMap((r) => Option.toArray(Option.fromUndefinedOr(intersect(r, older)))),
            ]);
            queue = fetchOrder(
              all.flatMap((r) => Option.toArray(Option.fromUndefinedOr(intersect(r, recent)))),
              recentStart,
            );
          }
          yield* save({ ...state, pending: queue, blocked, lastAttemptAt: now, lastError: unlockMessage });
          continue;
        }
        yield* Effect.logWarning(`cache sync ${account.name}: stopped: ${error.message}`);
        yield* save({ ...state, pending: queue, lastAttemptAt: now, lastError: error.message });
        return false;
      }
      return true;
    });

    const backfillPlan = Effect.fnUntraced(function* (target: string) {
      const span: DayRange = { from: target, to: today };
      const skip = new Set(state.failedDays);
      if (accountKey !== undefined) for (const day of yield* store.coveredDaySet(accountKey, span)) skip.add(day);
      const wanted = normalizeRanges([...state.blocked, ...subtractDays(span, skip)]);
      // Pending ranges stay as they are, so a resumed 413 split stays split.
      return fetchOrder([...state.pending, ...withoutPending(wanted, state.pending)], recentStart);
    });

    const backfill = Effect.fnUntraced(function* (from: string | undefined, retryFailed = false) {
      if (retryFailed) state = { ...state, failedDays: [] };
      const configured = config.cache.backfillFrom;
      const target = from ?? (state.backfillTarget !== null && state.backfillTarget < configured ? state.backfillTarget : configured);
      state = { ...state, backfillTarget: target };
      return yield* drain(yield* backfillPlan(target), "backfill");
    });

    const incremental = Effect.fnUntraced(function* (skipIfFetchedSince: number | undefined) {
      const covered = accountKey === undefined ? [] : yield* store.coveredRanges(accountKey);
      const first = covered[0];
      const last = covered.at(-1);
      if (accountKey === undefined || first === undefined || last === undefined) return yield* backfill(undefined);
      const window: DayRange = { from: maxDate(first.from, addDays(last.to, -overlapDays)), to: today };
      if (skipIfFetchedSince !== undefined) {
        const days = yield* store.coverageIn(accountKey, window);
        if (days.length === rangeLength(window) && days.every((d) => d.fetchedAt >= skipIfFetchedSince)) return true;
      }
      return yield* drain(fetchOrder([...state.pending, ...withoutPending([window], state.pending)], recentStart), "incremental");
    });

    let ok: boolean;
    switch (request.kind) {
      case "backfill":
        ok = yield* backfill(request.from, request.retryFailed);
        break;
      case "incremental":
        ok = yield* incremental(undefined);
        break;
      case "startup":
        ok = (yield* backfill(undefined)) && (yield* incremental(startedAt));
        break;
    }
    const finishedAt = yield* Clock.currentTimeMillis;
    yield* report({ status: ok ? "completed" : "failed", finishedAt, current: null });
    return yield* Ref.get(progress);
  });

  const initialProgress = (account: Account, request: SyncRequest, startedAt: number): JobProgress => ({
    account: account.name,
    kind: request.kind,
    status: "running",
    startedAt,
    finishedAt: null,
    requests: 0,
    rangesDone: 0,
    rowsWritten: 0,
    current: null,
    pending: [],
    blocked: [],
    failedDays: [],
    historyLimited: false,
    lastError: null,
  });

  const finishFailed = Effect.fnUntraced(function* (account: Account, job: RunningJob, cause: Cause.Cause<CacheError>) {
    yield* Effect.logError(`cache sync ${account.name}: failed`, cause);
    const finishedAt = yield* Clock.currentTimeMillis;
    yield* Ref.update(job.progress, (p) => ({
      ...p,
      status: "failed" as const,
      finishedAt,
      current: null,
      lastError: "The sync job failed unexpectedly; see the server log.",
    }));
    return yield* Ref.get(job.progress);
  });

  const launch = Effect.fnUntraced(function* (
    map: Map<string, RunningJob>,
    account: Account,
    request: SyncRequest,
  ): Effect.fn.Return<readonly [StartResult, Map<string, RunningJob>]> {
    const existing = map.get(account.tokenFingerprint);
    if (existing !== undefined) {
      const current = yield* Ref.get(existing.progress);
      if (current.status === "running") return [{ progress: current, joined: true } satisfies StartResult, map] as const;
    }
    const startedAt = yield* Clock.currentTimeMillis;
    const job: RunningJob = {
      account,
      progress: yield* Ref.make(initialProgress(account, request, startedAt)),
      done: yield* Deferred.make<JobProgress>(),
    };
    yield* Effect.logInfo(`cache sync ${account.name}: ${request.kind} started`);
    const body = runJob(account, request, job.progress).pipe(
      Effect.catchCause((cause) => finishFailed(account, job, cause)),
      Effect.tap((final) =>
        Effect.logInfo(
          `cache sync ${account.name}: ${request.kind} ${final.status} (${final.requests} requests, ${final.rowsWritten} movements)`,
        ),
      ),
      Effect.flatMap((final) => Deferred.succeed(job.done, final)),
    );
    yield* Effect.forkIn(body, scope);
    const progress = yield* Ref.get(job.progress);
    return [{ progress, joined: false } satisfies StartResult, new Map(map).set(account.tokenFingerprint, job)] as const;
  });

  const start = (account: Account, request: SyncRequest) =>
    SynchronizedRef.modifyEffect(jobs, (map) => launch(map, account, request));

  const progress = (account: Account) =>
    Effect.flatMap(SynchronizedRef.get(jobs), (map) => {
      const job = map.get(account.tokenFingerprint);
      return job === undefined ? Effect.succeed(Option.none<JobProgress>()) : Effect.asSome(Ref.get(job.progress));
    });

  const awaitJob = (account: Account, timeoutMs: number) =>
    Effect.flatMap(SynchronizedRef.get(jobs), (map) => {
      const job = map.get(account.tokenFingerprint);
      if (job === undefined) return Effect.succeed(Option.none<JobProgress>());
      return Deferred.await(job.done).pipe(
        Effect.timeoutOption(Duration.millis(timeoutMs)),
        Effect.andThen(Ref.get(job.progress)),
        Effect.asSome,
      );
    });

  return { start, awaitJob, progress } satisfies CacheSyncShape;
});
