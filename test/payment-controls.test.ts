import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { type Account, Accounts } from "../src/accounts.js";
import { ServicesLive } from "../src/app.js";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import { type AppConfigShape, MAX_RESPONSE_BYTES } from "../src/config.js";
import type { InvalidInput } from "../src/errors.js";
import { FioApi } from "../src/fio-api.js";
import { AUDIT_RETENTION_DAYS, PaymentControls, PENDING_TTL_MS, sha256Hex } from "../src/payment-controls.js";
import { type AuditRow, PaymentLedger } from "../src/payment-ledger.js";
import {
  DEFAULT_PAYMENT_LIMITS,
  type GrantPayments,
  normaliseAccount,
  OFF_ALLOWLIST,
  type PaymentLimits,
} from "../src/payment-limits.js";
import { buildImportXml, type Payer, type PaymentOrder, PaymentOrders } from "../src/payments.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { Redactor } from "../src/redaction.js";
import type { Principal } from "../src/transport/principal.js";
import { IMPORT_ERROR_XML, IMPORT_OK_XML, IMPORT_PERMISSION_XML } from "./fixtures.js";
import { seededConfig } from "./support/config.js";
import { memoryDatabase } from "./support/database.js";
import { FioHttp, html, text } from "./support/fio-http.js";

const TOKEN = "Tk7pQ2vX9mZr4LbN8sYw3HcJ6dFg1KaE5uVo0iRtBnMxWqSzPyGhCjDlUeAfOk2Q";
const BASE_URL = "https://fio.test/v1/rest";
const PAYER: Payer = { accountNumber: "2400222222", currency: "CZK" };
const IBAN = "DE89370400440532013000";
const OTHER_IBAN = "GB82WEST12345698765432";

const config = (paymentLimits: PaymentLimits = DEFAULT_PAYMENT_LIMITS): AppConfigShape => ({
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
  },
  paymentLimits,
});

const testLayer = (paymentLimits?: PaymentLimits) =>
  PaymentControls.Default.pipe(
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
    Layer.provideMerge(seededConfig(config(paymentLimits))),
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

const euro = (amount: number, accountTo = IBAN) => ({
  type: "euro",
  amount,
  currency: "EUR",
  accountTo,
  date: "2025-11-03",
  benefName: "Hans Muster",
});

const principal = (payments?: GrantPayments, subject = "fio_grant_1"): Principal => ({
  subject,
  scopes: "all",
  accountFingerprints: "all",
  clientId: "client_1",
  ...(payments === undefined ? {} : { payments }),
});

const limited = (limits: PaymentLimits): GrantPayments => ({ limits, allowlist: OFF_ALLOWLIST });

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

/** Every grant is live unless a test says otherwise. */
const live = (_grantId: string) => Effect.succeed(true);

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

  it.effect("refuses an order above maxPerOrder without contacting FIO", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(submit([domestic(50_000.01)]));
      assert.strictEqual(tagOf(error), "PermissionDenied");
      assert.match(messageOf(error), /per-order limit for CZK of 50000\.00/);
      assert.lengthOf(yield* uploads, 0);
      const [row] = yield* auditRows();
      assert.strictEqual(row?.outcome, "refused");
      assert.match(row?.reason ?? "", /^limit: /);
      assert.deepStrictEqual(row?.totals, { CZK: 5_000_001 });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("refuses a currency the limits do not list", () =>
    Effect.gen(function* () {
      const grant = limited({ maxPerOrder: { CZK: 1000 }, maxPerDay: { CZK: 2000 }, maxOrdersPerDay: 5 });
      const error = yield* failureOf(submit([euro(10)], { principal: principal(grant) }));
      assert.strictEqual(tagOf(error), "PermissionDenied");
      assert.match(messageOf(error), /EUR are not allowed/);
      assert.lengthOf(yield* uploads, 0);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("refuses a batch over maxPerDay, and allows it the next Prague day", () =>
    Effect.gen(function* () {
      yield* FioHttp.enqueue(text(IMPORT_OK_XML), text(IMPORT_OK_XML), text(IMPORT_OK_XML));
      yield* submit([domestic(40_000)]);
      yield* submit([domestic(40_000)]);
      const error = yield* failureOf(submit([domestic(30_000)]));
      assert.strictEqual(tagOf(error), "PermissionDenied");
      assert.include(messageOf(error), "Daily limit for CZK is 100000.00; 20000.00 remains today (Europe/Prague).");
      assert.lengthOf(yield* uploads, 2);
      yield* TestClock.adjust(DAY);
      yield* submit([domestic(30_000)]);
      assert.lengthOf(yield* uploads, 3);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("refuses orders beyond maxOrdersPerDay (counting orders, not batches)", () =>
    Effect.gen(function* () {
      const grant = principal(limited({ maxPerOrder: { CZK: 1000 }, maxPerDay: { CZK: 10_000 }, maxOrdersPerDay: 3 }));
      yield* FioHttp.enqueue(text(IMPORT_OK_XML));
      yield* submit([domestic(1), domestic(2)], { principal: grant });
      const error = yield* failureOf(submit([domestic(1), domestic(2)], { principal: grant }));
      assert.strictEqual(tagOf(error), "PermissionDenied");
      assert.match(messageOf(error), /Daily limit is 3 orders; 1 remain/);
      assert.lengthOf(yield* uploads, 1);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("applies the lower env ceiling over a grant's higher limit", () =>
    Effect.gen(function* () {
      const grant = principal(limited({ maxPerOrder: { CZK: 5000 }, maxPerDay: { CZK: 9000 }, maxOrdersPerDay: 10 }));
      const error = yield* failureOf(submit([domestic(1500)], { principal: grant }));
      assert.match(messageOf(error), /per-order limit for CZK of 1000\.00/);
    }).pipe(
      Effect.provide(testLayer({ maxPerOrder: { CZK: 1000 }, maxPerDay: { CZK: 100_000 }, maxOrdersPerDay: 20 })),
    ),
  );

  it.effect("lets only one of two concurrent submissions pass the daily limit", () =>
    Effect.gen(function* () {
      const grant = principal(limited({ maxPerOrder: { CZK: 50_000 }, maxPerDay: { CZK: 50_000 }, maxOrdersPerDay: 10 }));
      yield* FioHttp.enqueue(text(IMPORT_OK_XML), text(IMPORT_OK_XML));
      const results = yield* Effect.all(
        [Effect.exit(submit([domestic(40_000)], { principal: grant })), Effect.exit(submit([domestic(40_000)], { principal: grant }))],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter(Exit.isSuccess).length, 1);
      assert.lengthOf(yield* uploads, 1);
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

  it.effect("counts an unknown outcome towards the daily total", () =>
    Effect.gen(function* () {
      const grant = principal(limited({ maxPerOrder: { CZK: 50_000 }, maxPerDay: { CZK: 50_000 }, maxOrdersPerDay: 10 }));
      yield* FioHttp.enqueue(html(500, "<html>Internal error</html>"));
      const unknown = yield* failureOf(submit([domestic(40_000)], { principal: grant }));
      assert.strictEqual(tagOf(unknown), "UploadOutcomeUnknown");
      const error = yield* failureOf(submit([domestic(20_000)], { principal: grant }));
      assert.include(messageOf(error), "10000.00 remains today");
      assert.lengthOf(yield* uploads, 1);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("does not count a rejected batch", () =>
    Effect.gen(function* () {
      const grant = principal(limited({ maxPerOrder: { CZK: 50_000 }, maxPerDay: { CZK: 50_000 }, maxOrdersPerDay: 10 }));
      yield* FioHttp.enqueue(text(IMPORT_ERROR_XML), text(IMPORT_OK_XML));
      const rejected = yield* submit([domestic(40_000)], { principal: grant });
      assert.strictEqual((rejected.result as { outcome: string }).outcome, "rejected");
      yield* submit([domestic(40_000)], { principal: grant });
      assert.lengthOf(yield* uploads, 2);
      const outcomes = (yield* auditRows()).map((row) => row.outcome).sort();
      assert.deepStrictEqual(outcomes, ["accepted", "rejected"]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("limits local callers (no grant) by the server defaults", () =>
    Effect.gen(function* () {
      const local: Principal = { subject: "local", scopes: "all", accountFingerprints: "all" };
      const error = yield* failureOf(submit([domestic(60_000)], { principal: local }));
      assert.strictEqual(tagOf(error), "PermissionDenied");
      const [row] = yield* auditRows("local");
      assert.strictEqual(row?.clientId, null);
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
      const first = yield* failureOf(submit([domestic(60_000)], { key }));
      const second = yield* failureOf(submit([domestic(60_000)], { key }));
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

const allowlist = (mode: "enforce" | "confirm", ...entries: ReadonlyArray<string>): GrantPayments => ({
  limits: null,
  allowlist: { mode, entries: entries.map((entry) => ({ account: normaliseAccount(entry) ?? entry })) },
});

describe("payee allowlist", () => {
  it.effect("enforce refuses an unlisted IBAN and allows a listed one written with spaces in lower case", () =>
    Effect.gen(function* () {
      const grant = principal(allowlist("enforce", "de89 3704 0044 0532 0130 00"));
      const error = yield* failureOf(submit([euro(10, OTHER_IBAN)], { principal: grant }));
      assert.strictEqual(tagOf(error), "PermissionDenied");
      assert.include(messageOf(error), OTHER_IBAN);
      assert.lengthOf(yield* uploads, 0);
      const [row] = yield* auditRows();
      assert.strictEqual(row?.reason, `allowlist: ${OTHER_IBAN}`);
      yield* FioHttp.enqueue(text(IMPORT_OK_XML));
      yield* submit([euro(10)], { principal: grant });
      assert.lengthOf(yield* uploads, 1);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("confirm holds the batch and uploads the identical XML once after approval", () =>
    Effect.gen(function* () {
      const controls = yield* PaymentControls;
      const grant = principal(allowlist("confirm", IBAN));
      const key = freshKey();
      const held = yield* submit([euro(10)], { principal: grant, key });
      assert.strictEqual(held.outcome, "awaiting-admin-confirmation");
      assert.match(String(held.pendingId), /^pend_/);
      assert.strictEqual(held.expiresAt, "1970-01-02T00:00:00.000Z");
      assert.lengthOf(yield* uploads, 0);
      assert.deepStrictEqual(yield* submit([euro(10)], { principal: grant, key }), held);

      const [view] = yield* controls.listPending;
      assert.strictEqual(view?.batch.pendingId, held.pendingId);
      assert.strictEqual(view?.audit.outcome, "pending-confirmation");

      yield* FioHttp.enqueue(text(IMPORT_OK_XML));
      const approval = yield* controls.approvePending(String(held.pendingId), live);
      assert.strictEqual(approval.outcome, "accepted");
      const sent = yield* uploads;
      assert.lengthOf(sent, 1);
      const orders = decodeOrders([euro(10)]);
      assert.strictEqual(sent[0]?.files[0]?.text, yield* buildImportXml(orders, PAYER));
      assert.strictEqual(view?.batch.xmlSha256, sha256Hex(sent[0]?.files[0]?.text ?? ""));

      const again = yield* failureOf(controls.approvePending(String(held.pendingId), live));
      assert.strictEqual(tagOf(again), "InvalidInput");
      assert.lengthOf(yield* uploads, 1);
      const replayed = yield* submit([euro(10)], { principal: grant, key });
      assert.strictEqual((replayed.result as { outcome: string }).outcome, "accepted");
      assert.strictEqual(replayed.account, "main");
      assert.isUndefined(replayed.pendingId);
      const [row] = yield* auditRows();
      assert.strictEqual(row?.outcome, "accepted");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("confirm holds a batch even when every payee is listed, and counts it from submission", () =>
    Effect.gen(function* () {
      const grant = principal({
        limits: { maxPerOrder: { EUR: 100 }, maxPerDay: { EUR: 100 }, maxOrdersPerDay: 5 },
        allowlist: { mode: "confirm", entries: [{ account: IBAN }] },
      });
      const held = yield* submit([euro(80)], { principal: grant });
      assert.strictEqual(held.outcome, "awaiting-admin-confirmation");
      const error = yield* failureOf(submit([euro(30)], { principal: grant }));
      assert.include(messageOf(error), "20.00 remains today");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("decline uploads nothing and stops counting the batch", () =>
    Effect.gen(function* () {
      const controls = yield* PaymentControls;
      const grant = principal(allowlist("confirm"));
      const key = freshKey();
      const held = yield* submit([euro(10)], { principal: grant, key });
      assert.isTrue(yield* controls.declinePending(String(held.pendingId)));
      assert.isFalse(yield* controls.declinePending(String(held.pendingId)));
      assert.lengthOf(yield* controls.listPending, 0);
      assert.lengthOf(yield* uploads, 0);
      const [row] = yield* auditRows();
      assert.strictEqual(row?.outcome, "refused");
      assert.strictEqual(row?.reason, "declined by admin");
      const replay = yield* failureOf(submit([euro(10)], { principal: grant, key }));
      assert.match(messageOf(replay), /declined/);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("drops a held batch after 24 h without uploading", () =>
    Effect.gen(function* () {
      const controls = yield* PaymentControls;
      const held = yield* submit([euro(10)], { principal: principal(allowlist("confirm")) });
      yield* TestClock.adjust(PENDING_TTL_MS - 1);
      assert.lengthOf(yield* controls.listPending, 1);
      yield* TestClock.adjust(1);
      assert.lengthOf(yield* controls.listPending, 0);
      const error = yield* failureOf(controls.approvePending(String(held.pendingId), live));
      assert.strictEqual(tagOf(error), "InvalidInput");
      assert.lengthOf(yield* uploads, 0);
      const [row] = yield* auditRows();
      assert.strictEqual(row?.outcome, "refused");
      assert.strictEqual(row?.reason, "confirmation expired");
    }).pipe(Effect.provide(testLayer())),
  );
});

describe("held batch approval", () => {
  it.effect("refuses approval when the grant is no longer active and uploads nothing", () =>
    Effect.gen(function* () {
      const controls = yield* PaymentControls;
      const grant = principal(allowlist("confirm", IBAN));
      const key = freshKey();
      const held = yield* submit([euro(10)], { principal: grant, key });
      yield* FioHttp.enqueue(text(IMPORT_OK_XML));
      const checked: Array<string> = [];
      const revoked = (grantId: string) => Effect.sync(() => checked.push(grantId)).pipe(Effect.as(false));
      const approval = yield* controls.approvePending(String(held.pendingId), revoked);
      assert.deepStrictEqual(checked, ["fio_grant_1"]);
      assert.strictEqual(approval.outcome, "refused");
      assert.include(approval.message, "no longer active");
      assert.lengthOf(yield* uploads, 0);
      assert.lengthOf(yield* controls.listPending, 0);
      const [row] = yield* auditRows();
      assert.strictEqual(row?.outcome, "refused");
      assert.strictEqual(row?.reason, "approval: grant no longer active");
      const replay = yield* failureOf(submit([euro(10)], { principal: grant, key }));
      assert.include(messageOf(replay), "no longer active");
      const again = yield* failureOf(controls.approvePending(String(held.pendingId), live));
      assert.strictEqual(tagOf(again), "InvalidInput");
      assert.lengthOf(yield* uploads, 0);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("takes the batch and moves its audit row in one transaction", () =>
    Effect.gen(function* () {
      const ledger = yield* PaymentLedger;
      const held = yield* submit([euro(10)], { principal: principal(allowlist("confirm")) });
      const pendingId = String(held.pendingId);
      // The audit table's CHECK constraint rejects this outcome, failing the
      // audit update after the batch's DELETE: the DELETE must roll back.
      const broken = yield* failureOf(
        ledger.takePending(pendingId, 0, { outcome: "bogus" as AuditRow["outcome"], reason: "x" }),
      );
      assert.strictEqual(tagOf(broken), "PaymentAuditError");
      assert.isTrue((yield* ledger.getPending(pendingId))._tag === "Some");
      const [stillHeld] = yield* auditRows();
      assert.strictEqual(stillHeld?.outcome, "pending-confirmation");

      const taken = yield* ledger.takePending(pendingId, 0, { outcome: "refused", reason: "declined by admin" });
      assert.isTrue(taken._tag === "Some" && taken.value.moved);
      assert.isTrue((yield* ledger.getPending(pendingId))._tag === "None");
      const [row] = yield* auditRows();
      assert.strictEqual(row?.outcome, "refused");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("two concurrent approvals of one batch upload it once", () =>
    Effect.gen(function* () {
      const controls = yield* PaymentControls;
      const held = yield* submit([euro(10)], { principal: principal(allowlist("confirm", IBAN)) });
      yield* FioHttp.enqueue(text(IMPORT_OK_XML));
      yield* FioHttp.enqueue(text(IMPORT_OK_XML));
      const approve = Effect.exit(controls.approvePending(String(held.pendingId), live));
      const results = yield* Effect.all([approve, approve], { concurrency: "unbounded" });
      assert.strictEqual(results.filter(Exit.isSuccess).length, 1);
      assert.lengthOf(yield* uploads, 1);
      const [row] = yield* auditRows();
      assert.strictEqual(row?.outcome, "accepted");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("an approval racing the expiry sweep uploads at most once and leaves a consistent row", () =>
    Effect.gen(function* () {
      const controls = yield* PaymentControls;
      const ledger = yield* PaymentLedger;
      const held = yield* submit([euro(10)], { principal: principal(allowlist("confirm", IBAN)) });
      yield* FioHttp.enqueue(text(IMPORT_OK_XML));
      yield* TestClock.adjust(PENDING_TTL_MS - 1);
      const [approval] = yield* Effect.all(
        [
          Effect.exit(controls.approvePending(String(held.pendingId), live)),
          ledger.expirePending(PENDING_TTL_MS, JSON.stringify({ failure: null })),
        ],
        { concurrency: "unbounded" },
      );
      const sent = (yield* uploads).length;
      const [row] = yield* auditRows();
      assert.lengthOf(yield* ledger.pending(0), 0);
      if (Exit.isSuccess(approval)) {
        assert.strictEqual(sent, 1);
        assert.strictEqual(row?.outcome, "accepted");
      } else {
        assert.strictEqual(sent, 0);
        assert.strictEqual(row?.reason, "confirmation expired");
      }
    }).pipe(Effect.provide(testLayer())),
  );
});

describe("preview, audit listing and purge", () => {
  it.effect("previews the remaining allowance and problems without failing", () =>
    Effect.gen(function* () {
      const controls = yield* PaymentControls;
      yield* FioHttp.enqueue(text(IMPORT_OK_XML));
      yield* submit([domestic(30_000)]);
      const preview = yield* controls.preview({
        principal: principal(allowlist("enforce", IBAN)),
        payer: PAYER,
        orders: decodeOrders([domestic(80_000, { messageForRecipient: "[tag removed]" })]),
      });
      assert.isFalse(preview.withinLimits);
      assert.strictEqual(preview.limits.perCurrency.CZK?.remainingToday, 70_000);
      assert.strictEqual(preview.limits.ordersToday, 1);
      assert.deepStrictEqual(preview.allowlist, { mode: "enforce", unlistedPayees: ["2212-2000000699/0300"] });
      assert.lengthOf(preview.provenanceProblems, 1);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("lists rows newest first and filters by grant", () =>
    Effect.gen(function* () {
      const controls = yield* PaymentControls;
      yield* failureOf(submit([domestic(60_000)]));
      yield* TestClock.adjust(1000);
      yield* failureOf(submit([domestic(70_000)], { principal: principal(undefined, "fio_grant_2") }));
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
      yield* failureOf(submit([domestic(60_000)]));
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
