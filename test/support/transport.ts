import { Deferred, Effect, Layer, Redacted } from "effect";
import { Accounts } from "../../src/accounts.js";
import { TransactionCache } from "../../src/cache/service.js";
import { AppConfig, type AppConfigShape, type TransportConfig } from "../../src/config.js";
import { FioApi } from "../../src/fio-api.js";
import { RateLimiter } from "../../src/rate-limiter.js";
import { Redactor } from "../../src/redaction.js";
import type { NormalizedStatement } from "../../src/statement.js";

/** A FIO-shaped read token (64 URL-safe characters). */
export const FIO_TOKEN = "fioT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRS";
export const SAVINGS_TOKEN = "savingsT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN";

export const STATEMENT: NormalizedStatement = {
  info: {
    accountId: "2900000000",
    bankId: "2010",
    currency: "CZK",
    iban: "CZ0000000000000000000000",
    bic: "FIOBCZPPXXX",
    openingBalance: 100,
    closingBalance: 100,
    dateStart: "2026-01-01",
    dateEnd: "2026-01-31",
    yearList: null,
    idList: null,
    idFrom: null,
    idTo: null,
    idLastDownload: null,
  },
  transactionCount: 0,
  transactions: [],
};

export const ACCOUNT_NAMES = ["main", "savings"];

export function testConfig(transport: TransportConfig = { kind: "stdio" }): AppConfigShape {
  const token = Redacted.make(FIO_TOKEN);
  const savings = Redacted.make(SAVINGS_TOKEN);
  return {
    // Two accounts: with one, McpServer rejects the parameterless tools (an
    // empty Struct has no object-root JSON Schema), independent of transport.
    accounts: [
      { name: "main", token, accountNumber: "2900000000", currency: "CZK" },
      { name: "savings", token: savings, accountNumber: "2900000001", currency: "CZK" },
    ],
    secrets: [token, savings],
    baseUrl: "http://fio.invalid",
    rateLimitIntervalMs: 30_000,
    // Far below the interval: a call that would queue behind a held slot
    // fails fast at arrival instead of waiting.
    maxWaitMs: 5_000,
    requestTimeoutMs: 1_000,
    transport,
    cache: {
      enabled: false,
      dbPath: "",
      syncOnStartup: false,
      syncIntervalMinutes: 0,
      backfillFrom: "2000-01-01",
      overlapDays: 10,
      maxAgeMinutes: 60,
    },
  };
}

/** What a FioApi fake answers for `lastStatement` (the token test at /admin). */
export const LAST_STATEMENT = '{"year":2026,"id":7}';

/**
 * A FioApi whose `periods` goes through the real RateLimiter and holds its
 * slot until `release` completes, and whose `lastStatement` answers
 * LAST_STATEMENT through the rate limiter. Every other call dies: tests
 * must not reach them (in particular nothing that moves the `last` marker).
 */
export const fakeFioApi = (release: Deferred.Deferred<void>) =>
  Layer.effect(
    FioApi,
    Effect.gen(function* () {
      const limiter = yield* RateLimiter;
      const unused = Effect.die("not used by transport tests");
      return FioApi.of({
        periods: (account, _from, _to, priority) =>
          limiter.run(account.tokenFingerprint, priority ?? "interactive", Effect.as(Deferred.await(release), STATEMENT)),
        periodsRaw: () => unused,
        statement: () => unused,
        statementRaw: () => unused,
        last: () => unused,
        setLastId: () => unused,
        setLastDate: () => unused,
        lastStatement: (account) => limiter.run(account.tokenFingerprint, "interactive", Effect.succeed(LAST_STATEMENT)),
        merchantRaw: () => unused,
        importXml: () => unused,
      });
    }),
  );

/**
 * The app's services with a fake FioApi; one instance shared by every
 * session. `accounts` defaults to the configured ones (FIO_TOKEN /
 * FIO_ACCOUNTS); the OAuth harness passes the database-backed layer.
 */
export const testServices = <E = never, R = never>(
  config: AppConfigShape,
  release: Deferred.Deferred<void>,
  accounts: Layer.Layer<Accounts, E, R | Redactor | AppConfig> = Accounts.layer as Layer.Layer<Accounts, E, R | Redactor | AppConfig>,
) =>
  Layer.mergeAll(fakeFioApi(release), Layer.succeed(TransactionCache, { enabled: false })).pipe(
    Layer.provideMerge(Layer.mergeAll(accounts, RateLimiter.layer)),
    Layer.provideMerge(Redactor.layer),
    Layer.provideMerge(AppConfig.layerFrom(config)),
  );
