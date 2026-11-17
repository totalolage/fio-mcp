import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Effect, Redacted, Result } from "effect";

/**
 * Authenticated encryption of small secrets at rest: AES-256-GCM with a
 * 32-byte key, a fresh random 96-bit nonce per value, and caller-supplied
 * AAD naming what the ciphertext belongs to, so a ciphertext copied to
 * another record does not decrypt.
 *
 * Failures carry no detail: never key material, plaintext, or ciphertext.
 * Key parsing and the errors shown to users belong to the caller.
 */

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface Sealed {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

/** Encrypts `plaintext` under `key` with a fresh nonce, bound to `aad`. */
export const seal = (key: Redacted.Redacted<Uint8Array>, plaintext: string, aad: string): Effect.Effect<Sealed> =>
  Effect.sync(() => {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", Redacted.value(key), nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { nonce: new Uint8Array(nonce), ciphertext: new Uint8Array(ciphertext), tag: new Uint8Array(cipher.getAuthTag()) };
  });

/**
 * Decrypts and authenticates `sealed` under `key` and `aad`. Fails (with
 * no detail) when the key, the AAD, or any byte differs.
 */
export const open = (
  key: Redacted.Redacted<Uint8Array>,
  sealed: Sealed,
  aad: string,
): Result.Result<Redacted.Redacted<string>, "invalid"> => {
  if (sealed.nonce.length !== NONCE_BYTES || sealed.tag.length !== TAG_BYTES) return Result.fail("invalid");
  try {
    const decipher = createDecipheriv("aes-256-gcm", Redacted.value(key), sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(sealed.tag);
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
    return Result.succeed(Redacted.make(plaintext));
  } catch {
    return Result.fail("invalid");
  }
};
