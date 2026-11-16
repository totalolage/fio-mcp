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

/** The sealed columns of `transactions`; `raw_json` repeats them all, so it is sealed too. */
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
}) {
  override get message(): string {
    return `A sealed value in the cache's ${this.table}.${this.column} could not be decrypted: the row was altered or copied from another row, or FIO_MCP_DATA_KEY_FILE changed.`;
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
    return "FIO_MCP_DATA_KEY_FILE does not hold the key the cached transactions were encrypted with (FIO_CACHE_ENCRYPT). Restore the original key file, or remove the cached transactions and download them again.";
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
    onFailure: () => Result.fail(new CacheValueUnreadable({ table, column })),
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

const RECONCILE_BATCH = 500;

interface TransactionValues {
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

/** Fails with CacheKeyMismatch unless `key` opens a sealed value of each table (when there is one). */
const checkKey = Effect.fn("Cache.checkEncryptionKey")(function* (key: Redacted.Redacted<Uint8Array>) {
  const sql = yield* SqlClient.SqlClient;
  const [transaction] = yield* sql<TransactionValues>`
    SELECT account_key, movement_id, sealed, raw_json FROM transactions WHERE sealed = 1 LIMIT 1
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

const TRANSACTION_SELECT = `account_key, movement_id, sealed, ${SEALED_TRANSACTION_COLUMNS.join(", ")}`;

/** Every row of both tables brought to `encrypt` (sealed or opened), in batches, inside the caller's transaction. */
const convertAll = Effect.fn("Cache.convertRows")(function* (key: Redacted.Redacted<Uint8Array>, encrypt: boolean) {
  const sql = yield* SqlClient.SqlClient;
  const from = encrypt ? 0 : 1;
  let converted = 0;
  for (;;) {
    const rows = yield* sql<TransactionValues>`
      SELECT ${sql.literal(TRANSACTION_SELECT)} FROM transactions WHERE sealed = ${from} LIMIT ${RECONCILE_BATCH}
    `;
    if (rows.length === 0) break;
    for (const row of rows) {
      const values: Record<string, string | null> = {};
      if (encrypt) {
        for (const column of SEALED_TRANSACTION_COLUMNS) {
          const value = row[column];
          values[column] = yield* sealValue(key, "transactions", column, row.account_key, row.movement_id, typeof value === "string" ? value : null);
        }
      } else {
        const opened = yield* Result.match(
          openRow(key, "transactions", SEALED_TRANSACTION_COLUMNS, row.account_key, row.movement_id, row),
          { onFailure: Effect.fail, onSuccess: Effect.succeed },
        );
        for (const column of SEALED_TRANSACTION_COLUMNS) {
          const value = opened[column];
          values[column] = typeof value === "string" ? value : null;
        }
      }
      yield* sql`
        UPDATE transactions SET ${sql.update({ ...values, sealed: encrypt ? 1 : 0 })}
        WHERE account_key = ${row.account_key} AND movement_id = ${row.movement_id}
      `;
      converted += 1;
    }
  }
  const accounts = yield* sql<AccountValues>`SELECT account_key, sealed, iban FROM accounts WHERE sealed = ${from}`;
  for (const row of accounts) {
    const iban = encrypt
      ? yield* sealValue(key, "accounts", "iban", row.account_key, undefined, row.iban)
      : (yield* Result.match(openRow(key, "accounts", SEALED_ACCOUNT_COLUMNS, row.account_key, undefined, row), {
          onFailure: Effect.fail,
          onSuccess: Effect.succeed,
        })).iban;
    yield* sql`UPDATE accounts SET ${sql.update({ iban, sealed: encrypt ? 1 : 0 })} WHERE account_key = ${row.account_key}`;
    converted += 1;
  }
  return converted;
});

/**
 * Startup: brings the cache to FIO_CACHE_ENCRYPT. On, it seals every
 * plaintext row; off, it opens every sealed row (which needs the data key).
 * One transaction, so an interrupted run leaves the tables as they were and
 * the next startup repeats it; a run with nothing to convert changes nothing.
 * Fails when the key does not open what was sealed earlier.
 */
export const reconcileCacheEncryption = Effect.fn("Cache.reconcileEncryption")(function* (sealing: CacheSealing) {
  const sql = yield* SqlClient.SqlClient;
  const [pending] = yield* sql<{ n: number }>`
    SELECT (SELECT COUNT(*) FROM transactions WHERE sealed = ${sealing.encrypt ? 0 : 1})
      + (SELECT COUNT(*) FROM accounts WHERE sealed = ${sealing.encrypt ? 0 : 1}) AS n
  `;
  const key = sealing.dataKey;
  if (key === undefined) {
    // Off without a key: nothing may be sealed. On without a key is a configuration error caught earlier.
    if (sealing.encrypt || (pending?.n ?? 0) > 0) return yield* new CacheKeyMissing();
    return;
  }
  yield* checkKey(key);
  if ((pending?.n ?? 0) === 0) return;
  const converted = yield* sql.withTransaction(convertAll(key, sealing.encrypt));
  yield* Effect.logInfo(
    sealing.encrypt
      ? `cache: encrypted ${converted} cached rows (FIO_CACHE_ENCRYPT is on)`
      : `cache: decrypted ${converted} cached rows (FIO_CACHE_ENCRYPT is off)`,
  );
});
