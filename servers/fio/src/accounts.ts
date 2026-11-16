import { createHash } from "node:crypto";
import { Context, Effect, Layer, Redacted, Ref, type Stream, SubscriptionRef } from "effect";
import type { SqlClient } from "effect/sql";
import { type AccountStoreError, loadStoredAccounts, makeAccountStore } from "./account-store.js";
import { Database } from "./cache/db.js";
import { type AccountConfig, type AccountSeed, AppConfig } from "./config.js";
import { type ConfigError, InvalidInput } from "./errors.js";
import type { Payer } from "./payments.js";
import { Redactor } from "./redaction.js";
import type { StatementInfo } from "./statement.js";
import type { DataKeyMismatch, TokenDecryptionFailed } from "./token-crypto.js";

export interface Account {
  /**
   * Stable identity of the configured account: the database row id in HTTP
   * mode with OAuth (`acct_…`), `env:<index>` for accounts from FIO_TOKEN /
   * FIO_ACCOUNTS. Survives renames and token rotation.
   */
  readonly id: string;
  /** Name the model uses to pick an account; never the token. */
  readonly name: string;
  readonly token: Redacted.Redacted<string>;
  /**
   * Stable, non-reversible token fingerprint. Keys the rate limiter (accounts
   * that share a token share FIO's per-token limit) and binds cached data to
   * the token that fetched it.
   */
  readonly tokenFingerprint: string;
  readonly configuredAccountNumber: string | undefined;
  readonly configuredCurrency: string | undefined;
}

export interface KnownAccountDetails {
  readonly accountNumber: string | undefined;
  readonly currency: string | undefined;
}

export interface AccountsShape {
  /** The accounts right now. In HTTP mode with OAuth they change at runtime (/admin). */
  readonly list: Effect.Effect<ReadonlyArray<Account>>;
  /** The current list, then every new one. */
  readonly changes: Stream.Stream<ReadonlyArray<Account>>;
  /**
   * Replaces the list (after the database changed); hands new tokens to
   * `register` (the Redactor) first. Retire the tokens it drops in
   * `Transactions` before calling it (src/admin/accounts.ts does): the
   * cache drops a token's writes only once it is retired.
   */
  readonly replace: (accounts: ReadonlyArray<Account>) => Effect.Effect<void>;
  /** The named account, or the only one when `name` is omitted. */
  readonly resolve: (name: string | undefined) => Effect.Effect<Account, InvalidInput>;
  /** Remembers the account number and currency from a statement header (payer defaults). */
  readonly learn: (account: Account, info: StatementInfo) => Effect.Effect<void>;
  /** Configured values first, then what was learned from statements. */
  readonly details: (account: Account) => Effect.Effect<KnownAccountDetails>;
  /** The payer for payment orders; fails when the account number is not known yet. */
  readonly payer: (account: Account) => Effect.Effect<Payer, InvalidInput>;
}

export function tokenFingerprint(token: Redacted.Redacted<string>): string {
  return createHash("sha256").update(`fio-mcp:${Redacted.value(token)}`).digest("hex").slice(0, 32);
}

/** The last four characters of a token, the only part ever shown. */
export const tokenHint = (token: Redacted.Redacted<string>): string => Redacted.value(token).slice(-4);

export function toAccount(config: AccountConfig, id: string): Account {
  return {
    id,
    name: config.name,
    token: config.token,
    tokenFingerprint: tokenFingerprint(config.token),
    configuredAccountNumber: config.accountNumber,
    configuredCurrency: config.currency,
  };
}

/** Accounts from FIO_TOKEN / FIO_ACCOUNTS, identified by position. */
export const accountsFromConfig = (configs: ReadonlyArray<AccountConfig>): ReadonlyArray<Account> =>
  configs.map((config, index) => toAccount(config, `env:${index}`));

const NO_ACCOUNTS = "No FIO accounts are configured. Add one in the admin UI (/admin).";

export const makeAccounts = Effect.fn("Accounts.make")(function* (
  initial: ReadonlyArray<Account>,
  register: (tokens: ReadonlyArray<string>) => void = () => undefined,
) {
  register(initial.map((account) => Redacted.value(account.token)));
  const current = yield* SubscriptionRef.make<ReadonlyArray<Account>>(initial);
  // Learned per token: a rename keeps them, a new token (possibly of another bank account) starts over.
  const learned = yield* Ref.make(new Map<string, KnownAccountDetails>());

  const list = SubscriptionRef.get(current);

  const replace = (accounts: ReadonlyArray<Account>) =>
    Effect.suspend(() => {
      register(accounts.map((account) => Redacted.value(account.token)));
      return SubscriptionRef.set(current, accounts);
    });

  const resolve = (name: string | undefined): Effect.Effect<Account, InvalidInput> =>
    Effect.flatMap(list, (accounts) => {
      if (accounts.length === 0) return Effect.fail(new InvalidInput({ detail: NO_ACCOUNTS }));
      if (name !== undefined) {
        const account = accounts.find((a) => a.name === name);
        return account === undefined
          ? Effect.fail(new InvalidInput({ detail: `Unknown account "${name}".` }))
          : Effect.succeed(account);
      }
      const [only, ...rest] = accounts;
      return only !== undefined && rest.length === 0
        ? Effect.succeed(only)
        : Effect.fail(new InvalidInput({ detail: `Specify account: one of ${accounts.map((a) => a.name).join(", ")}.` }));
    });

  const learn = (account: Account, info: StatementInfo) =>
    Ref.update(learned, (map) => {
      const previous = map.get(account.tokenFingerprint);
      const accountNumber =
        info.accountId !== null && /^\d{1,10}$/.test(info.accountId) ? info.accountId : previous?.accountNumber;
      const currency = info.currency !== null && /^[A-Z]{3}$/.test(info.currency) ? info.currency : previous?.currency;
      return new Map(map).set(account.tokenFingerprint, { accountNumber, currency });
    });

  const details = (account: Account) =>
    Effect.map(Ref.get(learned), (map) => ({
      accountNumber: account.configuredAccountNumber ?? map.get(account.tokenFingerprint)?.accountNumber,
      currency: account.configuredCurrency ?? map.get(account.tokenFingerprint)?.currency,
    }));

  const payer = (account: Account) =>
    Effect.flatMap(details(account), ({ accountNumber, currency }) =>
      accountNumber === undefined
        ? Effect.fail(
            new InvalidInput({
              detail: `The FIO account number for "${account.name}" is unknown. Configure it (FIO_ACCOUNT_NUMBER, accounts[].accountNumber, or the admin UI), or call get_transactions for this account once so the server can read it from the statement header.`,
            }),
          )
        : Effect.succeed<Payer>(currency === undefined ? { accountNumber } : { accountNumber, currency }),
    );

  return { list, changes: SubscriptionRef.changes(current), replace, resolve, learn, details, payer } satisfies AccountsShape;
});

export class Accounts extends Context.Service<Accounts, AccountsShape>()("fio-mcp/Accounts") {
  /** The accounts from FIO_TOKEN / FIO_ACCOUNTS. */
  static readonly Default = Layer.effect(
    Accounts,
    // Fixed for the process; their tokens are in AppConfig.secrets, which the Redactor starts with.
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return Accounts.of(yield* makeAccounts(accountsFromConfig(config.accounts)));
    }),
  );

  /**
   * The accounts from the database (HTTP mode with OAuth), managed at
   * /admin. Needs the database and the data key; fails startup on a wrong
   * key, a row that does not decrypt, or a seed that is needed but invalid.
   * New tokens are registered with the Redactor.
   */
  static readonly stored = (
    key: Redacted.Redacted<Uint8Array>,
    accountSeed: AccountSeed,
  ): Layer.Layer<Accounts, DataKeyMismatch | TokenDecryptionFailed | AccountStoreError | ConfigError, SqlClient.SqlClient | Redactor> =>
    Layer.effect(
      Accounts,
      Effect.gen(function* () {
        const redactor = yield* Redactor;
        const store = yield* makeAccountStore(key);
        const records = yield* loadStoredAccounts(store, accountSeed);
        yield* Effect.logInfo(`accounts: ${records.length} accounts loaded from the database`);
        return Accounts.of(yield* makeAccounts(records.map((record) => record.account), redactor.register));
      }),
    );

  /**
   * The accounts from configuration: `stored` on the server's database in
   * HTTP mode with OAuth, otherwise `Default`.
   */
  static readonly Live = Layer.unwrap(
    Effect.gen(function* () {
      const { transport } = yield* AppConfig;
      return transport.kind === "http" && transport.auth.kind === "oauth"
        ? Accounts.stored(transport.auth.dataKey, transport.auth.accountSeed).pipe(
            Layer.provide(Layer.mergeAll(Database.Live, Redactor.Live)),
          )
        : Accounts.Default;
    }),
  ).pipe(Layer.provide(AppConfig.Live));
}
