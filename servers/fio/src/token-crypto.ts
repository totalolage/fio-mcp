import { Redacted, Schema } from "effect";

/**
 * Encryption of FIO tokens at rest (HTTP mode keeps them in SQLite).
 *
 * AES-256-GCM with the data key from FIO_MCP_DATA_KEY_FILE, a fresh random
 * 96-bit nonce per value, and AAD naming what the ciphertext belongs to
 * (`fio-mcp:account-token:v1:<account id>`), so a ciphertext copied to
 * another row does not decrypt. The database holds no token in plaintext;
 * a backup without the key file reveals none.
 *
 * Errors never carry key material, tokens, or ciphertext.
 *
 * The cipher (seal/open) lives in @mcps/core; FIO owns the key file
 * format, the AAD strings, and the errors.
 */

export { open, type Sealed, seal } from "@mcps/core/seal.js";

export const DATA_KEY_BYTES = 32;

/** The data key does not decrypt what the database holds: a different key file. */
export class DataKeyMismatch extends Schema.TaggedError<DataKeyMismatch>()("DataKeyMismatch", {}) {
  override get message(): string {
    return "FIO_MCP_DATA_KEY_FILE does not hold the key this database was encrypted with. Restore the original key file; the stored FIO tokens cannot be read without it. (If the key is lost, remove the database's accounts and settings rows as described in the README and add the accounts again.)";
  }
}

/** A stored token failed to decrypt or authenticate (wrong key, or a corrupted or moved row). */
export class TokenDecryptionFailed extends Schema.TaggedError<TokenDecryptionFailed>()("TokenDecryptionFailed", {
  accountId: Schema.String,
}) {
  override get message(): string {
    return `The stored FIO token of account ${this.accountId} could not be decrypted: the row was altered or copied from another row, or FIO_MCP_DATA_KEY_FILE changed. No account was dropped; fix the key file or replace the token in the admin UI after restoring the database.`;
  }
}

const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY = /^[A-Za-z0-9+/_-]{43}={0,1}$/;

/**
 * The 32-byte key from the key file's text: 64 hex digits, or base64
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

export const accountTokenAad = (accountId: string) => `fio-mcp:account-token:v1:${accountId}`;
export const KEY_CHECK_AAD = "fio-mcp:data-key-check:v1";
/** Known plaintext whose decryption proves the key file matches the database. */
export const KEY_CHECK_PLAINTEXT = "fio-mcp data key check";
