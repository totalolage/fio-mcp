import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import { Accounts } from "../accounts.js";
import { pragueToday } from "../cache/dates.js";
import {
  type GroupBy,
  historyUnlockMessage,
  type SyncRequest,
  type TransactionFilters,
  Transactions,
} from "../cache/service.js";
import { AppConfig } from "../config.js";
import { InvalidInput } from "../errors.js";
import { Redactor } from "../redaction.js";
import { annotateTool, DateParam, JsonObject, ToolFailure, withAccount } from "./common.js";
import { permittedAccount, READ, requireScopes, visibleAccounts } from "./permissions.js";

/**
 * Tools answered from the local cache only. They never call FIO, so they
 * have no rate limit. Data reaches the cache through sync_transactions, the
 * background sync, and get_transactions.
 */

export const CACHE_INSTRUCTIONS =
  "A local cache mirrors the account history. search_transactions, summarize_transactions and get_cache_status answer from it instantly without calling FIO; prefer them for questions about past movements. Each cached answer carries `freshness` (covered ranges, last sync, whether the range is complete). Call sync_transactions to fetch new movements.";

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

const Text = (what: string) => Schema.String.check(Schema.isMinLength(1)).annotate({ description: what });
const Amount = (what: string) =>
  Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: what });
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT }));
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const filterFields = {
  dateFrom: Schema.optionalKey(DateParam("First day (YYYY-MM-DD). Default: the first cached day.")),
  dateTo: Schema.optionalKey(DateParam("Last day (YYYY-MM-DD). Default: today.")),
  minAmount: Schema.optionalKey(Amount("Smallest absolute amount (combine with direction).")),
  maxAmount: Schema.optionalKey(Amount("Largest absolute amount (combine with direction).")),
  direction: Schema.optionalKey(
    Schema.Literals(["in", "out"]).annotate({ description: "in = incoming (amount > 0), out = outgoing (amount < 0)." }),
  ),
  counterparty: Schema.optionalKey(Text("Substring of the counterparty name or account number (case-insensitive).")),
  text: Schema.optionalKey(Text("Substring of the message, comment, or user identification (case-insensitive).")),
  variableSymbol: Schema.optionalKey(Text("Variable symbol, exact.")),
  constantSymbol: Schema.optionalKey(Text("Constant symbol, exact.")),
  specificSymbol: Schema.optionalKey(Text("Specific symbol, exact.")),
  type: Schema.optionalKey(Text('Movement type, exact (as FIO names it, e.g. "Platba kartou").')),
  currency: Schema.optionalKey(Text("Currency (ISO 4217), exact.")),
};

const tool = <const Name extends string, P extends Schema.Struct<Schema.Struct.Fields>>(
  name: Name,
  description: string,
  parameters: P,
) => Tool.make(name, { description, parameters, success: JsonObject, failure: ToolFailure, failureMode: "error" });

const CACHE_ONLY = { readOnly: true, openWorld: false, idempotent: true } as const;

export function makeCacheToolkit(accountNames: ReadonlyArray<string>) {
  const params = <F extends Schema.Struct.Fields>(fields: F) => withAccount(fields, accountNames);

  const SearchTransactions = annotateTool(
    tool(
      "search_transactions",
      "Search cached movements without calling FIO. Filters combine with AND. minAmount/maxAmount compare the absolute amount; use direction for the sign. Returns `transactions` (one page), `total` (all matches) and `freshness` for the date range searched.",
      params({
        ...filterFields,
        limit: Schema.optionalKey(Limit.annotate({ description: `Page size, default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.` })),
        offset: Schema.optionalKey(Offset.annotate({ description: "Matches to skip, default 0." })),
        order: Schema.optionalKey(Schema.Literals(["asc", "desc"]).annotate({ description: "By date; default desc." })),
      }),
    ),
    { title: "Search cached transactions", ...CACHE_ONLY },
  );

  const SummarizeTransactions = annotateTool(
    tool(
      "summarize_transactions",
      "Totals of cached movements without calling FIO, grouped by month, counterparty, or type and always split by currency: count, income, expense (positive), net. Same filters as search_transactions. Also returns per-currency totals and `freshness`.",
      params({
        ...filterFields,
        groupBy: Schema.Literals(["month", "counterparty", "type"]),
        limit: Schema.optionalKey(Limit.annotate({ description: `Groups per page, default ${DEFAULT_LIMIT}.` })),
        offset: Schema.optionalKey(Offset.annotate({ description: "Groups to skip, default 0." })),
      }),
    ),
    { title: "Summarize cached transactions", ...CACHE_ONLY },
  );

  const GetCacheStatus = annotateTool(
    Tool.make("get_cache_status", {
      description:
        "Per account: whether the cache is verified for its token, covered date ranges, row counts, last known balance, last sync, the running sync job, and whether older history is blocked (with the steps to unlock it). No FIO call.",
      parameters: Tool.EmptyParams,
      success: JsonObject,
      failure: ToolFailure,
      failureMode: "error",
    }),
    { title: "Cache status", ...CACHE_ONLY },
  );

  const SyncTransactions = annotateTool(
    tool(
      "sync_transactions",
      "Fetch movements from FIO into the cache in the background (date-range downloads only; the download marker is never moved). mode=incremental (default) re-fetches the recent days; mode=backfill fetches all missing history from `from` (default: the configured backfill start) and retries history FIO refused earlier, skipping days already cached. `refresh` (instead of mode/from) re-downloads the given days even if cached, updates changed movements and deletes the ones FIO no longer lists; days older than 90 days need a history unlock first. FIO allows one request per 30 s, so a long backfill takes minutes; this call waits briefly and returns the job status. Joins the job already running for this account.",
      params({
        mode: Schema.optionalKey(Schema.Literals(["incremental", "backfill"])),
        from: Schema.optionalKey(DateParam("For mode=backfill: first day to fetch (YYYY-MM-DD).")),
        refresh: Schema.optionalKey(
          Schema.Struct({
            from: DateParam("First day to re-download (YYYY-MM-DD)."),
            to: DateParam("Last day to re-download (YYYY-MM-DD); days after today are ignored."),
          }).annotate({ description: "Re-download these days even if they are cached. Not combinable with mode or from." }),
        ),
      }),
    ),
    { title: "Sync transactions into the cache", readOnly: false, idempotent: true, openWorld: true },
  );

  return Toolkit.make(SearchTransactions, SummarizeTransactions, GetCacheStatus, SyncTransactions);
}

export type CacheToolkit = ReturnType<typeof makeCacheToolkit>;

type FilterArgs = { readonly [K in keyof typeof filterFields]?: (typeof filterFields)[K]["Type"] | undefined };

const toFilters = (args: FilterArgs): TransactionFilters => ({
  dateFrom: args.dateFrom,
  dateTo: args.dateTo,
  minAmount: args.minAmount,
  maxAmount: args.maxAmount,
  direction: args.direction,
  counterparty: args.counterparty,
  text: args.text,
  variableSymbol: args.variableSymbol,
  constantSymbol: args.constantSymbol,
  specificSymbol: args.specificSymbol,
  type: args.type,
  currency: args.currency,
});

export const makeCacheHandlers = Effect.fn("CacheTools.handlers")(function* (toolkit: CacheToolkit) {
  const accounts = yield* Accounts;
  const cache = yield* Transactions;
  const redactor = yield* Redactor;
  const config = yield* AppConfig;
  const unlockMessage = historyUnlockMessage(config.rateLimitIntervalMs);
  const out = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.map(effect, redactor.redactDeep);

  return toolkit.of({
    search_transactions: (args) =>
      out(
        Effect.gen(function* () {
          const account = yield* permittedAccount(accounts, args.account);
          const page = { limit: args.limit ?? DEFAULT_LIMIT, offset: args.offset ?? 0, order: args.order ?? "desc" };
          const found = yield* cache.search(account, { ...toFilters(args), ...page });
          return {
            account: account.name,
            source: "cache",
            total: found.total,
            offset: page.offset,
            limit: page.limit,
            returned: found.transactions.length,
            transactions: found.transactions,
            freshness: found.freshness,
          };
        }),
      ),

    summarize_transactions: (args) =>
      out(
        Effect.gen(function* () {
          const account = yield* permittedAccount(accounts, args.account);
          const groupBy: GroupBy = args.groupBy;
          const page = { limit: args.limit ?? DEFAULT_LIMIT, offset: args.offset ?? 0 };
          const summary = yield* cache.summarize(account, { ...toFilters(args), groupBy, ...page });
          return { account: account.name, source: "cache", groupBy, ...summary };
        }),
      ),

    get_cache_status: () =>
      out(
        Effect.gen(function* () {
          yield* requireScopes(READ);
          const statuses = yield* cache.status(yield* visibleAccounts(accounts.list));
          return {
            dbPath: config.cache.dbPath,
            settings: {
              syncOnStartup: config.cache.syncOnStartup,
              syncIntervalMinutes: config.cache.syncIntervalMinutes,
              backfillFrom: config.cache.backfillFrom,
              overlapDays: config.cache.overlapDays,
              maxAgeMinutes: config.cache.maxAgeMinutes,
            },
            accounts: statuses,
          };
        }),
      ),

    sync_transactions: ({ account: name, mode, from, refresh }) =>
      out(
        Effect.gen(function* () {
          const account = yield* permittedAccount(accounts, name);
          if (from !== undefined && mode !== "backfill") {
            return yield* new InvalidInput({ detail: "`from` applies to mode=backfill only." });
          }
          const today = yield* pragueToday;
          if (from !== undefined && from > today) return yield* new InvalidInput({ detail: "`from` is in the future." });
          let request: SyncRequest = mode === "backfill" ? { kind: "backfill", from, retryFailed: true } : { kind: "incremental" };
          if (refresh !== undefined) {
            if (mode !== undefined || from !== undefined) {
              return yield* new InvalidInput({ detail: "`refresh` cannot be combined with `mode` or `from`." });
            }
            if (refresh.from > refresh.to) {
              return yield* new InvalidInput({ detail: "`refresh.from` must not be after `refresh.to`." });
            }
            if (refresh.from > today) return yield* new InvalidInput({ detail: "`refresh.from` is in the future." });
            request = { kind: "refresh", range: { from: refresh.from, to: refresh.to } };
          }
          const outcome = yield* cache.sync(account, request, config.maxWaitMs);
          // Only a resume can start nothing, and this tool never resumes.
          if (!outcome.started) return yield* Effect.die("sync_transactions started no job");
          const { joined, job } = outcome;
          const note =
            job.status === "running"
              ? "The sync continues in the background (one FIO request per 30 s). Call get_cache_status to follow it."
              : `The sync ${job.status}.`;
          return {
            account: account.name,
            joinedRunningJob: joined,
            // A joined job never takes on a refresh range, even when it is a refresh itself.
            ...(joined && (refresh !== undefined || (mode !== undefined && job.kind !== mode))
              ? {
                  warning: `A ${job.kind} job was already running; it was joined instead of starting ${refresh === undefined ? mode : `a refresh of ${refresh.from}..${refresh.to}`}. Call sync_transactions again when it has finished.`,
                }
              : {}),
            job,
            note,
            ...(job.historyLimited ? { historyUnlock: unlockMessage } : {}),
          };
        }),
      ),
  });
});

/** Registers the cache toolkit with the MCP server. */
export const CacheToolsLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const toolkit = makeCacheToolkit(config.accounts.map((a) => a.name));
    return McpServer.toolkit(toolkit).pipe(Layer.provide(toolkit.toLayer(makeCacheHandlers(toolkit))));
  }),
);
