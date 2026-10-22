import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Logger, Redacted, References, Tracer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";
import { Accounts } from "../src/accounts.js";
import { AppConfig, type AppConfigShape } from "../src/config.js";
import { PERMISSION_DENIED } from "../src/errors.js";
import { FioApi } from "../src/fio-api.js";
import { FioApiLive, type FioApiOptions, fioApiLayer } from "../src/fio-api-live.js";
import { make as makeFioClient } from "../src/generated/effect.gen.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { Redactor } from "../src/redaction.js";
import { FioHttp, html, json, text } from "./support/fio-http.js";

const TOKEN = "Tk7pQ2vX9mZr4LbN8sYw3HcJ6dFg1KaE5uVo0iRtBnMxWqSzPyGhCjDlUeAfOk2Q";
const BASE_URL = "https://fio.test/v1/rest";

const baseConfig: AppConfigShape = {
  accounts: [{ name: "main", token: Redacted.make(TOKEN), accountNumber: undefined, currency: undefined }],
  secrets: [Redacted.make(TOKEN)],
  baseUrl: BASE_URL,
  rateLimitIntervalMs: 30_000,
  maxWaitMs: 100_000,
  requestTimeoutMs: 20_000,
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
};

const testLayer = (options: FioApiOptions = {}, config: Partial<AppConfigShape> = {}) =>
  fioApiLayer(options).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FioHttp.layer({ tokens: [TOKEN], baseUrl: BASE_URL }),
        Accounts.layer,
        RateLimiter.layer,
        Redactor.layer,
      ),
    ),
    Layer.provideMerge(AppConfig.layerFrom({ ...baseConfig, ...config })),
  );

const account = Effect.flatMap(Effect.service(Accounts), (accounts) => accounts.resolve("main"));

/** Lets forked fibers run up to their next suspension. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

const STATEMENT = {
  accountStatement: {
    info: {
      accountId: "2400222222",
      bankId: "2010",
      currency: "CZK",
      iban: "CZ7920100000002400222222",
      bic: "FIOBCZPPXXX",
      openingBalance: 195.0,
      closingBalance: 1695.01,
      dateStart: "2024-01-01+0100",
      dateEnd: "2024-01-31+0100",
      yearList: null,
      idList: null,
      idFrom: 1147608196,
      idTo: 1147608196,
      idLastDownload: null,
    },
    transactionList: {
      transaction: [
        {
          column22: { value: 1147608196, name: "ID pohybu", id: 22 },
          column0: { value: "2024-01-15+0100", name: "Datum", id: 0 },
          column1: { value: 1500.01, name: "Objem", id: 1 },
          column14: { value: "CZK", name: "Měna", id: 14 },
          column2: { value: "2900233333", name: "Protiúčet", id: 2 },
          column10: { value: "Žluťoučký kůň s.r.o.", name: "Název protiúčtu", id: 10 },
          column3: { value: "2010", name: "Kód banky", id: 3 },
          column5: { value: "0012345", name: "VS", id: 5 },
          column8: { value: "Příjem převodem uvnitř banky", name: "Typ", id: 8 },
          column17: { value: 2105685816, name: "ID pokynu", id: 17 },
          column4: null,
          column6: null,
        },
      ],
    },
  },
};

/** Fails the test if the token shows up anywhere in the value or its message. */
const assertTokenFree = (value: unknown) => {
  const message = value instanceof Error ? value.message : "";
  const serialized = JSON.stringify(value) ?? "";
  for (const form of [TOKEN, encodeURIComponent(TOKEN)]) {
    assert.isFalse(message.includes(form), `token in message: ${message}`);
    assert.isFalse(serialized.includes(form), `token in value: ${serialized}`);
  }
  assert.isFalse(message.includes("fio.test"), `URL in message: ${message}`);
};

/** Runs `effect` and returns its failure, asserting it failed and is token-free. */
const failure = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    if (!Exit.isFailure(exit)) return assert.fail(`expected a failure, got ${JSON.stringify(exit)}`);
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
    if (error?._tag !== "Fail") return assert.fail(`expected a typed failure, got ${String(exit.cause)}`);
    assertTokenFree(error.error);
    return error.error;
  });

describe("FioApi", () => {
  describe("JSON statements", () => {
    it.effect("periods: GETs transactions.json, normalizes it, and learns the header", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const accounts = yield* Accounts;
        const acct = yield* account;
        yield* FioHttp.enqueue(json(STATEMENT));
        const statement = yield* api.periods(acct, "2024-01-01", "2024-01-31");
        assert.strictEqual(statement.transactionCount, 1);
        const [tx] = statement.transactions;
        assert.strictEqual(tx?.id, 1147608196);
        assert.strictEqual(tx?.date, "2024-01-15");
        assert.strictEqual(tx?.amount, 1500.01);
        assert.strictEqual(tx?.variableSymbol, "0012345");
        assert.strictEqual(tx?.counterpartyName, "Žluťoučký kůň s.r.o.");
        assert.strictEqual(tx?.constantSymbol, null);
        assert.strictEqual(statement.info.dateStart, "2024-01-01");
        const details = yield* accounts.details(acct);
        assert.deepStrictEqual(details, { accountNumber: "2400222222", currency: "CZK" });
        const [request] = yield* FioHttp.requests;
        assert.strictEqual(request?.method, "GET");
        assert.strictEqual(request?.path, "/periods/<token>/2024-01-01/2024-01-31/transactions.json");
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("statement and last use their documented paths", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.handle(() => json(STATEMENT));
        yield* api.statement(acct, 2024, 7);
        yield* TestClock.adjust(30_000);
        const last = yield* api.last(acct);
        assert.strictEqual(last.info.accountId, "2400222222");
        const paths = (yield* FioHttp.requests).map((r) => r.path);
        assert.deepStrictEqual(paths, ["/by-id/<token>/2024/7/transactions.json", "/last/<token>/transactions.json"]);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("an empty statement has no transactions", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue(
          json({ accountStatement: { info: STATEMENT.accountStatement.info, transactionList: { transaction: [] } } }),
        );
        const statement = yield* api.last(acct);
        assert.strictEqual(statement.transactionCount, 0);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("malformed JSON is a FioResponseError", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue({ body: `{"accountStatement": ${TOKEN}`, contentType: "application/json" });
        const error = yield* failure(api.periods(acct, "2024-01-01", "2024-01-31"));
        assert.strictEqual(error._tag, "FioResponseError");
        assert.include(error.message, "not valid JSON");
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("a JSON document that is not a statement is a FioResponseError", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue(json({ error: "nope" }));
        const missing = yield* failure(api.periods(acct, "2024-01-01", "2024-01-31"));
        assert.strictEqual(missing._tag, "FioResponseError");
        yield* TestClock.adjust(30_000);
        const wrongColumn = structuredClone(STATEMENT);
        Object.assign(wrongColumn.accountStatement.transactionList.transaction[0]!, {
          column1: { value: "a lot", name: "Objem", id: 1 },
        });
        yield* FioHttp.enqueue(json(wrongColumn));
        const shape = yield* failure(api.periods(acct, "2024-01-01", "2024-01-31"));
        assert.strictEqual(shape._tag, "FioResponseError");
        assert.include(shape.message, "documented shape");
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("an epoch date outside the Date range is a FioResponseError, not a defect", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        const farFuture = structuredClone(STATEMENT);
        Object.assign(farFuture.accountStatement.info, { dateStart: 1e100 });
        yield* FioHttp.enqueue(json(farFuture));
        const error = yield* failure(api.last(acct));
        assert.strictEqual(error._tag, "FioResponseError");
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("an empty 200 body on a JSON endpoint is a FioResponseError", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue({ body: "" });
        const error = yield* failure(api.last(acct));
        assert.strictEqual(error._tag, "FioResponseError");
      }).pipe(Effect.provide(testLayer())),
    );
  });

  describe("text endpoints", () => {
    it.effect("return the body verbatim, UTF-8 decoded, from the documented paths", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        const csv = "ID pohybu;Datum;Objem\n1147608196;15.01.2024;1500,01;Žluťoučký kůň\n";
        const sta = ":20:Fio\r\n:25:2400222222/2010\r\n";
        const merchant = '<?xml version="1.0" encoding="UTF-8"?><MerchantStatement><Info/></MerchantStatement>';
        yield* FioHttp.enqueue(
          text(csv, "text/csv;charset=UTF-8"),
          text(sta),
          text(merchant, "application/xml"),
          text("2024,7"),
          text('{"accountStatement":{}}', "application/json"),
        );
        assert.strictEqual(yield* api.periodsRaw(acct, "2024-01-01", "2024-01-31", "csv"), csv);
        yield* TestClock.adjust(30_000);
        assert.strictEqual(yield* api.statementRaw(acct, 2024, 7, "sta"), sta);
        yield* TestClock.adjust(30_000);
        assert.strictEqual(yield* api.merchantRaw(acct, "2024-01-01", "2024-01-31", "xml"), merchant);
        yield* TestClock.adjust(30_000);
        assert.strictEqual(yield* api.lastStatement(acct), "2024,7");
        yield* TestClock.adjust(30_000);
        assert.strictEqual(
          yield* api.periodsRaw(acct, "2024-01-01", "2024-01-31", "json"),
          '{"accountStatement":{}}',
        );
        const paths = (yield* FioHttp.requests).map((r) => r.path);
        assert.deepStrictEqual(paths, [
          "/periods/<token>/2024-01-01/2024-01-31/transactions.csv",
          "/by-id/<token>/2024/7/transactions.sta",
          "/merchant/<token>/2024-01-01/2024-01-31/transactions.xml",
          "/lastStatement/<token>/statement",
          "/periods/<token>/2024-01-01/2024-01-31/transactions.json",
        ]);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("set-last-id and set-last-date succeed on an empty body", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue({ status: 200 }, { status: 200, body: "" });
        yield* api.setLastId(acct, 1147608196);
        yield* TestClock.adjust(30_000);
        yield* api.setLastDate(acct, "2024-01-31");
        const paths = (yield* FioHttp.requests).map((r) => r.path);
        assert.deepStrictEqual(paths, ["/set-last-id/<token>/1147608196/", "/set-last-date/<token>/2024-01-31/"]);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("a body over the size limit is a FioResponseError, declared or streamed", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        const big = "x".repeat(2048);
        yield* FioHttp.enqueue(text(big), { ...text(big), headers: { "content-length": "2048" } }, text("x".repeat(1024)));
        const streamed = yield* failure(api.periodsRaw(acct, "2024-01-01", "2024-01-31", "csv"));
        assert.strictEqual(streamed._tag, "FioResponseError");
        assert.include(streamed.message, "larger");
        yield* TestClock.adjust(30_000);
        const declared = yield* failure(api.periodsRaw(acct, "2024-01-01", "2024-01-31", "csv"));
        assert.strictEqual(declared._tag, "FioResponseError");
        yield* TestClock.adjust(30_000);
        assert.strictEqual((yield* api.periodsRaw(acct, "2024-01-01", "2024-01-31", "csv")).length, 1024);
      }).pipe(Effect.provide(testLayer({ maxResponseBytes: 1024 }))),
    );
  });

  describe("payment import", () => {
    it.effect("POSTs multipart token, type=xml, lng=en and orders.xml; the token is only in its field", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        const response =
          '<?xml version="1.0" encoding="UTF-8"?><responseImport><result><errorCode>0</errorCode><idInstruction>1</idInstruction><status>ok</status></result></responseImport>';
        yield* FioHttp.enqueue(text(response, "application/xml"));
        const orders = '<?xml version="1.0" encoding="UTF-8"?><Import><Orders/></Import>';
        assert.strictEqual(yield* api.importXml(acct, orders), response);
        const [request] = yield* FioHttp.requests;
        assert.strictEqual(request?.method, "POST");
        assert.strictEqual(request?.path, "/import/");
        assert.deepStrictEqual(request?.fields, { token: "<token>", type: "xml", lng: "en" });
        assert.deepStrictEqual(request?.files, [
          { field: "file", filename: "orders.xml", contentType: "application/xml", text: orders },
        ]);
        assert.isFalse(request?.tokenInUrl);
        assert.isTrue(request?.tokenInBody);
        assert.isFalse(request?.tokenOutsideTokenField);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("HTTP 500 on import is PermissionDenied", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue(html(500, "<html><body>Internal error</body></html>"));
        const error = yield* failure(api.importXml(acct, "<Import/>"));
        assert.strictEqual(error._tag, "PermissionDenied");
        assert.isTrue(error.message.startsWith(PERMISSION_DENIED));
      }).pipe(Effect.provide(testLayer())),
    );
  });

  describe("HTTP status mapping", () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [404, "FioBadRequest"],
      [413, "TooManyItems"],
      [422, "HistoryAuthorizationRequired"],
      [500, "TokenRejected"],
      [401, "PermissionDenied"],
      [403, "PermissionDenied"],
      [418, "FioServerError"],
      [502, "FioServerError"],
    ];
    for (const [status, tag] of cases) {
      it.effect(`read HTTP ${status} is ${tag}`, () =>
        Effect.gen(function* () {
          const api = yield* FioApi;
          const acct = yield* account;
          yield* FioHttp.enqueue(html(status, "<html><body><h1>Error</h1><p>Something went wrong</p></body></html>"));
          const error = yield* failure(api.periods(acct, "2024-01-01", "2024-01-31"));
          assert.strictEqual(error._tag, tag);
          if (error._tag === "FioServerError") assert.strictEqual(error.status, status);
        }).pipe(Effect.provide(testLayer())),
      );
    }

    it.effect("error excerpts are tag-stripped and redact a token the body echoes", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue(html(404, `<html><body><p>Bad request /periods/${TOKEN}/2024-13-01/x</p></body></html>`));
        const error = yield* failure(api.periods(acct, "2024-13-01", "2024-01-31"));
        assert.strictEqual(error._tag, "FioBadRequest");
        if (error._tag === "FioBadRequest") assert.strictEqual(error.excerpt, "Bad request /periods/***/2024-13-01/x");
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("HTTP 409 blocks the token and retries once, then succeeds", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue(html(409, "Conflict"), json(STATEMENT));
        const fiber = yield* Effect.forkChild(api.periods(acct, "2024-01-01", "2024-01-31"));
        yield* settle;
        assert.strictEqual((yield* FioHttp.requests).length, 1);
        yield* TestClock.adjust(30_000);
        const statement = yield* Fiber.join(fiber);
        assert.strictEqual(statement.transactionCount, 1);
        assert.strictEqual((yield* FioHttp.requests).length, 2);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("a second HTTP 409 is RateLimited", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue(html(409, "Conflict"), html(409, "Conflict"));
        const fiber = yield* Effect.forkChild(failure(api.periods(acct, "2024-01-01", "2024-01-31")));
        yield* settle;
        yield* TestClock.adjust(30_000);
        const error = yield* Fiber.join(fiber);
        assert.strictEqual(error._tag, "RateLimited");
        assert.strictEqual((yield* FioHttp.requests).length, 2);
      }).pipe(Effect.provide(testLayer())),
    );
  });

  describe("transport", () => {
    it.effect("a network failure is FioTransportError(network, dispatched) without URL or token", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue({
          transportError: `connect ECONNREFUSED for ${BASE_URL}/periods/${TOKEN}/2024-01-01/2024-01-31/transactions.json`,
        });
        const error = yield* failure(api.periods(acct, "2024-01-01", "2024-01-31"));
        assert.strictEqual(error._tag, "FioTransportError");
        if (error._tag === "FioTransportError") {
          assert.strictEqual(error.kind, "network");
          assert.isTrue(error.dispatched);
          assert.include(error.detail, "ECONNREFUSED");
        }
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("a transport description with the URL is redacted too", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue({
          transportError: "socket hang up",
          description: `GET ${BASE_URL}/last/${TOKEN}/transactions.json failed`,
        });
        const error = yield* failure(api.last(acct));
        assert.strictEqual(error._tag, "FioTransportError");
        if (error._tag === "FioTransportError") assert.include(error.detail, "socket hang up");
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("no response within requestTimeoutMs is FioTransportError(timeout, dispatched)", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        yield* FioHttp.enqueue({ ...json(STATEMENT), delayMs: 60_000 });
        const fiber = yield* Effect.forkChild(failure(api.periods(acct, "2024-01-01", "2024-01-31")));
        yield* settle;
        yield* TestClock.adjust(5_000);
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust(15_000);
        const error = yield* Fiber.join(fiber);
        assert.strictEqual(error._tag, "FioTransportError");
        if (error._tag === "FioTransportError") {
          assert.strictEqual(error.kind, "timeout");
          assert.isTrue(error.dispatched);
        }
      }).pipe(Effect.provide(testLayer({}, { requestTimeoutMs: 20_000 }))),
    );

    it.effect("a request that cannot be built is FioTransportError(network, not dispatched)", () =>
      Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        const error = yield* failure(api.periods(acct, "", "2024-01-31"));
        assert.strictEqual(error._tag, "FioTransportError");
        if (error._tag === "FioTransportError") assert.isFalse(error.dispatched);
        assert.strictEqual((yield* FioHttp.requests).length, 0);
      }).pipe(Effect.provide(testLayer())),
    );
  });

  it.effect("a null transactionList is an empty statement", () =>
    Effect.gen(function* () {
      const api = yield* FioApi;
      const acct = yield* account;
      yield* FioHttp.enqueue(json({ accountStatement: { info: STATEMENT.accountStatement.info, transactionList: null } }));
      assert.strictEqual((yield* api.last(acct)).transactionCount, 0);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("set-last-id accepts any 2xx, including 204", () =>
    Effect.gen(function* () {
      const api = yield* FioApi;
      const acct = yield* account;
      yield* FioHttp.enqueue({ status: 204 });
      yield* api.setLastId(acct, 1);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("an error status keeps its meaning when its body is over the size limit", () =>
    Effect.gen(function* () {
      const api = yield* FioApi;
      const acct = yield* account;
      yield* FioHttp.enqueue(html(409, "x".repeat(4096)), html(404, "y".repeat(4096)));
      const fiber = yield* Effect.forkChild(failure(api.periodsRaw(acct, "2024-01-01", "2024-01-31", "csv")));
      yield* settle;
      yield* TestClock.adjust(30_000);
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error._tag, "FioBadRequest");
      if (error._tag === "FioBadRequest") assert.strictEqual(error.excerpt, "");
      assert.strictEqual((yield* FioHttp.requests).length, 2);
    }).pipe(Effect.provide(testLayer({ maxResponseBytes: 1024 }))),
  );

  it.effect("records no span or attribute with the token or URL", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    return Effect.gen(function* () {
      const api = yield* FioApi;
      const acct = yield* account;
      yield* FioHttp.enqueue(json(STATEMENT), html(500, "error"));
      yield* api.periods(acct, "2024-01-01", "2024-01-31");
      yield* TestClock.adjust(30_000);
      yield* Effect.exit(api.importXml(acct, "<Import/>"));
      for (const span of spans) {
        const recorded = JSON.stringify([span.name, [...span.attributes], span.events], (_key, value) =>
          typeof value === "bigint" ? String(value) : value,
        );
        assert.notInclude(recorded, TOKEN);
        assert.notInclude(recorded, "fio.test");
      }
    }).pipe(Effect.withTracer(tracer), Effect.provide(testLayer()));
  });

  it.effect("never logs the token", () => {
    const lines: Array<string> = [];
    const capture = Logger.make<unknown, void>((options) => {
      lines.push(Logger.formatLogFmt.log(options));
    });
    return Effect.gen(function* () {
      const api = yield* FioApi;
      const acct = yield* account;
      yield* FioHttp.enqueue(
        html(404, `<p>/periods/${TOKEN}/x</p>`),
        { transportError: `ECONNRESET ${BASE_URL}/last/${TOKEN}/transactions.json` },
        html(500, TOKEN),
      );
      yield* Effect.exit(api.periods(acct, "2024-01-01", "2024-01-31"));
      yield* TestClock.adjust(30_000);
      yield* Effect.exit(api.last(acct));
      yield* TestClock.adjust(30_000);
      yield* Effect.exit(api.importXml(acct, "<Import/>"));
      assert.isAtLeast(lines.length, 3);
      for (const line of lines) {
        assert.notInclude(line, TOKEN);
        assert.notInclude(line, "fio.test");
      }
    }).pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.provideService(References.MinimumLogLevel, "All"),
      Effect.provide(testLayer()),
    );
  });
});

describe("generated FIO client", () => {
  const client = Effect.map(Effect.service(HttpClient.HttpClient), (http) =>
    makeFioClient(http, {
      transformClient: (c) => Effect.succeed(c.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(BASE_URL)))),
    }),
  );
  const fixtures = FioHttp.layer({ tokens: [TOKEN], baseUrl: BASE_URL });

  it.effect("returns text exports as bytes", () =>
    Effect.gen(function* () {
      const fio = yield* client;
      yield* FioHttp.enqueue(text("a;b;č\n", "text/csv"));
      const bytes = yield* fio.getPeriods(TOKEN, "2024-01-01", "2024-01-31", "csv", undefined);
      assert.strictEqual(new TextDecoder().decode(bytes), "a;b;č\n");
    }).pipe(Effect.provide(fixtures)),
  );

  it.effect("returns void for an empty set-last-id response", () =>
    Effect.gen(function* () {
      const fio = yield* client;
      yield* FioHttp.enqueue({ status: 200 });
      const result = yield* fio.setLastId(TOKEN, "42", undefined);
      assert.isUndefined(result);
      const [request] = yield* FioHttp.requests;
      assert.strictEqual(request?.path, "/set-last-id/<token>/42/");
    }).pipe(Effect.provide(fixtures)),
  );

  it.effect("returns the XML import response as bytes", () =>
    Effect.gen(function* () {
      const fio = yield* client;
      const xml = "<responseImport><result><errorCode>0</errorCode><status>ok</status></result></responseImport>";
      yield* FioHttp.enqueue(text(xml, "application/xml"));
      const bytes = yield* fio.importPayments({
        payload: { token: TOKEN, type: "xml", file: new File(["<Import/>"], "orders.xml") },
      });
      assert.strictEqual(new TextDecoder().decode(bytes), xml);
    }).pipe(Effect.provide(fixtures)),
  );

  it.effect("fails an HTML error page with StatusCodeError and keeps the body readable", () =>
    Effect.gen(function* () {
      const fio = yield* client;
      yield* FioHttp.enqueue(html(500, "<html><body>Token neexistuje</body></html>"));
      const exit = yield* Effect.exit(fio.getPeriodsJson(TOKEN, "2024-01-01", "2024-01-31", undefined));
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === "Fail") : undefined;
      const value = error?._tag === "Fail" ? error.error : undefined;
      assert.isTrue(HttpClientError.isHttpClientError(value));
      if (HttpClientError.isHttpClientError(value) && value.reason._tag === "StatusCodeError") {
        assert.strictEqual(value.reason.response.status, 500);
        assert.include(yield* value.reason.response.text, "Token neexistuje");
      } else {
        assert.fail("expected StatusCodeError");
      }
    }).pipe(Effect.provide(fixtures)),
  );
});

describe("FioApiLive over fetch", () => {
  interface Hit {
    readonly method: string;
    readonly url: string;
    readonly body: string;
  }

  /** A local FIO stand-in: `route` answers by path; every request is recorded. */
  const localFio = (route: (path: string, req: IncomingMessage, res: ServerResponse) => void) =>
    Effect.acquireRelease(
      Effect.callback<{ server: Server; port: number; hits: Array<Hit> }>((resume) => {
        const hits: Array<Hit> = [];
        const server = createServer((req, res) => {
          const chunks: Array<Buffer> = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const url = req.url ?? "";
            hits.push({ method: req.method ?? "", url, body: Buffer.concat(chunks).toString("utf8") });
            route(url.split(TOKEN).join("<token>"), req, res);
          });
        });
        server.listen(0, "127.0.0.1", () =>
          resume(Effect.succeed({ server, port: (server.address() as AddressInfo).port, hits })),
        );
      }),
      ({ server }) =>
        Effect.callback<void>((resume) => {
          server.closeAllConnections();
          server.close(() => resume(Effect.void));
        }),
    );

  const liveLayer = (port: number, config: Partial<AppConfigShape> = {}) =>
    FioApiLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(Accounts.layer, RateLimiter.layerFrom({ intervalMs: 0, maxWaitMs: 1_000 }), Redactor.layer),
      ),
      Layer.provideMerge(
        AppConfig.layerFrom({
          ...baseConfig,
          baseUrl: `http://127.0.0.1:${port}/v1/rest`,
          requestTimeoutMs: 5_000,
          ...config,
        }),
      ),
    );

  it.live("reads chunked JSON, accepts 204, sends multipart with a filename, and does not follow redirects", () =>
    Effect.gen(function* () {
      const { port, hits } = yield* localFio((path, _req, res) => {
        if (path === "/v1/rest/last/<token>/transactions.json") {
          res.writeHead(200, { "content-type": "application/json;charset=UTF-8" });
          const body = JSON.stringify(STATEMENT);
          res.write(body.slice(0, 100));
          res.end(body.slice(100));
        } else if (path === "/v1/rest/set-last-id/<token>/5/") {
          res.writeHead(204).end();
        } else if (path === "/v1/rest/import/") {
          res.writeHead(200, { "content-type": "application/xml" }).end("<responseImport/>");
        } else if (path.startsWith("/v1/rest/periods/")) {
          res.writeHead(307, { location: `http://127.0.0.1:${port}/elsewhere/` }).end();
        } else {
          res.writeHead(418).end();
        }
      });
      const program = Effect.gen(function* () {
        const api = yield* FioApi;
        const acct = yield* account;
        assert.strictEqual((yield* api.last(acct)).transactionCount, 1);
        yield* api.setLastId(acct, 5);
        assert.strictEqual(yield* api.importXml(acct, "<Import/>"), "<responseImport/>");
        const redirect = yield* failure(api.periods(acct, "2024-01-01", "2024-01-31"));
        assert.strictEqual(redirect._tag, "FioServerError");
        if (redirect._tag === "FioServerError") assert.strictEqual(redirect.status, 307);
      });
      yield* program.pipe(Effect.provide(liveLayer(port)));
      assert.isFalse(hits.some((hit) => hit.url.startsWith("/elsewhere")));
      const upload = hits.find((hit) => hit.url === "/v1/rest/import/");
      assert.match(upload?.body ?? "", /name="file"; filename="orders\.xml"/);
      assert.match(upload?.body ?? "", /Content-Type: application\/xml/);
      assert.isFalse(hits.some((hit) => hit.url.includes("import") && hit.url.includes(TOKEN)));
    }).pipe(Effect.scoped),
  );

  it.live("the timeout covers a body that stalls after the headers", () =>
    Effect.gen(function* () {
      const { port } = yield* localFio((_path, _req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"accountStatement":');
      });
      const error = yield* Effect.gen(function* () {
        const api = yield* FioApi;
        return yield* failure(api.last(yield* account));
      }).pipe(Effect.provide(liveLayer(port, { requestTimeoutMs: 300 })));
      assert.strictEqual(error._tag, "FioTransportError");
      if (error._tag === "FioTransportError") {
        assert.strictEqual(error.kind, "timeout");
        assert.isTrue(error.dispatched);
      }
    }).pipe(Effect.scoped),
  );

  it.live("a body over the limit is refused and the response is closed", () =>
    Effect.gen(function* () {
      let closed = false;
      const { port } = yield* localFio((_path, _req, res) => {
        res.writeHead(200, { "content-type": "text/csv" });
        const timer = setInterval(() => res.write("x".repeat(512)), 5);
        res.on("close", () => {
          clearInterval(timer);
          closed = true;
        });
      });
      const layer = fioApiLayer({ maxResponseBytes: 4096 }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provideMerge(
          Layer.mergeAll(Accounts.layer, RateLimiter.layerFrom({ intervalMs: 0, maxWaitMs: 1_000 }), Redactor.layer),
        ),
        Layer.provideMerge(AppConfig.layerFrom({ ...baseConfig, baseUrl: `http://127.0.0.1:${port}/v1/rest` })),
      );
      const error = yield* Effect.gen(function* () {
        const api = yield* FioApi;
        return yield* failure(api.periodsRaw(yield* account, "2024-01-01", "2024-01-31", "csv"));
      }).pipe(Effect.provide(layer));
      assert.strictEqual(error._tag, "FioResponseError");
      for (let waited = 0; waited < 2_000 && !closed; waited += 10) yield* Effect.sleep(10);
      assert.isTrue(closed);
    }).pipe(Effect.scoped),
  );

  it.live("a connection dropped mid-body is a dispatched network failure", () =>
    Effect.gen(function* () {
      const { port } = yield* localFio((_path, _req, res) => {
        res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        res.write('{"accountStatement":');
        setTimeout(() => res.socket?.destroy(), 20);
      });
      const error = yield* Effect.gen(function* () {
        const api = yield* FioApi;
        return yield* failure(api.last(yield* account));
      }).pipe(Effect.provide(liveLayer(port)));
      assert.strictEqual(error._tag, "FioTransportError");
      if (error._tag === "FioTransportError") {
        assert.strictEqual(error.kind, "network");
        assert.isTrue(error.dispatched);
      }
    }).pipe(Effect.scoped),
  );
});
