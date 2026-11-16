/** Matches one guard tag with a real (32 hex) nonce. */
export const GUARD_TAG = /<\/?untrusted-([0-9a-f]{32})>/g;

/** Removes guard tags; leaves everything else (including "[tag removed]") as is. */
export const unguard = (text: string): string => text.replace(GUARD_TAG, "");

/** Distinct nonces used in a text (a JSON result or an error message). */
export const nonces = (text: string): ReadonlyArray<string> => [
  ...new Set([...text.matchAll(GUARD_TAG)].map((m) => m[1] ?? "")),
];
