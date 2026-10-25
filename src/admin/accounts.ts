import { Effect, Redacted, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { AccountNotFound, AccountStoreError, makeAccountStore, type NewAccount } from "../account-store.js";
import { type Account, Accounts } from "../accounts.js";
import { makeCachedData, Transactions } from "../cache/service.js";
import { ACCOUNT_NUMBER, CURRENCY, FIELD_RULES, TOKEN, validAccountName } from "../config.js";
import type { CacheError, FioRequestError } from "../errors.js";
import { FioApi } from "../fio-api.js";
import { parseLastStatement } from "../statement.js";

/**
 * Account changes from /admin. Each writes the database first, then
 * replaces the in-memory list from it (Accounts.replace), which the rate
 * limiter, background sync, tool schemas and tools/list follow
 * (src/account-runtime.ts, src/mcp/registration.ts). One change at a time.
 *
 * Inputs are checked with the same rules as FIO_ACCOUNTS; messages name the
 * field and rule, never the value.
 */

export class InvalidAccountInput extends Schema.TaggedError<InvalidAccountInput>()("InvalidAccountInput", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** The read-only FIO call of a token test failed; `reason` is the FIO error's (token-free) message. */
export class TokenTestFailed extends Schema.TaggedError<TokenTestFailed>()("TokenTestFailed", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `The token test failed: ${this.reason}`;
  }
}

const fail = (detail: string) => Effect.fail(new InvalidAccountInput({ detail }));

export const checkName = (raw: string) =>
  validAccountName(raw) ? Effect.succeed(raw.trim()) : fail(`The name ${FIELD_RULES.name}.`);

export const checkToken = (raw: string) => {
  const token = raw.trim();
  return TOKEN.test(token) ? Effect.succeed(Redacted.make(token)) : fail(`The token ${FIELD_RULES.token}.`);
};

const optional = (raw: string | undefined, pattern: RegExp, rule: string, transform: (s: string) => string = (s) => s) => {
  const value = transform((raw ?? "").trim());
  if (value !== "" && !pattern.test(value)) return fail(rule);
  return Effect.succeed(value === "" ? undefined : value);
};

export interface AccountInput {
  readonly name: string;
  readonly token: string;
  readonly accountNumber: string | undefined;
  readonly currency: string | undefined;
}

/**
 * What a removal did with the account's cached data: `kept` (keep chosen),
 * or `purged`: the number of bank accounts whose data was deleted, the
 * `accounts` that kept one (a token they have or had, the removed
 * account's current one included, is bound to it), and how many cached
 * bank accounts cannot be linked to a configured account (left alone; see
 * `CacheStore.purgeTokens`).
 */
export type RemovedCache =
  | { readonly kind: "kept" }
  | {
      readonly kind: "purged";
      readonly deleted: number;
      readonly accounts: ReadonlyArray<string>;
      readonly unattributed: number;
    };

export const makeAccountAdmin = Effect.fn("AccountAdmin.make")(function* (key: Redacted.Redacted<Uint8Array>) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* makeAccountStore(key);
  const accounts = yield* Accounts;
  const fio = yield* FioApi;
  // Retiring goes through the running cache (its gate is the one writes check); the
  // cached data is renamed and purged on the database even while the cache is disabled.
  const cache = yield* Transactions;
  const cacheStore = yield* makeCachedData();
  const lock = yield* Semaphore.make(1);

  /** Accounts as stored, with created and token-replaced times. */
  const records = store.load;

  /**
   * Publishes the stored accounts. First, tokens no account uses any more are
   * retired in the cache (no write, no sync job from now on; a running job is
   * stopped) and returning ones reinstated, so nothing that read the old list
   * can write for a removed token afterwards.
   */
  const reload = Effect.gen(function* () {
    const next = (yield* store.load).map((record) => record.account);
    const before = new Set((yield* accounts.list).map((account) => account.tokenFingerprint));
    const after = new Set(next.map((account) => account.tokenFingerprint));
    for (const fingerprint of after) if (!before.has(fingerprint)) yield* cache.reinstate(fingerprint);
    for (const fingerprint of before) if (!after.has(fingerprint)) yield* cache.retire(fingerprint);
    yield* accounts.replace(next);
  });

  /**
   * One change at a time, and never cut short (a closed browser
   * connection): the database and the published list stay in step.
   */
  const exclusive = <A, E>(effect: Effect.Effect<A, E>) => lock.withPermits(1)(Effect.uninterruptible(effect));

  const find = (accountId: string): Effect.Effect<Account, AccountNotFound> =>
    Effect.flatMap(accounts.list, (list) => {
      const account = list.find((candidate) => candidate.id === accountId);
      return account === undefined ? Effect.fail(new AccountNotFound()) : Effect.succeed(account);
    });

  const add = (input: AccountInput) =>
    exclusive(
      Effect.gen(function* () {
        const account: NewAccount = {
          name: yield* checkName(input.name),
          token: yield* checkToken(input.token),
          accountNumber: yield* optional(input.accountNumber, ACCOUNT_NUMBER, `The account number ${FIELD_RULES.accountNumber}.`),
          currency: yield* optional(input.currency, CURRENCY, `The currency ${FIELD_RULES.currency}.`, (s) => s.toUpperCase()),
        };
        const id = yield* store.insert(account);
        yield* reload;
        yield* Effect.logInfo(`admin: account ${id} added`);
        return account.name;
      }),
    );

  const rename = (accountId: string, rawName: string) =>
    exclusive(
      Effect.gen(function* () {
        const name = yield* checkName(rawName);
        const account = yield* find(accountId);
        yield* store.rename(accountId, name);
        yield* cacheStore.renameBinding(account.tokenFingerprint, name).pipe(Effect.ignore);
        yield* reload;
        yield* Effect.logInfo(`admin: account ${accountId} renamed`);
        return name;
      }),
    );

  /** Replaces the token. Grants name tokens, so existing grants no longer cover this account. */
  const rotate = (accountId: string, rawToken: string) =>
    exclusive(
      Effect.gen(function* () {
        const token = yield* checkToken(rawToken);
        const account = yield* find(accountId);
        yield* store.rotate(accountId, token);
        yield* reload;
        yield* Effect.logInfo(`admin: the token of account ${accountId} was replaced`);
        return account.name;
      }),
    );

  /**
   * Removes the account. With `purge`, also deletes what the cache holds for
   * every token it had (the current one and those it replaced), except each
   * bank account a token another account has or had is bound to (another
   * account using the same token keeps what that token cached). Returns what
   * happened to the cached data, naming the accounts that kept it.
   */
  const remove = (accountId: string, purge: boolean) =>
    exclusive(
      Effect.gen(function* () {
        const account = yield* find(accountId);
        const others = (yield* accounts.list).filter((other) => other.id !== accountId);
        let removed: RemovedCache;
        if (!purge) {
          yield* store.remove(accountId);
          yield* reload;
          removed = { kind: "kept" };
        } else {
          const history = yield* store.tokenHistory;
          const tokensOf = (some: Account) => [some.tokenFingerprint, ...(history.get(some.id) ?? [])];
          const current = new Set(others.map((other) => other.tokenFingerprint));
          // First stop every write for its tokens no other account uses: the check runs
          // inside each write's transaction, and a running job is stopped and awaited.
          // The tokens it replaced were retired when replaced, but only in this
          // process's memory.
          for (const fingerprint of tokensOf(account)) if (!current.has(fingerprint)) yield* cache.retire(fingerprint);
          // One transaction: if the purge fails, the account and its token history stay
          // and its token writes again (a job the retirement stopped stays stopped; its
          // pending ranges are saved for the next sync).
          const outcome = yield* sql
            .withTransaction(Effect.flatMap(store.remove(accountId), (fingerprints) => cacheStore.purgeTokens(fingerprints, new Set(others.flatMap(tokensOf)))))
            .pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.logError("accounts: failed to remove the account", cause).pipe(
                  Effect.andThen(Effect.fail(new AccountStoreError({ operation: "remove the account" }))),
                ),
              ),
              Effect.tapError(() => cache.reinstate(account.tokenFingerprint)),
            );
          yield* reload;
          removed = {
            kind: "purged",
            deleted: outcome.deleted,
            accounts: others.filter((other) => tokensOf(other).some((fp) => outcome.sharedWith.includes(fp))).map((other) => other.name),
            unattributed: outcome.unattributed,
          };
        }
        yield* Effect.logInfo(`admin: account ${accountId} removed; cached data: ${removed.kind}`);
        return { name: account.name, cache: removed };
      }),
    );

  /**
   * One read-only FIO call with the account's token: the latest statement's
   * id (`lastStatement`), which never moves the `last` download marker. It
   * goes through the token's rate limiter like a tool call.
   */
  const test = Effect.fn("AccountAdmin.test")(function* (accountId: string) {
    const account = yield* find(accountId);
    const body = yield* fio.lastStatement(account).pipe(
      Effect.mapError((error: FioRequestError) => new TokenTestFailed({ reason: error.message })),
    );
    const latest = parseLastStatement(body);
    return {
      name: account.name,
      latestStatement: latest.year === null || latest.number === null ? undefined : `${latest.year}/${latest.number}`,
    };
  });

  return { records, add, rename, rotate, remove, test };
});

export type AccountAdmin = Effect.Success<ReturnType<typeof makeAccountAdmin>>;
export type AccountAdminError = AccountStoreError | CacheError;
