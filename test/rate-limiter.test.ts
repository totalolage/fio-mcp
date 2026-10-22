import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FioApiError, RateLimitedError } from "../src/errors.js";
import { TokenRateLimiter } from "../src/rate-limiter.js";

const conflict = () => new FioApiError("rate_limited", "409", 409);

describe("TokenRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("spaces request starts by the interval and runs them in order", async () => {
    const limiter = new TokenRateLimiter({ intervalMs: 30_000, maxWaitMs: 100_000 });
    const starts: number[] = [];
    const job = (label: string) => async () => {
      starts.push(Date.now());
      return label;
    };
    const t0 = Date.now();
    const results = [limiter.run(job("a")), limiter.run(job("b")), limiter.run(job("c"))];
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(Promise.all(results)).resolves.toEqual(["a", "b", "c"]);
    expect(starts.map((s) => s - t0)).toEqual([0, 30_000, 60_000]);
  });

  it("does not wait when the interval has already passed", async () => {
    const limiter = new TokenRateLimiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
    await limiter.run(async () => 1);
    await vi.advanceTimersByTimeAsync(31_000);
    const fn = vi.fn(async () => 2);
    const p = limiter.run(fn);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledOnce();
    await expect(p).resolves.toBe(2);
  });

  it("fails fast with retry-after when the queue wait would exceed the cap", async () => {
    const limiter = new TokenRateLimiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
    await limiter.run(async () => "first");
    await vi.advanceTimersByTimeAsync(2_000);
    const fn = vi.fn(async () => "second");
    const error = await limiter.run(fn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(28);
    expect((error as Error).message).toMatch(/retry after 28 s/i);
    expect(fn).not.toHaveBeenCalled();
    // The rejected call did not reserve a slot.
    expect(limiter.state().nextSlotInSeconds).toBe(28);
  });

  it("queues a call whose wait fits within the cap", async () => {
    const limiter = new TokenRateLimiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
    await limiter.run(async () => "first");
    await vi.advanceTimersByTimeAsync(10_000);
    const fn = vi.fn(async () => "second");
    const p = limiter.run(fn);
    expect(limiter.state().queued).toBe(1);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe("second");
  });

  it("retries once after HTTP 409 when the back-off fits the budget", async () => {
    const limiter = new TokenRateLimiter({ intervalMs: 30_000, maxWaitMs: 40_000 });
    const fn = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce("ok");
    const t0 = Date.now();
    const p = limiter.run(fn);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBe(30_000);
    expect(limiter.state().last409At).toBeDefined();
  });

  it("fails fast after HTTP 409 when the back-off would exceed the budget", async () => {
    const limiter = new TokenRateLimiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
    const fn = vi.fn().mockRejectedValue(conflict());
    const error = await limiter.run(fn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as Error).message).toMatch(/409/);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(30);
    expect(fn).toHaveBeenCalledTimes(1);
    // Later callers also see the token as busy.
    expect(limiter.state().nextSlotInSeconds).toBe(30);
  });

  it("gives up after a second 409", async () => {
    const limiter = new TokenRateLimiter({ intervalMs: 30_000, maxWaitMs: 60_000 });
    const fn = vi.fn().mockRejectedValue(conflict());
    const p = limiter.run(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await p;
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as Error).message).toMatch(/twice/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("delays already-queued calls when a 409 arrives later", async () => {
    const limiter = new TokenRateLimiter({ intervalMs: 30_000, maxWaitMs: 40_000 });
    const t0 = Date.now();
    // A starts at 0 and gets a 409 after 15 s.
    const a = limiter
      .run(() => new Promise((_, reject) => setTimeout(() => reject(conflict()), 15_000)))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    // B arrives at 10 s and would normally start at 30 s.
    let bStartedAt: number | undefined;
    const b = limiter.run(async () => {
      bStartedAt = Date.now() - t0;
      return "b";
    });
    await vi.advanceTimersByTimeAsync(5_000);
    // A's retry would start at 45 s, past its 40 s budget: it fails fast.
    expect(await a).toBeInstanceOf(RateLimitedError);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(bStartedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(b).resolves.toBe("b");
    expect(bStartedAt).toBe(45_000);
  });

  it("fails a queued call fast when a 409 pushes it past its budget", async () => {
    const limiter = new TokenRateLimiter({ intervalMs: 30_000, maxWaitMs: 25_000 });
    const a = limiter
      .run(() => new Promise((_, reject) => setTimeout(() => reject(conflict()), 1_000)))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    // A finished (409) at 1 s, blocking until 31 s; B arrives at 10 s and fits (21 s wait).
    const fn = vi.fn(async () => "b");
    const b = limiter.run(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await a).toBeInstanceOf(RateLimitedError);
    await vi.advanceTimersByTimeAsync(21_000);
    await expect(b).resolves.toBe("b");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("passes non-409 errors through without retrying", async () => {
    const limiter = new TokenRateLimiter({ intervalMs: 30_000, maxWaitMs: 60_000 });
    const fn = vi.fn().mockRejectedValue(new FioApiError("bad_request", "404", 404));
    await expect(limiter.run(fn)).rejects.toMatchObject({ kind: "bad_request" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the caller aborts", async () => {
    const limiter = new TokenRateLimiter({ intervalMs: 30_000, maxWaitMs: 60_000 });
    await limiter.run(async () => 1);
    const controller = new AbortController();
    const fn = vi.fn(async () => 2);
    const p = limiter.run(fn, controller.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort(new Error("cancelled"));
    expect(await p).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).not.toHaveBeenCalled();
  });
});
