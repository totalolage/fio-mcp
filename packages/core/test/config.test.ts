import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, type FileSystem, Layer, Option, Redacted } from "effect";
import type { AppIdentity } from "../src/app-identity.js";
import { boolVar, ConfigError, intVar, listVar, optionalVar, secretVar } from "../src/config/env.js";
import {
  DEFAULT_ADMIN_HOST,
  loadAdminAllowedNetworks,
  loadAdminListener,
  loadAllowedHosts,
  loadAllowedOrigins,
  loadListenAddress,
  loadOAuthCredentials,
  loadTrustedProxies,
} from "../src/config/http.js";
import { parseDataKey, readDataKeyFile, readPasswordHashFile, readTotpSecretFile } from "../src/config/secret-files.js";
import { hashPassword } from "../src/oauth/crypto.js";

// A demo app with its own prefix: every message must name its variables.
const APP: AppIdentity = { name: "demo-mcp", idPrefix: "demo" };
const PREFIX = "DEMO_APP_";
const FAST_SCRYPT = { ln: 14, r: 8, p: 1 } as const;
const REQUIRED = "HTTP mode requires DEMO_APP_PUBLIC_URL and DEMO_APP_ADMIN_PASSWORD_HASH_FILE";
const KEY_HELP = "create one with `openssl rand -hex 32`";
const TOTP_HELP = "create one with `demo-mcp totp-init`";
const KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
// RFC 4648 base32 of 20 bytes (32 characters) and of 10 bytes (16 characters).
const TOTP_20 = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const TOTP_10 = "JBSWY3DPEHPK3PXP";

const fileWith = (content: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "core-config-")), "secret");
  writeFileSync(path, content, { mode: 0o600 });
  return path;
};

const missingFile = () => join(mkdtempSync(join(tmpdir(), "core-config-")), "absent");

const withEnv =
  (env: Record<string, string>) =>
  <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
    effect.pipe(Effect.provide(Layer.merge(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NodeFileSystem.layer)));

/** Runs `effect` under `env` and returns its ConfigError message. */
const failure = <A>(env: Record<string, string>, effect: Effect.Effect<A, ConfigError, FileSystem.FileSystem>) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(withEnv(env)(effect));
    assert.instanceOf(error, ConfigError);
    assert.strictEqual(error._tag, "ConfigError");
    assert.strictEqual(error.message, error.detail);
    return error.message;
  });

const hashLine = () => hashPassword(Redacted.make("the admin password"), FAST_SCRYPT);

describe("env readers", () => {
  it.effect("optionalVar trims and treats blank as unset", () =>
    Effect.gen(function* () {
      const run = withEnv({ DEMO_APP_A: "  x ", DEMO_APP_B: "   " });
      assert.deepStrictEqual(yield* run(optionalVar("DEMO_APP_A")), Option.some("x"));
      assert.isTrue(Option.isNone(yield* run(optionalVar("DEMO_APP_B"))));
      assert.isTrue(Option.isNone(yield* run(optionalVar("DEMO_APP_C"))));
    }),
  );

  it.effect("secretVar reads the value or the _FILE twin, dropping one trailing newline", () =>
    Effect.gen(function* () {
      const direct = yield* withEnv({ DEMO_APP_SECRET: "s3cret" })(secretVar("DEMO_APP_SECRET"));
      assert.strictEqual(Option.map(direct, Redacted.value).pipe(Option.getOrUndefined), "s3cret");
      const fromFile = yield* withEnv({ DEMO_APP_SECRET_FILE: fileWith("from-file\r\n") })(secretVar("DEMO_APP_SECRET"));
      assert.strictEqual(Option.map(fromFile, Redacted.value).pipe(Option.getOrUndefined), "from-file");
      assert.isTrue(Option.isNone(yield* withEnv({})(secretVar("DEMO_APP_SECRET"))));
    }),
  );

  it.effect("secretVar refuses both, an empty file and an unreadable file", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* failure({ DEMO_APP_SECRET: "a", DEMO_APP_SECRET_FILE: fileWith("b") }, secretVar("DEMO_APP_SECRET")),
        "Set either DEMO_APP_SECRET or DEMO_APP_SECRET_FILE, not both",
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_SECRET_FILE: fileWith("\n") }, secretVar("DEMO_APP_SECRET")),
        "DEMO_APP_SECRET_FILE: file is empty",
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_SECRET_FILE: missingFile() }, secretVar("DEMO_APP_SECRET")),
        "DEMO_APP_SECRET_FILE: file not readable",
      );
    }),
  );

  it.effect("intVar, boolVar and listVar parse or name the variable", () =>
    Effect.gen(function* () {
      const run = withEnv({ DEMO_APP_N: "42", DEMO_APP_ON: "Yes", DEMO_APP_LIST: " a, ,b ," });
      assert.strictEqual(yield* run(intVar("DEMO_APP_N", 1, 0)), 42);
      assert.strictEqual(yield* run(intVar("DEMO_APP_UNSET", 7, 0)), 7);
      assert.isTrue(yield* run(boolVar("DEMO_APP_ON", false)));
      assert.isFalse(yield* run(boolVar("DEMO_APP_UNSET", false)));
      assert.deepStrictEqual(yield* run(listVar("DEMO_APP_LIST")), ["a", "b"]);
      assert.deepStrictEqual(yield* run(listVar("DEMO_APP_UNSET")), []);
      assert.strictEqual(
        yield* failure({ DEMO_APP_N: "1.5" }, intVar("DEMO_APP_N", 1, 1, " (why)")),
        "DEMO_APP_N must be an integer >= 1 (why)",
      );
      assert.strictEqual(yield* failure({ DEMO_APP_ON: "maybe" }, boolVar("DEMO_APP_ON", false)), "DEMO_APP_ON must be true or false");
    }),
  );
});

describe("data key file", () => {
  it("parses 32 bytes as hex, base64 and URL-safe base64", () => {
    const bytes = Buffer.from(KEY_HEX, "hex");
    for (const text of [KEY_HEX, `${KEY_HEX.toUpperCase()}\n`, bytes.toString("base64"), bytes.toString("base64url")]) {
      const key = parseDataKey(text);
      assert.isDefined(key, text);
      if (key !== undefined) assert.deepStrictEqual(Buffer.from(Redacted.value(key)), bytes);
    }
  });

  it("rejects the wrong length and other encodings", () => {
    for (const text of [KEY_HEX.slice(2), `${KEY_HEX}00`, Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), "z".repeat(64), ""]) {
      assert.isUndefined(parseDataKey(text), text);
    }
  });

  it.effect("reads the key file, None when unset", () =>
    Effect.gen(function* () {
      const key = yield* withEnv({ DEMO_APP_DATA_KEY_FILE: fileWith(`${KEY_HEX}\n`) })(readDataKeyFile("DEMO_APP_DATA_KEY_FILE", KEY_HELP));
      assert.isTrue(Option.isSome(key));
      assert.isTrue(Option.isNone(yield* withEnv({})(readDataKeyFile("DEMO_APP_DATA_KEY_FILE", KEY_HELP))));
    }),
  );

  it.effect("names the variable for a bad, short or missing key file, never the content", () =>
    Effect.gen(function* () {
      const bad = "DEMO_APP_DATA_KEY_FILE: file must contain 32 bytes as 64 hex digits or base64; create one with `openssl rand -hex 32`";
      for (const content of [KEY_HEX.slice(2), "not a key at all"]) {
        const message = yield* failure({ DEMO_APP_DATA_KEY_FILE: fileWith(content) }, readDataKeyFile("DEMO_APP_DATA_KEY_FILE", KEY_HELP));
        assert.strictEqual(message, bad);
      }
      assert.strictEqual(
        yield* failure({ DEMO_APP_DATA_KEY_FILE: missingFile() }, readDataKeyFile("DEMO_APP_DATA_KEY_FILE", KEY_HELP)),
        "DEMO_APP_DATA_KEY_FILE: file not readable",
      );
    }),
  );
});

describe("password hash file", () => {
  it.effect("reads one hash line, ignoring blank lines", () =>
    Effect.gen(function* () {
      const line = yield* hashLine();
      const hash = yield* withEnv({ DEMO_APP_HASH_FILE: fileWith(`\n${line}\n\n`) })(readPasswordHashFile("DEMO_APP_HASH_FILE", APP));
      assert.isTrue(Option.isSome(hash));
      assert.isTrue(Option.isNone(yield* withEnv({})(readPasswordHashFile("DEMO_APP_HASH_FILE", APP))));
    }),
  );

  it.effect("refuses several lines, a bad hash and a missing file", () =>
    Effect.gen(function* () {
      const line = yield* hashLine();
      assert.strictEqual(
        yield* failure({ DEMO_APP_HASH_FILE: fileWith(`${line}\n${line}\n`) }, readPasswordHashFile("DEMO_APP_HASH_FILE", APP)),
        "DEMO_APP_HASH_FILE: file must contain exactly one hash line",
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_HASH_FILE: fileWith("plaintext\n") }, readPasswordHashFile("DEMO_APP_HASH_FILE", APP)),
        "DEMO_APP_HASH_FILE: file is not a demo-mcp password hash ($scrypt$ln=…,r=…,p=…$salt$hash); create one with `demo-mcp hash-password`",
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_HASH_FILE: missingFile() }, readPasswordHashFile("DEMO_APP_HASH_FILE", APP)),
        "DEMO_APP_HASH_FILE: file not readable",
      );
    }),
  );
});

describe("TOTP secret file", () => {
  it.effect("reads a base32 secret of at least 16 bytes, lowercase and spaced", () =>
    Effect.gen(function* () {
      const spaced = TOTP_20.toLowerCase().replace(/(.{4})/g, "$1 ");
      const secret = yield* withEnv({ DEMO_APP_TOTP_FILE: fileWith(`${spaced}\n`) })(readTotpSecretFile("DEMO_APP_TOTP_FILE", TOTP_HELP));
      assert.strictEqual(Option.map(secret, (s) => Redacted.value(s).length).pipe(Option.getOrUndefined), 20);
      assert.isTrue(Option.isNone(yield* withEnv({})(readTotpSecretFile("DEMO_APP_TOTP_FILE", TOTP_HELP))));
    }),
  );

  it.effect("refuses invalid base32, a short secret and a missing file", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* failure({ DEMO_APP_TOTP_FILE: fileWith("not base32!") }, readTotpSecretFile("DEMO_APP_TOTP_FILE", TOTP_HELP)),
        "DEMO_APP_TOTP_FILE: file must contain a base32 secret; create one with `demo-mcp totp-init`",
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_TOTP_FILE: fileWith(TOTP_10) }, readTotpSecretFile("DEMO_APP_TOTP_FILE", TOTP_HELP)),
        "DEMO_APP_TOTP_FILE: the secret must be at least 16 bytes (26 base32 characters); create one with `demo-mcp totp-init`",
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_TOTP_FILE: missingFile() }, readTotpSecretFile("DEMO_APP_TOTP_FILE", TOTP_HELP)),
        "DEMO_APP_TOTP_FILE: file not readable",
      );
    }),
  );
});

describe("HTTP listener variables", () => {
  const DEFAULTS = { host: "0.0.0.0", port: 3000 };

  it.effect("reads host and port under the prefix with defaults", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* withEnv({})(loadListenAddress(PREFIX, DEFAULTS)), DEFAULTS);
      assert.deepStrictEqual(
        yield* withEnv({ DEMO_APP_HOST: "127.0.0.1", DEMO_APP_PORT: "8080" })(loadListenAddress(PREFIX, DEFAULTS)),
        { host: "127.0.0.1", port: 8080 },
      );
      assert.strictEqual(yield* failure({ DEMO_APP_PORT: "0" }, loadListenAddress(PREFIX, DEFAULTS)), "DEMO_APP_PORT must be an integer >= 1");
      assert.strictEqual(
        yield* failure({ DEMO_APP_PORT: "65536" }, loadListenAddress(PREFIX, DEFAULTS)),
        "DEMO_APP_PORT must be an integer from 1 to 65535",
      );
    }),
  );

  it.effect("reads allowed origins as given and allowed hosts lowercased", () =>
    Effect.gen(function* () {
      const run = withEnv({ DEMO_APP_ALLOWED_ORIGINS: "https://A.example, https://b.example", DEMO_APP_ALLOWED_HOSTS: "MCP.Example.net:443" });
      assert.deepStrictEqual(yield* run(loadAllowedOrigins(PREFIX)), ["https://A.example", "https://b.example"]);
      assert.deepStrictEqual(yield* run(loadAllowedHosts(PREFIX)), ["mcp.example.net:443"]);
    }),
  );

  it.effect("parses trusted proxies and admin CIDRs, naming the bad entry", () =>
    Effect.gen(function* () {
      const networks = yield* withEnv({ DEMO_APP_TRUSTED_PROXIES: "172.18.0.0/16, 10.0.0.1" })(loadTrustedProxies(PREFIX));
      assert.strictEqual(networks.length, 2);
      assert.deepStrictEqual(yield* withEnv({})(loadTrustedProxies(PREFIX)), []);
      assert.strictEqual(
        yield* failure({ DEMO_APP_TRUSTED_PROXIES: "10.0.0.1,proxy.local" }, loadTrustedProxies(PREFIX)),
        "DEMO_APP_TRUSTED_PROXIES entry 2 must be an IP address or a CIDR network such as 172.18.0.0/16",
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_ADMIN_ALLOWED_CIDRS: "10.0.0.0/33" }, loadAdminAllowedNetworks(PREFIX)),
        "DEMO_APP_ADMIN_ALLOWED_CIDRS entry 1 must be an IP address or a CIDR network such as 172.18.0.0/16",
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_ADMIN_ALLOWED_CIDRS: " , ," }, loadAdminAllowedNetworks(PREFIX)),
        "DEMO_APP_ADMIN_ALLOWED_CIDRS must name at least one IP address or CIDR network",
      );
      assert.deepStrictEqual(yield* withEnv({})(loadAdminAllowedNetworks(PREFIX)), []);
    }),
  );

  it.effect("puts the admin listener on 127.0.0.1 by default and on a distinct port", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* withEnv({})(loadAdminListener(PREFIX, 3000)));
      assert.deepStrictEqual(yield* withEnv({ DEMO_APP_ADMIN_PORT: "3001" })(loadAdminListener(PREFIX, 3000)), {
        host: DEFAULT_ADMIN_HOST,
        port: 3001,
      });
      assert.strictEqual(DEFAULT_ADMIN_HOST, "127.0.0.1");
      assert.deepStrictEqual(
        yield* withEnv({ DEMO_APP_ADMIN_PORT: "3001", DEMO_APP_ADMIN_HOST: "0.0.0.0" })(loadAdminListener(PREFIX, 3000)),
        { host: "0.0.0.0", port: 3001 },
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_ADMIN_PORT: "3000" }, loadAdminListener(PREFIX, 3000)),
        "DEMO_APP_ADMIN_PORT must differ from DEMO_APP_PORT",
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_ADMIN_HOST: "127.0.0.1" }, loadAdminListener(PREFIX, 3000)),
        "DEMO_APP_ADMIN_HOST is set but DEMO_APP_ADMIN_PORT is not",
      );
      for (const port of ["0", "65536", "80a"]) {
        assert.strictEqual(
          yield* failure({ DEMO_APP_ADMIN_PORT: port }, loadAdminListener(PREFIX, 3000)),
          "DEMO_APP_ADMIN_PORT must be an integer from 1 to 65535",
        );
      }
    }),
  );
});

describe("OAuth credentials", () => {
  it.effect("needs both the public URL and the password hash file", () =>
    Effect.gen(function* () {
      const hashFile = fileWith(`${yield* hashLine()}\n`);
      const load = loadOAuthCredentials(PREFIX, APP, REQUIRED);
      const credentials = yield* withEnv({ DEMO_APP_PUBLIC_URL: "https://MCP.example.net/", DEMO_APP_ADMIN_PASSWORD_HASH_FILE: hashFile })(load);
      assert.strictEqual(credentials.publicUrl, "https://mcp.example.net");
      assert.strictEqual(yield* failure({}, load), REQUIRED);
      assert.strictEqual(
        yield* failure({ DEMO_APP_ADMIN_PASSWORD_HASH_FILE: hashFile }, load),
        `DEMO_APP_ADMIN_PASSWORD_HASH_FILE is set but DEMO_APP_PUBLIC_URL is not. ${REQUIRED}`,
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_PUBLIC_URL: "https://mcp.example.net" }, load),
        `DEMO_APP_PUBLIC_URL is set but DEMO_APP_ADMIN_PASSWORD_HASH_FILE is not. ${REQUIRED}`,
      );
    }),
  );

  it.effect("refuses a bad public URL before reading the hash file", () =>
    Effect.gen(function* () {
      const load = loadOAuthCredentials(PREFIX, APP, REQUIRED);
      assert.strictEqual(
        yield* failure({ DEMO_APP_PUBLIC_URL: "mcp.example.net", DEMO_APP_ADMIN_PASSWORD_HASH_FILE: missingFile() }, load),
        "DEMO_APP_PUBLIC_URL must be an absolute URL such as https://demo.example.net",
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_PUBLIC_URL: "http://mcp.example.net", DEMO_APP_ADMIN_PASSWORD_HASH_FILE: missingFile() }, load),
        "DEMO_APP_PUBLIC_URL must use https (http is accepted only for 127.0.0.1, [::1] and localhost)",
      );
      assert.strictEqual(
        yield* failure({ DEMO_APP_PUBLIC_URL: "https://mcp.example.net", DEMO_APP_ADMIN_PASSWORD_HASH_FILE: missingFile() }, load),
        "DEMO_APP_ADMIN_PASSWORD_HASH_FILE: file not readable",
      );
      const line = yield* hashLine();
      assert.strictEqual(
        yield* failure({ DEMO_APP_PUBLIC_URL: "https://mcp.example.net", DEMO_APP_ADMIN_PASSWORD_HASH_FILE: fileWith(`${line}\n${line}`) }, load),
        "DEMO_APP_ADMIN_PASSWORD_HASH_FILE: file must contain exactly one hash line",
      );
    }),
  );
});
