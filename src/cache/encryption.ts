import { Effect, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { open, type Sealed, seal } from "../token-crypto.js";

/**
 * Encryption at rest of the cache's free-text and identifying columns
 * (FIO_CACHE_ENCRYPT). Each value is sealed with the data key
 * (FIO_MCP_DATA_KEY_FILE, AES-256-GCM, see token-crypto.ts) and bound by its
 * AAD to its table, column and row, so a value copied to another row or
 * column does not decrypt.
 *
 * Every row of `transactions` and `accounts` records in its `sealed` column
 * (migration 0011) whether its values are sealed, so each row is read on its
 * own: a table holding plaintext and sealed rows side by side reads
 * correctly. At startup `reconcileCacheEncryption` brings every row to the
 * configured state in one transaction (seals plaintext rows when the
 * setting is on, opens sealed rows when it is off), so a crash midway leaves
 * the table as it was.
 *
 * Errors never carry key material, values, or ciphertext.
 */

/** What the cache needs from FIO_CACHE_ENCRYPT and FIO_MCP_DATA_KEY_FILE. */
export interface CacheSealing {
  /** Seal what is written, and keep every row sealed. */
  readonly encrypt: boolean;
  /** The data key; undefined when FIO_MCP_DATA_KEY_FILE is not set (then `encrypt` is false). */
  readonly dataKey: Redacted.Redacted<Uint8Array> | undefined;
}

/** No encryption (the default, and what tests get unless they ask). */
export const PLAINTEXT: CacheSealing = { encrypt: false, dataKey: undefined };

/**
 * The sealed columns of `transactions`: the ones SEC-13 lists, plus
 * `executed_by` (who executed the order, a person's name) and `details`
 * (card and merchant details), and `raw_json`, which repeats them all.
 */
export const SEALED_TRANSACTION_COLUMNS = [
  "counterparty_account",
  "counterparty_bank_code",
  "counterparty_bank_name",
  "counterparty_name",
  "counterparty_bic",
  "user_identification",
  "message",
  "comment",
  "payer_reference",
  "executed_by",
  "details",
  "raw_json",
] as const;
export type SealedTransactionColumn = (typeof SEALED_TRANSACTION_COLUMNS)[number];

/** The sealed columns of `accounts`. */
export const SEALED_ACCOUNT_COLUMNS = ["iban"] as const;

export type CacheTable = "transactions" | "accounts";

/**
 * `fio-mcp:cache:v1:<table>:<column>:<account_key>:<movement_id>`. An
 * `accounts` row has no movement; its place holds `-`.
 */
export const cacheAad = (table: CacheTable, column: string, accountKey: string, movementId: number | undefined) =>
  `fio-mcp:cache:v1:${table}:${column}:${accountKey}:${movementId ?? "-"}`;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** `v1.<nonce>.<ciphertext>.<tag>`, base64 parts (the format of the sealed FIO tokens). */
const encode = (sealed: Sealed) => `v1.${b64(sealed.nonce)}.${b64(sealed.ciphertext)}.${b64(sealed.tag)}`;

const decode = (text: string): Sealed | undefined => {
  const [version, nonce, ciphertext, tag, ...rest] = text.split(".");
  if (version !== "v1" || nonce === undefined || ciphertext === undefined || tag === undefined || rest.length > 0) {
    return undefined;
  }
  const bytes = (part: string) => new Uint8Array(Buffer.from(part, "base64"));
  return { nonce: bytes(nonce), ciphertext: bytes(ciphertext), tag: bytes(tag) };
};

/** A sealed cache value did not decrypt: altered, copied from another row, or sealed with another key. */
export class CacheValueUnreadable extends Schema.TaggedError<CacheValueUnreadable>()("CacheValueUnreadable", {
  table: Schema.String,
  column: Schema.String,
  /** The movement of a `transactions` row; null for an `accounts` row. */
  movementId: Schema.NullOr(Schema.Number),
}) {
  override get message(): string {
    const row = this.movementId === null ? "" : ` of movement ${this.movementId}`;
    return `The sealed value in the cache's ${this.table}.${this.column}${row} could not be decrypted: the row was altered or copied from another row, or FIO_MCP_DATA_KEY_FILE changed. Remove the cached transactions of that account and download them again.`;
  }
}

/** The cache holds sealed rows but FIO_MCP_DATA_KEY_FILE is not set, so nothing can decrypt them. */
export class CacheKeyMissing extends Schema.TaggedError<CacheKeyMissing>()("CacheKeyMissing", {}) {
  override get message(): string {
    return "The cache holds rows encrypted while FIO_CACHE_ENCRYPT was on, and FIO_MCP_DATA_KEY_FILE is not set. Set FIO_MCP_DATA_KEY_FILE to the key file they were encrypted with (with FIO_CACHE_ENCRYPT off they are then decrypted at startup), or remove the cached transactions and download them again.";
  }
}

/** The data key does not open the rows the cache sealed earlier: a different key file. */
export class CacheKeyMismatch extends Schema.TaggedError<CacheKeyMismatch>()("CacheKeyMismatch", {}) {
  override get message(): string {
    return "FIO_MCP_DATA_KEY_FILE does not decrypt the cached transactions (FIO_CACHE_ENCRYPT): the key file differs from the one they were encrypted with, or the cached rows were altered. Restore the original key file, or remove the cached transactions and download them again.";
  }
}

/** Seals `value` (NULL stays NULL) for `table.column` of the row. */
export const sealValue = (
  key: Redacted.Redacted<Uint8Array>,
  table: CacheTable,
  column: string,
  accountKey: string,
  movementId: number | undefined,
  value: string | null,
): Effect.Effect<string | null> =>
  value === null ? Effect.succeed(null) : Effect.map(seal(key, value, cacheAad(table, column, accountKey, movementId)), encode);

/** Opens a value `sealValue` produced for the same table, column and row. */
export const openValue = (
  key: Redacted.Redacted<Uint8Array> | undefined,
  table: CacheTable,
  column: string,
  accountKey: string,
  movementId: number | undefined,
  value: string | null,
): Result.Result<string | null, CacheValueUnreadable> => {
  if (value === null) return Result.succeed(null);
  const sealed = decode(value);
  const opened =
    key === undefined || sealed === undefined
      ? Result.fail("invalid" as const)
      : open(key, sealed, cacheAad(table, column, accountKey, movementId));
  return Result.match(opened, {
    onFailure: () => Result.fail(new CacheValueUnreadable({ table, column, movementId: movementId ?? null })),
    onSuccess: (plaintext) => Result.succeed(Redacted.value(plaintext)),
  });
};

type Values = Readonly<Record<string, string | null>>;

/** `values` (the given columns of one row) sealed. */
export const sealValues = Effect.fn("Cache.sealValues")(function* <V extends Values>(
  key: Redacted.Redacted<Uint8Array>,
  table: CacheTable,
  accountKey: string,
  movementId: number | undefined,
  values: V,
) {
  const sealed: Record<string, string | null> = {};
  for (const [column, value] of Object.entries(values)) {
    sealed[column] = yield* sealValue(key, table, column, accountKey, movementId, value);
  }
  return sealed as { [K in keyof V]: string | null };
});

/**
 * `row` with `columns` opened when `row.sealed` is 1; a plaintext row is
 * returned as it is. Columns the row does not have are skipped.
 */
export const openRow = <R extends { readonly sealed: number }>(
  key: Redacted.Redacted<Uint8Array> | undefined,
  table: CacheTable,
  columns: ReadonlyArray<string>,
  accountKey: string,
  movementId: number | undefined,
  row: R,
): Result.Result<R, CacheValueUnreadable> => {
  if (row.sealed !== 1) return Result.succeed(row);
  const opened: Record<string, unknown> = { ...row, sealed: 0 };
  for (const column of columns) {
    const value = opened[column];
    if (value === undefined) continue;
    const plain = openValue(key, table, column, accountKey, movementId, typeof value === "string" ? value : null);
    if (Result.isFailure(plain)) return Result.fail(plain.failure);
    opened[column] = plain.success;
  }
  return Result.succeed(opened as R);
};

/** The Result as an Effect. */
export const fromResult = <A, E>(result: Result.Result<A, E>): Effect.Effect<A, E> =>
  Result.match(result, { onFailure: Effect.fail, onSuccess: Effect.succeed });

const RECONCILE_BATCH = 500;

interface TransactionValues {
  readonly row_id: number;
  readonly account_key: string;
  readonly movement_id: number;
  readonly sealed: number;
  readonly [column: string]: string | number | null;
}

interface AccountValues {
  readonly account_key: string;
  readonly sealed: number;
  readonly iban: string | null;
}

/**
 * Fails with CacheKeyMismatch unless `key` opens a sealed value of each
 * table (when there is one): a wrong key fails here, before any row is
 * converted, rather than on the first row read.
 */
const checkKey = Effect.fn("Cache.checkEncryptionKey")(function* (key: Redacted.Redacted<Uint8Array>) {
  const sql = yield* SqlClient.SqlClient;
  const [transaction] = yield* sql<TransactionValues>`
    SELECT rowid AS row_id, account_key, movement_id, sealed, raw_json FROM transactions WHERE sealed = 1 LIMIT 1
  `;
  const [account] = yield* sql<AccountValues>`
    SELECT account_key, sealed, iban FROM accounts WHERE sealed = 1 AND iban IS NOT NULL LIMIT 1
  `;
  const opens =
    (transaction === undefined ||
      Result.isSuccess(openRow(key, "transactions", ["raw_json"], transaction.account_key, transaction.movement_id, transaction))) &&
    (account === undefined || Result.isSuccess(openRow(key, "accounts", SEALED_ACCOUNT_COLUMNS, account.account_key, undefined, account)));
  if (!opens) return yield* new CacheKeyMismatch();
});

const TRANSACTION_SELECT = `rowid AS row_id, account_key, movement_id, sealed, ${SEALED_TRANSACTION_COLUMNS.join(", ")}`;

/**
 * Every row of both tables brought to `encrypt` (sealed or opened), inside
 * the caller's transaction. Transactions are read in rowid batches, so the
 * whole pass reads each row once.
 */
const convertAll = Effect.fn("Cache.convertAll")(function* (key: Redacted.Redacted<Uint8Array>, encrypt: boolean) {
  const sql = yield* SqlClient.SqlClient;
  const from = encrypt ? 0 : 1;
  let converted = 0;
  let after = 0;
  for (;;) {
    const rows = yield* sql<TransactionValues>`
      SELECT ${sql.literal(TRANSACTION_SELECT)} FROM transactions
      WHERE sealed = ${from} AND rowid > ${after} ORDER BY rowid LIMIT ${RECONCILE_BATCH}
    `;
    if (rows.length === 0) break;
    for (const row of rows) {
      after = row.row_id;
      const stored: Record<string, string | null> = {};
      for (const column of SEALED_TRANSACTION_COLUMNS) {
        const value = row[column];
        stored[column] = typeof value === "string" ? value : null;
      }
      const values = encrypt
        ? yield* sealValues(key, "transactions", row.account_key, row.movement_id, stored)
        : yield* fromResult(
            openRow(key, "transactions", SEALED_TRANSACTION_COLUMNS, row.account_key, row.movement_id, { ...stored, sealed: 1 }),
          );
      yield* sql`
        UPDATE transactions SET ${sql.update({ ...values, sealed: encrypt ? 1 : 0 })} WHERE rowid = ${row.row_id}
      `;
      converted += 1;
    }
  }
  const accounts = yield* sql<AccountValues>`SELECT account_key, sealed, iban FROM accounts WHERE sealed = ${from}`;
  for (const row of accounts) {
    const iban = encrypt
      ? yield* sealValue(key, "accounts", "iban", row.account_key, undefined, row.iban)
      : (yield* fromResult(openRow(key, "accounts", SEALED_ACCOUNT_COLUMNS, row.account_key, undefined, row))).iban;
    yield* sql`UPDATE accounts SET ${sql.update({ iban, sealed: encrypt ? 1 : 0 })} WHERE account_key = ${row.account_key}`;
    converted += 1;
  }
  return converted;
});

/**
 * After sealing: rebuilds the database file (VACUUM) and truncates the
 * write-ahead log, so the plaintext the rows held before is not left in
 * free pages or old log frames. The sealing transaction records that this
 * is pending (`cache_plaintext_remnants`); the record is cleared only once
 * both steps completed, so a crash in between, or another connection
 * keeping the log from being truncated (logged), makes the next startup
 * run it again.
 */
const dropPlaintextRemnants = Effect.fn("Cache.dropPlaintextRemnants")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`VACUUM`;
  const [checkpoint] = yield* sql<{ busy: number }>`PRAGMA wal_checkpoint(TRUNCATE)`;
  if ((checkpoint?.busy ?? 0) !== 0) {
    return yield* Effect.logWarning(
      "cache: the database is open elsewhere, so its write-ahead log was not truncated after encrypting the cache; it may hold earlier plaintext until the next startup repeats this",
    );
  }
  yield* sql`DELETE FROM cache_plaintext_remnants`;
});

/**
 * The conversion step of `reconcileCacheEncryption`, without the key check
 * and the cleanup after it: one transaction that converts every row and,
 * when sealing, records the cleanup as pending. Exported so tests can stop
 * where a crash before the cleanup would.
 */
export const convertRows = Effect.fn("Cache.convertRows")(function* (key: Redacted.Redacted<Uint8Array>, encrypt: boolean) {
  const sql = yield* SqlClient.SqlClient;
  const converted = yield* sql.withTransaction(
    Effect.tap(convertAll(key, encrypt), () =>
      encrypt ? sql`INSERT OR IGNORE INTO cache_plaintext_remnants (pending) VALUES (1)` : sql`DELETE FROM cache_plaintext_remnants`,
    ),
  );
  yield* Effect.logInfo(
    encrypt
      ? `cache: encrypted ${converted} cached rows (FIO_CACHE_ENCRYPT is on)`
      : `cache: decrypted ${converted} cached rows (FIO_CACHE_ENCRYPT is off)`,
  );
});

/**
 * Startup of the cache service: brings the cache to FIO_CACHE_ENCRYPT. On,
 * it seals every plaintext row and then drops the plaintext's remnants from
 * the file; off, it opens every sealed row (which needs the data key). The
 * conversion is one transaction, so an interrupted run leaves the tables as
 * they were and the next startup repeats it; the cleanup after sealing is
 * repeated until it completes; a run with nothing to do changes nothing. Fails when the key is missing or does not open what was
 * sealed earlier, and when a sealed row does not decrypt.
 */
export const reconcileCacheEncryption = Effect.fn("Cache.reconcileEncryption")(function* (sealing: CacheSealing) {
  const sql = yield* SqlClient.SqlClient;
  const [pending] = yield* sql<{ n: number }>`
    SELECT (SELECT COUNT(*) FROM transactions WHERE sealed = ${sealing.encrypt ? 0 : 1})
      + (SELECT COUNT(*) FROM accounts WHERE sealed = ${sealing.encrypt ? 0 : 1}) AS n
  `;
  const [remnants] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM cache_plaintext_remnants`;
  const cleanupPending = (remnants?.n ?? 0) > 0;
  const key = sealing.dataKey;
  if (key === undefined) {
    // Off without a key: nothing may be sealed. On without a key is a configuration error caught earlier.
    if (sealing.encrypt || (pending?.n ?? 0) > 0) return yield* new CacheKeyMissing();
    // Off, the cache is plaintext by choice: an unfinished cleanup no longer matters.
    if (cleanupPending) yield* sql`DELETE FROM cache_plaintext_remnants`;
    return;
  }
  yield* checkKey(key);
  if ((pending?.n ?? 0) > 0) {
    yield* convertRows(key, sealing.encrypt);
    if (sealing.encrypt) yield* dropPlaintextRemnants();
  } else if (sealing.encrypt && cleanupPending) {
    yield* dropPlaintextRemnants();
  } else if (cleanupPending) {
    yield* sql`DELETE FROM cache_plaintext_remnants`;
  }
});
