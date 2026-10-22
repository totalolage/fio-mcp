import type { AccountConfig, Capability, ServerConfig } from "./config.js";
import { FioApiError, RateLimitedError } from "./errors.js";
import { FioClient, type FetchFn } from "./fio-client.js";
import { looksLikeMissingPaymentPermission, type ImportResult } from "./import-response.js";
import { TokenRateLimiter } from "./rate-limiter.js";
import { log, registerSecret } from "./redact.js";
import type { StatementInfo } from "./statement.js";

/** Consecutive HTTP 500s before a token is treated as dead (see classifyFailure). */
export const TOKEN_REJECTION_STRIKES = 2;

export interface LostCapability {
  capability: Capability;
  reason: string;
  at: string;
}

export type Operation = "read" | "import";

export class Account {
  readonly name: string;
  readonly client: FioClient;
  private readonly lost = new Map<Capability, LostCapability>();
  private learnedAccountNumber: string | undefined;
  private learnedCurrency: string | undefined;
  /** Consecutive HTTP 500 responses per operation type. */
  readonly strikes: Record<Operation, number> = { read: 0, import: 0 };

  constructor(
    private readonly config: AccountConfig,
    readonly limiter: TokenRateLimiter,
    client: FioClient,
  ) {
    this.name = config.name;
    this.client = client;
  }

  get declared(): Capability[] {
    return [...this.config.permissions];
  }

  has(capability: Capability): boolean {
    return this.config.permissions.has(capability) && !this.lost.has(capability);
  }

  effective(): Capability[] {
    return this.declared.filter((c) => this.has(c));
  }

  lostCapabilities(): LostCapability[] {
    return [...this.lost.values()];
  }

  /** Returns the capabilities that were actually removed. */
  revoke(capabilities: Capability[], reason: string): Capability[] {
    const removed: Capability[] = [];
    for (const capability of capabilities) {
      if (this.has(capability)) {
        this.lost.set(capability, { capability, reason, at: new Date().toISOString() });
        removed.push(capability);
      }
    }
    return removed;
  }

  get accountNumber(): string | undefined {
    return this.config.accountNumber ?? this.learnedAccountNumber;
  }

  get currency(): string | undefined {
    return this.config.currency ?? this.learnedCurrency;
  }

  /** Remembers the account number and currency from a statement header (used as payer defaults). */
  learn(info: StatementInfo): void {
    if (info.accountId && /^\d{1,10}$/.test(info.accountId)) this.learnedAccountNumber = info.accountId;
    if (info.currency && /^[A-Z]{3}$/.test(info.currency)) this.learnedCurrency = info.currency;
  }
}

export interface FailureOutcome {
  /** Capabilities this account lost because of the failure. */
  revoked: Capability[];
  /** Extra guidance for the model. */
  note?: string;
}

/**
 * Permission-loss classification. FIO documents no permission-denied response
 * and the read-only upload response is unknown, so this only revokes on strong
 * signals and never on transient-looking errors (network, timeout, 404, 409,
 * 413, 422, other 5xx):
 *
 * - HTTP 401/403 (undocumented, but unambiguous): on a read, the token is
 *   rejected outright, so read and payments are revoked. On an import, only
 *   payments is revoked.
 * - HTTP 500, documented as "token does not exist or is inactive": revoked
 *   only after TOKEN_REJECTION_STRIKES consecutive 500s for the same operation
 *   type, because a single 500 may be a genuine server fault. A success or any
 *   other HTTP status resets the count; network errors and timeouts do not. On reads this revokes read and payments; on
 *   imports only payments.
 * - A parsed import response that rejects the whole batch (status error/fatal)
 *   with a batch-level message that reads like a permission refusal (see
 *   looksLikeMissingPaymentPermission): payments is revoked.
 */
export function classifyFailure(account: Account, operation: Operation, error: unknown): FailureOutcome {
  // Any other HTTP answer (including a 409 surfaced as RateLimitedError) breaks a run of 500s.
  if (error instanceof RateLimitedError) {
    if (error.observedStatus !== undefined) account.strikes[operation] = 0;
    return { revoked: [] };
  }
  if (!(error instanceof FioApiError)) return { revoked: [] };
  if (error.status !== undefined && error.kind !== "token_rejected") account.strikes[operation] = 0;
  const all: Capability[] = ["read", "payments"];
  if (error.kind === "unauthorized") {
    const revoked =
      operation === "read"
        ? account.revoke(all, `FIO rejected the token on a read with HTTP ${error.status}`)
        : account.revoke(["payments"], `FIO rejected a payment import with HTTP ${error.status}`);
    return { revoked };
  }
  if (error.kind === "token_rejected") {
    account.strikes[operation]++;
    if (account.strikes[operation] >= TOKEN_REJECTION_STRIKES) {
      const reason = `FIO answered HTTP 500 ("token does not exist or is inactive") ${account.strikes[operation]} times in a row`;
      const revoked = operation === "read" ? account.revoke(all, reason) : account.revoke(["payments"], reason);
      return { revoked };
    }
    return {
      revoked: [],
      note:
        operation === "read"
          ? "Check in Internetbanking (Nastavení → API) that the token exists, is active, and has not expired. If the next request fails the same way, this account's tools will be removed."
          : "This can mean the token is inactive or lacks the payment-order permission. Verify it in Internetbanking (Nastavení → API). If the next import fails the same way, payment tools for this account will be removed.",
    };
  }
  return { revoked: [] };
}

export function classifyImportResult(account: Account, result: ImportResult): FailureOutcome {
  if (looksLikeMissingPaymentPermission(result)) {
    return {
      revoked: account.revoke(["payments"], `FIO refused the import: ${result.messages.join(" ")}`),
    };
  }
  return { revoked: [] };
}

export function recordSuccess(account: Account, operation: Operation): void {
  account.strikes[operation] = 0;
}

export class AccountRegistry {
  readonly accounts: Account[];
  private readonly listeners = new Set<() => void>();

  constructor(config: ServerConfig, fetchFn?: FetchFn) {
    const limiters = new Map<string, TokenRateLimiter>();
    this.accounts = config.accounts.map((accountConfig) => {
      registerSecret(accountConfig.token);
      registerSecret(encodeURIComponent(accountConfig.token));
      // Accounts that share a token share FIO's per-token limit.
      let limiter = limiters.get(accountConfig.token);
      if (!limiter) {
        limiter = new TokenRateLimiter({ intervalMs: config.rateLimitIntervalMs, maxWaitMs: config.maxWaitMs });
        limiters.set(accountConfig.token, limiter);
      }
      const client = new FioClient({
        baseUrl: config.baseUrl,
        token: accountConfig.token,
        limiter,
        requestTimeoutMs: config.requestTimeoutMs,
        ...(fetchFn ? { fetch: fetchFn } : {}),
      });
      return new Account(accountConfig, limiter, client);
    });
  }

  qualifying(capability: Capability): Account[] {
    return this.accounts.filter((a) => a.has(capability));
  }

  find(name: string): Account | undefined {
    return this.accounts.find((a) => a.name === name);
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** Applies a failure outcome; notifies listeners when capabilities were lost. */
  apply(account: Account, outcome: FailureOutcome): void {
    if (outcome.revoked.length === 0) return;
    log.warn(`account "${account.name}" lost capabilities: ${outcome.revoked.join(", ")}`);
    for (const listener of this.listeners) listener();
  }
}
