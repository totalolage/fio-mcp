import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { FioApiError } from "../src/errors.js";
import { FioClient } from "../src/fio-client.js";
import { TokenRateLimiter } from "../src/rate-limiter.js";
import { clearSecrets, redact, registerSecret } from "../src/redact.js";
import { PAY_TOKEN, READ_TOKEN } from "./fixtures.js";

describe("loadConfig", () => {
  it("defaults a single token to read-only", () => {
    const config = loadConfig({ FIO_TOKEN: READ_TOKEN });
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0]).toMatchObject({ name: "default", token: READ_TOKEN });
    expect([...config.accounts[0]!.permissions]).toEqual(["read"]);
    expect(config).toMatchObject({
      baseUrl: "https://fioapi.fio.cz/v1/rest",
      rateLimitIntervalMs: 30_000,
      maxWaitMs: 25_000,
    });
  });

  it("reads single-token permissions and account details", () => {
    const config = loadConfig({
      FIO_TOKEN: PAY_TOKEN,
      FIO_TOKEN_PERMISSIONS: "read,payments",
      FIO_ACCOUNT_NAME: "main",
      FIO_ACCOUNT_NUMBER: "2400222222",
      FIO_ACCOUNT_CURRENCY: "czk",
      FIO_MAX_WAIT_MS: "10000",
    });
    expect(config.accounts[0]).toMatchObject({ name: "main", accountNumber: "2400222222", currency: "CZK" });
    expect([...config.accounts[0]!.permissions].sort()).toEqual(["payments", "read"]);
    expect(config.maxWaitMs).toBe(10_000);
  });

  it("reads several accounts from FIO_ACCOUNTS", () => {
    const config = loadConfig({
      FIO_ACCOUNTS: JSON.stringify([
        { name: "personal", token: READ_TOKEN },
        { name: "business", token: PAY_TOKEN, permissions: ["read", "payments"] },
      ]),
    });
    expect(config.accounts.map((a) => [a.name, [...a.permissions].sort()])).toEqual([
      ["personal", ["read"]],
      ["business", ["payments", "read"]],
    ]);
  });

  it("rejects bad configuration without echoing tokens", () => {
    const attempts: Record<string, string>[] = [
      {},
      { FIO_TOKEN: READ_TOKEN, FIO_ACCOUNTS: "[]" },
      { FIO_ACCOUNTS: `[{"name":"a","token":"${READ_TOKEN}"` },
      { FIO_ACCOUNTS: JSON.stringify([{ name: "a", token: READ_TOKEN, permissions: "write" }]) },
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
