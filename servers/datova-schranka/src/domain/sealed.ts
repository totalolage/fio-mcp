import { open, type Sealed, seal } from "@mcps/core/seal.js";
import { Effect, type Redacted, Result } from "effect";

/**
 * Sealed values as one TEXT column: `v1.<nonce>.<ciphertext>.<tag>`, each
 * part base64url. AAD strings name what a ciphertext belongs to, so a value
 * copied to another row does not open.
 */

export const boxCredentialsAad = (boxId: string): string => `datova-schranka:box-credentials:v1:${boxId}`;
export const filingPayloadAad = (filingId: string): string => `datova-schranka:filing:v1:${filingId}`;
export const approvalNonceAad = (nonceHash: string): string => `datova-schranka:approval-nonce:v1:${nonceHash}`;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

export const encodeSealed = (sealed: Sealed): string =>
  `v1.${b64(sealed.nonce)}.${b64(sealed.ciphertext)}.${b64(sealed.tag)}`;

export const decodeSealed = (text: string): Result.Result<Sealed, "invalid"> => {
  const parts = text.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return Result.fail("invalid");
  const [, nonce = "", ciphertext = "", tag = ""] = parts;
  return Result.succeed({ nonce: bytesOf(nonce), ciphertext: bytesOf(ciphertext), tag: bytesOf(tag) });
};

/** Seals `plaintext` and encodes it for a TEXT column. */
export const sealText = (key: Redacted.Redacted<Uint8Array>, plaintext: string, aad: string): Effect.Effect<string> =>
  Effect.map(seal(key, plaintext, aad), encodeSealed);

/** Decodes and opens a TEXT column written by `sealText`; "invalid" on any mismatch. */
export const openText = (
  key: Redacted.Redacted<Uint8Array>,
  text: string,
  aad: string,
): Result.Result<Redacted.Redacted<string>, "invalid"> =>
  Result.flatMap(decodeSealed(text), (sealed) => open(key, sealed, aad));
