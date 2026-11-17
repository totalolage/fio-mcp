import { dirname, join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { failConfig, intVar, optionalVar } from "@mcps/core/config/env.js";
import {
  type ListenAddress,
  loadAdminAllowedNetworks,
  loadAdminListener,
  loadAllowedHosts,
  loadAllowedOrigins,
  loadListenAddress,
  loadOAuthCredentials,
  loadTrustedProxies,
} from "@mcps/core/config/http.js";
import { readDataKeyFile, readTotpSecretFile } from "@mcps/core/config/secret-files.js";
import type { PasswordHash } from "@mcps/core/oauth/crypto.js";
import { Context, Duration, Effect, Layer, Option, type Redacted } from "effect";
import type { IpNetwork } from "effect/net";
import { DataKey, DomainConfig, type DomainConfigShape, domainConfigDefaults } from "./domain/config.js";
import type { IsdsEnvironment } from "./isds/config.js";
import { APP_IDENTITY } from "./oauth/identity.js";

/**
 * The server's configuration from DATOVA_SCHRANKA_* (Effect Config, `_FILE`
 * secrets from the file system). datova-schranka serves HTTP with OAuth only:
 * there is no stdio transport and no unauthenticated mode. Every failure is a
 * core ConfigError naming the variable, never its value.
 */

const PREFIX = "DATOVA_SCHRANKA_";

/** Fio's defaults; the image listens on 3000 on every interface. */
export const DEFAULT_HTTP_HOST = "0.0.0.0";
export const DEFAULT_HTTP_PORT = 3000;

export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigins: ReadonlyArray<string>;
  /** Empty: any Host header. */
  readonly allowedHosts: ReadonlyArray<string>;
  readonly trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>;
  /** Empty: /admin and sign-in are not restricted by client address. */
  readonly adminAllowedNetworks: ReadonlyArray<IpNetwork.IpNetwork>;
  /** The separate admin listener, when DATOVA_SCHRANKA_ADMIN_PORT is set. */
  readonly adminListener: ListenAddress | undefined;
}

export interface OAuthConfig {
  /** The public origin: OAuth issuer; the MCP resource is this plus /mcp. */
  readonly publicUrl: string;
  /** The bootstrap admin password hash (DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE). */
  readonly passwordHash: Redacted.Redacted<PasswordHash>;
  /** The admin TOTP secret, when DATOVA_SCHRANKA_ADMIN_TOTP_SECRET_FILE is set. */
  readonly totpSecret: Redacted.Redacted<Uint8Array> | undefined;
}

export interface AppConfigShape {
  readonly http: HttpConfig;
  readonly oauth: OAuthConfig;
  /** DATOVA_SCHRANKA_DATA_KEY_FILE: seals box credentials, nonces and pending payloads. */
  readonly dataKey: Redacted.Redacted<Uint8Array>;
  /** DATOVA_SCHRANKA_DB_PATH, or the XDG data directory default. */
  readonly dbPath: string;
  /** What the domain services read; `dataDir` is DATOVA_SCHRANKA_DATA_DIR or `<dir of the database>/zfo`. */
  readonly domain: DomainConfigShape;
}

const HASH_HINT = `create the hash with \`${APP_IDENTITY.name} hash-password\``;
const OAUTH_REQUIRED = `${APP_IDENTITY.name} requires ${PREFIX}PUBLIC_URL and ${PREFIX}ADMIN_PASSWORD_HASH_FILE (${HASH_HINT}); it serves HTTP with OAuth only`;
const DATA_KEY_HELP =
  "create one with `openssl rand -hex 32 > datova_schranka_data_key` and keep a copy outside the database backups";
const DATA_KEY_REQUIRED = `${APP_IDENTITY.name} requires ${PREFIX}DATA_KEY_FILE, the key that seals the box credentials in the database; ${DATA_KEY_HELP}`;
const TOTP_HELP = `create one with \`${APP_IDENTITY.name} totp-init\``;

/** Fio variables that have no meaning here: refused, so nobody believes they apply. */
const UNSUPPORTED = ["TRANSPORT", "ALLOW_UNAUTHENTICATED", "ALLOW_UNAUTHENTICATED_ON_NETWORK"] as const;

const refuseUnsupported = Effect.forEach(
  UNSUPPORTED,
  (name) =>
    Effect.flatMap(optionalVar(`${PREFIX}${name}`), (value) =>
      Option.isSome(value)
        ? failConfig(`${PREFIX}${name} is not supported: ${APP_IDENTITY.name} serves HTTP with OAuth only; unset it`)
        : Effect.void,
    ),
  { discard: true },
);

const loadHttp = Effect.gen(function* () {
  const { host, port } = yield* loadListenAddress(PREFIX, { host: DEFAULT_HTTP_HOST, port: DEFAULT_HTTP_PORT });
  return {
    host,
    port,
    allowedOrigins: yield* loadAllowedOrigins(PREFIX),
    allowedHosts: yield* loadAllowedHosts(PREFIX),
    trustedProxies: yield* loadTrustedProxies(PREFIX),
    adminAllowedNetworks: yield* loadAdminAllowedNetworks(PREFIX),
    adminListener: yield* loadAdminListener(PREFIX, port),
  } satisfies HttpConfig;
});

const loadOAuth = Effect.gen(function* () {
  const credentials = yield* loadOAuthCredentials(PREFIX, APP_IDENTITY, OAUTH_REQUIRED);
  const totpSecret = yield* readTotpSecretFile(`${PREFIX}ADMIN_TOTP_SECRET_FILE`, TOTP_HELP);
  return {
    publicUrl: credentials.publicUrl,
    passwordHash: credentials.passwordHash,
    totpSecret: Option.getOrUndefined(totpSecret),
  } satisfies OAuthConfig;
});

const loadDataKey = Effect.gen(function* () {
  const key = yield* readDataKeyFile(`${PREFIX}DATA_KEY_FILE`, DATA_KEY_HELP);
  if (Option.isNone(key)) return yield* failConfig(DATA_KEY_REQUIRED);
  return key.value;
});

/** DATOVA_SCHRANKA_DB_PATH, else $XDG_DATA_HOME (else $HOME/.local/share)/datova-schranka/datova-schranka.sqlite, like Fio. */
const loadDbPath = Effect.gen(function* () {
  const explicit = yield* optionalVar(`${PREFIX}DB_PATH`);
  if (Option.isSome(explicit)) return explicit.value;
  const xdg = yield* optionalVar("XDG_DATA_HOME");
  const home = yield* optionalVar("HOME");
  const dataHome = Option.isSome(xdg) ? Option.some(xdg.value) : Option.map(home, (dir) => `${dir}/.local/share`);
  if (Option.isNone(dataHome)) {
    return yield* failConfig(
      `${PREFIX}DB_PATH is not set and neither XDG_DATA_HOME nor HOME is, so the database has no location`,
    );
  }
  return `${dataHome.value}/${APP_IDENTITY.name}/${APP_IDENTITY.name}.sqlite`;
});

const ENVIRONMENTS: ReadonlyArray<IsdsEnvironment> = ["production", "test"];

const loadEnvironment = Effect.gen(function* () {
  const key = `${PREFIX}ISDS_ENVIRONMENT`;
  const value = yield* optionalVar(key);
  if (Option.isNone(value)) return domainConfigDefaults.environment;
  const environment = ENVIRONMENTS.find((candidate) => candidate === value.value.toLowerCase());
  if (environment === undefined) return yield* failConfig(`${key} must be production or test`);
  return environment;
});

const loadDomain = Effect.fn("config.loadDomain")(function* (dbPath: string) {
  const dataDir = yield* optionalVar(`${PREFIX}DATA_DIR`);
  return {
    environment: yield* loadEnvironment,
    requestTimeout: Duration.millis(
      yield* intVar(`${PREFIX}ISDS_REQUEST_TIMEOUT_MS`, Duration.toMillis(domainConfigDefaults.requestTimeout), 1000),
    ),
    dataDir: Option.getOrElse(dataDir, () => join(dirname(dbPath), "zfo")),
    attachmentInlineMaxBytes: yield* intVar(
      `${PREFIX}ATTACHMENT_INLINE_MAX_BYTES`,
      domainConfigDefaults.attachmentInlineMaxBytes,
      0,
    ),
    responseInlineMaxBytes: yield* intVar(
      `${PREFIX}RESPONSE_INLINE_MAX_BYTES`,
      domainConfigDefaults.responseInlineMaxBytes,
      0,
    ),
    approvalNonceTtl: Duration.minutes(
      yield* intVar(`${PREFIX}APPROVAL_NONCE_TTL_MINUTES`, Duration.toMinutes(domainConfigDefaults.approvalNonceTtl), 1),
    ),
    pendingTtl: Duration.hours(
      yield* intVar(`${PREFIX}PENDING_TTL_HOURS`, Duration.toHours(domainConfigDefaults.pendingTtl), 1),
    ),
  } satisfies DomainConfigShape;
});

/** Reads the whole configuration through the current ConfigProvider (and the file system for `_FILE` secrets). */
export const loadConfig = Effect.gen(function* () {
  yield* refuseUnsupported;
  const http = yield* loadHttp;
  const oauth = yield* loadOAuth;
  const dataKey = yield* loadDataKey;
  const dbPath = yield* loadDbPath;
  const domain = yield* loadDomain(dbPath);
  return { http, oauth, dataKey, dbPath, domain } satisfies AppConfigShape;
}).pipe(Effect.withSpan("config.load"));

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("datova-schranka/AppConfig") {
  /** Reads the environment (and `_FILE` secrets) through the current ConfigProvider. */
  static readonly Default = Layer.effect(AppConfig, loadConfig);
  static readonly Live = AppConfig.Default.pipe(Layer.provide(NodeFileSystem.layer));
}

/** DomainConfig and DataKey from the loaded configuration. */
export const DomainLive: Layer.Layer<DomainConfig | DataKey, never, AppConfig> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return Layer.merge(DomainConfig.layer(config.domain), DataKey.layer(config.dataKey));
  }),
);
