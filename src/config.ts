import { z } from "zod";
import { registerSecret } from "./redact.js";

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
/** FIO allows one request per token every 30 s; the environment cannot configure less. */
export const MIN_RATE_LIMIT_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_WAIT_MS = 25_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_ACCOUNT_NAME = "default";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

const accountSchema = z
  .object({
    name: z.string().regex(ACCOUNT_NAME),
    token: z
      .string()
      .min(1)
      .refine((t) => !/[\s/?#]/.test(t)),
    accountNumber: z
      .string()
      .regex(/^\d{1,10}$/)
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .strict();

type AccountField = keyof z.infer<typeof accountSchema>;

const FIELD_RULES: Record<AccountField, string> = {
  name: "must be 1-32 characters of letters, digits, _ or -, starting with a letter or digit",
  token: "must be a non-empty string without whitespace, '/', '?' or '#'",
  accountNumber: "must be the FIO account number without bank code (1-10 digits)",
  currency: "must be an ISO 4217 code such as CZK",
};

const SINGLE_ACCOUNT_VARS: Record<AccountField, string> = {
  name: "FIO_ACCOUNT_NAME",
  token: "FIO_TOKEN",
  accountNumber: "FIO_ACCOUNT_NUMBER",
  currency: "FIO_ACCOUNT_CURRENCY",
};

const ACCOUNT_FIELDS = Object.keys(FIELD_RULES).join(", ");

/**
 * Describes schema failures by field name and rule only. Zod's own messages
 * and unknown keys can quote the input, which may be a token.
 */
function describeIssues(error: z.ZodError, index: number | undefined): string {
  const where = index === undefined ? undefined : `FIO_ACCOUNTS[${index}]`;
  const problems = new Set<string>();
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (issue.path.length === 1 && typeof field === "string" && field in FIELD_RULES) {
      const label = where ? `${where}.${field}` : SINGLE_ACCOUNT_VARS[field as AccountField];
      problems.add(`${label} ${FIELD_RULES[field as AccountField]}`);
    } else if (issue.code === "unrecognized_keys") {
      problems.add(`${where ?? "account"} has unknown fields; allowed fields are ${ACCOUNT_FIELDS}`);
    } else {
      problems.add(`${where ?? "account"} must be an object with fields ${ACCOUNT_FIELDS}`);
    }
  }
  return [...problems].join("; ");
}

/** Never echoes the raw value: a misplaced token must not reach stderr. */
function intSetting(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, why = ""): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${key} must be an integer >= ${min}${why}`);
  }
  return value;
}

/** Registers every token-like value before validation, so no later message or log line can carry one. */
function registerCandidateTokens(single: string | undefined, accounts: unknown): void {
  if (single) registerSecret(single);
  if (!Array.isArray(accounts)) return;
  for (const account of accounts) {
    const token: unknown = (account as { token?: unknown } | null)?.token;
    if (typeof token === "string") registerSecret(token);
  }
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
  registerCandidateTokens(single, undefined);
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
    registerCandidateTokens(undefined, parsed);
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
      throw new ConfigError(`Invalid account configuration: ${describeIssues(result.error, multi ? index : undefined)}`);
    }
    const { name, token, accountNumber, currency } = result.data;
    accounts.push({ name, token, accountNumber, currency });
  });

  const firstIndex = new Map<string, number>();
  accounts.forEach((account, index) => {
    const earlier = firstIndex.get(account.name);
    if (earlier !== undefined) {
      throw new ConfigError(`FIO_ACCOUNTS[${index}].name repeats the name of FIO_ACCOUNTS[${earlier}]; names must be unique`);
    }
    firstIndex.set(account.name, index);
  });

  return {
    accounts,
    baseUrl: (env.FIO_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    rateLimitIntervalMs: intSetting(
      env,
      "FIO_RATE_LIMIT_INTERVAL_MS",
      DEFAULT_RATE_LIMIT_INTERVAL_MS,
      MIN_RATE_LIMIT_INTERVAL_MS,
      " (FIO allows one request per token every 30 s)",
    ),
    maxWaitMs: intSetting(env, "FIO_MAX_WAIT_MS", DEFAULT_MAX_WAIT_MS, 0),
    requestTimeoutMs: intSetting(env, "FIO_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS, 1),
  };
}
