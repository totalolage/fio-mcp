import { z } from "zod";

export interface AccountConfig {
  /** Name the model uses to pick an account; never the token. */
  name: string;
  token: string;
  /** FIO account number (payer `accountFrom` for payment orders). */
  accountNumber?: string;
  /** Account currency (ISO 4217), used as the default order currency. */
  currency?: string;
}

export interface ServerConfig {
  accounts: AccountConfig[];
  baseUrl: string;
  /** Minimum spacing between requests with the same token. */
  rateLimitIntervalMs: number;
  /** Longest a tool call may wait for a rate-limit slot before failing fast. */
  maxWaitMs: number;
  /** Per-request HTTP timeout. */
  requestTimeoutMs: number;
}

export const DEFAULT_BASE_URL = "https://fioapi.fio.cz/v1/rest";
export const DEFAULT_RATE_LIMIT_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_WAIT_MS = 25_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_ACCOUNT_NAME = "default";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

const accountSchema = z
  .object({
    name: z.string().regex(ACCOUNT_NAME, "name must be 1-32 characters of letters, digits, _ or -, starting with a letter or digit"),
    token: z
      .string()
      .min(1, "token is required")
      .refine((t) => !/[\s/?#]/.test(t), "token must not contain whitespace, '/', '?' or '#'"),
    accountNumber: z
      .string()
      .regex(/^\d{1,10}$/, "accountNumber must be the FIO account number without bank code (1-10 digits)")
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code such as CZK")
      .optional(),
  })
  .strict();

function describeIssues(error: z.ZodError, prefix: string): string {
  return error.issues
    .map((issue) => `${prefix}${issue.path.length ? issue.path.join(".") + ": " : ""}${issue.message}`)
    .join("; ");
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${key} must be an integer >= ${min} (got "${raw}")`);
  }
  return value;
}

/**
 * Reads configuration from the environment.
 *
 * Single account: FIO_TOKEN, optional FIO_ACCOUNT_NAME, FIO_ACCOUNT_NUMBER,
 * FIO_ACCOUNT_CURRENCY. Several accounts: FIO_ACCOUNTS, a JSON array of
 * {name, token, accountNumber?, currency?}.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const single = env.FIO_TOKEN?.trim();
  const multi = env.FIO_ACCOUNTS?.trim();
  if (single && multi) {
    throw new ConfigError("Set either FIO_TOKEN or FIO_ACCOUNTS, not both");
  }
  if (!single && !multi) {
    throw new ConfigError("No FIO token configured: set FIO_TOKEN, or FIO_ACCOUNTS for several accounts");
  }

  let rawAccounts: unknown[];
  if (multi) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(multi);
    } catch {
      // Do not echo the value: it contains tokens.
      throw new ConfigError("FIO_ACCOUNTS is not valid JSON");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new ConfigError("FIO_ACCOUNTS must be a non-empty JSON array of {name, token}");
    }
    rawAccounts = parsed;
  } else {
    rawAccounts = [
      {
        name: env.FIO_ACCOUNT_NAME?.trim() || DEFAULT_ACCOUNT_NAME,
        token: single,
        accountNumber: env.FIO_ACCOUNT_NUMBER?.trim() || undefined,
        currency: env.FIO_ACCOUNT_CURRENCY?.trim().toUpperCase() || undefined,
      },
    ];
  }

  const accounts: AccountConfig[] = [];
  rawAccounts.forEach((raw, index) => {
    const result = accountSchema.safeParse(raw);
    if (!result.success) {
      const where = multi ? `FIO_ACCOUNTS[${index}].` : "";
      throw new ConfigError(`Invalid account configuration: ${describeIssues(result.error, where)}`);
    }
    const { name, token, accountNumber, currency } = result.data;
    accounts.push({ name, token, accountNumber, currency });
  });

  const names = new Set<string>();
  for (const account of accounts) {
    if (names.has(account.name)) throw new ConfigError(`Duplicate account name "${account.name}"`);
    names.add(account.name);
  }

  return {
    accounts,
    baseUrl: (env.FIO_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    rateLimitIntervalMs: positiveInt(env, "FIO_RATE_LIMIT_INTERVAL_MS", DEFAULT_RATE_LIMIT_INTERVAL_MS),
    maxWaitMs: positiveInt(env, "FIO_MAX_WAIT_MS", DEFAULT_MAX_WAIT_MS),
    requestTimeoutMs: positiveInt(env, "FIO_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS, 1),
  };
}
