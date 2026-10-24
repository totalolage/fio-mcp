import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { Effect, Redacted, Schema } from "effect";

/**
 * Secrets the authorization server mints and checks: opaque tokens (stored
 * only as SHA-256 hashes), PKCE, cookie signatures, and the admin password
 * hash (scrypt). Every comparison of secret material is constant-time.
 */

/** 256 random bits, base64url, behind a short type prefix. */
export const randomSecret = (prefix: string) =>
  Effect.sync(() => Redacted.make(`${prefix}${randomBytes(32).toString("base64url")}`));

/** A random identifier that is not a secret (client ids, grant ids). */
export const randomId = (prefix: string) => Effect.sync(() => `${prefix}${randomBytes(16).toString("base64url")}`);

/** Storage key for a token or code: SHA-256 hex. 256-bit random inputs need no salt or stretching. */
export const hashSecret = (secret: Redacted.Redacted<string> | string): string =>
  createHash("sha256")
    .update(typeof secret === "string" ? secret : Redacted.value(secret), "utf8")
    .digest("hex");

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time string equality; both sides are hashed first so lengths do not leak. */
export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

/** RFC 7636 §4.1: 43-128 characters of the unreserved set. */
export const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** An S256 challenge is the base64url SHA-256 of the verifier: 43 characters. */
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** RFC 7636 §4.6, S256 only. */
export const pkceMatches = (verifier: string, challenge: string): boolean =>
  CODE_VERIFIER.test(verifier) &&
  safeEqual(createHash("sha256").update(verifier, "ascii").digest("base64url"), challenge);

/** HMAC-SHA256 signature (base64url) of `value` under `key`. */
export const sign = (key: Redacted.Redacted<Uint8Array>, value: string): string =>
  createHmac("sha256", Redacted.value(key)).update(value, "utf8").digest("base64url");

export const newSigningKey = Effect.sync(() => Redacted.make(new Uint8Array(randomBytes(32))));

// ---------------------------------------------------------------------------
// Admin password: `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<hash>` (base64, no padding).

export class PasswordHashError extends Schema.TaggedError<PasswordHashError>()("PasswordHashError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface ScryptParams {
  /** log2 of the CPU/memory cost N. */
  readonly ln: number;
  readonly r: number;
  readonly p: number;
}

export interface PasswordHash {
  readonly params: ScryptParams;
  readonly salt: Uint8Array;
  readonly hash: Uint8Array;
}

/** OWASP's scrypt baseline: N=2^17, r=8, p=1 (128 MiB, a few hundred ms). */
export const DEFAULT_SCRYPT: ScryptParams = { ln: 17, r: 8, p: 1 };
const MAX_SCRYPT_MEMORY = 256 * 1024 * 1024;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

const FORMAT = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,})\$([A-Za-z0-9+/]{43,})$/;

const memoryOf = ({ ln, r }: ScryptParams) => 128 * 2 ** ln * r;

/** Parses and bounds-checks a hash line; the error never echoes the value. */
export function parsePasswordHash(line: string): PasswordHash | PasswordHashError {
  const match = FORMAT.exec(line.trim());
  if (match === null) {
    return new PasswordHashError({
      detail: "is not a fio-mcp password hash ($scrypt$ln=…,r=…,p=…$salt$hash); create one with `fio-mcp hash-password`",
    });
  }
  const params = { ln: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (params.ln < 14 || params.ln > 20 || params.r < 1 || params.p < 1 || params.p > 4 || memoryOf(params) > MAX_SCRYPT_MEMORY) {
    return new PasswordHashError({ detail: "has scrypt parameters outside the accepted range (ln 14-20, p 1-4, at most 256 MiB)" });
  }
  const salt = Buffer.from(match[4] ?? "", "base64");
  const hash = Buffer.from(match[5] ?? "", "base64");
  if (salt.length < SALT_BYTES || hash.length < KEY_BYTES) {
    return new PasswordHashError({ detail: "has a salt or hash that is too short" });
  }
  return { params, salt: new Uint8Array(salt), hash: new Uint8Array(hash) };
}

const unpadded = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/=+$/, "");

export const formatPasswordHash = ({ params, salt, hash }: PasswordHash): string =>
  `$scrypt$ln=${params.ln},r=${params.r},p=${params.p}$${unpadded(salt)}$${unpadded(hash)}`;

const derive = (password: string, salt: Uint8Array, params: ScryptParams, length: number) =>
  Effect.callback<Uint8Array, PasswordHashError>((resume) => {
    scrypt(
      password.normalize("NFC"),
      salt,
      length,
      { N: 2 ** params.ln, r: params.r, p: params.p, maxmem: MAX_SCRYPT_MEMORY + 1024 * 1024 },
      (error, key) =>
        resume(
          error === null
            ? Effect.succeed(new Uint8Array(key))
            : Effect.fail(new PasswordHashError({ detail: "scrypt failed" })),
        ),
    );
  });

export const hashPassword = Effect.fn("Password.hash")(function* (
  password: Redacted.Redacted<string>,
  params: ScryptParams = DEFAULT_SCRYPT,
) {
  const salt = new Uint8Array(randomBytes(SALT_BYTES));
  const hash = yield* derive(Redacted.value(password), salt, params, KEY_BYTES);
  return formatPasswordHash({ params, salt, hash });
});

/** Constant-time check of `password` against `expected`. */
export const verifyPassword = Effect.fn("Password.verify")(function* (
  password: Redacted.Redacted<string>,
  expected: PasswordHash,
) {
  const actual = yield* derive(Redacted.value(password), expected.salt, expected.params, expected.hash.length);
  return timingSafeEqual(actual, expected.hash);
});
