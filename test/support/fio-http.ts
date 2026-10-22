/**
 * Scripted FIO HTTP for tests: an `HttpClient` that answers from a script
 * and records every request. Nothing reaches the network.
 *
 * Usage:
 *
 *   const layer = FioHttp.layer({ tokens: [TOKEN] }); // Layer<FioHttp | HttpClient.HttpClient>
 *   // provide it under FioApiLayer (src/fio-api-live.ts), then in the test:
 *   yield* FioHttp.enqueue(json(statement), { status: 409 }, { transportError: "socket hang up" });
 *   yield* FioHttp.handle((request) => (request.path.startsWith("/last/") ? text("ok") : { status: 404 }));
 *   const [first] = yield* FioHttp.requests;
 *
 * Replies (`FioHttpReply`):
 * - `{ status?, body?, contentType?, headers?, delayMs? }`: an HTTP response
 *   (status defaults to 200, body to empty). `delayMs` sleeps on the Clock
 *   first, so TestClock controls it.
 * - `{ transportError, description?, delayMs? }`: fails like a network error
 *   (HttpClientError with a TransportError reason whose cause has that
 *   message, and the given description).
 * Queued replies are used first, in order; then the handler. A request with
 * neither dies with a message naming it.
 *
 * Recorded requests (`RecordedRequest`), with every configured token replaced
 * by "<token>":
 * - `method`; `url`; `path` (relative to `baseUrl`, default FIO's base URL).
 * - `fields`: multipart string fields by name; `files`: multipart files
 *   (field, filename, contentType, text).
 * - `tokenInUrl`: a raw or URL-encoded token appeared in the URL.
 * - `tokenInBody`: a token appeared anywhere in the multipart body.
 * - `tokenOutsideTokenField`: a token appeared in the body outside the
 *   `token` field (other fields or file contents).
 * Requests are recorded before the reply, so a timed-out request still shows.
 *
 * Helpers: `json(value)`, `text(body, contentType?)`, `html(status, body)`.
 */
import { Context, Effect, Layer, Ref } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

export const DEFAULT_TEST_BASE_URL = "https://fioapi.fio.cz/v1/rest";

export interface FioHttpResponse {
  readonly status?: number;
  readonly body?: string | Uint8Array;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly delayMs?: number;
}

export interface FioHttpTransportFailure {
  readonly transportError: string;
  /** Optional TransportError description (some clients put the URL there). */
  readonly description?: string;
  readonly delayMs?: number;
}

export type FioHttpReply = FioHttpResponse | FioHttpTransportFailure;

export interface RecordedFile {
  readonly field: string;
  readonly filename: string;
  readonly contentType: string;
  readonly text: string;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly files: ReadonlyArray<RecordedFile>;
  readonly tokenInUrl: boolean;
  readonly tokenInBody: boolean;
  readonly tokenOutsideTokenField: boolean;
}

export type FioHttpHandler = (request: RecordedRequest) => FioHttpReply | Effect.Effect<FioHttpReply>;

export interface FioHttpOptions {
  /** Raw tokens to detect and mask in recorded requests. */
  readonly tokens?: ReadonlyArray<string>;
  readonly baseUrl?: string;
  readonly replies?: ReadonlyArray<FioHttpReply>;
  readonly handler?: FioHttpHandler;
}

export interface FioHttpShape {
  readonly client: HttpClient.HttpClient;
  readonly enqueue: (...replies: ReadonlyArray<FioHttpReply>) => Effect.Effect<void>;
  readonly handle: (handler: FioHttpHandler) => Effect.Effect<void>;
  readonly requests: Effect.Effect<ReadonlyArray<RecordedRequest>>;
}

export const json = (value: unknown, status = 200): FioHttpResponse => ({
  status,
  body: JSON.stringify(value),
  contentType: "application/json;charset=UTF-8",
});

export const text = (body: string, contentType = "text/plain;charset=UTF-8"): FioHttpResponse => ({
  body,
  contentType,
});

export const html = (status: number, body: string): FioHttpResponse => ({
  status,
  body,
  contentType: "text/html;charset=UTF-8",
});

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const make = Effect.fnUntraced(function* (options: FioHttpOptions) {
  const tokens = (options.tokens ?? []).filter((t) => t.length > 0);
  const forms = [...new Set(tokens.flatMap((t) => [t, encodeURIComponent(t)]))].sort((a, b) => b.length - a.length);
  const mask = (value: string) => forms.reduce((out, form) => out.split(form).join("<token>"), value);
  const contains = (value: string) => forms.some((form) => value.includes(form));
  const baseUrl = (options.baseUrl ?? DEFAULT_TEST_BASE_URL).replace(/\/$/, "");

  const queue = yield* Ref.make<ReadonlyArray<FioHttpReply>>(options.replies ?? []);
  const handler = yield* Ref.make<FioHttpHandler | undefined>(options.handler);
  const recorded = yield* Ref.make<ReadonlyArray<RecordedRequest>>([]);

  const record = Effect.fnUntraced(function* (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]) {
    const fields: Record<string, string> = {};
    const files: Array<RecordedFile> = [];
    let tokenInBody = false;
    let tokenOutsideTokenField = false;
    if (request.body._tag === "FormData") {
      for (const [name, value] of request.body.formData.entries()) {
        const content = typeof value === "string" ? value : yield* Effect.promise(() => value.text());
        const hasToken = contains(content);
        tokenInBody ||= hasToken;
        if (name !== "token") tokenOutsideTokenField ||= hasToken;
        if (typeof value === "string") fields[name] = mask(value);
        else files.push({ field: name, filename: value.name, contentType: value.type, text: mask(content) });
      }
    }
    const url = request.url;
    const relative = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : new URL(url).pathname;
    return {
      method: request.method,
      url: mask(url),
      path: mask(relative),
      fields,
      files,
      tokenInUrl: contains(url),
      tokenInBody,
      tokenOutsideTokenField,
    } satisfies RecordedRequest;
  });

  const nextReply = Effect.fnUntraced(function* (request: RecordedRequest) {
    const queued = yield* Ref.modify(queue, ([head, ...rest]): [FioHttpReply | undefined, ReadonlyArray<FioHttpReply>] =>
      head === undefined ? [undefined, []] : [head, rest],
    );
    if (queued !== undefined) return queued;
    const handle = yield* Ref.get(handler);
    if (handle === undefined) return yield* Effect.die(`FioHttp: no scripted reply for ${request.method} ${request.path}`);
    const reply = handle(request);
    return Effect.isEffect(reply) ? yield* reply : reply;
  });

  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const recordedRequest = yield* record(request);
      yield* Ref.update(recorded, (all) => [...all, recordedRequest]);
      const reply = yield* nextReply(recordedRequest);
      if (reply.delayMs !== undefined && reply.delayMs > 0) yield* Effect.sleep(reply.delayMs);
      if ("transportError" in reply) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: new Error(reply.transportError),
            ...(reply.description === undefined ? {} : { description: reply.description }),
          }),
        });
      }
      const status = reply.status ?? 200;
      const headers: Record<string, string> = { ...reply.headers };
      if (reply.contentType !== undefined) headers["content-type"] = reply.contentType;
      const body = NULL_BODY_STATUSES.has(status) ? null : (reply.body ?? "");
      return HttpClientResponse.fromWeb(request, new Response(body, { status, headers }));
    }),
  );

  return {
    client,
    enqueue: (...replies) => Ref.update(queue, (current) => [...current, ...replies]),
    handle: (next) => Ref.set(handler, next),
    requests: Ref.get(recorded),
  } satisfies FioHttpShape;
});

export class FioHttp extends Context.Service<FioHttp, FioHttpShape>()("test/FioHttp") {
  /** The scripted client as `HttpClient.HttpClient`, plus this accessor. */
  static readonly layer = (options: FioHttpOptions = {}): Layer.Layer<FioHttp | HttpClient.HttpClient> =>
    Layer.effectContext(
      Effect.map(make(options), (shape) => Context.make(FioHttp, shape).pipe(Context.add(HttpClient.HttpClient, shape.client))),
    );

  static readonly enqueue = (...replies: ReadonlyArray<FioHttpReply>) =>
    Effect.flatMap(Effect.service(FioHttp), (http) => http.enqueue(...replies));

  static readonly handle = (handler: FioHttpHandler) => Effect.flatMap(Effect.service(FioHttp), (http) => http.handle(handler));

  static readonly requests = Effect.flatMap(Effect.service(FioHttp), (http) => http.requests);
}
