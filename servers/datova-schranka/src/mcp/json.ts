import { DateTime } from "effect";

/**
 * A domain value as plain JSON data for a tool result: ISDS times become
 * ISO 8601 UTC strings, sets become arrays, bigints strings, and binary
 * fields (the qualified timestamp) are left out. Undefined fields are
 * dropped.
 */
export const toJson = (value: unknown): unknown => {
  if (DateTime.isDateTime(value)) return DateTime.formatIso(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return undefined;
  if (value instanceof Set) return [...value].map(toJson);
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const converted = toJson(field);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
};

/** toJson of an object value. */
export const jsonObject = (value: object): Record<string, unknown> => toJson(value) as Record<string, unknown>;
