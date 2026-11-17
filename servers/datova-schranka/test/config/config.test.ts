import { assert, describe, it } from "@effect/vitest";
import { ConfigError } from "@mcps/core/config/env.js";
import { Duration, Effect, Layer, Redacted } from "effect";
import { DomainLive } from "../../src/config.js";
import { DataKey, DomainConfig } from "../../src/domain/config.js";
import { appConfigFrom, DATA_KEY_HEX, loadConfigFrom, requiredEnv, secretFile } from "./support.js";

const MIB = 1024 * 1024;

const configError = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(loadConfigFrom(env));
    assert.instanceOf(error, ConfigError);
    return error.message;
  });

const without = (env: Record<string, string>, ...keys: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !keys.includes(key)));

describe("loadConfig", () => {
  it.effect("reads the required variables with every default", () =>
    Effect.gen(function* () {
      const env = yield* requiredEnv;
      const config = yield* loadConfigFrom(env);
      assert.deepStrictEqual(
        { ...config.http },
        {
          host: "0.0.0.0",
          port: 3000,
          allowedOrigins: [],
          allowedHosts: [],
          trustedProxies: [],
          adminAllowedNetworks: [],
          adminListener: undefined,
        },
      );
      assert.strictEqual(config.oauth.publicUrl, "https://ds.example.test");
      assert.isDefined(Redacted.value(config.oauth.passwordHash).params);
      assert.isUndefined(config.oauth.totpSecret);
      assert.strictEqual(Buffer.from(Redacted.value(config.dataKey)).toString("hex"), DATA_KEY_HEX);
      assert.strictEqual(config.dbPath, "/home/test/.local/share/datova-schranka/datova-schranka.sqlite");
      const domain = config.domain;
      assert.strictEqual(domain.environment, "production");
      assert.strictEqual(domain.dataDir, "/home/test/.local/share/datova-schranka/zfo");
      assert.strictEqual(Duration.toMillis(domain.requestTimeout), 60_000);
      assert.strictEqual(domain.attachmentInlineMaxBytes, 10 * MIB);
      assert.strictEqual(domain.responseInlineMaxBytes, 25 * MIB);
      assert.strictEqual(Duration.toMillis(domain.approvalNonceTtl), 15 * 60_000);
      assert.strictEqual(Duration.toMillis(domain.pendingTtl), 168 * 3_600_000);
    }),
  );

  it.effect("puts the database under XDG_DATA_HOME before HOME, and the ZFO store beside an explicit DB_PATH", () =>
    Effect.gen(function* () {
      const env = yield* requiredEnv;
      const xdg = yield* loadConfigFrom({ ...env, XDG_DATA_HOME: "/xdg" });
      assert.strictEqual(xdg.dbPath, "/xdg/datova-schranka/datova-schranka.sqlite");
      assert.strictEqual(xdg.domain.dataDir, "/xdg/datova-schranka/zfo");
      const explicit = yield* loadConfigFrom({ ...env, DATOVA_SCHRANKA_DB_PATH: "/data/ds.sqlite" });
      assert.strictEqual(explicit.dbPath, "/data/ds.sqlite");
      assert.strictEqual(explicit.domain.dataDir, "/data/zfo");
    }),
  );

  it.effect("reads every variable", () =>
    Effect.gen(function* () {
      const env = yield* requiredEnv;
      const config = yield* loadConfigFrom({
        ...env,
        DATOVA_SCHRANKA_HOST: "127.0.0.1",
        DATOVA_SCHRANKA_PORT: "8080",
        DATOVA_SCHRANKA_ALLOWED_ORIGINS: "https://a.example, https://b.example",
        DATOVA_SCHRANKA_ALLOWED_HOSTS: "DS.Example.Test",
        DATOVA_SCHRANKA_TRUSTED_PROXIES: "10.0.0.1",
        DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS: "192.168.0.0/16",
        DATOVA_SCHRANKA_ADMIN_PORT: "8081",
        DATOVA_SCHRANKA_ADMIN_TOTP_SECRET_FILE: secretFile("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP\n"),
        DATOVA_SCHRANKA_DB_PATH: "/data/datova-schranka.sqlite",
        DATOVA_SCHRANKA_DATA_DIR: "/zfo",
        DATOVA_SCHRANKA_ISDS_ENVIRONMENT: " Test ",
        DATOVA_SCHRANKA_ISDS_REQUEST_TIMEOUT_MS: "5000",
        DATOVA_SCHRANKA_ATTACHMENT_INLINE_MAX_BYTES: "0",
        DATOVA_SCHRANKA_RESPONSE_INLINE_MAX_BYTES: "1000",
        DATOVA_SCHRANKA_APPROVAL_NONCE_TTL_MINUTES: "5",
        DATOVA_SCHRANKA_PENDING_TTL_HOURS: "24",
      });
      assert.strictEqual(config.http.host, "127.0.0.1");
      assert.strictEqual(config.http.port, 8080);
      assert.deepStrictEqual(config.http.allowedOrigins, ["https://a.example", "https://b.example"]);
      assert.deepStrictEqual(config.http.allowedHosts, ["ds.example.test"]);
      assert.strictEqual(config.http.trustedProxies.length, 1);
      assert.strictEqual(config.http.adminAllowedNetworks.length, 1);
      assert.deepStrictEqual(config.http.adminListener, { host: "127.0.0.1", port: 8081 });
      assert.isDefined(config.oauth.totpSecret);
      assert.strictEqual(config.dbPath, "/data/datova-schranka.sqlite");
      assert.strictEqual(config.domain.dataDir, "/zfo");
      assert.strictEqual(config.domain.environment, "test");
      assert.strictEqual(Duration.toMillis(config.domain.requestTimeout), 5000);
      assert.strictEqual(config.domain.attachmentInlineMaxBytes, 0);
      assert.strictEqual(config.domain.responseInlineMaxBytes, 1000);
      assert.strictEqual(Duration.toMillis(config.domain.approvalNonceTtl), 5 * 60_000);
      assert.strictEqual(Duration.toMillis(config.domain.pendingTtl), 24 * 3_600_000);
    }),
  );

  it.effect("requires the public URL and password hash file, naming both and how to make the hash", () =>
    Effect.gen(function* () {
      const env = yield* requiredEnv;
      const neither = yield* configError(
        without(env, "DATOVA_SCHRANKA_PUBLIC_URL", "DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE"),
      );
      assert.include(neither, "DATOVA_SCHRANKA_PUBLIC_URL");
      assert.include(neither, "DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE");
      assert.include(neither, "datova-schranka hash-password");
      const noUrl = yield* configError(without(env, "DATOVA_SCHRANKA_PUBLIC_URL"));
      assert.include(noUrl, "DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE is set but DATOVA_SCHRANKA_PUBLIC_URL is not");
      const noHash = yield* configError(without(env, "DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE"));
      assert.include(noHash, "DATOVA_SCHRANKA_PUBLIC_URL is set but DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE is not");
    }),
  );

  it.effect("always requires DATA_KEY_FILE and never echoes a bad key", () =>
    Effect.gen(function* () {
      const env = yield* requiredEnv;
      const missing = yield* configError(without(env, "DATOVA_SCHRANKA_DATA_KEY_FILE"));
      assert.include(missing, "requires DATOVA_SCHRANKA_DATA_KEY_FILE");
      assert.include(missing, "openssl rand -hex 32");
      const secret = "not-a-key-but-a-secret-value";
      const bad = yield* configError({ ...env, DATOVA_SCHRANKA_DATA_KEY_FILE: secretFile(secret) });
      assert.include(bad, "DATOVA_SCHRANKA_DATA_KEY_FILE");
      assert.notInclude(bad, secret);
    }),
  );

  it.effect("needs some location for the database", () =>
    Effect.gen(function* () {
      const env = yield* requiredEnv;
      const message = yield* configError(without(env, "HOME"));
      assert.include(message, "DATOVA_SCHRANKA_DB_PATH is not set and neither XDG_DATA_HOME nor HOME is");
    }),
  );

  it.effect("refuses invalid values, naming the variable and never echoing the value", () =>
    Effect.gen(function* () {
      const env = yield* requiredEnv;
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["DATOVA_SCHRANKA_ISDS_ENVIRONMENT", "staging-x9"],
        ["DATOVA_SCHRANKA_PORT", "port-x9"],
        ["DATOVA_SCHRANKA_PORT", "70000"],
        ["DATOVA_SCHRANKA_ISDS_REQUEST_TIMEOUT_MS", "999"],
        ["DATOVA_SCHRANKA_ATTACHMENT_INLINE_MAX_BYTES", "-1"],
        ["DATOVA_SCHRANKA_RESPONSE_INLINE_MAX_BYTES", "lots-x9"],
        ["DATOVA_SCHRANKA_APPROVAL_NONCE_TTL_MINUTES", "0"],
        ["DATOVA_SCHRANKA_PENDING_TTL_HOURS", "1.5"],
        ["DATOVA_SCHRANKA_ADMIN_PORT", "3000"],
        ["DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS", "cidr-x9"],
        ["DATOVA_SCHRANKA_TRUSTED_PROXIES", "proxy-x9"],
        ["DATOVA_SCHRANKA_PUBLIC_URL", "ftp://url-x9.example"],
      ];
      for (const [key, value] of cases) {
        const message = yield* configError({ ...env, [key]: value });
        assert.include(message, key, `${key}=${value}`);
        assert.notInclude(message, value, `${key}=${value}`);
      }
    }),
  );

  it.effect("refuses Fio's transport and unauthenticated variables: HTTP with OAuth only", () =>
    Effect.gen(function* () {
      const env = yield* requiredEnv;
      for (const key of [
        "DATOVA_SCHRANKA_TRANSPORT",
        "DATOVA_SCHRANKA_ALLOW_UNAUTHENTICATED",
        "DATOVA_SCHRANKA_ALLOW_UNAUTHENTICATED_ON_NETWORK",
      ]) {
        const message = yield* configError({ ...env, [key]: "value-x9" });
        assert.include(message, `${key} is not supported`);
        assert.notInclude(message, "value-x9");
      }
    }),
  );
});

describe("DomainLive", () => {
  it.effect("feeds DomainConfig and DataKey from the configuration", () =>
    Effect.gen(function* () {
      const env = yield* requiredEnv;
      const layer = DomainLive.pipe(
        Layer.provide(appConfigFrom({ ...env, DATOVA_SCHRANKA_ISDS_ENVIRONMENT: "test", DATOVA_SCHRANKA_DATA_DIR: "/zfo" })),
      );
      const { domain, key } = yield* Effect.gen(function* () {
        return { domain: yield* DomainConfig, key: (yield* DataKey).key };
      }).pipe(Effect.provide(layer));
      assert.strictEqual(domain.environment, "test");
      assert.strictEqual(domain.dataDir, "/zfo");
      assert.strictEqual(Buffer.from(Redacted.value(key)).toString("hex"), DATA_KEY_HEX);
    }),
  );
});
