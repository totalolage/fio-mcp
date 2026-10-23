import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { MIN_RATE_LIMIT_INTERVAL_MS } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { hashPassword } from "../src/oauth/crypto.js";
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
      const missing = yield* configError({ FIO_TOKEN_FILE: "/nonexistent/fio-token" });
      assert.strictEqual(missing, "FIO_TOKEN_FILE: file not readable");
    }),
  );

  it.effect("never echoes the value or path of a *_FILE variable", () =>
    Effect.gen(function* () {
      // A token pasted into a _FILE variable is read as a path; it must not be printed.
      const pasted = "Xq7LmR2vT9bWc4NzK8pJd3HsF6gYa1UeQ5oVi0nZrM2tB7xLw4kCj9hPy3sDf8Ga";
      const pastedDir = join(mkdtempSync(join(tmpdir(), "fio-mcp-config-")), pasted);
      mkdirSync(pastedDir);
      const fileIn = (content: string) => {
        const path = join(pastedDir, `secret-${content.length}`);
        writeFileSync(path, content, { mode: 0o440 });
        return path;
      };
      const http = {
        FIO_TOKEN: READ_TOKEN,
        FIO_MCP_TRANSPORT: "http",
        FIO_MCP_PUBLIC_URL: "https://fio.example.test",
      };
      const attempts: Array<[Record<string, string>, string]> = [
        [{ FIO_TOKEN_FILE: pasted }, "FIO_TOKEN_FILE: file not readable"],
        [{ FIO_TOKEN_FILE: fileIn("\n") }, "FIO_TOKEN_FILE: file is empty"],
        [{ FIO_ACCOUNTS_FILE: pasted }, "FIO_ACCOUNTS_FILE: file not readable"],
        [{ FIO_ACCOUNTS_FILE: fileIn("  \n") }, "FIO_ACCOUNTS_FILE: file is empty"],
        [{ ...http, FIO_MCP_ADMIN_PASSWORD_HASH_FILE: pasted }, "FIO_MCP_ADMIN_PASSWORD_HASH_FILE: file not readable"],
        [
          { ...http, FIO_MCP_ADMIN_PASSWORD_HASH_FILE: fileIn("") },
          "FIO_MCP_ADMIN_PASSWORD_HASH_FILE: file must contain exactly one hash line",
        ],
        [
          { ...http, FIO_MCP_ADMIN_PASSWORD_HASH_FILE: fileIn("not-a-hash") },
          "FIO_MCP_ADMIN_PASSWORD_HASH_FILE: file is not a fio-mcp password hash ($scrypt$ln=…,r=…,p=…$salt$hash); create one with `fio-mcp hash-password`",
        ],
      ];
      for (const [env, expected] of attempts) {
        const error = yield* Effect.flip(loadConfigFrom(env));
        assert.instanceOf(error, ConfigError);
        assert.strictEqual(error.message, expected);
        for (const output of [error.message, error.detail, String(error), JSON.stringify(error)]) {
          assert.notInclude(output, pasted.slice(0, 20), JSON.stringify(Object.keys(env)));
        }
      }
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

  it.effect("loads OAuth HTTP auth config and normalizes the public origin", () =>
    Effect.gen(function* () {
      const hash = yield* hashPassword(Redacted.make("test-admin-password"), { ln: 14, r: 8, p: 1 });
      const hashFile = secretFile(`${hash}\n`);
      const env = {
        FIO_TOKEN: READ_TOKEN,
        FIO_MCP_TRANSPORT: "http",
        FIO_MCP_PUBLIC_URL: "https://fio.example.test",
        FIO_MCP_ADMIN_PASSWORD_HASH_FILE: hashFile,
      };

      const config = yield* loadConfigFrom(env);
      assert.strictEqual(config.transport.kind, "http");
      if (config.transport.kind === "http") {
        assert.strictEqual(config.transport.auth.kind, "oauth");
        if (config.transport.auth.kind === "oauth") {
          assert.strictEqual(config.transport.auth.publicUrl, "https://fio.example.test");
        }
      }

      const normalized = yield* loadConfigFrom({ ...env, FIO_MCP_PUBLIC_URL: "https://FIO.example.test/" });
      assert.strictEqual(normalized.transport.kind, "http");
      if (normalized.transport.kind === "http" && normalized.transport.auth.kind === "oauth") {
        assert.strictEqual(normalized.transport.auth.publicUrl, "https://fio.example.test");
      }
    }),
  );

  it.effect("requires OAuth settings unless unauthenticated HTTP is explicitly allowed", () =>
    Effect.gen(function* () {
      const env = { FIO_TOKEN: READ_TOKEN, FIO_MCP_TRANSPORT: "http" };
      const message = yield* configError(env);
      assert.include(message, "HTTP mode requires FIO_MCP_PUBLIC_URL and FIO_MCP_ADMIN_PASSWORD_HASH_FILE");

      const open = yield* loadConfigFrom({ ...env, FIO_MCP_ALLOW_UNAUTHENTICATED: "true" });
      assert.strictEqual(open.transport.kind, "http");
      if (open.transport.kind === "http") assert.strictEqual(open.transport.auth.kind, "unauthenticated");
    }),
  );

  it.effect("requires both OAuth public URL and password hash file", () =>
    Effect.gen(function* () {
      const publicOnly = yield* configError({
        FIO_TOKEN: READ_TOKEN,
        FIO_MCP_TRANSPORT: "http",
        FIO_MCP_PUBLIC_URL: "https://fio.example.test",
      });
      assert.include(publicOnly, "FIO_MCP_ADMIN_PASSWORD_HASH_FILE is not");

      const hashOnly = yield* configError({
        FIO_TOKEN: READ_TOKEN,
        FIO_MCP_TRANSPORT: "http",
        FIO_MCP_ADMIN_PASSWORD_HASH_FILE: secretFile("unused\n"),
      });
      assert.include(hashOnly, "FIO_MCP_PUBLIC_URL is not");
    }),
  );

  it.effect("ignores the removed static bearer token: HTTP mode still requires OAuth", () =>
    Effect.gen(function* () {
      const value = "legacy-bearer-secret-value";
      const message = yield* configError({
        FIO_TOKEN: READ_TOKEN,
        FIO_MCP_TRANSPORT: "http",
        FIO_MCP_AUTH_TOKEN: value,
      });
      assert.include(message, "HTTP mode requires FIO_MCP_PUBLIC_URL and FIO_MCP_ADMIN_PASSWORD_HASH_FILE");
      assert.notInclude(message, value);
    }),
  );

  it.effect("validates OAuth public URL origins and allows loopback HTTP", () =>
    Effect.gen(function* () {
      const hash = yield* hashPassword(Redacted.make("test-admin-password"), { ln: 14, r: 8, p: 1 });
      const common = {
        FIO_TOKEN: READ_TOKEN,
        FIO_MCP_TRANSPORT: "http",
        FIO_MCP_ADMIN_PASSWORD_HASH_FILE: secretFile(`${hash}\n`),
      };

      const path = yield* configError({ ...common, FIO_MCP_PUBLIC_URL: "https://fio.example.test/base" });
      assert.include(path, "must be an origin");
      const insecure = yield* configError({ ...common, FIO_MCP_PUBLIC_URL: "http://fio.example.test" });
      assert.include(insecure, "must use https");

      const loopback = yield* loadConfigFrom({ ...common, FIO_MCP_PUBLIC_URL: "http://127.0.0.1:3000" });
      assert.strictEqual(loopback.transport.kind, "http");
      if (loopback.transport.kind === "http" && loopback.transport.auth.kind === "oauth") {
        assert.strictEqual(loopback.transport.auth.publicUrl, "http://127.0.0.1:3000");
      }
    }),
  );

  it.effect("rejects malformed password hash files without echoing their contents", () =>
    Effect.gen(function* () {
      const secret = "not-a-hash-secretvalue";
      const message = yield* configError({
        FIO_TOKEN: READ_TOKEN,
        FIO_MCP_TRANSPORT: "http",
        FIO_MCP_PUBLIC_URL: "https://fio.example.test",
        FIO_MCP_ADMIN_PASSWORD_HASH_FILE: secretFile(secret),
      });
      assert.include(message, "is not a fio-mcp password hash");
      assert.notInclude(message, "secretvalue");
    }),
  );

  it.effect("accepts a hash file with a trailing LF or CRLF and rejects captured prompts without echoing them", () =>
    Effect.gen(function* () {
      const hash = yield* hashPassword(Redacted.make("test-admin-password"), { ln: 14, r: 8, p: 1 });
      const env = { FIO_TOKEN: READ_TOKEN, FIO_MCP_TRANSPORT: "http", FIO_MCP_PUBLIC_URL: "https://fio.example.test" };
      for (const content of [`${hash}\n`, `${hash}\r\n`]) {
        const config = yield* loadConfigFrom({ ...env, FIO_MCP_ADMIN_PASSWORD_HASH_FILE: secretFile(content) });
        assert.strictEqual(config.transport.kind, "http");
      }
      // What `docker run -t … > admin.hash` captured: the prompts land in the file.
      const path = secretFile(`Admin password: \n${hash}\n`);
      const message = yield* configError({ ...env, FIO_MCP_ADMIN_PASSWORD_HASH_FILE: path });
      assert.strictEqual(message, "FIO_MCP_ADMIN_PASSWORD_HASH_FILE: file must contain exactly one hash line");
      assert.notInclude(message, path);
      assert.notInclude(message, "Admin password");
      assert.notInclude(message, hash);
    }),
  );

  it.effect("reads trusted proxies and rejects invalid entries without echoing them", () =>
    Effect.gen(function* () {
      const env = { FIO_TOKEN: READ_TOKEN, FIO_MCP_TRANSPORT: "http", FIO_MCP_ALLOW_UNAUTHENTICATED: "true" };
      const config = yield* loadConfigFrom({ ...env, FIO_MCP_TRUSTED_PROXIES: "172.18.0.0/16, 10.0.0.2,fd00::/8" });
      assert.strictEqual(config.transport.kind === "http" ? config.transport.trustedProxies.length : 0, 3);
      const message = yield* configError({ ...env, FIO_MCP_TRUSTED_PROXIES: "172.18.0.0/16,secret-proxy-name" });
      assert.include(message, "FIO_MCP_TRUSTED_PROXIES entry 2");
      assert.notInclude(message, "secret-proxy-name");
    }),
  );

  it.effect("reads HTTP transport and cache settings", () =>
    Effect.gen(function* () {
      const config = yield* loadConfigFrom({
        FIO_TOKEN: READ_TOKEN,
        FIO_MCP_TRANSPORT: "HTTP",
        FIO_MCP_ALLOW_UNAUTHENTICATED: "true",
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
        auth: { kind: "unauthenticated" },
        allowedOrigins: ["https://a.example", "https://b.example"],
        allowedHosts: ["fio.example:443", "localhost"],
        trustedProxies: [],
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
