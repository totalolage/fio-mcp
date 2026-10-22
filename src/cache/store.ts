import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { type CacheError, FioResponseError } from "../errors.js";
import type { NormalizedStatement, StatementInfo, Transaction } from "../statement.js";
import { type DayRange, eachDay, intersect } from "./dates.js";
import { cacheFailure } from "./db.js";

/**
 * SQL access for the transaction cache. Cached rows belong to a bank account
 * (`accountId/bankId` from the statement header), never to a configured
 * account name; a token fingerprint reaches them only through a binding that
 * a FIO response verified. Every SqlError becomes a CacheError (cause logged).
 */

export type SyncMode = "backfill" | "incremental";

export interface SyncState {
  readonly accountKey: string | null;
  /** The interrupted job's mode while `pending` is non-empty. */
  readonly mode: SyncMode | null;
  /** Ranges still to fetch, in fetch order. */
  readonly pending: ReadonlyArray<DayRange>;
  /** Ranges FIO refused with HTTP 422 (history older than 90 days is locked). */
  readonly blocked: ReadonlyArray<DayRange>;
  /** Single days that still exceeded 50,000 movements. */
  readonly failedDays: ReadonlyArray<string>;
  readonly historyLimited: boolean;
  readonly historyLimitedSince: number | null;
  readonly backfillTarget: string | null;
  readonly lastSuccessAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly lastError: string | null;
  /** Rows written by the latest job. */
  readonly rowsWritten: number;
}

export const emptySyncState: SyncState = {
  accountKey: null,
  mode: null,
  pending: [],
  blocked: [],
  failedDays: [],
  historyLimited: false,
  historyLimitedSince: null,
  backfillTarget: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastError: null,
  rowsWritten: 0,
};

export interface Binding {
  readonly accountKey: string;
  readonly accountName: string;
  readonly verifiedAt: number;
}

export interface CachedAccount {
  readonly accountKey: string;
  readonly accountId: string;
  readonly bankId: string;
  readonly iban: string | null;
  readonly bic: string | null;
  readonly currency: string | null;
  readonly balance: number | null;
  readonly balanceDate: string | null;
}

export interface CoverageDay {
  readonly day: string;
  readonly fetchedAt: number;
}

export interface TransactionFilters {
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
  /** Compared with the absolute amount. */
  readonly minAmount?: number | undefined;
  readonly maxAmount?: number | undefined;
  readonly direction?: "in" | "out" | undefined;
  /** Case-insensitive (ASCII) substring of the counterparty name or account. */
  readonly counterparty?: string | undefined;
  /** Case-insensitive (ASCII) substring of the message, comment, or user identification. */
  readonly text?: string | undefined;
  readonly variableSymbol?: string | undefined;
  readonly constantSymbol?: string | undefined;
  readonly specificSymbol?: string | undefined;
  readonly type?: string | undefined;
  readonly currency?: string | undefined;
}

export type GroupBy = "month" | "counterparty" | "type";

export interface SummaryGroup {
  readonly key: string;
  readonly currency: string;
  readonly count: number;
  readonly income: number;
  readonly expense: number;
  readonly net: number;
}

export interface CommitInput {
  readonly accountName: string;
  readonly tokenFingerprint: string;
  readonly statement: NormalizedStatement;
  /**
   * The requested /periods range. The days in it (narrowed to the period
   * FIO's header reports, when present) are recorded as covered. Omit for
   * responses that are not a full date range.
   */
  readonly coverage?: DayRange | undefined;
  readonly fetchedAt: number;
  /** Sync state to persist in the same transaction. */
  readonly syncState?: SyncState | undefined;
}

export interface CommitResult {
  readonly accountKey: string;
  readonly rowsWritten: number;
  /** The days recorded as covered. */
  readonly coverage: DayRange | undefined;
}

const ROW_BATCH = 200;
const DAY_BATCH = 1000;

const TRANSACTION_COLUMNS = [
  "date",
  "amount",
  "currency",
  "counterparty_account",
  "counterparty_bank_code",
  "counterparty_bank_name",
  "counterparty_name",
  "counterparty_bic",
  "constant_symbol",
  "variable_symbol",
  "specific_symbol",
  "user_identification",
  "message",
  "type",
  "executed_by",
  "details",
  "comment",
  "instruction_id",
  "payer_reference",
  "raw_json",
  "updated_at",
] as const;

const UPSERT_TRANSACTION = `ON CONFLICT (account_key, movement_id) DO UPDATE SET ${TRANSACTION_COLUMNS.map(
  (c) => `${c} = excluded.${c}`,
).join(", ")}`;

interface TransactionRow {
  readonly movement_id: number;
  readonly date: string;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly counterparty_account: string | null;
  readonly counterparty_bank_code: string | null;
  readonly counterparty_bank_name: string | null;
  readonly counterparty_name: string | null;
  readonly counterparty_bic: string | null;
  readonly constant_symbol: string | null;
  readonly variable_symbol: string | null;
  readonly specific_symbol: string | null;
  readonly user_identification: string | null;
  readonly message: string | null;
  readonly type: string | null;
  readonly executed_by: string | null;
  readonly details: string | null;
  readonly comment: string | null;
  readonly instruction_id: number | null;
  readonly payer_reference: string | null;
}

interface SyncStateRow {
  readonly account_key: string | null;
  readonly mode: string | null;
  readonly pending_json: string;
  readonly blocked_json: string;
  readonly failed_days_json: string;
  readonly history_limited: number;
  readonly history_limited_since: number | null;
  readonly backfill_target: string | null;
  readonly last_success_at: number | null;
  readonly last_attempt_at: number | null;
  readonly last_error: string | null;
  readonly rows_written: number;
}

const RangesJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })));
const DaysJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeRanges = Schema.decodeUnknownEffect(RangesJson);
const decodeDays = Schema.decodeUnknownEffect(DaysJson);

/** The bank account a statement belongs to, from its header. */
export function accountKeyOf(info: StatementInfo): string | undefined {
  return info.accountId !== null && info.bankId !== null ? `${info.accountId}/${info.bankId}` : undefined;
}

function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.movement_id,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    counterpartyAccount: row.counterparty_account,
    counterpartyName: row.counterparty_name,
    counterpartyBankCode: row.counterparty_bank_code,
    counterpartyBankName: row.counterparty_bank_name,
    counterpartyBic: row.counterparty_bic,
    constantSymbol: row.constant_symbol,
    variableSymbol: row.variable_symbol,
    specificSymbol: row.specific_symbol,
    userIdentification: row.user_identification,
    messageForRecipient: row.message,
    type: row.type,
    executedBy: row.executed_by,
    details: row.details,
    comment: row.comment,
    instructionId: row.instruction_id,
    payerReference: row.payer_reference,
  };
}

function transactionRecord(accountKey: string, tx: Transaction & { id: number; date: string }, now: number) {
  return {
    account_key: accountKey,
    movement_id: tx.id,
    date: tx.date,
    amount: tx.amount,
    currency: tx.currency,
    counterparty_account: tx.counterpartyAccount,
    counterparty_bank_code: tx.counterpartyBankCode,
    counterparty_bank_name: tx.counterpartyBankName,
    counterparty_name: tx.counterpartyName,
    counterparty_bic: tx.counterpartyBic,
    constant_symbol: tx.constantSymbol,
    variable_symbol: tx.variableSymbol,
    specific_symbol: tx.specificSymbol,
    user_identification: tx.userIdentification,
    message: tx.messageForRecipient,
    type: tx.type,
    executed_by: tx.executedBy,
    details: tx.details,
    comment: tx.comment,
    instruction_id: tx.instructionId,
    payer_reference: tx.payerReference,
    raw_json: JSON.stringify(tx),
    first_seen_at: now,
    updated_at: now,
  };
}

/**
 * The requested range narrowed to the period FIO's header says it covers.
 * FIO does not document whether period bounds are inclusive; the header is
 * its own statement of what the response contains.
 */
function coveredBy(requested: DayRange | undefined, info: StatementInfo): DayRange | undefined {
  if (requested === undefined) return undefined;
  const reported: DayRange = { from: info.dateStart ?? requested.from, to: info.dateEnd ?? requested.to };
  return intersect(requested, reported);
}

function chunks<A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> {
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const cents = (value: number | null) => (value ?? 0) / 100;

const escapeLike = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const makeCacheStore = Effect.fn("CacheStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const where = (accountKey: string, f: TransactionFilters) => {
    const clauses = [sql`account_key = ${accountKey}`];
    if (f.dateFrom !== undefined) clauses.push(sql`date >= ${f.dateFrom}`);
    if (f.dateTo !== undefined) clauses.push(sql`date <= ${f.dateTo}`);
    if (f.minAmount !== undefined) clauses.push(sql`ABS(amount) >= ${f.minAmount}`);
    if (f.maxAmount !== undefined) clauses.push(sql`ABS(amount) <= ${f.maxAmount}`);
    if (f.direction === "in") clauses.push(sql`amount > 0`);
    if (f.direction === "out") clauses.push(sql`amount < 0`);
    if (f.counterparty !== undefined) {
      const like = escapeLike(f.counterparty);
      clauses.push(
        sql`(counterparty_name LIKE ${like} ESCAPE '\\' OR counterparty_account LIKE ${like} ESCAPE '\\' OR (counterparty_account || '/' || counterparty_bank_code) LIKE ${like} ESCAPE '\\')`,
      );
    }
    if (f.text !== undefined) {
      const like = escapeLike(f.text);
      clauses.push(
        sql`(message LIKE ${like} ESCAPE '\\' OR comment LIKE ${like} ESCAPE '\\' OR user_identification LIKE ${like} ESCAPE '\\')`,
      );
    }
    if (f.variableSymbol !== undefined) clauses.push(sql`variable_symbol = ${f.variableSymbol}`);
    if (f.constantSymbol !== undefined) clauses.push(sql`constant_symbol = ${f.constantSymbol}`);
    if (f.specificSymbol !== undefined) clauses.push(sql`specific_symbol = ${f.specificSymbol}`);
    if (f.type !== undefined) clauses.push(sql`type = ${f.type}`);
    if (f.currency !== undefined) clauses.push(sql`currency = ${f.currency.toUpperCase()}`);
    return sql.and(clauses);
  };

  const binding = (tokenFingerprint: string) =>
    sql<{ account_key: string; account_name: string; verified_at: number }>`
      SELECT account_key, account_name, verified_at FROM bindings WHERE token_fingerprint = ${tokenFingerprint}
    `.pipe(
      Effect.map(([row]) =>
        row === undefined
          ? Option.none<Binding>()
          : Option.some<Binding>({ accountKey: row.account_key, accountName: row.account_name, verifiedAt: row.verified_at }),
      ),
      cacheFailure("read the account binding"),
    );

  const account = (accountKey: string) =>
    sql<{
      account_id: string;
      bank_id: string;
      iban: string | null;
      bic: string | null;
      currency: string | null;
      balance: number | null;
      balance_date: string | null;
    }>`SELECT * FROM accounts WHERE account_key = ${accountKey}`.pipe(
      Effect.map(([row]) =>
        row === undefined
          ? Option.none<CachedAccount>()
          : Option.some<CachedAccount>({
              accountKey,
              accountId: row.account_id,
              bankId: row.bank_id,
              iban: row.iban,
              bic: row.bic,
              currency: row.currency,
              balance: row.balance,
              balanceDate: row.balance_date,
            }),
      ),
      cacheFailure("read the cached account"),
    );

  const syncState = Effect.fn("CacheStore.syncState")(function* (tokenFingerprint: string) {
      const [row] = yield* sql<SyncStateRow>`SELECT * FROM sync_state WHERE token_fingerprint = ${tokenFingerprint}`;
      if (row === undefined) return emptySyncState;
      return {
        accountKey: row.account_key,
        mode: row.mode === "backfill" || row.mode === "incremental" ? row.mode : null,
        pending: yield* decodeRanges(row.pending_json),
        blocked: yield* decodeRanges(row.blocked_json),
        failedDays: yield* decodeDays(row.failed_days_json),
        historyLimited: row.history_limited !== 0,
        historyLimitedSince: row.history_limited_since,
        backfillTarget: row.backfill_target,
        lastSuccessAt: row.last_success_at,
        lastAttemptAt: row.last_attempt_at,
        lastError: row.last_error,
        rowsWritten: row.rows_written,
      } satisfies SyncState;
  }, cacheFailure("read the sync state"));

  const writeSyncState = (tokenFingerprint: string, state: SyncState) =>
    sql`
      INSERT INTO sync_state ${sql.insert({
        token_fingerprint: tokenFingerprint,
        account_key: state.accountKey,
        mode: state.mode,
        pending_json: JSON.stringify(state.pending),
        blocked_json: JSON.stringify(state.blocked),
        failed_days_json: JSON.stringify(state.failedDays),
        history_limited: state.historyLimited ? 1 : 0,
        history_limited_since: state.historyLimitedSince,
        backfill_target: state.backfillTarget,
        last_success_at: state.lastSuccessAt,
        last_attempt_at: state.lastAttemptAt,
        last_error: state.lastError,
        rows_written: state.rowsWritten,
      })}
      ON CONFLICT (token_fingerprint) DO UPDATE SET
        account_key = excluded.account_key, mode = excluded.mode, pending_json = excluded.pending_json,
        blocked_json = excluded.blocked_json, failed_days_json = excluded.failed_days_json,
        history_limited = excluded.history_limited, history_limited_since = excluded.history_limited_since,
        backfill_target = excluded.backfill_target, last_success_at = excluded.last_success_at,
        last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error, rows_written = excluded.rows_written
    `;

  const putSyncState = (tokenFingerprint: string, state: SyncState) =>
    writeSyncState(tokenFingerprint, state).pipe(Effect.asVoid, cacheFailure("save the sync state"));

  /** Rows, coverage, binding, account header and sync state of one response, in one transaction. */
  const commit = (input: CommitInput): Effect.Effect<CommitResult, CacheError | FioResponseError> => {
    const accountKey = accountKeyOf(input.statement.info);
    return accountKey === undefined
      ? Effect.fail(new FioResponseError({ detail: "The FIO statement header has no account number or bank code." }))
      : commitFor(input, accountKey);
  };

  const commitFor = Effect.fn("CacheStore.commit")(
    function* (input: CommitInput, accountKey: string) {
      const { statement, fetchedAt: now } = input;
      const info = statement.info;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO accounts ${sql.insert({
              account_key: accountKey,
              account_id: info.accountId,
              bank_id: info.bankId,
              iban: info.iban,
              bic: info.bic,
              currency: info.currency,
              balance: info.closingBalance,
              balance_date: info.closingBalance === null ? null : info.dateEnd,
              updated_at: now,
            })}
            ON CONFLICT (account_key) DO UPDATE SET
              iban = COALESCE(excluded.iban, iban),
              bic = COALESCE(excluded.bic, bic),
              currency = COALESCE(excluded.currency, currency),
              balance = CASE WHEN excluded.balance_date IS NOT NULL AND (balance_date IS NULL OR excluded.balance_date >= balance_date)
                THEN excluded.balance ELSE balance END,
              balance_date = CASE WHEN excluded.balance_date IS NOT NULL AND (balance_date IS NULL OR excluded.balance_date >= balance_date)
                THEN excluded.balance_date ELSE balance_date END,
              updated_at = excluded.updated_at
          `;
          const [previous] = yield* sql<{ account_key: string }>`
            SELECT account_key FROM bindings WHERE token_fingerprint = ${input.tokenFingerprint}
          `;
          if (previous !== undefined && previous.account_key !== accountKey) {
            yield* Effect.logWarning(
              `cache: the token of "${input.accountName}" now returns a different bank account; cached data follows the new account`,
            );
          }
          yield* sql`
            INSERT INTO bindings ${sql.insert({
              token_fingerprint: input.tokenFingerprint,
              account_key: accountKey,
              account_name: input.accountName,
              verified_at: now,
            })}
            ON CONFLICT (token_fingerprint) DO UPDATE SET
              account_key = excluded.account_key, account_name = excluded.account_name, verified_at = excluded.verified_at
          `;
          const rows = statement.transactions.filter(
            (tx): tx is Transaction & { id: number; date: string } => tx.id !== null && tx.date !== null,
          );
          for (const batch of chunks(rows, ROW_BATCH)) {
            yield* sql`
              INSERT INTO transactions ${sql.insert(batch.map((tx) => transactionRecord(accountKey, tx, now)))}
              ${sql.literal(UPSERT_TRANSACTION)}
            `;
          }
          const coverage = coveredBy(input.coverage, info);
          if (coverage !== undefined) {
            const days = eachDay(coverage).map((day) => ({ account_key: accountKey, day, fetched_at: now }));
            for (const batch of chunks(days, DAY_BATCH)) {
              yield* sql`
                INSERT INTO coverage_days ${sql.insert(batch)}
                ON CONFLICT (account_key, day) DO UPDATE SET fetched_at = excluded.fetched_at
              `;
            }
          }
          if (input.syncState !== undefined) {
            yield* writeSyncState(input.tokenFingerprint, { ...input.syncState, accountKey });
          }
          return { accountKey, rowsWritten: rows.length, coverage } satisfies CommitResult;
        }),
      );
    },
    cacheFailure("store fetched transactions"),
  );

  const coverageIn = (accountKey: string, range: DayRange) =>
    sql<{ day: string; fetched_at: number }>`
      SELECT day, fetched_at FROM coverage_days
      WHERE account_key = ${accountKey} AND day >= ${range.from} AND day <= ${range.to}
      ORDER BY day
    `.pipe(
      Effect.map((rows) => rows.map((r): CoverageDay => ({ day: r.day, fetchedAt: r.fetched_at }))),
      cacheFailure("read coverage"),
    );

  /** Covered days as runs of consecutive days, oldest first. */
  const coveredRanges = (accountKey: string, range?: DayRange) =>
    sql<{ from: string; to: string }>`
      SELECT MIN(day) AS "from", MAX(day) AS "to" FROM (
        SELECT day, CAST(julianday(day) AS INTEGER) - ROW_NUMBER() OVER (ORDER BY day) AS grp
        FROM coverage_days
        WHERE account_key = ${accountKey}
          AND day >= ${range?.from ?? "0000-00-00"} AND day <= ${range?.to ?? "9999-99-99"}
      )
      GROUP BY grp ORDER BY 1
    `.pipe(
      Effect.map((rows) => rows.map((r): DayRange => ({ from: r.from, to: r.to }))),
      cacheFailure("read coverage"),
    );

  const coveredDaySet = (accountKey: string, range: DayRange) =>
    Effect.map(coverageIn(accountKey, range), (days) => new Set(days.map((d) => d.day)));

  const transactionsIn = (accountKey: string, range: DayRange) =>
    sql<TransactionRow>`
      SELECT * FROM transactions
      WHERE account_key = ${accountKey} AND date >= ${range.from} AND date <= ${range.to}
      ORDER BY date, movement_id
    `.pipe(Effect.map((rows) => rows.map(toTransaction)), cacheFailure("read cached transactions"));

  const search = Effect.fn("CacheStore.search")(function* (
    accountKey: string,
    filters: TransactionFilters,
    page: { readonly limit: number; readonly offset: number; readonly order: "asc" | "desc" },
  ) {
      const condition = where(accountKey, filters);
      const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM transactions WHERE ${condition}`;
      const order = sql.literal(page.order === "asc" ? "date ASC, movement_id ASC" : "date DESC, movement_id DESC");
      const rows = yield* sql<TransactionRow>`
        SELECT * FROM transactions WHERE ${condition} ORDER BY ${order} LIMIT ${page.limit} OFFSET ${page.offset}
      `;
      return { total: count?.total ?? 0, transactions: rows.map(toTransaction) };
  }, cacheFailure("search cached transactions"));

  const GROUP_KEYS: Record<GroupBy, string> = {
    month: "substr(date, 1, 7)",
    counterparty:
      "COALESCE(counterparty_name, CASE WHEN counterparty_account IS NOT NULL THEN counterparty_account || COALESCE('/' || counterparty_bank_code, '') END, '(none)')",
    type: "COALESCE(type, '(none)')",
  };

  const summarize = Effect.fn("CacheStore.summarize")(function* (
    accountKey: string,
    filters: TransactionFilters,
    groupBy: GroupBy,
    page: { readonly limit: number; readonly offset: number },
  ) {
      const condition = where(accountKey, filters);
      const key = sql.literal(GROUP_KEYS[groupBy]);
      const order = sql.literal(
        groupBy === "month" ? "key ASC, currency ASC" : "(income_cents + expense_cents) DESC, key ASC, currency ASC",
      );
      const sums = sql.literal(`COUNT(*) AS count,
        SUM(CASE WHEN amount > 0 THEN CAST(ROUND(amount * 100) AS INTEGER) ELSE 0 END) AS income_cents,
        SUM(CASE WHEN amount < 0 THEN CAST(ROUND(-amount * 100) AS INTEGER) ELSE 0 END) AS expense_cents`);
      type SumRow = { key: string; currency: string; count: number; income_cents: number | null; expense_cents: number | null };
      const [groupCount] = yield* sql<{ total: number }>`
        SELECT COUNT(*) AS total FROM (SELECT 1 FROM transactions WHERE ${condition} GROUP BY ${key}, COALESCE(currency, ''))
      `;
      const groups = yield* sql<SumRow>`
        SELECT ${key} AS key, COALESCE(currency, '') AS currency, ${sums}
        FROM transactions WHERE ${condition}
        GROUP BY key, currency ORDER BY ${order} LIMIT ${page.limit} OFFSET ${page.offset}
      `;
      const totals = yield* sql<SumRow>`
        SELECT '' AS key, COALESCE(currency, '') AS currency, ${sums}
        FROM transactions WHERE ${condition} GROUP BY currency ORDER BY currency
      `;
      const toGroup = (row: SumRow): SummaryGroup => {
        const income = row.income_cents ?? 0;
        const expense = row.expense_cents ?? 0;
        return {
          key: row.key,
          currency: row.currency,
          count: row.count,
          income: cents(income),
          expense: cents(expense),
          net: cents(income - expense),
        };
      };
      return {
        totalGroups: groupCount?.total ?? 0,
        groups: groups.map(toGroup),
        totals: totals.map(toGroup).map(({ key: _key, ...total }) => total),
      };
  }, cacheFailure("summarize cached transactions"));

  const stats = (accountKey: string) =>
    sql<{ rows: number; earliest: string | null; latest: string | null }>`
      SELECT COUNT(*) AS rows, MIN(date) AS earliest, MAX(date) AS latest FROM transactions WHERE account_key = ${accountKey}
    `.pipe(
      Effect.map(([row]) => ({
        rowCount: row?.rows ?? 0,
        earliestMovement: row?.earliest ?? null,
        latestMovement: row?.latest ?? null,
      })),
      cacheFailure("count cached transactions"),
    );

  return {
    binding,
    account,
    syncState,
    putSyncState,
    commit,
    coverageIn,
    coveredRanges,
    coveredDaySet,
    transactionsIn,
    search,
    summarize,
    stats,
  };
});

export type CacheStore = Effect.Success<ReturnType<typeof makeCacheStore>>;
