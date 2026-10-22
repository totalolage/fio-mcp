import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, MIN_RATE_LIMIT_INTERVAL_MS, loadConfig } from "../src/config.js";
import { FioApiError } from "../src/errors.js";
import { FioClient, excerpt } from "../src/fio-client.js";
import { TokenRateLimiter } from "../src/rate-limiter.js";
import { clearSecrets, redact, registerSecret } from "../src/redact.js";
import { PAY_TOKEN, READ_TOKEN } from "./fixtures.js";

function configError(env: Record<string, string>): Error {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as Error;
  }
  throw new Error("loadConfig accepted invalid configuration");
}

describe("loadConfig", () => {
  afterEach(() => clearSecrets());

  it("reads a single token with defaults", () => {
    const config = loadConfig({ FIO_TOKEN: READ_TOKEN });
    expect(config.accounts).toEqual([{ name: "default", token: READ_TOKEN, accountNumber: undefined, currency: undefined }]);
    expect(config).toMatchObject({
      baseUrl: "https://fioapi.fio.cz/v1/rest",
      rateLimitIntervalMs: 30_000,
      maxWaitMs: 25_000,
    });
  });

  it("reads single-token account details", () => {
    const config = loadConfig({
      FIO_TOKEN: PAY_TOKEN,
      FIO_ACCOUNT_NAME: "main",
      FIO_ACCOUNT_NUMBER: "2400222222",
      FIO_ACCOUNT_CURRENCY: "czk",
      FIO_MAX_WAIT_MS: "10000",
    });
    expect(config.accounts[0]).toMatchObject({ name: "main", accountNumber: "2400222222", currency: "CZK" });
    expect(config.maxWaitMs).toBe(10_000);
  });

  it("reads several accounts from FIO_ACCOUNTS", () => {
    const config = loadConfig({
      FIO_ACCOUNTS: JSON.stringify([
        { name: "personal", token: READ_TOKEN },
        { name: "business", token: PAY_TOKEN, accountNumber: "2400222222" },
      ]),
    });
    expect(config.accounts.map((a) => [a.name, a.accountNumber])).toEqual([
      ["personal", undefined],
      ["business", "2400222222"],
    ]);
  });

  it("rejects bad configuration without echoing tokens", () => {
    const attempts: Record<string, string>[] = [
      {},
      { FIO_TOKEN: READ_TOKEN, FIO_ACCOUNTS: "[]" },
      { FIO_ACCOUNTS: `[{"name":"a","token":"${READ_TOKEN}"` },
      { FIO_ACCOUNTS: JSON.stringify([{ name: "a", token: READ_TOKEN, unknownKey: true }]) },
      { FIO_ACCOUNTS: JSON.stringify([{ name: "a", token: READ_TOKEN }, { name: "a", token: PAY_TOKEN }]) },
      { FIO_ACCOUNTS: JSON.stringify([{ name: "bad name", token: READ_TOKEN }]) },
      { FIO_TOKEN: READ_TOKEN, FIO_RATE_LIMIT_INTERVAL_MS: "soon" },
    ];
    for (const env of attempts) {
      let error: unknown;
      try {
        loadConfig(env);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(READ_TOKEN);
      expect((error as Error).message).not.toContain(PAY_TOKEN);
    }
  });

  it("never echoes a token pasted into the wrong variable or field", () => {
    const attempts: Record<string, string>[] = [
      { FIO_TOKEN: PAY_TOKEN, FIO_MAX_WAIT_MS: READ_TOKEN },
      { FIO_TOKEN: PAY_TOKEN, FIO_REQUEST_TIMEOUT_MS: READ_TOKEN },
      { FIO_TOKEN: PAY_TOKEN, FIO_RATE_LIMIT_INTERVAL_MS: READ_TOKEN },
      { FIO_TOKEN: PAY_TOKEN, FIO_ACCOUNT_NAME: READ_TOKEN },
      { FIO_TOKEN: PAY_TOKEN, FIO_ACCOUNT_NUMBER: READ_TOKEN },
      { FIO_TOKEN: PAY_TOKEN, FIO_ACCOUNT_CURRENCY: READ_TOKEN },
      { FIO_ACCOUNTS: JSON.stringify([{ name: READ_TOKEN, token: PAY_TOKEN }]) },
      { FIO_ACCOUNTS: JSON.stringify([{ name: "a", token: PAY_TOKEN, [READ_TOKEN]: true }]) },
      { FIO_ACCOUNTS: JSON.stringify([{ name: "a", token: PAY_TOKEN, currency: READ_TOKEN }]) },
      { FIO_ACCOUNTS: JSON.stringify([READ_TOKEN]) },
      { FIO_ACCOUNTS: `[{"name":"a","token":${READ_TOKEN}}]` },
    ];
    for (const env of attempts) {
      const message = configError(env).message;
      // Checked before any redaction: the message itself must not carry the value.
      expect(message, JSON.stringify(Object.keys(env))).not.toContain(READ_TOKEN.slice(0, 20));
      expect(message).not.toContain(PAY_TOKEN.slice(0, 20));
    }
    expect(configError({ FIO_TOKEN: PAY_TOKEN, FIO_MAX_WAIT_MS: READ_TOKEN }).message).toBe(
      "FIO_MAX_WAIT_MS must be an integer >= 0",
    );
    expect(configError({ FIO_ACCOUNTS: JSON.stringify([{ name: "a", token: PAY_TOKEN, [READ_TOKEN]: true }]) }).message).toBe(
      "Invalid account configuration: FIO_ACCOUNTS[0] has unknown fields; allowed fields are name, token, accountNumber, currency",
    );
  });

  it("registers tokens for redaction before validation can fail", () => {
    configError({ FIO_TOKEN: READ_TOKEN, FIO_MAX_WAIT_MS: "soon" });
    expect(redact(`leaked ${READ_TOKEN}`)).toBe("leaked ***");
    clearSecrets();

    configError({
      FIO_ACCOUNTS: JSON.stringify([
        { name: "ok", token: READ_TOKEN },
        { name: "bad name", token: PAY_TOKEN },
      ]),
    });
    expect(redact(`${READ_TOKEN} ${PAY_TOKEN}`)).toBe("*** ***");
  });

  it("rejects rate-limit intervals below FIO's 30 s limit", () => {
    expect(MIN_RATE_LIMIT_INTERVAL_MS).toBe(30_000);
    for (const value of ["0", "1", "29999"]) {
      expect(configError({ FIO_TOKEN: READ_TOKEN, FIO_RATE_LIMIT_INTERVAL_MS: value }).message).toBe(
        "FIO_RATE_LIMIT_INTERVAL_MS must be an integer >= 30000 (FIO allows one request per token every 30 s)",
      );
    }
    expect(loadConfig({ FIO_TOKEN: READ_TOKEN, FIO_RATE_LIMIT_INTERVAL_MS: "30000" }).rateLimitIntervalMs).toBe(30_000);
    expect(loadConfig({ FIO_TOKEN: READ_TOKEN, FIO_RATE_LIMIT_INTERVAL_MS: "45000" }).rateLimitIntervalMs).toBe(45_000);
  });
});

describe("token redaction", () => {
  afterEach(() => clearSecrets());

  it("redacts registered tokens anywhere in text", () => {
    registerSecret(READ_TOKEN);
    expect(redact(`token=${READ_TOKEN}&x=1`)).toBe("token=***&x=1");
  });

  it("redacts token path segments even for unknown tokens", () => {
    expect(redact("GET https://fioapi.fio.cz/v1/rest/periods/SECRET123/2024-01-01/2024-01-31/transactions.json")).toBe(
      "GET https://fioapi.fio.cz/v1/rest/periods/***/2024-01-01/2024-01-31/transactions.json",
    );
    expect(redact("/set-last-id/SECRET/123/ and /lastStatement/SECRET/statement")).toBe(
      "/set-last-id/***/123/ and /lastStatement/***/statement",
    );
  });

  it("redacts a token that straddles the excerpt truncation point", () => {
    registerSecret(READ_TOKEN);
    const short = excerpt(`${"x".repeat(280)}${READ_TOKEN}`);
    expect(short).not.toContain(READ_TOKEN.slice(0, 20));
    expect(short).toBe(`${"x".repeat(280)}***`);
    const tagged = excerpt(`<html><body>${"x".repeat(290)}<b>${READ_TOKEN}</b> tail</body></html>`);
    expect(tagged).not.toContain(READ_TOKEN.slice(0, 5));
  });

  it("redacts JSON-escaped tokens", () => {
    registerSecret('ab"cd\\ef');
    expect(redact(JSON.stringify({ token: 'ab"cd\\ef' }))).toBe('{"token":"***"}');
  });

  it("keeps tokens out of client errors", async () => {
    registerSecret(READ_TOKEN);
    const limiter = new TokenRateLimiter({ intervalMs: 0, maxWaitMs: 1000 });
    const failing = new FioClient({
      baseUrl: "https://fioapi.test/v1/rest",
      token: READ_TOKEN,
      limiter,
      requestTimeoutMs: 1000,
      fetch: async (url) => {
        throw new TypeError(`fetch failed for ${String(url)}`, { cause: new Error(`connect ECONNREFUSED ${String(url)}`) });
      },
    });
    const networkError = await failing.lastStatement().catch((e: unknown) => e);
    expect(networkError).toBeInstanceOf(FioApiError);
    expect((networkError as Error).message).toContain("/lastStatement/***/statement");
    expect((networkError as Error).message).not.toContain(READ_TOKEN);

    const echoing = new FioClient({
      baseUrl: "https://fioapi.test/v1/rest",
      token: READ_TOKEN,
      limiter,
      requestTimeoutMs: 1000,
      fetch: async (url) => new Response(`<html>bad request for ${String(url)}</html>`, { status: 404 }),
    });
    const httpError = await echoing.periods("2024-01-01", "2024-01-02", "json").catch((e: unknown) => e);
    expect(httpError).toMatchObject({ kind: "bad_request", status: 404 });
    expect((httpError as Error).message).not.toContain(READ_TOKEN);
  });
});
