import { Effect, Option, type Redacted } from "effect";
import type { IpNetwork } from "effect/net";
import type { AppIdentity } from "../app-identity.js";
import type { PasswordHash } from "../oauth/crypto.js";
import { parsePublicUrl } from "../oauth/urls.js";
import { parseTrustedProxy } from "../transport/client-address.js";
import { failConfig, intVar, listVar, optionalVar } from "./env.js";
import { readPasswordHashAt } from "./secret-files.js";

/**
 * The HTTP listener, OAuth and admin-listener variables every HTTP server
 * reads, under the app's prefix (`<prefix>HOST`, `<prefix>PORT`, ...). The
 * suffixes and their security rules live here so apps cannot drift apart.
 * Each loader reads its own variables; the app composes them in the order
 * its failures should be reported.
 */

/** Default bind address of the separate admin listener (`<prefix>ADMIN_HOST`). */
export const DEFAULT_ADMIN_HOST = "127.0.0.1";

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

/** `<prefix>HOST` and `<prefix>PORT` (1-65535), each defaulting to `defaults`. */
export const loadListenAddress = Effect.fn("config.loadListenAddress")(function* (prefix: string, defaults: ListenAddress) {
  const host = Option.getOrElse(yield* optionalVar(`${prefix}HOST`), () => defaults.host);
  const port = yield* intVar(`${prefix}PORT`, defaults.port, 1);
  if (port > 65_535) return yield* failConfig(`${prefix}PORT must be an integer from 1 to 65535`);
  return { host, port } satisfies ListenAddress;
});

/** `<prefix>ALLOWED_ORIGINS`: exact Origin values accepted on /mcp. */
export const loadAllowedOrigins = (prefix: string) => listVar(`${prefix}ALLOWED_ORIGINS`);

/** `<prefix>ALLOWED_HOSTS`: accepted Host header values, lowercased. Empty accepts any. */
export const loadAllowedHosts = (prefix: string) =>
  listVar(`${prefix}ALLOWED_HOSTS`).pipe(Effect.map((hosts) => hosts.map((h) => h.toLowerCase())));

/** A comma-separated list of IP addresses and CIDR networks (parseTrustedProxy) in `key`. */
const loadNetworks = Effect.fn("config.loadNetworks")(function* (key: string) {
  const networks: Array<IpNetwork.IpNetwork> = [];
  for (const [index, entry] of (yield* listVar(key)).entries()) {
    const network = parseTrustedProxy(entry);
    if (network === undefined) {
      return yield* failConfig(`${key} entry ${index + 1} must be an IP address or a CIDR network such as 172.18.0.0/16`);
    }
    networks.push(network);
  }
  return networks;
});

/** `<prefix>TRUSTED_PROXIES`: reverse proxies whose X-Forwarded-For is believed. Empty trusts no one. */
export const loadTrustedProxies = (prefix: string) => loadNetworks(`${prefix}TRUSTED_PROXIES`);

/**
 * `<prefix>ADMIN_ALLOWED_CIDRS`: client networks allowed to reach /admin and
 * the sign-in pages. Empty or unset: no restriction. An empty allowlist
 * allows everyone, so a set variable must name at least one network (not
 * just commas).
 */
export const loadAdminAllowedNetworks = Effect.fn("config.loadAdminAllowedNetworks")(function* (prefix: string) {
  const key = `${prefix}ADMIN_ALLOWED_CIDRS`;
  const networks = yield* loadNetworks(key);
  if (networks.length === 0 && Option.isSome(yield* optionalVar(key))) {
    return yield* failConfig(`${key} must name at least one IP address or CIDR network`);
  }
  return networks;
});

/**
 * `<prefix>ADMIN_PORT` (1-65535, distinct from the main `port`) and
 * `<prefix>ADMIN_HOST` (default DEFAULT_ADMIN_HOST, only with the port): a
 * second listener that alone serves /admin. Undefined when the port is unset.
 */
export const loadAdminListener = Effect.fn("config.loadAdminListener")(function* (prefix: string, port: number) {
  const adminHost = yield* optionalVar(`${prefix}ADMIN_HOST`);
  const rawPort = yield* optionalVar(`${prefix}ADMIN_PORT`);
  if (Option.isNone(rawPort)) {
    if (Option.isSome(adminHost)) return yield* failConfig(`${prefix}ADMIN_HOST is set but ${prefix}ADMIN_PORT is not`);
    return undefined;
  }
  const adminPort = Number(rawPort.value);
  if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65_535) {
    return yield* failConfig(`${prefix}ADMIN_PORT must be an integer from 1 to 65535`);
  }
  const listener: ListenAddress = { host: Option.getOrElse(adminHost, () => DEFAULT_ADMIN_HOST), port: adminPort };
  if (listener.port === port) {
    return yield* failConfig(`${prefix}ADMIN_PORT must differ from ${prefix}PORT`);
  }
  return listener;
});

export interface OAuthCredentials {
  /** The public origin: OAuth issuer; the resource is this plus /mcp. */
  readonly publicUrl: string;
  /** The bootstrap admin password hash. */
  readonly passwordHash: Redacted.Redacted<PasswordHash>;
}

/**
 * `<prefix>PUBLIC_URL` and `<prefix>ADMIN_PASSWORD_HASH_FILE`, both
 * required. `required` is the app's sentence saying so (and how to create
 * the hash); it is the whole failure when neither is set and follows the
 * failure when only one is.
 */
export const loadOAuthCredentials = Effect.fn("config.loadOAuthCredentials")(function* (
  prefix: string,
  app: AppIdentity,
  required: string,
) {
  const urlKey = `${prefix}PUBLIC_URL`;
  const hashKey = `${prefix}ADMIN_PASSWORD_HASH_FILE`;
  const publicUrl = yield* optionalVar(urlKey);
  const hashFile = yield* optionalVar(hashKey);
  if (Option.isNone(publicUrl) && Option.isNone(hashFile)) return yield* failConfig(required);
  if (Option.isNone(publicUrl)) return yield* failConfig(`${hashKey} is set but ${urlKey} is not. ${required}`);
  if (Option.isNone(hashFile)) return yield* failConfig(`${urlKey} is set but ${hashKey} is not. ${required}`);
  const parsedUrl = parsePublicUrl(publicUrl.value, app);
  if ("problem" in parsedUrl) return yield* failConfig(`${urlKey} ${parsedUrl.problem}`);
  const passwordHash = yield* readPasswordHashAt(hashKey, hashFile.value, app);
  return { publicUrl: parsedUrl.origin, passwordHash } satisfies OAuthCredentials;
});
