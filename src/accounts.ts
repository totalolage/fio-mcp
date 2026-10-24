import { createHash } from "node:crypto";
import { Context, Effect, Layer, Redacted, Ref } from "effect";
import { type AccountConfig, AppConfig } from "./config.js";
import { InvalidInput } from "./errors.js";
import type { Payer } from "./payments.js";
import type { StatementInfo } from "./statement.js";

export interface Account {
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
  readonly list: ReadonlyArray<Account>;
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

export function toAccount(config: AccountConfig): Account {
  return {
    name: config.name,
    token: config.token,
    tokenFingerprint: tokenFingerprint(config.token),
    configuredAccountNumber: config.accountNumber,
    configuredCurrency: config.currency,
  };
}

export const makeAccounts = Effect.fn("Accounts.make")(function* (configs: ReadonlyArray<AccountConfig>) {
  const list = configs.map(toAccount);
  const learned = yield* Ref.make(new Map<string, KnownAccountDetails>());

  const resolve = (name: string | undefined): Effect.Effect<Account, InvalidInput> => {
    if (name !== undefined) {
      const account = list.find((a) => a.name === name);
      return account === undefined
        ? Effect.fail(new InvalidInput({ detail: `Unknown account "${name}".` }))
        : Effect.succeed(account);
    }
    const [only, ...rest] = list;
    return only !== undefined && rest.length === 0
      ? Effect.succeed(only)
      : Effect.fail(new InvalidInput({ detail: `Specify account: one of ${list.map((a) => a.name).join(", ")}.` }));
  };

  const learn = (account: Account, info: StatementInfo) =>
    Ref.update(learned, (map) => {
      const previous = map.get(account.name);
      const accountNumber =
        info.accountId !== null && /^\d{1,10}$/.test(info.accountId) ? info.accountId : previous?.accountNumber;
      const currency = info.currency !== null && /^[A-Z]{3}$/.test(info.currency) ? info.currency : previous?.currency;
      return new Map(map).set(account.name, { accountNumber, currency });
    });

  const details = (account: Account) =>
    Effect.map(Ref.get(learned), (map) => ({
      accountNumber: account.configuredAccountNumber ?? map.get(account.name)?.accountNumber,
      currency: account.configuredCurrency ?? map.get(account.name)?.currency,
    }));

  const payer = (account: Account) =>
    Effect.flatMap(details(account), ({ accountNumber, currency }) =>
      accountNumber === undefined
        ? Effect.fail(
            new InvalidInput({
              detail: `The FIO account number for "${account.name}" is unknown. Configure it (FIO_ACCOUNT_NUMBER or accounts[].accountNumber), or call get_transactions for this account once so the server can read it from the statement header.`,
            }),
          )
        : Effect.succeed<Payer>(currency === undefined ? { accountNumber } : { accountNumber, currency }),
    );

  return { list, resolve, learn, details, payer } satisfies AccountsShape;
});

export class Accounts extends Context.Service<Accounts, AccountsShape>()("fio-mcp/Accounts") {
  static readonly Default = Layer.effect(
    Accounts,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return Accounts.of(yield* makeAccounts(config.accounts));
    }),
  );

  static readonly Live = Accounts.Default.pipe(Layer.provide(AppConfig.Live));
}
