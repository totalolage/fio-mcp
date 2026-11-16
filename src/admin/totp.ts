import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP for the optional admin second factor: HMAC-SHA1, 6 digits,
 * 30 s steps, one step of clock drift either way. Only `node:crypto`.
 * Secrets travel as base32 (RFC 4648, as authenticator apps expect).
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted on either side of the current one. */
export const TOTP_WINDOW = 1;
/** `fio-mcp totp-init` secrets: 160 bits, the HMAC-SHA1 block RFC 4226 recommends. */
export const TOTP_SECRET_BYTES = 20;
/** Shorter configured secrets are refused (RFC 4226 requires at least 128 bits). */
export const MIN_TOTP_SECRET_BYTES = 16;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 without padding. */
export const encodeBase32 = (bytes: Uint8Array): string => {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
};

/**
 * Decodes base32, accepting lowercase, spaces and trailing `=` padding.
 * Undefined for any other character, padding in the middle, or no data.
 */
export const decodeBase32 = (text: string): Uint8Array | undefined => {
  const cleaned = text.replace(/\s+/g, "").toUpperCase().replace(/=+$/, "");
  if (cleaned === "") return undefined;
  const out: Array<number> = [];
  let buffer = 0;
  let bits = 0;
  for (const char of cleaned) {
    const value = BASE32.indexOf(char);
    if (value < 0) return undefined;
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
};

/** The 30 s step `unixSeconds` falls in. */
export const totpStep = (unixSeconds: number): number => Math.floor(unixSeconds / TOTP_PERIOD_SECONDS);

/** RFC 4226 HOTP for `counter`, 6 digits. */
const hotp = (secret: Uint8Array, counter: number): string => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(binary).padStart(TOTP_DIGITS, "0");
};

/** The code for the step `unixSeconds` falls in. */
export const totpCode = (secret: Uint8Array, unixSeconds: number): string => hotp(secret, totpStep(unixSeconds));

/**
 * The step within ±TOTP_WINDOW of `unixSeconds` whose code is `code`, or
 * undefined. Spaces in `code` are ignored. Every candidate is compared in
 * constant time and none is skipped once one matches.
 */
export const matchingTotpStep = (secret: Uint8Array, code: string, unixSeconds: number): number | undefined => {
  const entered = code.replace(/\s+/g, "");
  if (!/^\d+$/.test(entered) || entered.length !== TOTP_DIGITS) return undefined;
  const given = Buffer.from(entered, "ascii");
  const current = totpStep(unixSeconds);
  let matched: number | undefined;
  for (let step = Math.max(0, current - TOTP_WINDOW); step <= current + TOTP_WINDOW; step++) {
    if (timingSafeEqual(given, Buffer.from(hotp(secret, step), "ascii")) && matched === undefined) matched = step;
  }
  return matched;
};

/** A fresh random secret of TOTP_SECRET_BYTES. */
export const newTotpSecret = (): Uint8Array => new Uint8Array(randomBytes(TOTP_SECRET_BYTES));

/** The `otpauth://` URI authenticator apps import (usually as a QR code). */
export const otpauthUri = (secret: Uint8Array): string =>
  `otpauth://totp/fio-mcp:admin?secret=${encodeBase32(secret)}&issuer=fio-mcp&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
