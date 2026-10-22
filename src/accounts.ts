import type { AccountConfig, ServerConfig } from "./config.js";
import { FioClient, type FetchFn } from "./fio-client.js";
import { TokenRateLimiter } from "./rate-limiter.js";
import { registerSecret } from "./redact.js";
import type { StatementInfo } from "./statement.js";

export class Account {
  readonly name: string;
  private learnedAccountNumber: string | undefined;
  private learnedCurrency: string | undefined;

  constructor(
    private readonly config: AccountConfig,
    readonly limiter: TokenRateLimiter,
    readonly client: FioClient,
  ) {
    this.name = config.name;
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

export class AccountRegistry {
  readonly accounts: Account[];

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

  find(name: string): Account | undefined {
    return this.accounts.find((a) => a.name === name);
  }
}
