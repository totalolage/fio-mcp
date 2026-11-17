import { Effect, Option, Redacted } from "effect";
import { decodeBase32, MIN_TOTP_SECRET_BYTES } from "../admin/totp.js";
import type { AppIdentity } from "../app-identity.js";
import { type PasswordHash, PasswordHashError, parsePasswordHash } from "../oauth/crypto.js";
import { failConfig, optionalVar, readVarFile } from "./env.js";

/**
 * Secrets that live only in files named by a variable: the data key, the
 * admin password hash and the admin TOTP secret. Each reader returns None
 * when its variable is unset, so the app decides whether that is an error
 * and how to word it. Never echoes the file content.
 */

/** Length of the AES-256-GCM data key (seal.ts). */
export const DATA_KEY_BYTES = 32;

const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY = /^[A-Za-z0-9+/_-]{43}={0,1}$/;

/**
 * The 32-byte key from a key file's text: 64 hex digits, or base64
 * (standard or URL-safe, padded or not). Undefined for anything else, so
 * the caller's message can stay value-free.
 */
export function parseDataKey(text: string): Redacted.Redacted<Uint8Array> | undefined {
  const trimmed = text.trim();
  if (HEX_KEY.test(trimmed)) return Redacted.make(new Uint8Array(Buffer.from(trimmed, "hex")));
  if (BASE64_KEY.test(trimmed)) {
    const bytes = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (bytes.length === DATA_KEY_BYTES) return Redacted.make(new Uint8Array(bytes));
  }
  return undefined;
}

/** The data key from the file `key` names (parseDataKey). `help` says how to create one. */
export const readDataKeyFile = Effect.fn("config.readDataKeyFile")(function* (key: string, help: string) {
  const file = yield* optionalVar(key);
  if (Option.isNone(file)) return Option.none<Redacted.Redacted<Uint8Array>>();
  const dataKey = parseDataKey(yield* readVarFile(key, file.value));
  if (dataKey === undefined) {
    return yield* failConfig(`${key}: file must contain 32 bytes as 64 hex digits or base64; ${help}`);
  }
  return Option.some(dataKey);
});

/** The admin password hash from the file `key` names: exactly one non-blank line, in `app`'s hash format. */
export const readPasswordHashFile = Effect.fn("config.readPasswordHashFile")(function* (key: string, app: AppIdentity) {
  const file = yield* optionalVar(key);
  if (Option.isNone(file)) return Option.none<Redacted.Redacted<PasswordHash>>();
  return Option.some(yield* readPasswordHashAt(key, file.value, app));
});

/** readPasswordHashFile for a `path` already read from `key`. */
export const readPasswordHashAt = Effect.fn("config.readPasswordHashAt")(function* (
  key: string,
  path: string,
  app: AppIdentity,
) {
  const content = yield* readVarFile(key, path);
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 1) {
    return yield* failConfig(`${key}: file must contain exactly one hash line`);
  }
  const hash = parsePasswordHash(lines[0] ?? "", app);
  if (hash instanceof PasswordHashError) {
    return yield* failConfig(`${key}: file ${hash.detail}`);
  }
  return Redacted.make(hash);
});

/**
 * The admin TOTP secret (RFC 6238, base32) from the file `key` names.
 * Lowercase, spaces and `=` padding are accepted; at least
 * MIN_TOTP_SECRET_BYTES (128 bits). `help` says how to create one.
 */
export const readTotpSecretFile = Effect.fn("config.readTotpSecretFile")(function* (key: string, help: string) {
  const file = yield* optionalVar(key);
  if (Option.isNone(file)) return Option.none<Redacted.Redacted<Uint8Array>>();
  const secret = decodeBase32(yield* readVarFile(key, file.value));
  if (secret === undefined) {
    return yield* failConfig(`${key}: file must contain a base32 secret; ${help}`);
  }
  if (secret.length < MIN_TOTP_SECRET_BYTES) {
    return yield* failConfig(
      `${key}: the secret must be at least ${MIN_TOTP_SECRET_BYTES} bytes (${Math.ceil((MIN_TOTP_SECRET_BYTES * 8) / 5)} base32 characters); ${help}`,
    );
  }
  return Option.some(Redacted.make(secret));
});
