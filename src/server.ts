import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Account, AccountRegistry } from "./accounts.js";
import type { ServerConfig } from "./config.js";
import { FioApiError, PermissionDeniedError, RateLimitedError, ToolInputError } from "./errors.js";
import { MERCHANT_FORMATS, MOVEMENT_FORMATS, STATEMENT_FORMATS, type FetchFn } from "./fio-client.js";
import { looksLikeMissingPaymentPermission, parseImportResponse } from "./import-response.js";
import { buildImportXml, paymentOrdersSchema, summarizeOrders, type PaymentOrder } from "./payments.js";
import { log, redact } from "./redact.js";
import { parseLastStatement, parseStatementJson } from "./statement.js";

export const SERVER_NAME = "fio-mcp";
export const SERVER_VERSION = "0.1.0";

type Shape = Record<string, z.ZodType>;
type Args = Record<string, unknown>;
type Extra = { signal: AbortSignal };
type Operation = "read" | "import";

interface ToolContext {
  account: Account;
  args: Args;
  signal: AbortSignal;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** Network operation type, for error messages. Absent for local-only tools. */
  operation?: Operation;
  annotations: ToolAnnotations;
  shape: Shape;
  run: (ctx: ToolContext) => Promise<unknown>;
}

const dateParam = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .describe(what);

const PAYMENT_WARNING =
  "Orders are NOT executed by this call: FIO only queues them as a batch, which an authorized person must then sign in FIO Internetbanking (SMS or Fio signature) before anything is paid. Even so, it creates a real batch in the bank. Only call it after the user has reviewed the exact orders (use preview_payment_orders) and explicitly asked to submit them.";

/** What to tell the user when a payment upload is refused for lack of permission. */
const PAYMENT_TOKEN_HINT =
  'Payment orders need a token created with the "Sledování účtu a zadávání platebních a inkasních příkazů" permission (Internetbanking → Nastavení → API).';

const UPLOAD_UNCERTAIN =
  "The upload may or may not have created a batch. Check the pending batches in FIO Internetbanking before submitting again, or the orders could be duplicated.";

/** Upload failures after which FIO may still have created the batch. */
const UNCERTAIN_UPLOAD_ERRORS = new Set<FioApiError["kind"]>(["timeout", "network", "bad_response", "http_error"]);

function json(value: unknown): CallToolResult {
  // Redacted too: a bank response echoing a token must not reach the model.
  return { content: [{ type: "text", text: redact(JSON.stringify(value, null, 2)) }] };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: redact(message) }] };
}

/**
 * Turns FIO's refusals into the permission-denied message. FIO documents no
 * permission error, so this covers the signals that can only mean the token
 * may not do this:
 * - HTTP 401/403 on any call (undocumented, but unambiguous);
 * - HTTP 500 on a payment upload: FIO's code for a missing or inactive token,
 *   and the most likely answer to a read-only token trying to upload;
 * - an upload response refusing the batch on the token's behalf (handled in
 *   submit_payment_orders via looksLikeMissingPaymentPermission).
 * HTTP 500 on reads keeps FIO's documented meaning (token missing or inactive).
 */
function asPermissionDenied(operation: Operation | undefined, error: unknown): PermissionDeniedError | undefined {
  if (!(error instanceof FioApiError)) return undefined;
  if (error.kind === "unauthorized") {
    return new PermissionDeniedError(
      `FIO refused this token (HTTP ${error.status}). Check the token and its permission in Internetbanking (Nastavení → API).` +
        (operation === "import" ? ` ${PAYMENT_TOKEN_HINT}` : ""),
    );
  }
  if (operation === "import" && error.kind === "token_rejected") {
    return new PermissionDeniedError(
      `FIO rejected this token for payment orders (HTTP 500): it is read-only, or inactive or expired. ${PAYMENT_TOKEN_HINT}`,
    );
  }
  return undefined;
}

export interface FioServer {
  server: McpServer;
  registry: AccountRegistry;
  toolNames(): string[];
}

export function createFioServer(config: ServerConfig, options: { fetch?: FetchFn } = {}): FioServer {
  const registry = new AccountRegistry(config, options.fetch);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for FIO Bank accounts (Czech Republic). Every tool is listed regardless of what the configured API tokens may do; if a token lacks the permission, the tool answers \"You don't have permissions to do that.\" FIO allows one request per token every 30 seconds, so batch questions into as few calls as possible. Call get_server_status to see accounts and rate-limit state.",
    },
  );

  const definitions: ToolDefinition[] = [
    {
      name: "get_transactions",
      title: "Transactions for a date range",
      description:
        "List account movements between two dates (inclusive, YYYY-MM-DD) with the account header (balances, IBAN). Does not move the download marker. Data older than 90 days requires the owner to unlock history in Internetbanking first.",
      operation: "read",
      annotations: { readOnlyHint: true, openWorldHint: true },
      shape: {
        dateFrom: dateParam("First day (YYYY-MM-DD)."),
        dateTo: dateParam("Last day (YYYY-MM-DD)."),
      },
      run: async ({ account, args, signal }) => {
        const { dateFrom, dateTo } = args as { dateFrom: string; dateTo: string };
        if (dateFrom > dateTo) throw new ToolInputError("dateFrom must not be after dateTo.");
        const statement = parseStatementJson(await account.client.periods(dateFrom, dateTo, "json", signal));
        account.learn(statement.info);
        return { account: account.name, ...statement };
      },
    },
    {
      name: "get_statement",
      title: "Official statement",
      description: "Fetch an official account statement by year and statement number, with all its movements.",
      operation: "read",
      annotations: { readOnlyHint: true, openWorldHint: true },
      shape: {
        year: z.number().int().min(1990).max(2200).describe("Statement year, e.g. 2025."),
        number: z.number().int().min(1).max(999).describe("Statement number within the year."),
      },
      run: async ({ account, args, signal }) => {
        const { year, number } = args as { year: number; number: number };
        const statement = parseStatementJson(await account.client.statement(year, number, "json", signal));
        account.learn(statement.info);
        return { account: account.name, ...statement };
      },
    },
    {
      name: "get_new_transactions",
      title: "New transactions since last download",
      description:
        "Fetch movements that arrived since the last download. SIDE EFFECT: when the result is non-empty, FIO moves this token's server-side download marker past them, so the same movements will not be returned again (also to other programs using the same token). If a call times out, the marker may have moved anyway; use set_download_marker to rewind. For read-only browsing, prefer get_transactions.",
      operation: "read",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      shape: {},
      run: async ({ account, signal }) => {
        const statement = parseStatementJson(await account.client.last("json", signal));
        account.learn(statement.info);
        return {
          account: account.name,
          markerAdvanced: statement.transactionCount > 0,
          ...statement,
        };
      },
    },
    {
      name: "set_download_marker",
      title: "Set the download marker",
      description:
        "Move the server-side marker used by get_new_transactions. Give exactly one of: movementId (the last movement that was downloaded successfully; later ones count as new) or date (the last day whose movements were NOT downloaded successfully; movements from that day onward count as new). Changes state in the bank but moves no money.",
      operation: "read",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      shape: {
        movementId: z.number().int().positive().optional().describe("ID of the last successfully downloaded movement."),
        date: dateParam("Last day that was NOT downloaded successfully (YYYY-MM-DD).").optional(),
      },
      run: async ({ account, args, signal }) => {
        const { movementId, date } = args as { movementId?: number; date?: string };
        if ((movementId === undefined) === (date === undefined)) {
          throw new ToolInputError("Give exactly one of movementId or date.");
        }
        if (movementId !== undefined) await account.client.setLastId(movementId, signal);
        else await account.client.setLastDate(date as string, signal);
        return { account: account.name, ok: true, marker: movementId !== undefined ? { movementId } : { date } };
      },
    },
    {
      name: "get_last_statement",
      title: "Latest statement number",
      description:
        "Look up the year and number of the most recent official statement (use with get_statement). FIO does not document the response format; the raw text is included.",
      operation: "read",
      annotations: { readOnlyHint: true, openWorldHint: true },
      shape: {},
      run: async ({ account, signal }) => ({
        account: account.name,
        ...parseLastStatement(await account.client.lastStatement(signal)),
      }),
    },
    {
      name: "export_transactions",
      title: "Raw export",
      description: `Download movements as raw text in one of FIO's export formats. source=period needs dateFrom/dateTo and supports ${MOVEMENT_FORMATS.join(", ")}. source=statement needs year/number and also supports sta (MT940), cba_xml, sba_xml. source=merchant (card/POS transactions for merchants) needs dateFrom/dateTo and supports ${MERCHANT_FORMATS.join(", ")}. FIO recommends one format per token, so prefer the JSON tools unless a specific format is needed.`,
      operation: "read",
      annotations: { readOnlyHint: true, openWorldHint: true },
      shape: {
        source: z.enum(["period", "statement", "merchant"]),
        format: z.enum(STATEMENT_FORMATS),
        dateFrom: dateParam("First day, for source=period or merchant.").optional(),
        dateTo: dateParam("Last day, for source=period or merchant.").optional(),
        year: z.number().int().min(1990).max(2200).optional().describe("Statement year, for source=statement."),
        number: z.number().int().min(1).max(999).optional().describe("Statement number, for source=statement."),
      },
      run: async ({ account, args, signal }) => {
        const a = args as {
          source: "period" | "statement" | "merchant";
          format: (typeof STATEMENT_FORMATS)[number];
          dateFrom?: string;
          dateTo?: string;
          year?: number;
          number?: number;
        };
        let body: string;
        if (a.source === "statement") {
          if (a.year === undefined || a.number === undefined) throw new ToolInputError("source=statement needs year and number.");
          body = await account.client.statement(a.year, a.number, a.format, signal);
        } else {
          if (!a.dateFrom || !a.dateTo) throw new ToolInputError(`source=${a.source} needs dateFrom and dateTo.`);
          if (a.dateFrom > a.dateTo) throw new ToolInputError("dateFrom must not be after dateTo.");
          if (a.source === "period") {
            if (!(MOVEMENT_FORMATS as readonly string[]).includes(a.format)) {
              throw new ToolInputError(`source=period supports ${MOVEMENT_FORMATS.join(", ")}.`);
            }
            body = await account.client.periods(a.dateFrom, a.dateTo, a.format as (typeof MOVEMENT_FORMATS)[number], signal);
          } else {
            if (!(MERCHANT_FORMATS as readonly string[]).includes(a.format)) {
              throw new ToolInputError(`source=merchant supports ${MERCHANT_FORMATS.join(", ")}.`);
            }
            body = await account.client.merchant(a.dateFrom, a.dateTo, a.format as (typeof MERCHANT_FORMATS)[number], signal);
          }
        }
        return { account: account.name, format: a.format, content: body };
      },
    },
    {
      name: "preview_payment_orders",
      title: "Preview payment orders (dry run)",
      description:
        "Validate payment orders locally and return the exact Fio XML that submit_payment_orders would upload, with totals. Sends nothing to the bank; FIO validates again on upload. Show the result to the user before submitting.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      shape: { orders: paymentOrdersSchema },
      run: async ({ account, args }) => {
        const orders = args.orders as PaymentOrder[];
        const payer = payerFor(account);
        return {
          account: account.name,
          dryRun: true,
          payerAccount: payer.accountNumber,
          ...summarizeOrders(orders, payer),
          xml: buildImportXml(orders, payer),
        };
      },
    },
    {
      name: "submit_payment_orders",
      title: "Submit payment orders",
      description: `Upload domestic, euro (SEPA/T2), and foreign payment orders to FIO as one batch. WARNING: ${PAYMENT_WARNING} The response lists FIO's verdict per batch and order.`,
      operation: "import",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      shape: {
        orders: paymentOrdersSchema,
        confirm: z
          .literal(true)
          .describe("Must be true, confirming the user reviewed these exact orders and asked to submit them."),
      },
      run: async ({ account, args, signal }) => {
        const orders = args.orders as PaymentOrder[];
        const payer = payerFor(account);
        const xml = buildImportXml(orders, payer);
        const result = parseImportResponse(await account.client.importXml(xml, signal));
        if (looksLikeMissingPaymentPermission(result)) {
          throw new PermissionDeniedError(`FIO refused the upload: "${result.messages.join(" ")}". ${PAYMENT_TOKEN_HINT}`);
        }
        return {
          account: account.name,
          payerAccount: payer.accountNumber,
          ...summarizeOrders(orders, payer),
          result,
          nextStep:
            result.outcome === "accepted"
              ? "The batch was created but NOT executed. An authorized person must sign it in FIO Internetbanking (SMS or Fio signature) for the payments to be processed."
              : result.outcome === "rejected"
                ? "FIO rejected the batch; nothing was created. Fix the problems listed and try again."
                : `FIO's answer is ambiguous (status "${result.status || "missing"}"${result.batchIds.length ? `, batch ID ${result.batchIds.join(", ")}` : ""}). ${UPLOAD_UNCERTAIN}`,
        };
      },
    },
  ];

  function payerFor(account: Account) {
    const accountNumber = account.accountNumber;
    if (!accountNumber) {
      throw new ToolInputError(
        `The FIO account number for "${account.name}" is unknown. Configure it (FIO_ACCOUNT_NUMBER or accounts[].accountNumber), or call get_transactions for this account once so the server can read it from the statement header.`,
      );
    }
    return { accountNumber, ...(account.currency ? { currency: account.currency } : {}) };
  }

  function resolveAccount(requested: unknown): Account {
    if (typeof requested === "string") {
      const account = registry.find(requested);
      if (!account) throw new ToolInputError(`Unknown account "${requested}".`);
      return account;
    }
    const [only, ...rest] = registry.accounts;
    if (only && rest.length === 0) return only;
    throw new ToolInputError(`Specify account: one of ${registry.accounts.map((a) => a.name).join(", ")}.`);
  }

  function handlerFor(def: ToolDefinition) {
    return async (args: Args, extra: Extra): Promise<CallToolResult> => {
      try {
        const account = resolveAccount(args.account);
        return json(await def.run({ account, args, signal: extra.signal }));
      } catch (error) {
        return failure(def, error);
      }
    };
  }

  function failure(def: ToolDefinition, error: unknown): CallToolResult {
    const denied = error instanceof PermissionDeniedError ? error : asPermissionDenied(def.operation, error);
    if (denied) return errorResult(denied.message);
    const expected =
      error instanceof RateLimitedError || error instanceof ToolInputError || error instanceof FioApiError;
    if (!expected) log.error(`tool ${def.name} failed:`, error);
    const parts = [error instanceof Error ? error.message : String(error)];
    if (def.operation === "import" && error instanceof FioApiError && UNCERTAIN_UPLOAD_ERRORS.has(error.kind)) {
      parts.push(UPLOAD_UNCERTAIN);
    }
    return errorResult(parts.join("\n"));
  }

  const names = registry.accounts.map((a) => a.name);
  // Only multi-account setups get an account parameter. strictObject rejects unknown
  // arguments (typos, or an account parameter sent to a single-account server).
  const accountShape: Shape =
    names.length > 1
      ? { account: z.enum(names as [string, ...string[]]).describe(`Account to use: ${names.join(", ")}.`) }
      : {};
  for (const def of definitions) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: z.strictObject({ ...accountShape, ...def.shape }),
        annotations: def.annotations,
      },
      handlerFor(def) as never,
    );
  }

  server.registerTool(
    "get_server_status",
    {
      title: "Server status",
      description:
        "Show configured accounts (names only, never tokens), their FIO account numbers and currencies where known, and each token's rate-limit state. No network call.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      json({
        accounts: registry.accounts.map((account) => ({
          name: account.name,
          accountNumber: account.accountNumber ?? null,
          currency: account.currency ?? null,
          rateLimit: account.limiter.state(),
        })),
        rateLimit: {
          requestsPerToken: `1 per ${config.rateLimitIntervalMs / 1000} s`,
          maxWaitSeconds: config.maxWaitMs / 1000,
        },
      }),
  );

  const toolNames = () => [...definitions.map((d) => d.name), "get_server_status"];
  return { server, registry, toolNames };
}
