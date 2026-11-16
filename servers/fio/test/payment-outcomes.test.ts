import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Logger, Redacted, References, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { type Account, Accounts } from "../src/accounts.js";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import { type AppConfigShape, MAX_RESPONSE_BYTES } from "../src/config.js";
import type { InvalidInput } from "../src/errors.js";
import { FioApi } from "../src/fio-api.js";
import { NEW_KEY_ADVICE, PaymentControls } from "../src/payment-controls.js";
import { PaymentLedger } from "../src/payment-ledger.js";
import { DEFAULT_PAYMENT_LIMITS } from "../src/payment-limits.js";
import { buildImportXml, type Payer, type PaymentOrder, PaymentOrders } from "../src/payments.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { Redactor } from "../src/redaction.js";
import type { Principal } from "../src/transport/principal.js";
import { IMPORT_ERROR_XML } from "./fixtures.js";
import { seededConfig } from "./support/config.js";
import { memoryDatabase } from "./support/database.js";
import { FioHttp, html, text } from "./support/fio-http.js";

const TOKEN = "Tk7pQ2vX9mZr4LbN8sYw3HcJ6dFg1KaE5uVo0iRtBnMxWqSzPyGhCjDlUeAfOk2Q";
const BASE_URL = "https://fio.test/v1/rest";
const PAYER: Payer = { accountNumber: "2400222222", currency: "CZK" };

const config: AppConfigShape = {
  accounts: [{ name: "main", token: Redacted.make(TOKEN), accountNumber: "2400222222", currency: "CZK" }],
  secrets: [Redacted.make(TOKEN)],
  baseUrl: BASE_URL,
  rateLimitIntervalMs: 0,
  maxWaitMs: 100_000,
  requestTimeoutMs: 20_000,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  transport: { kind: "stdio" },
  cache: {
    enabled: false,
    dbPath: ":memory:",
    syncOnStartup: false,
    syncIntervalMinutes: 0,
    backfillFrom: "2000-01-01",
    overlapDays: 10,
    maxAgeMinutes: 60,
    encrypt: false,
    dataKey: undefined,
  },
  paymentLimits: DEFAULT_PAYMENT_LIMITS,
};

const testLayer = PaymentControls.Default.pipe(
  Layer.provideMerge(PaymentLedger.Default),
  Layer.provideMerge(FioApi.Default),
  Layer.provideMerge(
    Layer.mergeAll(
      FioHttp.layer({ tokens: [TOKEN], baseUrl: BASE_URL }),
      Accounts.Default,
      RateLimiter.Default,
      Redactor.Default,
      memoryDatabase(SERVER_MIGRATIONS),
    ),
  ),
  Layer.provideMerge(seededConfig(config)),
);

const principal: Principal = { subject: "fio_grant_1", scopes: "all", accountFingerprints: "all", clientId: "client_1" };

const account: Effect.Effect<Account, InvalidInput, Accounts> = Effect.flatMap(Effect.service(Accounts), (accounts) =>
  accounts.resolve("main"),
);

const decodeOrders = Schema.decodeUnknownSync(PaymentOrders);
const ORDERS: ReadonlyArray<unknown> = [
  { type: "domestic", amount: 10, accountTo: "2212-2000000699", bankCode: "0300", date: "2025-11-03" },
];

const submit = (idempotencyKey: string) =>
  Effect.gen(function* () {
    const controls = yield* PaymentControls;
    const orders: ReadonlyArray<PaymentOrder> = decodeOrders(ORDERS);
    const xml = yield* buildImportXml(orders, PAYER);
    return yield* controls.submit({ principal, account: yield* account, payer: PAYER, orders, xml, idempotencyKey });
  });

/** The submission's failure message, or its success value as JSON. */
const answerOf = (idempotencyKey: string) =>
  Effect.map(Effect.exit(submit(idempotencyKey)), (exit) => {
    if (Exit.isSuccess(exit)) return { tag: "success", text: JSON.stringify(exit.value) };
    const reason = exit.cause.reasons[0];
    if (reason?._tag !== "Fail") return { tag: "defect", text: String(exit) };
    return { tag: reason.error._tag, text: reason.error.message };
  });

const uploadCount = Effect.map(FioHttp.requests, (requests) => requests.filter((r) => r.path === "/import/").length);

/** Every column of every audit row, read straight from SQLite. */
const rawAuditRows = Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => sql`SELECT * FROM payment_audit`);

/** Runs `effect` with every log line (all levels) captured as text. */
const withLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const logs: Array<string> = [];
    const capture = Logger.make<unknown, void>((entry) => void logs.push(Logger.formatLogFmt.log(entry)));
    const value = yield* effect.pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
    return { value, logs };
  });

const leaks = (text: string): boolean => text.toLowerCase().includes(TOKEN.toLowerCase());

const importXml = (status: string, batchId: string) => `<?xml version="1.0" encoding="UTF-8"?>
<responseImport>
  <result>
    <errorCode>0</errorCode>
    <idInstruction>${batchId}</idInstruction>
    <status>${status}</status>
  </result>
</responseImport>`;

describe("audit fields from FIO's import response are redacted", () => {
  const cases = [
    { name: "status and idInstruction", status: TOKEN, batchId: TOKEN },
    { name: "idInstruction of an error response", status: "error", batchId: `x${TOKEN}` },
    { name: "status next to a numeric batch id", status: `fatal ${TOKEN}`, batchId: "105545555" },
  ];
  for (const testCase of cases) {
    it.effect(`no token in any audit column, log line or answer when FIO echoes it in ${testCase.name}`, () =>
      Effect.gen(function* () {
        yield* FioHttp.enqueue(text(importXml(testCase.status, testCase.batchId)));
        const { value, logs } = yield* withLogs(
          Effect.gen(function* () {
            const fresh = yield* answerOf("key_redact_0001");
            const replayed = yield* answerOf("key_redact_0001");
            return { fresh, replayed };
          }),
        );
        assert.strictEqual(yield* uploadCount, 1);
        const rows = yield* rawAuditRows;
        assert.lengthOf(rows, 1);
        const row = rows[0] as Record<string, unknown>;
        assert.strictEqual(row.outcome, "unknown");
        assert.isNotNull(row.fio_error_code);
        assert.isNotNull(row.batch_ids);
        // Case-insensitive: the parser lowercases FIO's status.
        for (const [column, cell] of Object.entries(row)) assert.isFalse(leaks(String(cell)), `audit column ${column}`);
        for (const line of logs) assert.isFalse(leaks(line), line);
        assert.isFalse(leaks(value.fresh.text), value.fresh.text);
        assert.isFalse(leaks(value.replayed.text), value.replayed.text);
      }).pipe(Effect.provide(testLayer)),
    );
  }
});

describe("not-sent and rejected uploads are final for their idempotency key", () => {
  const assertFinal = (answer: { readonly tag: string; readonly text: string }) => {
    assert.include(answer.text, NEW_KEY_ADVICE);
    assert.notMatch(answer.text, /retry after/i);
    assert.notInclude(answer.text, "before submitting again");
  };

  it.effect("a RateLimited (FIO 409) upload answers and replays the new-key advice, never Retry after", () =>
    Effect.gen(function* () {
      yield* FioHttp.enqueue({ status: 409 }, { status: 409 });
      const fresh = yield* answerOf("key_ratelimit_1");
      const replayed = yield* answerOf("key_ratelimit_1");
      assert.strictEqual(fresh.tag, "UploadRefused");
      assertFinal(fresh);
      assert.include(fresh.text, "FIO returned 409 and processed nothing");
      assert.deepStrictEqual(replayed, fresh);
      assert.strictEqual(yield* uploadCount, 2); // the limiter's one retry, then never again
      const rows = yield* rawAuditRows;
      assert.lengthOf(rows, 1);
      assert.strictEqual(rows[0]?.outcome, "refused");
      assert.strictEqual(rows[0]?.reason, "not sent: FIO returned 409 and processed nothing");
    }).pipe(Effect.provide(testLayer)),
  );

  const rejected = [
    { name: "an HTTP 404 (FioBadRequest)", reply: html(404, "<html>Not found</html>"), tag: "UploadRefused" },
    { name: "an HTTP 413 (TooManyItems)", reply: html(413, ""), tag: "UploadRefused" },
    { name: "a parsed error response", reply: text(IMPORT_ERROR_XML), tag: "success" },
  ];
  for (const testCase of rejected) {
    it.effect(`a rejected upload (${testCase.name}) answers and replays the new-key advice`, () =>
      Effect.gen(function* () {
        yield* FioHttp.enqueue(testCase.reply);
        const fresh = yield* answerOf("key_rejected_1");
        const replayed = yield* answerOf("key_rejected_1");
        assert.strictEqual(fresh.tag, testCase.tag);
        assertFinal(fresh);
        assert.deepStrictEqual(replayed, fresh);
        assert.strictEqual(yield* uploadCount, 1);
        const rows = yield* rawAuditRows;
        assert.lengthOf(rows, 1);
        assert.strictEqual(rows[0]?.outcome, "rejected");
      }).pipe(Effect.provide(testLayer)),
    );
  }

  it.effect("an unknown outcome (HTTP 500) keeps its check-Internetbanking guidance, not the new-key advice", () =>
    Effect.gen(function* () {
      yield* FioHttp.enqueue(html(500, "boom"));
      const unknown = yield* answerOf("key_unknown_1");
      // The unknown outcome keeps its "check Internetbanking" guidance.
      assert.strictEqual(unknown.tag, "UploadOutcomeUnknown");
      assert.include(unknown.text, "before submitting again");
      assert.notInclude(unknown.text, NEW_KEY_ADVICE);
    }).pipe(Effect.provide(testLayer)),
  );
});
