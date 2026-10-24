import { type Deferred, Layer, Redacted } from "effect";
import { Accounts } from "../../src/accounts.js";
import { Transactions } from "../../src/cache/service.js";
import { type AppConfigShape, MAX_RESPONSE_BYTES, type TransportConfig } from "../../src/config.js";
import { RateLimiter } from "../../src/rate-limiter.js";
import { Redactor } from "../../src/redaction.js";
import { seededConfig } from "./config.js";
import { slotHoldingFio } from "./fio-api.js";

/** A FIO-shaped read token (64 URL-safe characters). */
export const FIO_TOKEN = "fioT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRS";
export const SAVINGS_TOKEN = "savingsT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN";

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
    maxResponseBytes: MAX_RESPONSE_BYTES,
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

/** The app's services with a fake FioApi; one instance shared by every session. */
export const testServices = (config: AppConfigShape, release: Deferred.Deferred<void>) =>
  Transactions.Disabled.pipe(
    Layer.provideMerge(slotHoldingFio(release)),
    Layer.provideMerge(Layer.mergeAll(Redactor.Default, Accounts.Default, RateLimiter.Default)),
    Layer.provideMerge(seededConfig(config)),
  );
