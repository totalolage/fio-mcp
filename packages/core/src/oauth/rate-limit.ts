/**
 * Sliding-window counters per key (a client id or a client address), in
 * memory. At most `limit` events per key in any `windowMs`; beyond
 * `maxKeys` keys the least recently used are forgotten.
 */
export interface WindowPolicy {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
}

export interface WindowLimiter {
  /** Seconds until `key` may have another event, or 0 when it may now. */
  readonly retryAfter: (key: string, now: number) => number;
  readonly record: (key: string, now: number) => void;
}

export const makeWindowLimiter = (policy: WindowPolicy): WindowLimiter => {
  const events = new Map<string, Array<number>>();

  const recent = (key: string, now: number) => {
    const times = (events.get(key) ?? []).filter((time) => time > now - policy.windowMs);
    if (times.length === 0) events.delete(key);
    return times;
  };

  const retryAfter = (key: string, now: number) => {
    const times = recent(key, now);
    const oldest = times[0];
    return times.length < policy.limit || oldest === undefined ? 0 : Math.ceil((oldest + policy.windowMs - now) / 1000);
  };

  const record = (key: string, now: number) => {
    const times = recent(key, now);
    times.push(now);
    events.delete(key);
    events.set(key, times);
    while (events.size > policy.maxKeys) {
      const stalest = events.keys().next();
      if (stalest.done === true) break;
      events.delete(stalest.value);
    }
  };

  return { retryAfter, record };
};
