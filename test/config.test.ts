import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { MIN_RATE_LIMIT_INTERVAL_MS } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { loadConfigFrom, PAY_TOKEN, READ_TOKEN } from "./fixtures.js";

const configError = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(loadConfigFrom(env));
    assert.instanceOf(error, ConfigError);
    return error.message;
  });

const secretFile = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "fio-mcp-config-"));
  const path = join(dir, "secret");
  writeFileSync(path, content, { mode: 0o440 });
  return path;
};

describe("loadConfig", () => {
  it.effect("reads a single token with defaults", () =>
    Effect.gen(function* () {
      const config = yield* loadConfigFrom({ FIO_TOKEN: READ_TOKEN });
      assert.strictEqual(config.accounts.length, 1);
      const [account] = config.accounts;
      assert.strictEqual(account?.name, "default");
      assert.strictEqual(account && Redacted.value(account.token), READ_TOKEN);
      assert.isUndefined(account?.accountNumber);
      assert.strictEqual(config.baseUrl, "https://fioapi.fio.cz/v1/rest");
      assert.strictEqual(config.rateLimitIntervalMs, 30_000);
      assert.strictEqual(config.maxWaitMs, 25_000);
      assert.deepStrictEqual(config.transport, { kind: "stdio" });
      assert.strictEqual(config.cache.dbPath, "/home/test/.local/share/fio-mcp/fio.sqlite");
      // The token is held as Redacted and never printed.
      assert.notInclude(String(account?.token), READ_TOKEN);
      assert.notInclude(JSON.stringify(config), READ_TOKEN);
    }),
  );

  it.effect("reads single-token account details", () =>
    Effect.gen(function* () {
      const config = yield* loadConfigFrom({
        FIO_TOKEN: PAY_TOKEN,
        FIO_ACCOUNT_NAME: "main",
        FIO_ACCOUNT_NUMBER: "2400222222",
        FIO_ACCOUNT_CURRENCY: "czk",
        FIO_MAX_WAIT_MS: "10000",
      });
      assert.deepInclude(config.accounts[0], { name: "main", accountNumber: "2400222222", currency: "CZK" });
      assert.strictEqual(config.maxWaitMs, 10_000);
    }),
  );

  it.effect("reads several accounts from FIO_ACCOUNTS", () =>
    Effect.gen(function* () {
      const config = yield* loadConfigFrom({
        FIO_ACCOUNTS: JSON.stringify([
          { name: "personal", token: READ_TOKEN },
          { name: "business", token: PAY_TOKEN, accountNumber: "2400222222" },
        ]),
      });
      assert.deepStrictEqual(
        config.accounts.map((a) => [a.name, a.accountNumber]),
        [
          ["personal", undefined],
          ["business", "2400222222"],
        ],
      );
      assert.strictEqual(config.secrets.length, 2);
    }),
  );

  it.effect("reads secrets from *_FILE variables and drops the trailing newline", () =>
    Effect.gen(function* () {
      const single = yield* loadConfigFrom({ FIO_TOKEN_FILE: secretFile(`${READ_TOKEN}\n`) });
      assert.strictEqual(Redacted.value(single.accounts[0]?.token ?? Redacted.make("")), READ_TOKEN);
      const multi = yield* loadConfigFrom({
        FIO_ACCOUNTS_FILE: secretFile(`${JSON.stringify([{ name: "a", token: PAY_TOKEN }])}\n`),
      });
      assert.strictEqual(multi.accounts[0]?.name, "a");
      const http = yield* loadConfigFrom({
        FIO_TOKEN: READ_TOKEN,
        FIO_MCP_TRANSPORT: "http",
        FIO_MCP_AUTH_TOKEN_FILE: secretFile("bearer-secret-0123456789\n"),
      });
      assert.strictEqual(http.transport.kind, "http");
      if (http.transport.kind === "http") {
        assert.strictEqual(http.transport.authToken && Redacted.value(http.transport.authToken), "bearer-secret-0123456789");
      }
      assert.strictEqual(http.secrets.length, 2);
    }),
  );

  it.effect("rejects a secret set both directly and as a file, naming only the variables", () =>
    Effect.gen(function* () {
      const path = secretFile(READ_TOKEN);
      assert.strictEqual(
        yield* configError({ FIO_TOKEN: READ_TOKEN, FIO_TOKEN_FILE: path }),
        "Set either FIO_TOKEN or FIO_TOKEN_FILE, not both",
      );
      assert.strictEqual(
        yield* configError({ FIO_ACCOUNTS: "[]", FIO_ACCOUNTS_FILE: path }),
        "Set either FIO_ACCOUNTS or FIO_ACCOUNTS_FILE, not both",
      );
      assert.strictEqual(
        yield* configError({
          FIO_TOKEN: READ_TOKEN,
          FIO_MCP_TRANSPORT: "http",
          FIO_MCP_AUTH_TOKEN: "x".repeat(20),
          FIO_MCP_AUTH_TOKEN_FILE: path,
        }),
        "Set either FIO_MCP_AUTH_TOKEN or FIO_MCP_AUTH_TOKEN_FILE, not both",
      );
      const missing = yield* configError({ FIO_TOKEN_FILE: "/nonexistent/fio-token" });
      assert.strictEqual(missing, "FIO_TOKEN_FILE: cannot read /nonexistent/fio-token");
    }),
  );

  it.effect("rejects tokens shorter than 32 characters or with unsafe characters", () =>
    Effect.gen(function* () {
      for (const token of ["short", "a".repeat(31), `${"a".repeat(40)}/x`, `${"a".repeat(40)}"x`]) {
        const message = yield* configError({ FIO_TOKEN: token });
        assert.match(message, /^Invalid account configuration: FIO_TOKEN must be at least 32 characters/);
        assert.notInclude(message, token);
      }
      const ok = yield* loadConfigFrom({ FIO_TOKEN: "a".repeat(32) });
      assert.strictEqual(ok.accounts.length, 1);
    }),
  );

  it.effect("rejects bad configuration without echoing tokens", () =>
    Effect.gen(function* () {
      const attempts: Array<Record<string, string>> = [
        {},
        { FIO_TOKEN: READ_TOKEN, FIO_ACCOUNTS: "[]" },
        { FIO_ACCOUNTS: `[{"name":"a","token":"${READ_TOKEN}"` },
        { FIO_ACCOUNTS: JSON.stringify([{ name: "a", token: READ_TOKEN, unknownKey: true }]) },
        { FIO_ACCOUNTS: JSON.stringify([{ name: "a", token: READ_TOKEN }, { name: "a", token: PAY_TOKEN }]) },
        { FIO_ACCOUNTS: JSON.stringify([{ name: "bad name", token: READ_TOKEN }]) },
        { FIO_TOKEN: READ_TOKEN, FIO_RATE_LIMIT_INTERVAL_MS: "soon" },
        { FIO_TOKEN: READ_TOKEN, FIO_MCP_TRANSPORT: "carrier-pigeon" },
        { FIO_TOKEN: READ_TOKEN, FIO_MCP_TRANSPORT: "http", FIO_MCP_PORT: "70000" },
        { FIO_TOKEN: READ_TOKEN, FIO_MCP_TRANSPORT: "http", FIO_MCP_AUTH_TOKEN: "short" },
        { FIO_TOKEN: READ_TOKEN, FIO_BACKFILL_FROM: "2024-02-30" },
        { FIO_TOKEN: READ_TOKEN, FIO_SYNC_INTERVAL_MINUTES: "1" },
        { FIO_TOKEN: READ_TOKEN, FIO_CACHE_ENABLED: "maybe" },
      ];
      for (const env of attempts) {
        const message = yield* configError(env);
        assert.notInclude(message, READ_TOKEN);
        assert.notInclude(message, PAY_TOKEN);
      }
    }),
  );

  it.effect("never echoes a token pasted into the wrong variable or field", () =>
    Effect.gen(function* () {
      const attempts: Array<Record<string, string>> = [
        { FIO_TOKEN: PAY_TOKEN, FIO_MAX_WAIT_MS: READ_TOKEN },
        { FIO_TOKEN: PAY_TOKEN, FIO_REQUEST_TIMEOUT_MS: READ_TOKEN },
        { FIO_TOKEN: PAY_TOKEN, FIO_RATE_LIMIT_INTERVAL_MS: READ_TOKEN },
        { FIO_TOKEN: PAY_TOKEN, FIO_ACCOUNT_NAME: READ_TOKEN },
        { FIO_TOKEN: PAY_TOKEN, FIO_ACCOUNT_NUMBER: READ_TOKEN },
        { FIO_TOKEN: PAY_TOKEN, FIO_ACCOUNT_CURRENCY: READ_TOKEN },
        { FIO_TOKEN: PAY_TOKEN, FIO_MCP_TRANSPORT: READ_TOKEN },
        { FIO_TOKEN: PAY_TOKEN, FIO_BACKFILL_FROM: READ_TOKEN },
        { FIO_ACCOUNTS: JSON.stringify([{ name: READ_TOKEN, token: PAY_TOKEN }]) },
        { FIO_ACCOUNTS: JSON.stringify([{ name: "a", token: PAY_TOKEN, [READ_TOKEN]: true }]) },
        { FIO_ACCOUNTS: JSON.stringify([{ name: "a", token: PAY_TOKEN, currency: READ_TOKEN }]) },
        { FIO_ACCOUNTS: JSON.stringify([READ_TOKEN]) },
        { FIO_ACCOUNTS: `[{"name":"a","token":${READ_TOKEN}}]` },
      ];
      for (const env of attempts) {
        const message = yield* configError(env);
        assert.notInclude(message, READ_TOKEN.slice(0, 20), JSON.stringify(Object.keys(env)));
        assert.notInclude(message, PAY_TOKEN.slice(0, 20));
      }
      assert.strictEqual(
        yield* configError({ FIO_TOKEN: PAY_TOKEN, FIO_MAX_WAIT_MS: READ_TOKEN }),
        "FIO_MAX_WAIT_MS must be an integer >= 0",
      );
      assert.strictEqual(
        yield* configError({ FIO_ACCOUNTS: JSON.stringify([{ name: "a", token: PAY_TOKEN, [READ_TOKEN]: true }]) }),
        "Invalid account configuration: FIO_ACCOUNTS[0] has unknown fields; allowed fields are name, token, accountNumber, currency",
      );
    }),
  );

  it.effect("rejects rate-limit intervals below FIO's 30 s limit", () =>
    Effect.gen(function* () {
      for (const value of ["0", "1", "29999"]) {
        assert.strictEqual(
          yield* configError({ FIO_TOKEN: READ_TOKEN, FIO_RATE_LIMIT_INTERVAL_MS: value }),
          "FIO_RATE_LIMIT_INTERVAL_MS must be an integer >= 30000 (FIO allows one request per token every 30 s)",
        );
      }
      assert.strictEqual((yield* loadConfigFrom({ FIO_TOKEN: READ_TOKEN, FIO_RATE_LIMIT_INTERVAL_MS: "30000" })).rateLimitIntervalMs, 30_000);
      assert.strictEqual((yield* loadConfigFrom({ FIO_TOKEN: READ_TOKEN, FIO_RATE_LIMIT_INTERVAL_MS: "45000" })).rateLimitIntervalMs, 45_000);
      assert.strictEqual(MIN_RATE_LIMIT_INTERVAL_MS, 30_000);
    }),
  );

  it.effect("reads HTTP transport and cache settings", () =>
    Effect.gen(function* () {
      const config = yield* loadConfigFrom({
        FIO_TOKEN: READ_TOKEN,
        FIO_MCP_TRANSPORT: "HTTP",
        FIO_MCP_PORT: "8080",
        FIO_MCP_ALLOWED_ORIGINS: "https://a.example, https://b.example",
        FIO_MCP_ALLOWED_HOSTS: "Fio.Example:443,localhost",
        FIO_DB_PATH: "/data/fio.sqlite",
        FIO_SYNC_INTERVAL_MINUTES: "30",
        FIO_SYNC_ON_STARTUP: "false",
        FIO_BACKFILL_FROM: "2015-01-01",
      });
      assert.deepStrictEqual(config.transport, {
        kind: "http",
        host: "0.0.0.0",
        port: 8080,
        authToken: undefined,
        allowedOrigins: ["https://a.example", "https://b.example"],
        allowedHosts: ["fio.example:443", "localhost"],
      });
      assert.deepInclude(config.cache, {
        enabled: true,
        dbPath: "/data/fio.sqlite",
        syncOnStartup: false,
        syncIntervalMinutes: 30,
        backfillFrom: "2015-01-01",
      });
      const xdg = yield* loadConfigFrom({ FIO_TOKEN: READ_TOKEN, XDG_DATA_HOME: "/xdg" });
      assert.strictEqual(xdg.cache.dbPath, "/xdg/fio-mcp/fio.sqlite");
    }),
  );
});
