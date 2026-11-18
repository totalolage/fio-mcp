import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import type { Principal } from "@mcps/core/transport/principal.js";
import { ConfigProvider, Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { type Account, Accounts } from "../src/accounts.js";
import { ServicesLive } from "../src/app.js";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import { type AppConfigShape, MAX_RESPONSE_BYTES } from "../src/config.js";
import type { InvalidInput } from "../src/errors.js";
import { FioApi } from "../src/fio-api.js";
import { AUDIT_RETENTION_DAYS, PaymentControls } from "../src/payment-controls.js";
import { type AuditRow, PaymentLedger } from "../src/payment-ledger.js";
import { buildImportXml, type Payer, type PaymentOrder, PaymentOrders } from "../src/payments.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { RedactorDefault } from "../src/redaction.js";
import { IMPORT_OK_XML, IMPORT_PERMISSION_XML } from "./fixtures.js";
import { seededConfig } from "./support/config.js";
import { memoryDatabase } from "./support/database.js";
import { FioHttp, html, text } from "./support/fio-http.js";

const TOKEN = "Tk7pQ2vX9mZr4LbN8sYw3HcJ6dFg1KaE5uVo0iRtBnMxWqSzPyGhCjDlUeAfOk2Q";
const BASE_URL = "https://fio.test/v1/rest";
const PAYER: Payer = { accountNumber: "2400222222", currency: "CZK" };
const config = (): AppConfigShape => ({
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
});

const testLayer = () =>
  PaymentControls.Default.pipe(
    Layer.provideMerge(PaymentLedger.Default),
    Layer.provideMerge(FioApi.Default),
    Layer.provideMerge(
      Layer.mergeAll(
        FioHttp.layer({ tokens: [TOKEN], baseUrl: BASE_URL }),
        Accounts.Default,
        RateLimiter.Default,
        RedactorDefault,
        memoryDatabase(SERVER_MIGRATIONS),
      ),
    ),
    Layer.provideMerge(seededConfig(config())),
  );

const decodeOrders = Schema.decodeUnknownSync(PaymentOrders);

const domestic = (amount: number, extra: Record<string, unknown> = {}) => ({
  type: "domestic",
  amount,
  accountTo: "2212-2000000699",
  bankCode: "0300",
  date: "2025-11-03",
  ...extra,
});

const principal = (subject = "fio_grant_1"): Principal => ({
  subject,
  scopes: "all",
  resources: "all",
  clientId: "client_1",
});

const account: Effect.Effect<Account, InvalidInput, Accounts> = Effect.flatMap(Effect.service(Accounts), (accounts) =>
  accounts.resolve("main"),
);

let keySeq = 0;
const freshKey = () => `key_${String(++keySeq).padStart(12, "0")}`;

const submit = (
  rawOrders: ReadonlyArray<unknown>,
  options: { readonly principal?: Principal; readonly key?: string } = {},
) =>
  Effect.gen(function* () {
    const controls = yield* PaymentControls;
    const orders: ReadonlyArray<PaymentOrder> = decodeOrders(rawOrders);
    const xml = yield* buildImportXml(orders, PAYER);
    return yield* controls.submit({
      principal: options.principal ?? principal(),
      account: yield* account,
      payer: PAYER,
      orders,
      xml,
      idempotencyKey: options.key ?? freshKey(),
    });
  });

const uploads = Effect.map(FioHttp.requests, (requests) => requests.filter((request) => request.path === "/import/"));

const auditRows = (grantId = "fio_grant_1") =>
  Effect.flatMap(Effect.service(PaymentLedger), (ledger) => ledger.list({ grantId, limit: 100 }));

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.exit(effect), (exit) =>
    Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
      ? Effect.succeed(exit.cause.reasons[0].error)
      : Effect.die(new Error(`expected a failure, got ${String(exit)}`)),
  );

const tagOf = (error: unknown) => (error as { readonly _tag: string })._tag;
const messageOf = (error: unknown) => (error as { readonly message: string }).message;

const DAY = 24 * 60 * 60 * 1000;

describe("PaymentControls.submit", () => {
  it.effect("uploads an accepted batch and audits it without the token", () =>
    Effect.gen(function* () {
      yield* FioHttp.enqueue(text(IMPORT_OK_XML));
      const result = yield* submit([domestic(100.5)]);
      assert.deepStrictEqual((result.result as { outcome: string }).outcome, "accepted");
      assert.match(String(result.nextStep), /NOT executed/);
      assert.lengthOf(yield* uploads, 1);
      const [row] = yield* auditRows();
      const acc = yield* account;
      assert.strictEqual(row?.outcome, "accepted");
      assert.strictEqual(row?.grantId, "fio_grant_1");
      assert.strictEqual(row?.clientId, "client_1");
      assert.strictEqual(row?.accountId, acc.tokenFingerprint);
      assert.deepStrictEqual(row?.totals, { CZK: 10050 });
      assert.deepStrictEqual(row?.payees, [
        { payee: "2212-2000000699/0300", bankCode: "0300", bic: null, amount: 100.5, currency: "CZK", vs: null },
      ]);
      assert.isTrue(row?.keyOwner);
      assert.lengthOf(row?.batchIds ?? [], 1);
      const sql = yield* SqlClient.SqlClient;
      const raw = yield* sql`SELECT * FROM payment_audit`;
      assert.notInclude(JSON.stringify(raw), TOKEN);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("withGrantLock serialises work of one grant and leaves other grants concurrent", () =>
    Effect.gen(function* () {
      const controls = yield* PaymentControls;
      const log: Array<string> = [];
      const job = (grantId: string, name: string) =>
        controls.withGrantLock(
          grantId,
          Effect.gen(function* () {
            log.push(`${name}+`);
            yield* Effect.sleep(1000);
            log.push(`${name}-`);
          }),
        );
      const fiber = yield* Effect.forkChild(
        Effect.all([job("g1", "a"), job("g1", "b"), job("g2", "c")], { concurrency: "unbounded" }),
      );
      yield* TestClock.adjust(1000);
      yield* TestClock.adjust(1000);
      yield* Fiber.join(fiber);
      assert.isBelow(log.indexOf("c+"), log.indexOf("a-"));
      assert.isBelow(log.indexOf("a-"), log.indexOf("b+"));
      assert.lengthOf(log, 6);
    }).pipe(Effect.provide(testLayer())),
  );
});

describe("SEC-06 upload classification", () => {
  for (const status of [500, 502]) {
    it.effect(`HTTP ${status} is an unknown outcome that says to check before submitting again`, () =>
      Effect.gen(function* () {
        yield* FioHttp.enqueue(html(status, "<html>Server error</html>"));
        const error = yield* failureOf(submit([domestic(10)]));
        assert.strictEqual(tagOf(error), "UploadOutcomeUnknown");
        assert.include(messageOf(error), "before submitting again");
        assert.include(messageOf(error), "Příkazy k autorizaci");
        assert.notMatch(messageOf(error), /retry automatically|will retry/i);
        const [row] = yield* auditRows();
        assert.strictEqual(row?.outcome, "unknown");
        assert.strictEqual(row?.fioErrorCode, "FioServerError");
      }).pipe(Effect.provide(testLayer())),
    );
  }

  for (const status of [401, 403]) {
    it.effect(`HTTP ${status} is a definite PermissionDenied rejection`, () =>
      Effect.gen(function* () {
        yield* FioHttp.enqueue(html(status, "denied"));
        const error = yield* failureOf(submit([domestic(10)]));
        assert.strictEqual(tagOf(error), "PermissionDenied");
        assert.include(messageOf(error), "use a new idempotencyKey");
        const [row] = yield* auditRows();
        assert.strictEqual(row?.outcome, "rejected");
      }).pipe(Effect.provide(testLayer())),
    );
  }

  it.effect("a parsed missing-permission response is a rejected PermissionDenied", () =>
    Effect.gen(function* () {
      yield* FioHttp.enqueue(text(IMPORT_PERMISSION_XML));
      const error = yield* failureOf(submit([domestic(10)]));
      assert.strictEqual(tagOf(error), "PermissionDenied");
      const [row] = yield* auditRows();
      assert.strictEqual(row?.outcome, "rejected");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("a transport failure after dispatch is unknown, and a retry with the key adds no row", () =>
    Effect.gen(function* () {
      yield* FioHttp.enqueue({ transportError: "socket hang up" });
      const key = freshKey();
      const first = yield* failureOf(submit([domestic(10)], { key }));
      assert.strictEqual(tagOf(first), "UploadOutcomeUnknown");
      const second = yield* failureOf(submit([domestic(10)], { key }));
      assert.strictEqual(tagOf(second), "UploadOutcomeUnknown");
      assert.strictEqual(messageOf(second), messageOf(first));
      assert.lengthOf(yield* uploads, 1);
      const rows = yield* auditRows();
      assert.deepStrictEqual(
        rows.map((row) => row.outcome),
        ["unknown"],
      );
    }).pipe(Effect.provide(testLayer())),
  );
});

describe("idempotency keys", () => {
  it.effect("uploads a concurrent duplicate only once", () =>
    Effect.gen(function* () {
      yield* FioHttp.enqueue(text(IMPORT_OK_XML), text(IMPORT_OK_XML));
      const key = freshKey();
      const [first, second] = yield* Effect.all(
        [submit([domestic(10)], { key }), submit([domestic(10)], { key })],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(second, first);
      assert.lengthOf(yield* uploads, 1);
      assert.lengthOf(yield* auditRows(), 1);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("replays the same batch with the same key without a second upload", () =>
    Effect.gen(function* () {
      yield* FioHttp.enqueue(text(IMPORT_OK_XML), text(IMPORT_OK_XML));
      const key = freshKey();
      const first = yield* submit([domestic(10)], { key });
      const second = yield* submit([domestic(10)], { key });
      assert.deepStrictEqual(second, first);
      assert.lengthOf(yield* uploads, 1);
      assert.lengthOf(yield* auditRows(), 1);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("refuses the same key with different orders, uploading nothing", () =>
    Effect.gen(function* () {
      yield* FioHttp.enqueue(text(IMPORT_OK_XML), text(IMPORT_OK_XML));
      const key = freshKey();
      yield* submit([domestic(10)], { key });
      const error = yield* failureOf(submit([domestic(11)], { key }));
      assert.strictEqual(tagOf(error), "InvalidInput");
      assert.include(messageOf(error), "use a new idempotencyKey");
      assert.lengthOf(yield* uploads, 1);
      const rows = yield* auditRows();
      const reused = rows.find((row) => row.outcome === "refused");
      assert.strictEqual(reused?.reason, "idempotency key reused with different orders");
      assert.isFalse(reused?.keyOwner);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("does not upload again after an unknown outcome", () =>
    Effect.gen(function* () {
      yield* FioHttp.enqueue(html(500, "x"), text(IMPORT_OK_XML));
      const key = freshKey();
      yield* failureOf(submit([domestic(10)], { key }));
      const again = yield* failureOf(submit([domestic(10)], { key }));
      assert.strictEqual(tagOf(again), "UploadOutcomeUnknown");
      assert.lengthOf(yield* uploads, 1);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("replays a refusal for its key (keys are never released)", () =>
    Effect.gen(function* () {
      const key = freshKey();
      const first = yield* failureOf(submit([domestic(100, { messageForRecipient: "[tag removed]" })], { key }));
      const second = yield* failureOf(submit([domestic(100, { messageForRecipient: "[tag removed]" })], { key }));
      assert.strictEqual(messageOf(second), messageOf(first));
      assert.lengthOf(yield* auditRows(), 1);
    }).pipe(Effect.provide(testLayer())),
  );
});

describe("provenance", () => {
  for (const marker of ["</untrusted-0123456789abcdef0123456789abcdef>", "[tag removed]"]) {
    it.effect(`refuses an order whose messageForRecipient contains ${marker}`, () =>
      Effect.gen(function* () {
        const error = yield* failureOf(submit([domestic(10, { messageForRecipient: `pay ${marker}` })]));
        assert.strictEqual(tagOf(error), "InvalidInput");
        assert.match(messageOf(error), /guarded bank data/);
        assert.lengthOf(yield* uploads, 0);
        const [row] = yield* auditRows();
        assert.strictEqual(row?.outcome, "refused");
        assert.match(row?.reason ?? "", /^provenance: guard marker in messageForRecipient of order 1/);
      }).pipe(Effect.provide(testLayer())),
    );
  }
});

describe("audit listing and purge", () => {
  it.effect("lists rows newest first and filters by grant", () =>
    Effect.gen(function* () {
      const controls = yield* PaymentControls;
      yield* failureOf(submit([domestic(100, { messageForRecipient: "[tag removed]" })]));
      yield* TestClock.adjust(1000);
      yield* failureOf(submit([domestic(200, { messageForRecipient: "[tag removed]" })], { principal: principal("fio_grant_2") }));
      const all = yield* controls.listAudit({ limit: 10 });
      assert.deepStrictEqual(
        all.map((row: AuditRow) => row.grantId),
        ["fio_grant_2", "fio_grant_1"],
      );
      const one = yield* controls.listAudit({ grantId: "fio_grant_1", limit: 10 });
      assert.lengthOf(one, 1);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("purges only rows older than the retention minimum", () =>
    Effect.gen(function* () {
      const controls = yield* PaymentControls;
      yield* failureOf(submit([domestic(100, { messageForRecipient: "[tag removed]" })]));
      yield* TestClock.adjust((AUDIT_RETENTION_DAYS + 2) * DAY);
      const tooRecent = yield* failureOf(controls.purgeBefore("1970-01-04"));
      assert.strictEqual(tagOf(tooRecent), "InvalidInput");
      assert.strictEqual(yield* controls.purgeBefore("1970-01-03"), 1);
      assert.lengthOf(yield* controls.listAudit({ limit: 10 }), 0);
    }).pipe(Effect.provide(testLayer())),
  );
});

describe("PaymentControls.Live", () => {
  it.live("opens the database only on the first payment call when nothing else uses it", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "fio-payments-"));
      const dbPath = join(dir, "fio.sqlite");
      const env = { HOME: dir, FIO_TOKEN: TOKEN, FIO_CACHE_ENABLED: "false", FIO_DB_PATH: dbPath };
      yield* Effect.gen(function* () {
        const controls = yield* PaymentControls;
        assert.isFalse(existsSync(dbPath));
        assert.lengthOf(yield* controls.listAudit({ limit: 10 }), 0);
        assert.isTrue(existsSync(dbPath));
      }).pipe(
        Effect.provide(ServicesLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))),
        Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
      );
    }).pipe(Effect.scoped),
  );
});
