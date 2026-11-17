import { randomBytes } from "node:crypto";

/**
 * Identifier rules the domain checks before an id reaches SQL, a file path
 * or ISDS. ISDS data box ids are 7 lowercase letters and digits; message ids
 * 1-20 digits (models.ts accepts any 7 / 1-20 characters, so these are
 * stricter on purpose: they are safe as path segments).
 */
const DATA_BOX_ID = /^[a-z0-9]{7}$/;
const MESSAGE_ID = /^[0-9]{1,20}$/;
const BOX_ID = /^box_[A-Za-z0-9_-]{22}$/;

export const isDataBoxId = (value: string): boolean => DATA_BOX_ID.test(value);
export const isMessageId = (value: string): boolean => MESSAGE_ID.test(value);

/** Our opaque id of a stored box (what grants hold): `box_` + 128 random bits, base64url. Never the dbID. */
export const newBoxId = (): string => `box_${randomBytes(16).toString("base64url")}`;
export const isBoxId = (value: string): boolean => BOX_ID.test(value);

/** A random row id for audit entries, filings and the like. */
export const newRowId = (prefix: string): string => `${prefix}_${randomBytes(16).toString("base64url")}`;
