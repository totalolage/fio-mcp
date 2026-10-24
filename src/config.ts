import { Config, Context, Effect, FileSystem, Layer, Option, Predicate, Redacted, Schema } from "effect";
import type { IpNetwork } from "effect/net";
import { ConfigError } from "./errors.js";
import { type PasswordHash, PasswordHashError, parsePasswordHash } from "./oauth/crypto.js";
import { parsePublicUrl } from "./oauth/urls.js";
import { parseDataKey } from "./token-crypto.js";
import { parseTrustedProxy } from "./transport/client-address.js";

/**
 * Configuration from the environment, through Effect's ConfigProvider.
 *
 * Secrets (FIO tokens) come from a variable or from a file named by its
 * `_FILE` twin, never both, and are held as `Redacted`; the admin password
 * hash and the data key come from files only.
 *
 * With OAuth over HTTP the FIO accounts live in the database (encrypted
 * with the data key, managed at /admin); FIO_TOKEN / FIO_ACCOUNTS are then
 * optional and only seed an empty database once (src/account-store.ts).
 * Diagnostics name the variable, field, or path, never a value: a misplaced
 * token must not reach stderr.
 */

export interface AccountConfig {
  /** Name the model uses to pick an account; never the token. */
  readonly name: string;
  readonly token: Redacted.Redacted<string>;
  /** FIO account number (payer `accountFrom` for payment orders). */
  readonly accountNumber: string | undefined;
  /** Account currency (ISO 4217), the default order currency. */
  readonly currency: string | undefined;
}

export type TransportConfig =
  | { readonly kind: "stdio" }
  | {
      readonly kind: "http";
      readonly host: string;
      readonly port: number;
      readonly auth: HttpAuthConfig;
      /** Exact Origin values accepted on /mcp. Requests without Origin are accepted. */
      readonly allowedOrigins: ReadonlyArray<string>;
      /** Accepted Host header values (host or host:port). Empty accepts any. */
      readonly allowedHosts: ReadonlyArray<string>;
      /**
       * Reverse proxies whose X-Forwarded-For names the client address for
       * login and authorization throttling. Empty trusts no one.
       */
      readonly trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>;
    };

/**
 * How /mcp is protected. `oauth`: the embedded authorization server
 * (FIO_MCP_PUBLIC_URL + FIO_MCP_ADMIN_PASSWORD_HASH_FILE). `unauthenticated`:
 * FIO_MCP_ALLOW_UNAUTHENTICATED=true, every caller has full access.
 */
export type HttpAuthConfig =
  | {
      readonly kind: "oauth";
      /** The public origin: OAuth issuer; the resource is this plus /mcp. */
      readonly publicUrl: string;
      /** The bootstrap hash; a password changed at /admin (stored in the database) takes precedence. */
      readonly passwordHash: Redacted.Redacted<PasswordHash>;
      /** AES-256-GCM key (FIO_MCP_DATA_KEY_FILE) for the FIO tokens in the database. */
      readonly dataKey: Redacted.Redacted<Uint8Array>;
    }
  | { readonly kind: "unauthenticated" };

export interface CacheConfig {
  readonly enabled: boolean;
  readonly dbPath: string;
  readonly syncOnStartup: boolean;
  /** 0 disables periodic sync. */
  readonly syncIntervalMinutes: number;
  /** First day the initial backfill asks for (YYYY-MM-DD). */
  readonly backfillFrom: string;
  /** Incremental sync re-fetches this many days before the newest covered day. */
  readonly overlapDays: number;
  /** A cached day fetched less than this long ago counts as fresh. */
  readonly maxAgeMinutes: number;
}

export interface AppConfigShape {
  /**
   * Accounts from FIO_TOKEN / FIO_ACCOUNTS. Never empty for stdio and
   * unauthenticated HTTP; may be empty with OAuth, where the database is
   * authoritative and these only seed it.
   */
  readonly accounts: ReadonlyArray<AccountConfig>;
  /** Every configured secret that must never leave the process: the FIO tokens. */
  readonly secrets: ReadonlyArray<Redacted.Redacted<string>>;
  readonly baseUrl: string;
  /** Minimum spacing between requests with the same token. */
  readonly rateLimitIntervalMs: number;
  /** Longest an interactive call may wait for a rate-limit slot before failing fast. */
  readonly maxWaitMs: number;
  /** Per-request HTTP timeout. */
  readonly requestTimeoutMs: number;
  readonly transport: TransportConfig;
  readonly cache: CacheConfig;
}

export const DEFAULT_BASE_URL = "https://fioapi.fio.cz/v1/rest";
export const DEFAULT_RATE_LIMIT_INTERVAL_MS = 30_000;
/** FIO allows one request per token every 30 s; the environment cannot configure less. */
export const MIN_RATE_LIMIT_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_WAIT_MS = 25_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_ACCOUNT_NAME = "default";
export const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_HTTP_HOST = "0.0.0.0";
export const DEFAULT_HTTP_PORT = 3000;
/** Earliest day the initial backfill asks for; FIO serves what the account has. */
export const DEFAULT_BACKFILL_FROM = "2000-01-01";
export const DEFAULT_OVERLAP_DAYS = 10;
export const DEFAULT_CACHE_MAX_AGE_MINUTES = 60;
export const MIN_SYNC_INTERVAL_MINUTES = 5;

// Control and format characters (Cc, Cf: e.g. U+200B, U+202E) and line or
// paragraph separators are invisible or reorder text, so a name could look
// like another one on the consent page.
const ACCOUNT_NAME_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// URL-safe characters only: tokens go into URL paths, and protocol-level
// redaction can then never cut through JSON or SSE framing.
export const TOKEN = new RegExp(`^[A-Za-z0-9._~-]{${MIN_TOKEN_LENGTH},}$`);
export const ACCOUNT_NUMBER = /^\d{1,10}$/;
export const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^(?!0000)\d{4}-\d{2}-\d{2}$/;

export const FIELD_RULES = {
  name: "must be 1-64 Unicode code points after trimming, with no control, format or line separator characters",
  token: `must be at least ${MIN_TOKEN_LENGTH} characters of letters, digits, '.', '_', '~' or '-' (FIO tokens are 64 characters)`,
  accountNumber: "must be the FIO account number without bank code (1-10 digits)",
  currency: "must be an ISO 4217 code such as CZK",
} as const;

type AccountField = keyof typeof FIELD_RULES;

const SINGLE_ACCOUNT_VARS: Record<AccountField, string> = {
  name: "FIO_ACCOUNT_NAME",
  token: "FIO_TOKEN",
  accountNumber: "FIO_ACCOUNT_NUMBER",
  currency: "FIO_ACCOUNT_CURRENCY",
};

const ACCOUNT_FIELDS = Object.keys(FIELD_RULES).join(", ");

const fail = (detail: string) => Effect.fail(new ConfigError({ detail }));

/** A trimmed, non-empty variable, or None. Never echoes the value on failure. */
const optionalVar = Effect.fn("config.optionalVar")(function* (key: string) {
  const value = yield* Config.option(Config.String(key)).pipe(
    Effect.mapError(() => new ConfigError({ detail: `Could not read ${key}` })),
  );
  return Option.filter(
    Option.map(value, (s) => s.trim()),
    (s) => s !== "",
  );
});

/**
 * A secret from `key` or from the file named by `${key}_FILE`. Exactly one
 * may be set. A trailing newline in the file is dropped.
 */
const secretVar = Effect.fn("config.secretVar")(function* (key: string) {
  const direct = yield* optionalVar(key);
  const file = yield* optionalVar(`${key}_FILE`);
  if (Option.isSome(direct) && Option.isSome(file)) {
    return yield* fail(`Set either ${key} or ${key}_FILE, not both`);
  }
  if (Option.isSome(file)) {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(file.value)
      .pipe(Effect.mapError(() => new ConfigError({ detail: `${key}_FILE: file not readable` })));
    const trimmed = content.replace(/\r?\n$/, "").trim();
    if (trimmed === "") return yield* fail(`${key}_FILE: file is empty`);
    return Option.some(Redacted.make(trimmed));
  }
  return Option.map(direct, (value) => Redacted.make(value));
});

const intVar = Effect.fn("config.intVar")(function* (key: string, fallback: number, min: number, why = "") {
  const raw = yield* optionalVar(key);
  if (Option.isNone(raw)) return fallback;
  const value = Number(raw.value);
  if (!Number.isInteger(value) || value < min) {
    return yield* fail(`${key} must be an integer >= ${min}${why}`);
  }
  return value;
});

const boolVar = Effect.fn("config.boolVar")(function* (key: string, fallback: boolean) {
  const raw = yield* optionalVar(key);
  if (Option.isNone(raw)) return fallback;
  const value = raw.value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return yield* fail(`${key} must be true or false`);
});

const listVar = (key: string) =>
  optionalVar(key).pipe(
    Effect.map((raw) =>
      Option.match(raw, {
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== ""),
      }),
    ),
  );

const isCalendarDate = (value: string): boolean => {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

const RawAccount = Schema.Record(Schema.String, Schema.Unknown);

/** The account-name rule (before trimming): 1-64 code points after trimming, nothing invisible. */
export const validAccountName = (value: string): boolean => {
  if (ACCOUNT_NAME_INVISIBLE.test(value)) return false;
  const length = Array.from(value.trim()).length;
  return length >= 1 && length <= 64;
};

/** Names are unique ignoring case after trimming. */
export const accountNameKey = (name: string): string => name.trim().toLowerCase();

/** Validates one account object, describing failures by field name and rule only. */
const parseAccount = Effect.fn("config.parseAccount")(function* (raw: unknown, index: number | undefined) {
  const where = index === undefined ? undefined : `FIO_ACCOUNTS[${index}]`;
  const label = (field: AccountField) => (where ? `${where}.${field}` : SINGLE_ACCOUNT_VARS[field]);
  if (!Schema.is(RawAccount)(raw)) {
    return yield* fail(`Invalid account configuration: ${where ?? "account"} must be an object with fields ${ACCOUNT_FIELDS}`);
  }
  const problems: Array<string> = [];
  if (Object.keys(raw).some((key) => !(key in FIELD_RULES))) {
    problems.push(`${where ?? "account"} has unknown fields; allowed fields are ${ACCOUNT_FIELDS}`);
  }
  const text = (field: AccountField, pattern: RegExp, required: boolean): string | undefined => {
    const value = raw[field];
    if (value === undefined && !required) return undefined;
    if (Predicate.isString(value) && pattern.test(value)) return value;
    problems.push(`${label(field)} ${FIELD_RULES[field]}`);
    return undefined;
  };
  const rawName = raw.name;
  const name = Predicate.isString(rawName) && validAccountName(rawName) ? rawName.trim() : undefined;
  if (name === undefined) problems.push(`${label("name")} ${FIELD_RULES.name}`);
  const token = text("token", TOKEN, true);
  const accountNumber = text("accountNumber", ACCOUNT_NUMBER, false);
  const currency = text("currency", CURRENCY, false);
  if (problems.length > 0 || name === undefined || token === undefined) {
    return yield* fail(`Invalid account configuration: ${problems.join("; ")}`);
  }
  return { name, token: Redacted.make(token), accountNumber, currency } satisfies AccountConfig;
});

/** `optional`: none configured is fine (OAuth over HTTP, where the database holds the accounts). */
const loadAccounts = Effect.fn("config.loadAccounts")(function* (optional: boolean) {
  const single = yield* secretVar("FIO_TOKEN");
  const multi = yield* secretVar("FIO_ACCOUNTS");
  if (Option.isSome(single) && Option.isSome(multi)) {
    return yield* fail("Set either FIO_TOKEN or FIO_ACCOUNTS (or their _FILE variants), not both");
  }
  if (Option.isSome(multi)) {
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(Redacted.value(multi.value)),
      // Do not echo the value: it contains tokens.
      catch: () => new ConfigError({ detail: "FIO_ACCOUNTS is not valid JSON" }),
    });
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return yield* fail("FIO_ACCOUNTS must be a non-empty JSON array of {name, token}");
    }
    const accounts = yield* Effect.forEach(parsed, (raw: unknown, index) => parseAccount(raw, index));
    const firstIndex = new Map<string, number>();
    for (const [index, account] of accounts.entries()) {
      const key = accountNameKey(account.name);
      const earlier = firstIndex.get(key);
      if (earlier !== undefined) {
        return yield* fail(
          `FIO_ACCOUNTS[${index}].name repeats the name of FIO_ACCOUNTS[${earlier}]; names must be unique ignoring case after trimming`,
        );
      }
      firstIndex.set(key, index);
    }
    return accounts;
  }
  if (Option.isNone(single)) {
    if (optional) return [];
    return yield* fail(
      "No FIO token configured: set FIO_TOKEN (or FIO_TOKEN_FILE), or FIO_ACCOUNTS (or FIO_ACCOUNTS_FILE) for several accounts",
    );
  }
  // Keep an explicitly empty value so it fails the account-name rule instead
  // of silently falling back to the default name.
  const configuredName = yield* Config.option(Config.String("FIO_ACCOUNT_NAME")).pipe(
    Effect.mapError(() => new ConfigError({ detail: "Could not read FIO_ACCOUNT_NAME" })),
  );
  const accountNumber = yield* optionalVar("FIO_ACCOUNT_NUMBER");
  const currency = yield* optionalVar("FIO_ACCOUNT_CURRENCY");
  const account = yield* parseAccount(
    {
      name: Option.getOrElse(configuredName, () => DEFAULT_ACCOUNT_NAME),
      token: Redacted.value(single.value),
      ...(Option.isSome(accountNumber) ? { accountNumber: accountNumber.value } : {}),
      ...(Option.isSome(currency) ? { currency: currency.value.toUpperCase() } : {}),
    },
    undefined,
  );
  return [account];
});

const HTTP_AUTH_REQUIRED =
  "HTTP mode requires FIO_MCP_PUBLIC_URL and FIO_MCP_ADMIN_PASSWORD_HASH_FILE (create the hash with `fio-mcp hash-password`). To run without authentication on a trusted network, set FIO_MCP_ALLOW_UNAUTHENTICATED=true";

const loadHttpAuth = Effect.fn("config.loadHttpAuth")(function* () {
  const publicUrl = yield* optionalVar("FIO_MCP_PUBLIC_URL");
  const hashFile = yield* optionalVar("FIO_MCP_ADMIN_PASSWORD_HASH_FILE");
  const allowUnauthenticated = yield* boolVar("FIO_MCP_ALLOW_UNAUTHENTICATED", false);
  if (Option.isNone(publicUrl) && Option.isNone(hashFile)) {
    if (allowUnauthenticated) return { kind: "unauthenticated" } satisfies HttpAuthConfig;
    return yield* fail(HTTP_AUTH_REQUIRED);
  }
  if (Option.isNone(publicUrl)) return yield* fail(`FIO_MCP_ADMIN_PASSWORD_HASH_FILE is set but FIO_MCP_PUBLIC_URL is not. ${HTTP_AUTH_REQUIRED}`);
  if (Option.isNone(hashFile)) return yield* fail(`FIO_MCP_PUBLIC_URL is set but FIO_MCP_ADMIN_PASSWORD_HASH_FILE is not. ${HTTP_AUTH_REQUIRED}`);
  const parsedUrl = parsePublicUrl(publicUrl.value);
  if ("problem" in parsedUrl) return yield* fail(`FIO_MCP_PUBLIC_URL ${parsedUrl.problem}`);
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs
    .readFileString(hashFile.value)
    .pipe(Effect.mapError(() => new ConfigError({ detail: "FIO_MCP_ADMIN_PASSWORD_HASH_FILE: file not readable" })));
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 1) {
    return yield* fail("FIO_MCP_ADMIN_PASSWORD_HASH_FILE: file must contain exactly one hash line");
  }
  const hash = parsePasswordHash(lines[0] ?? "");
  if (hash instanceof PasswordHashError) {
    return yield* fail(`FIO_MCP_ADMIN_PASSWORD_HASH_FILE: file ${hash.detail}`);
  }
  const dataKey = yield* loadDataKey();
  return {
    kind: "oauth",
    publicUrl: parsedUrl.origin,
    passwordHash: Redacted.make(hash),
    dataKey,
  } satisfies HttpAuthConfig;
});

const DATA_KEY_HELP = "create one with `openssl rand -hex 32 > fio_mcp_data_key` and keep a copy outside the database backups";

/** FIO_MCP_DATA_KEY_FILE: 32 bytes as 64 hex digits or base64. Never echoes the content. */
const loadDataKey = Effect.fn("config.loadDataKey")(function* () {
  const file = yield* optionalVar("FIO_MCP_DATA_KEY_FILE");
  if (Option.isNone(file)) {
    return yield* fail(
      `HTTP mode with OAuth requires FIO_MCP_DATA_KEY_FILE, the key that encrypts the FIO tokens in the database; ${DATA_KEY_HELP}`,
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs
    .readFileString(file.value)
    .pipe(Effect.mapError(() => new ConfigError({ detail: "FIO_MCP_DATA_KEY_FILE: file not readable" })));
  const key = parseDataKey(content);
  if (key === undefined) {
    return yield* fail(`FIO_MCP_DATA_KEY_FILE: file must contain 32 bytes as 64 hex digits or base64; ${DATA_KEY_HELP}`);
  }
  return key;
});

const loadTrustedProxies = Effect.fn("config.loadTrustedProxies")(function* () {
  const networks: Array<IpNetwork.IpNetwork> = [];
  for (const [index, entry] of (yield* listVar("FIO_MCP_TRUSTED_PROXIES")).entries()) {
    const network = parseTrustedProxy(entry);
    if (network === undefined) {
      return yield* fail(
        `FIO_MCP_TRUSTED_PROXIES entry ${index + 1} must be an IP address or a CIDR network such as 172.18.0.0/16`,
      );
    }
    networks.push(network);
  }
  return networks;
});

const loadTransport = Effect.fn("config.loadTransport")(function* () {
  const kind = Option.getOrElse(yield* optionalVar("FIO_MCP_TRANSPORT"), () => "stdio").toLowerCase();
  if (kind === "stdio") return { kind: "stdio" } satisfies TransportConfig;
  if (kind !== "http") return yield* fail("FIO_MCP_TRANSPORT must be stdio or http");
  const host = Option.getOrElse(yield* optionalVar("FIO_MCP_HOST"), () => DEFAULT_HTTP_HOST);
  const port = yield* intVar("FIO_MCP_PORT", DEFAULT_HTTP_PORT, 1);
  if (port > 65_535) return yield* fail("FIO_MCP_PORT must be an integer from 1 to 65535");
  return {
    kind: "http",
    host,
    port,
    auth: yield* loadHttpAuth(),
    allowedOrigins: yield* listVar("FIO_MCP_ALLOWED_ORIGINS"),
    allowedHosts: (yield* listVar("FIO_MCP_ALLOWED_HOSTS")).map((h) => h.toLowerCase()),
    trustedProxies: yield* loadTrustedProxies(),
  } satisfies TransportConfig;
});

const loadCache = Effect.fn("config.loadCache")(function* () {
  const enabled = yield* boolVar("FIO_CACHE_ENABLED", true);
  const explicitPath = yield* optionalVar("FIO_DB_PATH");
  const xdg = yield* optionalVar("XDG_DATA_HOME");
  const home = yield* optionalVar("HOME");
  const dataHome = Option.isSome(xdg) ? Option.some(xdg.value) : Option.map(home, (h) => `${h}/.local/share`);
  const dbPath = Option.isSome(explicitPath)
    ? explicitPath
    : Option.map(dataHome, (dir) => `${dir}/fio-mcp/fio.sqlite`);
  if (enabled && Option.isNone(dbPath)) {
    return yield* fail("FIO_DB_PATH is not set and neither XDG_DATA_HOME nor HOME is, so the cache has no location");
  }
  const backfillFrom = Option.getOrElse(yield* optionalVar("FIO_BACKFILL_FROM"), () => DEFAULT_BACKFILL_FROM);
  if (!isCalendarDate(backfillFrom)) return yield* fail("FIO_BACKFILL_FROM must be a date YYYY-MM-DD");
  const syncIntervalMinutes = yield* intVar("FIO_SYNC_INTERVAL_MINUTES", 0, 0);
  if (syncIntervalMinutes !== 0 && syncIntervalMinutes < MIN_SYNC_INTERVAL_MINUTES) {
    return yield* fail(`FIO_SYNC_INTERVAL_MINUTES must be 0 (off) or at least ${MIN_SYNC_INTERVAL_MINUTES}`);
  }
  return {
    enabled,
    dbPath: Option.getOrElse(dbPath, () => ""),
    syncOnStartup: yield* boolVar("FIO_SYNC_ON_STARTUP", true),
    syncIntervalMinutes,
    backfillFrom,
    overlapDays: yield* intVar("FIO_SYNC_OVERLAP_DAYS", DEFAULT_OVERLAP_DAYS, 1),
    maxAgeMinutes: yield* intVar("FIO_CACHE_MAX_AGE_MINUTES", DEFAULT_CACHE_MAX_AGE_MINUTES, 0),
  } satisfies CacheConfig;
});

/** Reads and validates the whole configuration. */
export const loadConfig = Effect.fn("config.load")(function* () {
  const transport = yield* loadTransport();
  const accounts = yield* loadAccounts(transport.kind === "http" && transport.auth.kind === "oauth");
  const baseUrl = Option.getOrElse(yield* optionalVar("FIO_API_BASE_URL"), () => DEFAULT_BASE_URL).replace(/\/+$/, "");
  const cache = yield* loadCache();
  if (transport.kind === "http" && transport.auth.kind === "oauth" && cache.dbPath === "") {
    return yield* fail(
      "FIO_DB_PATH is not set and neither XDG_DATA_HOME nor HOME is, so the OAuth clients and tokens have no location",
    );
  }
  const config: AppConfigShape = {
    accounts,
    secrets: accounts.map((a) => a.token),
    baseUrl,
    rateLimitIntervalMs: yield* intVar(
      "FIO_RATE_LIMIT_INTERVAL_MS",
      DEFAULT_RATE_LIMIT_INTERVAL_MS,
      MIN_RATE_LIMIT_INTERVAL_MS,
      " (FIO allows one request per token every 30 s)",
    ),
    maxWaitMs: yield* intVar("FIO_MAX_WAIT_MS", DEFAULT_MAX_WAIT_MS, 0),
    requestTimeoutMs: yield* intVar("FIO_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS, 1),
    transport,
    cache,
  };
  return config;
});

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("fio-mcp/AppConfig") {
  /** Reads the environment (and `_FILE` secrets) through the current ConfigProvider. */
  static readonly layer = Layer.effect(AppConfig, loadConfig());

  static readonly layerFrom = (config: AppConfigShape) => Layer.succeed(AppConfig, config);
}
