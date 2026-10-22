import { Deferred, Effect, Layer, Redacted } from "effect";
import { Accounts } from "../../src/accounts.js";
import { AppConfig, type AppConfigShape, type TransportConfig } from "../../src/config.js";
import { FioApi } from "../../src/fio-api.js";
import { RateLimiter } from "../../src/rate-limiter.js";
import { Redactor } from "../../src/redaction.js";
import type { NormalizedStatement } from "../../src/statement.js";

/** A FIO-shaped read token (64 URL-safe characters). */
export const FIO_TOKEN = "fioT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRS";
const SAVINGS_TOKEN = "savingsT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN";
export const AUTH_TOKEN = "bearer-0123456789abcdefghijklmnopqrstuvwxyzABCDEF";

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
    secrets: [
      token,
      savings,
      ...(transport.kind === "http" && transport.authToken !== undefined ? [transport.authToken] : []),
    ],
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

/**
 * A FioApi whose `periods` goes through the real RateLimiter and holds its
 * slot until `release` completes. Every other call dies: tests must not
 * reach them.
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
        lastStatement: () => unused,
        merchantRaw: () => unused,
        importXml: () => unused,
      });
    }),
  );

/** The app's services with a fake FioApi; one instance shared by every session. */
export const testServices = (config: AppConfigShape, release: Deferred.Deferred<void>) =>
  fakeFioApi(release).pipe(
    Layer.provideMerge(Layer.mergeAll(Redactor.layer, Accounts.layer, RateLimiter.layer)),
    Layer.provideMerge(AppConfig.layerFrom(config)),
  );
