import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import { type Account, Accounts } from "../accounts.js";
import { AppConfig } from "../config.js";
import { InvalidInput, PAYMENT_TOKEN_HINT, PermissionDenied, UploadOutcomeUnknown } from "../errors.js";
import { FioApi, MERCHANT_FORMATS, MOVEMENT_FORMATS, STATEMENT_FORMATS } from "../fio-api.js";
import { type ImportResult, looksLikeMissingPaymentPermission, parseImportResponse } from "../import-response.js";
import { buildImportXml, PaymentOrders, summarizeOrders } from "../payments.js";
import { RateLimiter } from "../rate-limiter.js";
import { Redactor } from "../redaction.js";
import { parseLastStatement } from "../statement.js";
import { annotateTool, DateParam, JsonObject, ToolFailure, withAccount } from "./common.js";

export const SERVER_INSTRUCTIONS =
  "Tools for FIO Bank accounts (Czech Republic). Every tool is listed regardless of what the configured API tokens may do; if a token lacks the permission, the tool answers \"You don't have permissions to do that.\" FIO allows one request per token every 30 seconds, so batch questions into as few calls as possible. Call get_server_status to see accounts and rate-limit state.";

const PAYMENT_WARNING =
  "Orders are NOT executed by this call: FIO only queues them as a batch, which an authorized person must then sign in FIO Internetbanking (SMS or Fio signature) before anything is paid. Even so, it creates a real batch in the bank. Only call it after the user has reviewed the exact orders (use preview_payment_orders) and explicitly asked to submit them.";

const UPLOAD_UNCERTAIN_SHORT =
  "Check the pending batches in FIO Internetbanking before submitting again, or the orders could be duplicated.";

const Year = Schema.Int.check(Schema.isBetween({ minimum: 1990, maximum: 2200 }));
const StatementNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999 }));

const tool = <const Name extends string, P extends Schema.Struct<Schema.Struct.Fields> | Tool.EmptyParams>(
  name: Name,
  description: string,
  parameters: P,
) => Tool.make(name, { description, parameters, success: JsonObject, failure: ToolFailure, failureMode: "error" });

/** The FIO-backed and local tools. Parameter schemas depend on the configured account names. */
export function makeFioToolkit(accountNames: ReadonlyArray<string>) {
  const params = <F extends Schema.Struct.Fields>(fields: F) => withAccount(fields, accountNames);

  const GetTransactions = annotateTool(
    tool(
      "get_transactions",
      "List account movements between two dates (inclusive, YYYY-MM-DD) with the account header (balances, IBAN). Does not move the download marker. Data older than 90 days requires the owner to unlock history in Internetbanking first.",
      params({
        dateFrom: DateParam("First day (YYYY-MM-DD)."),
        dateTo: DateParam("Last day (YYYY-MM-DD)."),
      }),
    ),
    { title: "Transactions for a date range", readOnly: true, openWorld: true },
  );

  const GetStatement = annotateTool(
    tool(
      "get_statement",
      "Fetch an official account statement by year and statement number, with all its movements.",
      params({
        year: Year.annotate({ description: "Statement year, e.g. 2025." }),
        number: StatementNumber.annotate({ description: "Statement number within the year." }),
      }),
    ),
    { title: "Official statement", readOnly: true, openWorld: true },
  );

  const GetNewTransactions = annotateTool(
    tool(
      "get_new_transactions",
      "Fetch movements that arrived since the last download. SIDE EFFECT: when the result is non-empty, FIO moves this token's server-side download marker past them, so the same movements will not be returned again (also to other programs using the same token). If a call times out, the marker may have moved anyway; use set_download_marker to rewind. For read-only browsing, prefer get_transactions.",
      params({}),
    ),
    { title: "New transactions since last download", readOnly: false, idempotent: false, openWorld: true },
  );

  const SetDownloadMarker = annotateTool(
    tool(
      "set_download_marker",
      "Move the server-side marker used by get_new_transactions. Give exactly one of: movementId (the last movement that was downloaded successfully; later ones count as new) or date (the last day whose movements were NOT downloaded successfully; movements from that day onward count as new). Changes state in the bank but moves no money.",
      params({
        movementId: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThan(0)).annotate({ description: "ID of the last successfully downloaded movement." }),
        ),
        date: Schema.optionalKey(DateParam("Last day that was NOT downloaded successfully (YYYY-MM-DD).")),
      }),
    ),
    { title: "Set the download marker", readOnly: false, idempotent: true, openWorld: true },
  );

  const GetLastStatement = annotateTool(
    tool(
      "get_last_statement",
      "Look up the year and number of the most recent official statement (use with get_statement). FIO does not document the response format; the raw text is included.",
      params({}),
    ),
    { title: "Latest statement number", readOnly: true, openWorld: true },
  );

  const ExportTransactions = annotateTool(
    tool(
      "export_transactions",
      `Download movements as raw text in one of FIO's export formats. source=period needs dateFrom/dateTo and supports ${MOVEMENT_FORMATS.join(", ")}. source=statement needs year/number and also supports sta (MT940), cba_xml, sba_xml. source=merchant (card/POS transactions for merchants) needs dateFrom/dateTo and supports ${MERCHANT_FORMATS.join(", ")}. FIO recommends one format per token, so prefer the JSON tools unless a specific format is needed.`,
      params({
        source: Schema.Literals(["period", "statement", "merchant"]),
        format: Schema.Literals(STATEMENT_FORMATS),
        dateFrom: Schema.optionalKey(DateParam("First day, for source=period or merchant.")),
        dateTo: Schema.optionalKey(DateParam("Last day, for source=period or merchant.")),
        year: Schema.optionalKey(Year.annotate({ description: "Statement year, for source=statement." })),
        number: Schema.optionalKey(StatementNumber.annotate({ description: "Statement number, for source=statement." })),
      }),
    ),
    { title: "Raw export", readOnly: true, openWorld: true },
  );

  const PreviewPaymentOrders = annotateTool(
    tool(
      "preview_payment_orders",
      "Validate payment orders locally and return the exact Fio XML that submit_payment_orders would upload, with totals. Sends nothing to the bank; FIO validates again on upload. Show the result to the user before submitting.",
      params({ orders: PaymentOrders }),
    ),
    { title: "Preview payment orders (dry run)", readOnly: true, openWorld: false },
  );

  const SubmitPaymentOrders = annotateTool(
    tool(
      "submit_payment_orders",
      `Upload domestic, euro (SEPA/T2), and foreign payment orders to FIO as one batch. WARNING: ${PAYMENT_WARNING} The response lists FIO's verdict per batch and order.`,
      params({
        orders: PaymentOrders,
        confirm: Schema.Literal(true).annotate({
          description: "Must be true, confirming the user reviewed these exact orders and asked to submit them.",
        }),
      }),
    ),
    { title: "Submit payment orders", readOnly: false, destructive: true, idempotent: false, openWorld: true },
  );

  const GetServerStatus = annotateTool(
    tool(
      "get_server_status",
      "Show configured accounts (names only, never tokens), their FIO account numbers and currencies where known, and each token's rate-limit state. No network call.",
      Tool.EmptyParams,
    ),
    { title: "Server status", readOnly: true, openWorld: false },
  );

  return Toolkit.make(
    GetTransactions,
    GetStatement,
    GetNewTransactions,
    SetDownloadMarker,
    GetLastStatement,
    ExportTransactions,
    PreviewPaymentOrders,
    SubmitPaymentOrders,
    GetServerStatus,
  );
}

export type FioToolkit = ReturnType<typeof makeFioToolkit>;

function nextStepFor(result: ImportResult): string {
  switch (result.outcome) {
    case "accepted":
      return "The batch was created but NOT executed. An authorized person must sign it in FIO Internetbanking (SMS or Fio signature) for the payments to be processed.";
    case "rejected":
      return "FIO rejected the batch; nothing was created. Fix the problems listed and try again.";
    case "unknown": {
      const batch = result.batchIds.length ? `, batch ID ${result.batchIds.join(", ")}` : "";
      return `FIO's answer is ambiguous (status "${result.status || "missing"}"${batch}). The upload may or may not have created a batch. ${UPLOAD_UNCERTAIN_SHORT}`;
    }
  }
}

const checkRange = (dateFrom: string, dateTo: string) =>
  dateFrom > dateTo ? Effect.fail(new InvalidInput({ detail: "dateFrom must not be after dateTo." })) : Effect.void;

/** Builds the handlers from the services; every result is redacted before it leaves. */
export const makeFioHandlers = Effect.fn("FioTools.handlers")(function* (toolkit: FioToolkit) {
  const accounts = yield* Accounts;
  const fio = yield* FioApi;
  const limiter = yield* RateLimiter;
  const redactor = yield* Redactor;
  const config = yield* AppConfig;
  const out = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.map(effect, redactor.redactDeep);
  const accountStatus = Effect.fnUntraced(function* (acc: Account) {
    const details = yield* accounts.details(acc);
    return {
      name: acc.name,
      accountNumber: details.accountNumber ?? null,
      currency: details.currency ?? null,
      rateLimit: yield* limiter.state(acc.tokenFingerprint),
    };
  });

  return toolkit.of({
    get_transactions: ({ account, dateFrom, dateTo }) =>
      out(
        Effect.gen(function* () {
          const acc = yield* accounts.resolve(account);
          yield* checkRange(dateFrom, dateTo);
          const statement = yield* fio.periods(acc, dateFrom, dateTo);
          return { account: acc.name, ...statement };
        }),
      ),

    get_statement: ({ account, year, number }) =>
      out(
        Effect.gen(function* () {
          const acc = yield* accounts.resolve(account);
          const statement = yield* fio.statement(acc, year, number);
          return { account: acc.name, ...statement };
        }),
      ),

    get_new_transactions: ({ account }) =>
      out(
        Effect.gen(function* () {
          const acc = yield* accounts.resolve(account);
          const statement = yield* fio.last(acc);
          return { account: acc.name, markerAdvanced: statement.transactionCount > 0, ...statement };
        }),
      ),

    set_download_marker: ({ account, movementId, date }) =>
      out(
        Effect.gen(function* () {
          const acc = yield* accounts.resolve(account);
          if (movementId !== undefined && date === undefined) {
            yield* fio.setLastId(acc, movementId);
            return { account: acc.name, ok: true, marker: { movementId } };
          }
          if (date !== undefined && movementId === undefined) {
            yield* fio.setLastDate(acc, date);
            return { account: acc.name, ok: true, marker: { date } };
          }
          return yield* new InvalidInput({ detail: "Give exactly one of movementId or date." });
        }),
      ),

    get_last_statement: ({ account }) =>
      out(
        Effect.gen(function* () {
          const acc = yield* accounts.resolve(account);
          return { account: acc.name, ...parseLastStatement(yield* fio.lastStatement(acc)) };
        }),
      ),

    export_transactions: (args) =>
      out(
        Effect.gen(function* () {
          const acc = yield* accounts.resolve(args.account);
          const { source, format, dateFrom, dateTo, year, number } = args;
          if (source === "statement") {
            if (year === undefined || number === undefined) {
              return yield* new InvalidInput({ detail: "source=statement needs year and number." });
            }
            const content = yield* fio.statementRaw(acc, year, number, format);
            return { account: acc.name, format, content };
          }
          if (dateFrom === undefined || dateTo === undefined) {
            return yield* new InvalidInput({ detail: `source=${source} needs dateFrom and dateTo.` });
          }
          yield* checkRange(dateFrom, dateTo);
          if (source === "period") {
            const movementFormat = MOVEMENT_FORMATS.find((f) => f === format);
            if (movementFormat === undefined) {
              return yield* new InvalidInput({ detail: `source=period supports ${MOVEMENT_FORMATS.join(", ")}.` });
            }
            const content = yield* fio.periodsRaw(acc, dateFrom, dateTo, movementFormat);
            return { account: acc.name, format, content };
          }
          const merchantFormat = MERCHANT_FORMATS.find((f) => f === format);
          if (merchantFormat === undefined) {
            return yield* new InvalidInput({ detail: `source=merchant supports ${MERCHANT_FORMATS.join(", ")}.` });
          }
          const content = yield* fio.merchantRaw(acc, dateFrom, dateTo, merchantFormat);
          return { account: acc.name, format, content };
        }),
      ),

    preview_payment_orders: ({ account, orders }) =>
      out(
        Effect.gen(function* () {
          const acc = yield* accounts.resolve(account);
          const payer = yield* accounts.payer(acc);
          const xml = yield* buildImportXml(orders, payer);
          return {
            account: acc.name,
            dryRun: true,
            payerAccount: payer.accountNumber,
            ...summarizeOrders(orders, payer),
            xml,
          };
        }),
      ),

    submit_payment_orders: ({ account, orders }) =>
      out(
        Effect.gen(function* () {
          const acc = yield* accounts.resolve(account);
          const payer = yield* accounts.payer(acc);
          const xml = yield* buildImportXml(orders, payer);
          const body = yield* fio.importXml(acc, xml).pipe(
            Effect.catchTags({
              // The request may have reached FIO: the batch may exist.
              FioTransportError: (error) =>
                error.dispatched ? Effect.fail(new UploadOutcomeUnknown({ detail: error.message })) : Effect.fail(error),
              FioServerError: (error) => Effect.fail(new UploadOutcomeUnknown({ detail: error.message })),
              FioResponseError: (error) => Effect.fail(new UploadOutcomeUnknown({ detail: error.message })),
            }),
          );
          const result = yield* parseImportResponse(body, redactor.excerpt).pipe(
            Effect.mapError((error) => new UploadOutcomeUnknown({ detail: error.message })),
          );
          if (looksLikeMissingPaymentPermission(result)) {
            return yield* new PermissionDenied({
              detail: `FIO refused the upload: "${result.messages.join(" ")}". ${PAYMENT_TOKEN_HINT}`,
            });
          }
          const nextStep = nextStepFor(result);
          return {
            account: acc.name,
            payerAccount: payer.accountNumber,
            ...summarizeOrders(orders, payer),
            result,
            nextStep,
          };
        }),
      ),

    get_server_status: () =>
      out(
        Effect.gen(function* () {
          const listed = yield* Effect.forEach(accounts.list, accountStatus);
          return {
            accounts: listed,
            rateLimit: {
              requestsPerToken: `1 per ${config.rateLimitIntervalMs / 1000} s`,
              maxWaitSeconds: config.maxWaitMs / 1000,
            },
          };
        }),
      ),
  });
});

/** Registers the FIO toolkit with the MCP server. */
export const FioToolsLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const toolkit = makeFioToolkit(config.accounts.map((a) => a.name));
    return McpServer.toolkit(toolkit).pipe(Layer.provide(toolkit.toLayer(makeFioHandlers(toolkit))));
  }),
);
