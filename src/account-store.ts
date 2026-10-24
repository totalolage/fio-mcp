import { randomBytes } from "node:crypto";
import { Clock, Effect, Option, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { type Account, tokenFingerprint } from "./accounts.js";
import { type AccountSeed, accountNameKey } from "./config.js";
import {
  accountTokenAad,
  DataKeyMismatch,
  KEY_CHECK_AAD,
  KEY_CHECK_PLAINTEXT,
  open,
  type Sealed,
  seal,
  TokenDecryptionFailed,
} from "./token-crypto.js";

/**
 * FIO accounts in the server's SQLite file (HTTP mode with OAuth). Tokens
 * are stored only encrypted (src/token-crypto.ts); the AAD binds each one
 * to its row id. Everything else (name, account number, currency, the
 * token fingerprint already used by the cache and the OAuth grants) is
 * plaintext.
 *
 * Source of truth: the database. FIO_TOKEN / FIO_ACCOUNTS seed it once,
 * when it has no accounts and has never been seeded or edited; after that
 * they are ignored with a warning.
 *
 * `server_settings` also holds the data-key check value (a known plaintext
 * sealed under the key, so a wrong key file fails startup even without
 * accounts) and the admin password hash once it is changed at /admin.
 */

export const SETTING = {
  dataKeyCheck: "data_key_check",
  adminPasswordHash: "admin_password_hash",
  /** Set once env accounts were imported, or the accounts were edited at /admin. */
  accountsSeeded: "accounts_seeded",
} as const;

/** The account database failed; the SQL cause is logged (redacted), never shown. */
export class AccountStoreError extends Schema.TaggedError<AccountStoreError>()("AccountStoreError", {
  operation: Schema.String,
}) {
  override get message(): string {
    return `The server failed to ${this.operation}. See the server log for details.`;
  }
}

export class DuplicateAccountName extends Schema.TaggedError<DuplicateAccountName>()("DuplicateAccountName", {}) {
  override get message(): string {
    return "Another account already has this name (names are compared ignoring case).";
  }
}

export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()("AccountNotFound", {}) {
  override get message(): string {
    return "The account no longer exists. Reload the page.";
  }
}

const storeFailure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AccountStoreError, R> =>
    Effect.catch(effect, (cause) =>
      Effect.logError(`accounts: failed to ${operation}`, cause).pipe(
        Effect.andThen(Effect.fail(new AccountStoreError({ operation }))),
      ),
    );

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** `v1.<nonce>.<ciphertext>.<tag>`, base64 parts. */
export const encodeSealed = (sealed: Sealed) => `v1.${b64(sealed.nonce)}.${b64(sealed.ciphertext)}.${b64(sealed.tag)}`;

export const decodeSealed = (text: string): Sealed | undefined => {
  const [version, nonce, ciphertext, tag, ...rest] = text.split(".");
  if (version !== "v1" || nonce === undefined || ciphertext === undefined || tag === undefined || rest.length > 0) {
    return undefined;
  }
  const bytes = (part: string) => new Uint8Array(Buffer.from(part, "base64"));
  return { nonce: bytes(nonce), ciphertext: bytes(ciphertext), tag: bytes(tag) };
};

interface AccountRow {
  readonly account_id: string;
  readonly name: string;
  readonly token_sealed: string;
  readonly token_fingerprint: string;
  readonly account_number: string | null;
  readonly currency: string | null;
  readonly created_at: number;
  readonly token_updated_at: number;
}

/** An account with what /admin shows about it. */
export interface AccountRecord {
  readonly account: Account;
  readonly createdAt: number;
  readonly tokenUpdatedAt: number;
}

export interface NewAccount {
  readonly name: string;
  readonly token: Redacted.Redacted<string>;
  readonly accountNumber: string | undefined;
  readonly currency: string | undefined;
}

export const newAccountId = Effect.sync(() => `acct_${randomBytes(16).toString("base64url")}`);

const putSettingSql = (sql: SqlClient.SqlClient, name: string, value: string, now: number) =>
  sql`
    INSERT INTO server_settings ${sql.insert({ key: name, value, updated_at: now })}
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `;

/** `server_settings` rows; values are not secret (hashes, check values, markers). */
export const makeSettingsStore = Effect.fn("SettingsStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get = (name: string) =>
    sql<{ value: string }>`SELECT value FROM server_settings WHERE key = ${name}`.pipe(
      Effect.map(([row]) => Option.map(Option.fromNullishOr(row), (r) => r.value)),
      storeFailure("read a setting"),
    );

  const put = (name: string, value: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => putSettingSql(sql, name, value, now)).pipe(
      Effect.asVoid,
      storeFailure("store a setting"),
    );

  /** True when the setting existed. */
  const remove = (name: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ key: string }>`SELECT key FROM server_settings WHERE key = ${name}`;
          yield* sql`DELETE FROM server_settings WHERE key = ${name}`;
          return row !== undefined;
        }),
      )
      .pipe(storeFailure("delete a setting"));

  return { get, put, remove };
});

export type SettingsStore = Effect.Success<ReturnType<typeof makeSettingsStore>>;

export const makeAccountStore = Effect.fn("AccountStore.make")(function* (key: Redacted.Redacted<Uint8Array>) {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* makeSettingsStore();
  const putSettingNow = (name: string, value: string, now: number) => putSettingSql(sql, name, value, now);

  const toRecord = (row: AccountRow): Result.Result<AccountRecord, TokenDecryptionFailed> => {
    const sealed = decodeSealed(row.token_sealed);
    const token = sealed === undefined ? Result.fail("invalid" as const) : open(key, sealed, accountTokenAad(row.account_id));
    if (Result.isFailure(token)) return Result.fail(new TokenDecryptionFailed({ accountId: row.account_id }));
    // A row whose fingerprint does not match its token was edited outside fio-mcp.
    if (tokenFingerprint(token.success) !== row.token_fingerprint) {
      return Result.fail(new TokenDecryptionFailed({ accountId: row.account_id }));
    }
    return Result.succeed({
      account: {
        id: row.account_id,
        name: row.name,
        token: token.success,
        tokenFingerprint: row.token_fingerprint,
        configuredAccountNumber: row.account_number ?? undefined,
        configuredCurrency: row.currency ?? undefined,
      },
      createdAt: row.created_at,
      tokenUpdatedAt: row.token_updated_at,
    });
  };

  /** Every account, decrypted, in display order. Any row that does not decrypt fails the whole load. */
  const load = Effect.gen(function* () {
    const rows = yield* sql<AccountRow>`SELECT * FROM fio_accounts ORDER BY position, created_at, account_id`.pipe(
      storeFailure("read the accounts"),
    );
    const records: Array<AccountRecord> = [];
    for (const row of rows) {
      const record = toRecord(row);
      if (Result.isFailure(record)) return yield* record.failure;
      records.push(record.success);
    }
    return records;
  });

  /**
   * Proves the key matches the database: decrypts the stored check value.
   * Without one (first start), every stored token must decrypt before the
   * check value is created.
   */
  const checkKey = Effect.gen(function* () {
    const stored = yield* settings.get(SETTING.dataKeyCheck);
    if (Option.isNone(stored)) {
      yield* load;
      const sealed = yield* seal(key, KEY_CHECK_PLAINTEXT, KEY_CHECK_AAD);
      return yield* settings.put(SETTING.dataKeyCheck, encodeSealed(sealed));
    }
    const sealed = decodeSealed(stored.value);
    const opened = sealed === undefined ? Result.fail("invalid" as const) : open(key, sealed, KEY_CHECK_AAD);
    if (Result.isFailure(opened) || Redacted.value(opened.success) !== KEY_CHECK_PLAINTEXT) {
      return yield* new DataKeyMismatch();
    }
  });

  const sealToken = (accountId: string, token: Redacted.Redacted<string>) =>
    Effect.map(seal(key, Redacted.value(token), accountTokenAad(accountId)), encodeSealed);

  /** Records that the account has (had) this token; a token it had before keeps its first time. */
  const recordToken = (accountId: string, fingerprint: string, now: number) =>
    sql`
      INSERT INTO fio_account_tokens ${sql.insert({ account_id: accountId, token_fingerprint: fingerprint, created_at: now })}
      ON CONFLICT (account_id, token_fingerprint) DO NOTHING
    `;

  const nameTaken = (name: string, except: string | undefined) =>
    sql<{ account_id: string }>`SELECT account_id FROM fio_accounts WHERE name_key = ${accountNameKey(name)}`.pipe(
      Effect.map((rows) => rows.some((row) => row.account_id !== except)),
    );

  const insertNow = Effect.fnUntraced(function* (input: NewAccount, now: number) {
    const accountId = yield* newAccountId;
    const [last] = yield* sql<{ position: number | null }>`SELECT MAX(position) AS position FROM fio_accounts`;
    yield* sql`
      INSERT INTO fio_accounts ${sql.insert({
        account_id: accountId,
        name: input.name,
        name_key: accountNameKey(input.name),
        token_sealed: yield* sealToken(accountId, input.token),
        token_fingerprint: tokenFingerprint(input.token),
        account_number: input.accountNumber ?? null,
        currency: input.currency ?? null,
        position: (last?.position ?? 0) + 1,
        created_at: now,
        updated_at: now,
        token_updated_at: now,
      })}
    `;
    yield* recordToken(accountId, tokenFingerprint(input.token), now);
    return accountId;
  });

  /** Adds an account; the name must be unused (ignoring case). */
  const insert = (input: NewAccount) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (yield* nameTaken(input.name, undefined)) return Result.fail(new DuplicateAccountName());
          const now = yield* Clock.currentTimeMillis;
          const id = yield* insertNow(input, now);
          yield* putSettingNow(SETTING.accountsSeeded, String(now), now);
          return Result.succeed(id);
        }),
      )
      .pipe(storeFailure("add the account"), Effect.flatMap(Effect.fromResult));

  const exists = (accountId: string) =>
    sql<{ account_id: string }>`SELECT account_id FROM fio_accounts WHERE account_id = ${accountId}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  const rename = (accountId: string, name: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* exists(accountId))) return Result.fail<AccountNotFound | DuplicateAccountName>(new AccountNotFound());
          if (yield* nameTaken(name, accountId)) return Result.fail(new DuplicateAccountName());
          const now = yield* Clock.currentTimeMillis;
          yield* sql`
            UPDATE fio_accounts SET name = ${name}, name_key = ${accountNameKey(name)}, updated_at = ${now}
            WHERE account_id = ${accountId}
          `;
          return Result.succeed(undefined);
        }),
      )
      .pipe(storeFailure("rename the account"), Effect.flatMap(Effect.fromResult));

  /** Replaces the token; the row id (and so the AAD) stays, the nonce is new. */
  const rotate = (accountId: string, token: Redacted.Redacted<string>) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* exists(accountId))) return Result.fail(new AccountNotFound());
          const now = yield* Clock.currentTimeMillis;
          yield* sql`
            UPDATE fio_accounts SET
              token_sealed = ${yield* sealToken(accountId, token)},
              token_fingerprint = ${tokenFingerprint(token)},
              updated_at = ${now},
              token_updated_at = ${now}
            WHERE account_id = ${accountId}
          `;
          yield* recordToken(accountId, tokenFingerprint(token), now);
          return Result.succeed(undefined);
        }),
      )
      .pipe(storeFailure("replace the token"), Effect.flatMap(Effect.fromResult));

  /** Each account's token fingerprints, its current one included, oldest first. */
  const tokenHistory = sql<{ account_id: string; token_fingerprint: string }>`
    SELECT account_id, token_fingerprint FROM fio_account_tokens ORDER BY account_id, created_at, token_fingerprint
  `.pipe(
    Effect.map((rows) => {
      const history = new Map<string, Array<string>>();
      for (const row of rows) history.set(row.account_id, [...(history.get(row.account_id) ?? []), row.token_fingerprint]);
      return history as ReadonlyMap<string, ReadonlyArray<string>>;
    }),
    storeFailure("read the token history"),
  );

  /**
   * Removes the account with its token history (nothing else needs it: grants
   * name tokens). Returns the fingerprints of every token it had.
   */
  const remove = (accountId: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ token_fingerprint: string }>`
            SELECT token_fingerprint FROM fio_accounts WHERE account_id = ${accountId}
          `;
          if (row === undefined) return Result.fail(new AccountNotFound());
          const history = yield* sql<{ token_fingerprint: string }>`
            SELECT token_fingerprint FROM fio_account_tokens WHERE account_id = ${accountId} ORDER BY created_at, token_fingerprint
          `;
          const now = yield* Clock.currentTimeMillis;
          yield* sql`DELETE FROM fio_account_tokens WHERE account_id = ${accountId}`;
          yield* sql`DELETE FROM fio_accounts WHERE account_id = ${accountId}`;
          yield* putSettingNow(SETTING.accountsSeeded, String(now), now);
          const fingerprints = history.map((entry) => entry.token_fingerprint);
          return Result.succeed(fingerprints.includes(row.token_fingerprint) ? fingerprints : [...fingerprints, row.token_fingerprint]);
        }),
      )
      .pipe(storeFailure("remove the account"), Effect.flatMap(Effect.fromResult));

  /**
   * Imports the seed's accounts when the database has no accounts and was
   * never seeded or edited; only then is the seed read (and its errors
   * fail the import). Returns how many were imported, or None when the
   * database already decides.
   */
  const seed = (accountSeed: AccountSeed) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM fio_accounts`;
          const [seeded] = yield* sql<{ value: string }>`SELECT value FROM server_settings WHERE key = ${SETTING.accountsSeeded}`;
          if ((row?.total ?? 0) > 0 || seeded !== undefined) return Result.succeed(Option.none<number>());
          const loaded = yield* Effect.result(accountSeed.load);
          if (Result.isFailure(loaded)) return Result.fail(loaded.failure);
          const configs = loaded.success;
          if (configs.length === 0) return Result.succeed(Option.some(0));
          const now = yield* Clock.currentTimeMillis;
          for (const config of configs) {
            yield* insertNow(
              { name: config.name, token: config.token, accountNumber: config.accountNumber, currency: config.currency },
              now,
            );
          }
          yield* putSettingNow(SETTING.accountsSeeded, String(now), now);
          return Result.succeed(Option.some(configs.length));
        }),
      )
      .pipe(storeFailure("import the configured accounts"), Effect.flatMap(Effect.fromResult));

  return { checkKey, load, insert, rename, rotate, remove, seed, tokenHistory };
});

export type AccountStore = Effect.Success<ReturnType<typeof makeAccountStore>>;

const IGNORED_ENV_WARNING =
  "accounts: FIO_TOKEN / FIO_ACCOUNTS (or their _FILE variants) are set but ignored: in HTTP mode with OAuth the accounts live in the database and are managed at /admin. Remove the variables and delete the accounts file (it holds the tokens in plaintext).";

/**
 * Loads the accounts at startup: checks the data key, seeds an empty
 * database from FIO_TOKEN / FIO_ACCOUNTS once, and decrypts every account.
 * A wrong key or an undecryptable row fails startup; no account is
 * silently dropped.
 */
export const loadStoredAccounts = Effect.fn("AccountStore.loadAtStartup")(function* (
  store: AccountStore,
  accountSeed: AccountSeed,
) {
  yield* store.checkKey;
  const seeded = yield* store.seed(accountSeed);
  if (Option.isSome(seeded) && seeded.value > 0) {
    yield* Effect.logWarning(
      `accounts: imported ${seeded.value} accounts from FIO_TOKEN / FIO_ACCOUNTS into the database (encrypted). Remove those variables and delete the accounts file: from now on the accounts are managed at /admin.`,
    );
  } else if (Option.isNone(seeded) && accountSeed.configured) {
    yield* Effect.logWarning(IGNORED_ENV_WARNING);
  }
  return yield* store.load;
});
