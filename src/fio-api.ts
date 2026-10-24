import { Context, Effect, Layer, Predicate, Redacted, Result, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { SchemaError } from "effect/Schema";
import { type Account, Accounts } from "./accounts.js";
import { AppConfig } from "./config.js";
import {
  errorForStatus,
  type FioRequestError,
  FioResponseError,
  FioTransportError,
  type Operation,
  type TokenBusy,
} from "./errors.js";
import { type FioClient, make as makeFioClient } from "./generated/effect.gen.js";
import { type Priority, RateLimiter } from "./rate-limiter.js";
import { Redactor, type RedactorShape } from "./redaction.js";
import { type NormalizedStatement, normalizeStatement } from "./statement.js";

/** Movement export formats (PDF §5). */
export const MOVEMENT_FORMATS = ["csv", "gpc", "html", "json", "ofx", "xml"] as const;
/** Official statements additionally support MT940 (`sta`) and ČBA/SBA XML. PDF is binary and not exposed. */
export const STATEMENT_FORMATS = [...MOVEMENT_FORMATS, "sta", "cba_xml", "sba_xml"] as const;
export const MERCHANT_FORMATS = ["xml", "csv"] as const;

export type MovementFormat = (typeof MOVEMENT_FORMATS)[number];
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];
export type MerchantFormat = (typeof MERCHANT_FORMATS)[number];

/**
 * FIO's REST API for one account at a time. Every call goes through the
 * account token's rate limiter (interactive priority unless stated), applies
 * the request timeout, and maps every failure to a tagged error. JSON
 * statements are normalized, and their header is passed to
 * `Accounts.learn`.
 */
export interface FioApiShape {
  /** GET /periods/{token}/{from}/{to}/transactions.json. Never moves the download marker. */
  readonly periods: (
    account: Account,
    from: string,
    to: string,
    priority?: Priority,
  ) => Effect.Effect<NormalizedStatement, FioRequestError>;
  /** GET /periods/{token}/{from}/{to}/transactions.{format}, raw text. */
  readonly periodsRaw: (
    account: Account,
    from: string,
    to: string,
    format: MovementFormat,
  ) => Effect.Effect<string, FioRequestError>;
  /** GET /by-id/{token}/{year}/{id}/transactions.json */
  readonly statement: (account: Account, year: number, id: number) => Effect.Effect<NormalizedStatement, FioRequestError>;
  /** GET /by-id/{token}/{year}/{id}/transactions.{format}, raw text. */
  readonly statementRaw: (
    account: Account,
    year: number,
    id: number,
    format: StatementFormat,
  ) => Effect.Effect<string, FioRequestError>;
  /** GET /last/{token}/transactions.json. Advances the server-side marker when non-empty. */
  readonly last: (account: Account) => Effect.Effect<NormalizedStatement, FioRequestError>;
  /** GET /set-last-id/{token}/{id}/ */
  readonly setLastId: (account: Account, id: number) => Effect.Effect<void, FioRequestError>;
  /** GET /set-last-date/{token}/{date}/ */
  readonly setLastDate: (account: Account, date: string) => Effect.Effect<void, FioRequestError>;
  /** GET /lastStatement/{token}/statement, raw text (the format is undocumented). */
  readonly lastStatement: (account: Account) => Effect.Effect<string, FioRequestError>;
  /** GET /merchant/{token}/{from}/{to}/transactions.{format}, raw text. */
  readonly merchantRaw: (
    account: Account,
    from: string,
    to: string,
    format: MerchantFormat,
  ) => Effect.Effect<string, FioRequestError>;
  /**
   * POST /import/ with a Fio XML file (type=xml, lng=en). Creates a payment
   * batch on success. Returns the raw XML response. HTTP 500 and 401/403
   * map to PermissionDenied.
   */
  readonly importXml: (account: Account, xml: string) => Effect.Effect<string, FioRequestError>;
}

/*
 * The adapter: FioApi on top of the client generated from openapi/fio-api.yaml.
 *
 * The token is unwrapped only to build each request. Every call runs in the
 * token's rate-limiter slot, with the request timeout covering the response
 * body. Responses are buffered (bounded) before the generated client decodes
 * them, and every failure becomes a tagged error whose text is redacted and
 * never names the request URL.
 */

type ClientError = HttpClientError.HttpClientError | SchemaError;

const OVERSIZED = "fio-mcp: response body over the size limit";
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const UTF8 = new TextDecoder();
const URL_PATTERN = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi;

const transportFailure = (request: HttpClientRequest.HttpClientRequest, cause: unknown, description: string) =>
  new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause, description }) });

/**
 * Reads the whole body, at most `maxBytes`, and returns an equivalent
 * buffered response. On a 2xx, a larger body fails decoding and a body cut
 * off mid-read is a transport failure. On any other status the status is
 * what matters, so an unreadable body becomes an empty one.
 */
const bufferResponse = (maxBytes: number) =>
  Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
    const oversized = new HttpClientError.HttpClientError({
      reason: new HttpClientError.DecodeError({ request: response.request, response, description: OVERSIZED }),
    });
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    const read = yield* Stream.runForEach(response.stream, (chunk) => {
      size += chunk.byteLength;
      if (size > maxBytes) return Effect.fail(oversized);
      chunks.push(chunk);
      return Effect.void;
    }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "EmptyBodyError",
        () => Effect.void,
      ),
      Effect.result,
    );
    const ok = response.status >= 200 && response.status < 300;
    if (Result.isFailure(read)) {
      if (ok && read.failure === oversized) return yield* oversized;
      if (ok) {
        return yield* transportFailure(
          response.request,
          read.failure.reason.cause,
          "The connection dropped while reading the response.",
        );
      }
      chunks.length = 0;
      size = 0;
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return HttpClientResponse.fromWeb(
      response.request,
      new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
        status: response.status,
        headers: response.headers,
      }),
    );
  });

/** Messages along an error's cause chain (fetch hides the reason in `cause`). */
function causeMessages(cause: unknown): string {
  const messages: Array<string> = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    if (Predicate.hasProperty(current, "message") && typeof current.message === "string" && current.message !== "") {
      messages.push(current.message);
    } else if (typeof current === "string" && current !== "") {
      messages.push(current);
    }
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  return messages.join(": ");
}

/** Maps a generated-client failure to the tagged errors FioApi documents. */
const toFioError =
  (redactor: RedactorShape, operation: Operation) =>
  (error: ClientError): Effect.Effect<never, FioRequestError | TokenBusy> => {
    if (!HttpClientError.isHttpClientError(error)) {
      return Effect.fail(
        new FioResponseError({ detail: "FIO returned a JSON statement that does not match the documented shape." }),
      );
    }
    const reason = error.reason;
    switch (reason._tag) {
      case "StatusCodeError":
        return reason.response.text.pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((body) => Effect.fail(errorForStatus(reason.response.status, redactor.excerpt(body), operation))),
        );
      case "TransportError": {
        const cause = causeMessages(reason.cause);
        const what = reason.description ?? "The request failed.";
        const detail = redactor.redact(cause === "" ? what : `${what} (${cause})`).replace(URL_PATTERN, "<url>");
        return Effect.fail(new FioTransportError({ kind: "network", detail: detail.slice(0, 400), dispatched: true }));
      }
      case "EncodeError":
      case "InvalidUrlError":
        return Effect.fail(
          new FioTransportError({
            kind: "network",
            detail: "The request could not be built, so it was not sent.",
            dispatched: false,
          }),
        );
      case "DecodeError":
        return Effect.fail(
          new FioResponseError({
            detail:
              reason.description === OVERSIZED
                ? "FIO returned a response larger than this server reads. Narrow the request."
                : "FIO returned a response that could not be decoded (not valid JSON).",
          }),
        );
      case "EmptyBodyError":
        return Effect.fail(new FioResponseError({ detail: "FIO returned an empty response." }));
    }
  };

const makeFioApi = Effect.fn("FioApi.make")(function* () {
  const config = yield* AppConfig;
  const accounts = yield* Accounts;
  const limiter = yield* RateLimiter;
  const redactor = yield* Redactor;
  const httpClient = yield* HttpClient.HttpClient;
  const buffer = bufferResponse(config.maxResponseBytes);
  const client = makeFioClient(httpClient, {
    transformClient: (client) =>
      Effect.succeed(
        client.pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(config.baseUrl)),
          HttpClient.transformResponse(Effect.flatMap(buffer)),
        ),
      ),
  });

  /**
   * One request in the token's limiter slot. The token is unwrapped only
   * here; tracing is off so no span or propagated header carries the URL.
   */
  const call = <A>(
    account: Account,
    priority: Priority,
    operation: Operation,
    request: (client: FioClient, token: string) => Effect.Effect<A, ClientError>,
  ): Effect.Effect<A, FioRequestError> =>
    limiter.run(
      account.tokenFingerprint,
      priority,
      Effect.suspend(() => request(client, Redacted.value(account.token))).pipe(
        Effect.catch(toFioError(redactor, operation)),
        Effect.timeoutOrElse({
          duration: config.requestTimeoutMs,
          orElse: () =>
            Effect.fail(
              new FioTransportError({
                kind: "timeout",
                detail: `No complete response within ${config.requestTimeoutMs} ms.`,
                dispatched: true,
              }),
            ),
        }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      ),
    );

  const text = (bytes: Uint8Array) => UTF8.decode(bytes);

  const statement = Effect.fnUntraced(function* (account: Account, json: unknown) {
    const normalized = yield* normalizeStatement(json);
    yield* accounts.learn(account, normalized.info);
    return normalized;
  });

  /** Error messages are token-free by construction; this logs nothing else. */
  const logFailure =
    (name: string) =>
    <A>(self: Effect.Effect<A, FioRequestError>): Effect.Effect<A, FioRequestError> =>
      Effect.tapError(self, (error) => Effect.logDebug(`FIO ${name} failed: ${error._tag}: ${error.message}`));

  return {
    periods: (account, from, to, priority = "interactive") =>
      call(account, priority, "read", (c, token) => c.getPeriodsJson(token, from, to, undefined)).pipe(
        Effect.flatMap((json) => statement(account, json)),
        logFailure("periods"),
      ),
    periodsRaw: (account, from, to, format) =>
      call(account, "interactive", "read", (c, token) => c.getPeriods(token, from, to, format, undefined)).pipe(
        Effect.map(text),
        logFailure("periods"),
      ),
    statement: (account, year, id) =>
      call(account, "interactive", "read", (c, token) =>
        c.getStatementJson(token, String(year), String(id), undefined),
      ).pipe(
        Effect.flatMap((json) => statement(account, json)),
        logFailure("statement"),
      ),
    statementRaw: (account, year, id, format) =>
      call(account, "interactive", "read", (c, token) =>
        c.getStatement(token, String(year), String(id), format, undefined),
      ).pipe(Effect.map(text), logFailure("statement")),
    last: (account) =>
      call(account, "interactive", "read", (c, token) => c.getLastJson(token, undefined)).pipe(
        Effect.flatMap((json) => statement(account, json)),
        logFailure("last"),
      ),
    setLastId: (account, id) =>
      call(account, "interactive", "read", (c, token) => c.setLastId(token, String(id), undefined)).pipe(
        logFailure("set-last-id"),
      ),
    setLastDate: (account, date) =>
      call(account, "interactive", "read", (c, token) => c.setLastDate(token, date, undefined)).pipe(
        logFailure("set-last-date"),
      ),
    lastStatement: (account) =>
      call(account, "interactive", "read", (c, token) => c.getLastStatement(token, undefined)).pipe(
        Effect.map(text),
        logFailure("lastStatement"),
      ),
    merchantRaw: (account, from, to, format) =>
      call(account, "interactive", "read", (c, token) =>
        c.getMerchantTransactions(token, from, to, format, undefined),
      ).pipe(Effect.map(text), logFailure("merchant")),
    importXml: (account, xml) =>
      call(account, "interactive", "import", (c, token) =>
        c.importPayments({
          payload: {
            token,
            type: "xml",
            lng: "en",
            file: new File([xml], "orders.xml", { type: "application/xml" }),
          },
        }),
      ).pipe(Effect.map(text), logFailure("import")),
  } satisfies FioApiShape;
});

export class FioApi extends Context.Service<FioApi, FioApiShape>()("fio-mcp/FioApi") {
  /** FioApi over the HttpClient in context (tests provide a scripted one). */
  static readonly Default = Layer.effect(FioApi, makeFioApi());

  /**
   * The production HttpClient: fetch without following redirects. A 3xx
   * would replay the token-bearing URL or the multipart token to another
   * location, so it surfaces as an HTTP error instead.
   */
  static readonly FetchClient = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
  );

  static readonly Live = FioApi.Default.pipe(
    Layer.provide(FioApi.FetchClient),
    Layer.provide(Layer.mergeAll(Accounts.Live, RateLimiter.Live, Redactor.Live, AppConfig.Live)),
  );
}
