import { Effect, Layer, Predicate, Redacted, Result, Stream } from "effect";
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
import { FioApi, type FioApiShape } from "./fio-api.js";
import { type FioClient, make as makeFioClient } from "./generated/effect.gen.js";
import { type Priority, RateLimiter } from "./rate-limiter.js";
import { Redactor, type RedactorShape } from "./redaction.js";
import { normalizeStatement } from "./statement.js";

/**
 * FioApi on top of the client generated from openapi/fio-api.yaml.
 *
 * The token is unwrapped only to build each request. Every call runs in the
 * token's rate-limiter slot, with the request timeout covering the response
 * body. Responses are buffered (bounded) before the generated client decodes
 * them, and every failure becomes a tagged error whose text is redacted and
 * never names the request URL.
 */

/** Largest response body FioApi reads. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface FioApiOptions {
  readonly maxResponseBytes?: number;
}

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
        const detail = redactor.redact(causeMessages(reason.cause)).replace(URL_PATTERN, "<url>").slice(0, 300);
        const what = reason.description ?? "The request failed.";
        return Effect.fail(
          new FioTransportError({
            kind: "network",
            detail: detail === "" ? what : `${what} (${detail})`,
            dispatched: true,
          }),
        );
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

export const makeFioApi = Effect.fn("FioApi.make")(function* (options: FioApiOptions = {}) {
  const config = yield* AppConfig;
  const accounts = yield* Accounts;
  const limiter = yield* RateLimiter;
  const redactor = yield* Redactor;
  const httpClient = yield* HttpClient.HttpClient;
  const buffer = bufferResponse(options.maxResponseBytes ?? MAX_RESPONSE_BYTES);
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

  return FioApi.of({
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
  } satisfies FioApiShape);
});

/** FioApi over a caller-supplied HttpClient (tests provide a scripted one). */
export const fioApiLayer = (options: FioApiOptions = {}) => Layer.effect(FioApi, makeFioApi(options));

export const FioApiLayer: Layer.Layer<
  FioApi,
  never,
  AppConfig | Accounts | RateLimiter | Redactor | HttpClient.HttpClient
> = fioApiLayer();

/**
 * FioApi over fetch. Redirects are not followed: a 3xx would replay the
 * token-bearing URL or the multipart token to another location, so it
 * surfaces as an HTTP error instead.
 */
export const FioApiLive: Layer.Layer<FioApi, never, AppConfig | Accounts | RateLimiter | Redactor> = FioApiLayer.pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }))),
  ),
);
