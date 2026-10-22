import { FioApiError, RateLimitedError } from "./errors.js";

export interface RateLimiterOptions {
  /** Minimum spacing between request starts. FIO allows one request per 30 s per token. */
  intervalMs: number;
  /** Longest a call may spend waiting (queue plus 409 back-off) before failing fast. */
  maxWaitMs: number;
}

export interface RateLimitState {
  intervalSeconds: number;
  /** Seconds until a newly arriving call could start (0 = now). */
  nextSlotInSeconds: number;
  /** Calls waiting for a slot. */
  queued: number;
  last409At?: string;
}

interface Waiter {
  /** Latest acceptable start time; past it the call fails fast instead of waiting. */
  deadline: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Serialized request queue for one FIO token.
 *
 * Calls start in arrival order, at least `intervalMs` apart. Each call has a
 * wait budget (`maxWaitMs` from when it arrived). A call that cannot start
 * within its budget is rejected with a retry-after hint instead of hanging past
 * the MCP client's timeout: at arrival when the projected start is already too
 * late, or at dispatch when a later 409 pushed the queue back.
 *
 * On HTTP 409 (token used elsewhere within the window) the token is blocked for
 * a full interval, which delays everyone queued, and the call retries once at
 * the head of the queue if that still fits its budget.
 */
export class TokenRateLimiter {
  private lastStart = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;
  private last409At: number | undefined;
  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: RateLimiterOptions) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + this.options.maxWaitMs;
    await this.acquire(deadline, signal, false);
    try {
      return await fn();
    } catch (error) {
      if (!isConflict(error)) throw error;
      this.block();
      await this.acquire(deadline, signal, true, "FIO returned HTTP 409 (the token was used elsewhere within the last 30 s).", 409);
      try {
        return await fn();
      } catch (retryError) {
        if (!isConflict(retryError)) throw retryError;
        this.block();
        throw new RateLimitedError(
          Math.ceil(this.options.intervalMs / 1000),
          "FIO returned HTTP 409 twice; another client is probably using this token.",
          409,
        );
      }
    }
  }

  state(): RateLimitState {
    const now = Date.now();
    return {
      intervalSeconds: this.options.intervalMs / 1000,
      nextSlotInSeconds: Math.ceil(Math.max(0, this.projectedStart(now) - now) / 1000),
      queued: this.queue.length,
      ...(this.last409At === undefined ? {} : { last409At: new Date(this.last409At).toISOString() }),
    };
  }

  /** Earliest time the head of the queue may start. */
  private readyAt(): number {
    return Math.max(this.lastStart + this.options.intervalMs, this.blockedUntil);
  }

  /** Estimated start for a call joining the back of the queue now. */
  private projectedStart(now: number): number {
    return Math.max(now, this.readyAt()) + this.queue.length * this.options.intervalMs;
  }

  private block(): void {
    this.last409At = Date.now();
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + this.options.intervalMs);
    this.reschedule();
  }

  private acquire(
    deadline: number,
    signal: AbortSignal | undefined,
    front: boolean,
    reason?: string,
    observedStatus?: number,
  ): Promise<void> {
    const now = Date.now();
    const start = front ? Math.max(now, this.readyAt()) : this.projectedStart(now);
    if (start > deadline) {
      return Promise.reject(this.tooLate(start - now, reason, observedStatus));
    }
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { deadline, resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          this.remove(waiter);
          reject(signal.reason ?? new Error("Aborted"));
          this.reschedule();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      if (front) this.queue.unshift(waiter);
      else this.queue.push(waiter);
      this.reschedule();
    });
  }

  private tooLate(waitMs: number, reason?: string, observedStatus?: number): RateLimitedError {
    return new RateLimitedError(
      Math.max(1, Math.ceil(waitMs / 1000)),
      reason ??
        `FIO allows one request per ${Math.round(this.options.intervalMs / 1000)} s per token and the next free slot is ${Math.ceil(waitMs / 1000)} s away.`,
      observedStatus,
    );
  }

  private remove(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  private reschedule(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pump();
  }

  /** Dispatches the head of the queue when its slot arrives. */
  private pump(): void {
    const now = Date.now();
    while (this.queue.length > 0) {
      const head = this.queue[0] as Waiter;
      const readyAt = Math.max(now, this.readyAt());
      if (readyAt > head.deadline) {
        // A 409 pushed the queue past this call's budget: fail fast.
        this.remove(head);
        head.reject(this.tooLate(readyAt - now));
        continue;
      }
      if (readyAt > now) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.pump();
        }, readyAt - now);
        return;
      }
      this.remove(head);
      this.lastStart = now;
      head.resolve();
    }
  }
}

function isConflict(error: unknown): boolean {
  return error instanceof FioApiError && error.kind === "rate_limited";
}
