import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { ByteSize, Clock, Context, Effect, Exit, Layer, Predicate, Result, Schema, type Scope, Stream, type Types } from "effect";
import { McpServer } from "effect/ai";
import { Headers, HttpBody, HttpEffect, HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { TransportConfig } from "../config.js";
import { Redactor } from "../redaction.js";
import { Auth } from "./auth.js";
import { type FrameRedactor, makeFrameRedactor } from "./frame-redaction.js";
import { CurrentPrincipal, type Principal } from "./principal.js";
import type { ServerInfo } from "./server-info.js";

/**
 * MCP Streamable HTTP. The app serves plain HTTP; TLS terminates at the
 * reverse proxy in front of it.
 *
 * Every path except /healthz passes the Host allowlist (DNS-rebinding
 * defence); McpServer's routes then pass `Auth`, and McpServer itself
 * rejects foreign Origin headers. Every response body is redacted on the
 * way out.
 * /healthz bypasses the guard so container and proxy probes work with any
 * Host header and without credentials; it touches neither FIO nor the
 * network.
 */

export type HttpTransportConfig = Extract<TransportConfig, { readonly kind: "http" }>;

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";

const HealthRoute = HttpRouter.add(
  "GET",
  HEALTH_PATH,
  HttpMiddleware.withLoggerDisabled(Effect.succeed(HttpServerResponse.jsonUnsafe({ status: "ok" }))),
);

// `host` or `host:port`, with IPv6 literals in brackets.
const HOST_HEADER = /^(\[[^\]]*\]|[^:]*)(?::\d*)?$/;

/**
 * An empty allowlist accepts any Host. An entry without a port accepts that
 * host on any port; an entry with a port accepts only that port.
 */
export function isAllowedHost(allowedHosts: ReadonlyArray<string>, header: string | undefined): boolean {
  if (allowedHosts.length === 0) return true;
  if (header === undefined) return false;
  const host = header.trim().toLowerCase();
  return allowedHosts.includes(host) || allowedHosts.includes(HOST_HEADER.exec(host)?.[1] ?? host);
}

/**
 * Redacts a response body. McpServer answers with byte bodies (JSON or a
 * complete SSE body) or byte streams (one SSE event per chunk); both are
 * whole frames per chunk. Raw bodies only occur for strings here.
 */
export function redactResponse(
  frames: FrameRedactor,
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse {
  const body = response.body;
  switch (body._tag) {
    case "Uint8Array": {
      const redacted = frames.chunk(body.body);
      return redacted === body.body
        ? response
        : HttpServerResponse.setBody(response, HttpBody.uint8Array(redacted, body.contentType));
    }
    case "Stream":
      // Chunk sizes may change, so any declared length is dropped.
      return HttpServerResponse.setBody(response, HttpBody.stream(Stream.map(body.stream, (chunk) => frames.chunk(chunk)), body.contentType));
    case "Raw":
      return typeof body.body === "string"
        ? HttpServerResponse.setBody(response, HttpBody.text(frames.text(body.body), body.contentType))
        : response;
    default:
      return response;
  }
}

const pathOf = (url: string) => url.split("?", 1)[0];

const unauthorized = (challenge: string) =>
  HttpServerResponse.empty({ status: 401, headers: { "www-authenticate": challenge } });

const forbidden = HttpServerResponse.empty({ status: 403 });

const unavailable = HttpServerResponse.empty({ status: 503, headers: { "retry-after": "5" } });

// What McpServer answers for a session id it does not know.
const unknownSession = HttpServerResponse.empty({ status: 404 });

const payloadTooLarge = HttpServerResponse.empty({ status: 413 });

const tooManySessions = HttpServerResponse.empty({ status: 429, headers: { "retry-after": "60" } });

const tooManyRequests = HttpServerResponse.empty({ status: 429, headers: { "retry-after": "1" } });

const MCP_SESSION_HEADER = "mcp-session-id";
const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

export interface SessionLimits {
  /** Sessions across all subjects, including reservations and sessions being ended. */
  readonly maxTracked: number;
  /** Sessions one subject (OAuth grant) may hold. */
  readonly maxPerSubject: number;
  /** A session without a request for this long is ended when its subject or the server needs room. */
  readonly idleMs: number;
}

export const SESSION_LIMITS: SessionLimits = {
  maxTracked: 1_000,
  maxPerSubject: 32,
  idleMs: 60 * 60_000,
};

/**
 * Largest /mcp request body. The largest legitimate request, a 100-order
 * payment import, is around 100 KB of JSON.
 */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Largest initialize request: McpServer keeps its client info for the session's lifetime. */
export const MAX_INITIALIZE_BODY_BYTES = 64 * 1024;
/** Requests one subject may have in flight at once; each may hold a body of MAX_BODY_BYTES. */
export const MAX_CONCURRENT_REQUESTS = 16;

/** A session slot: the subject (OAuth grant) holding it and its use. */
interface Slot {
  readonly subject: string;
  lastSeen: number;
  /** Requests in progress; a busy session is never ended for being idle. */
  active: number;
  /** Negotiated at initialization, sent back when the session is ended. */
  protocolVersion: string | undefined;
}

/** A tracked session given up to make room; it still counts until McpServer has ended it. */
export interface Eviction {
  readonly session: string;
  readonly slot: Slot;
}

export type Admission =
  | { readonly _tag: "Admitted"; readonly reservation: number; readonly evicted: Eviction | undefined }
  | { readonly _tag: "SubjectFull" }
  | { readonly _tag: "ServerFull" };

/**
 * Which subject owns which MCP session, with admission limits. Every
 * session McpServer holds is counted here: a slot is reserved before an
 * initialization is dispatched and becomes the session's once its id is
 * known (even when the client never received it), and a session given up
 * for room is counted until McpServer has ended it. At capacity, the
 * longest-idle session (of the subject, or of anyone when the server is
 * full) is ended if it has been idle for `idleMs`; otherwise the new
 * session is refused.
 */
export const makeSessionOwners = (limits: SessionLimits = SESSION_LIMITS) => {
  const sessions = new Map<string, Slot>();
  const reservations = new Map<number, Slot>();
  let ending = 0;
  let nextReservation = 0;

  const size = () => sessions.size + reservations.size + ending;

  const countOf = (subject: string) => {
    let count = 0;
    for (const slot of sessions.values()) if (slot.subject === subject) count++;
    for (const slot of reservations.values()) if (slot.subject === subject) count++;
    return count;
  };

  /** The longest-idle slot (of `subject`, or of anyone) unused for `idleMs`. */
  const idlest = (now: number, subject?: string) => {
    let found: { readonly key: string | number; readonly slot: Slot } | undefined;
    const consider = (key: string | number, slot: Slot) => {
      if (subject !== undefined && slot.subject !== subject) return;
      if (slot.active > 0 || slot.lastSeen > now - limits.idleMs) return;
      if (found === undefined || slot.lastSeen < found.slot.lastSeen) found = { key, slot };
    };
    for (const [key, slot] of sessions) consider(key, slot);
    for (const [key, slot] of reservations) consider(key, slot);
    return found;
  };

  /** A reservation for one new session, possibly in place of an idle one that must be ended first. */
  const admit = (subject: string, now: number): Admission => {
    let victim: ReturnType<typeof idlest>;
    if (countOf(subject) >= limits.maxPerSubject) {
      victim = idlest(now, subject);
      if (victim === undefined) return { _tag: "SubjectFull" };
    } else if (size() >= limits.maxTracked) {
      victim = idlest(now);
      if (victim === undefined) return { _tag: "ServerFull" };
    }
    let evicted: Eviction | undefined;
    if (typeof victim?.key === "string") {
      sessions.delete(victim.key);
      ending++;
      evicted = { session: victim.key, slot: victim.slot };
    } else if (typeof victim?.key === "number") {
      // A reservation whose response never went out; there is no id to end.
      reservations.delete(victim.key);
    }
    const reservation = nextReservation++;
    reservations.set(reservation, { subject, lastSeen: now, active: 0, protocolVersion: undefined });
    return { _tag: "Admitted", reservation, evicted };
  };

  /** McpServer has ended an evicted session, or (on failure) it is the subject's again. */
  const ended = (evicted: Eviction, ok: boolean) => {
    ending--;
    if (!ok) sessions.set(evicted.session, evicted.slot);
  };

  /**
   * A response went out: a reservation becomes `session`'s slot, or is
   * freed when none was created. A session created without a reservation
   * is tracked too.
   */
  const settle = (
    reservation: number | undefined,
    subject: string,
    session: string | undefined,
    protocolVersion: string | undefined,
    now: number,
  ) => {
    if (reservation !== undefined) reservations.delete(reservation);
    if (session !== undefined && !sessions.has(session)) {
      sessions.set(session, { subject, lastSeen: now, active: 0, protocolVersion });
    }
  };

  /** `session`'s slot when it belongs to `subject`, marked in use. */
  const use = (session: string, subject: string, now: number): Slot | undefined => {
    const slot = sessions.get(session);
    if (slot === undefined || slot.subject !== subject) return undefined;
    slot.lastSeen = now;
    slot.active++;
    return slot;
  };

  const done = (slot: Slot, now: number) => {
    slot.lastSeen = now;
    slot.active--;
  };

  const forget = (session: string) => sessions.delete(session);

  return { admit, ended, settle, use, done, forget, size };
};

type BodyRead =
  | { readonly _tag: "Read"; readonly text: string; readonly bytes: number }
  | { readonly _tag: "TooLarge" }
  | { readonly _tag: "Unreadable" };

/**
 * Reads the body once, at most MAX_BODY_BYTES: a larger declared length is
 * refused unread, a longer body stops being read at the limit. McpServer
 * later reads the same cached body.
 */
const readBody = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<BodyRead> => {
  const declared = Number(request.headers["content-length"]);
  if (declared > MAX_BODY_BYTES) return Effect.succeed({ _tag: "TooLarge" });
  return request.text.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.map((text): BodyRead => {
      // Only the Node server enforces MaxBodySize while reading.
      const bytes = Buffer.byteLength(text);
      return bytes > MAX_BODY_BYTES ? { _tag: "TooLarge" } : { _tag: "Read", text, bytes };
    }),
    Effect.catch((error) =>
      Effect.succeed<BodyRead>(
        error.reason._tag === "RequestParseError" && error.reason.reason === "BodyTooLarge"
          ? { _tag: "TooLarge" }
          : { _tag: "Unreadable" },
      ),
    ),
  );
};

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/**
 * Whether a POST without a session id may create a session: an initialize
 * request, or a batch. A body McpServer cannot parse creates none.
 */
const mayInitialize = (text: string) => {
  const message = decodeJson(text);
  if (Result.isFailure(message)) return false;
  const value = message.success;
  return Array.isArray(value) || (Predicate.hasProperty(value, "method") && value.method === "initialize");
};

/**
 * Set on requests this module dispatches itself (ending a session through
 * McpServer's DELETE handling); they skip the Host allowlist and `Auth`.
 * Only code in this module can set it.
 */
const InternalRequest = Context.Reference<boolean>("fio-mcp/transport/http/InternalRequest", {
  defaultValue: () => false,
});

/**
 * Every route: response redaction, and (except /healthz) the Host allowlist.
 * Paths are compared literally; any other spelling of /healthz is checked.
 */
const guard = (allowedHosts: ReadonlyArray<string>) =>
  HttpRouter.middleware(
    Effect.gen(function* () {
      const frames = makeFrameRedactor(yield* Redactor);
      return Effect.fnUntraced(function* (
        httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
      ) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const internal = yield* InternalRequest;
        if (!internal && pathOf(request.url) !== HEALTH_PATH && !isAllowedHost(allowedHosts, request.headers.host)) {
          return forbidden;
        }
        return redactResponse(frames, yield* httpEffect);
      });
    }),
    { global: true },
  );

/**
 * Authentication and limits for every route McpServer registers. Route
 * middleware, not a path comparison: the router also matches /MCP, /mcp/,
 * //mcp and percent-encoded spellings. The principal reaches tool handlers
 * as `CurrentPrincipal`.
 *
 * A subject (OAuth grant) may have MAX_CONCURRENT_REQUESTS requests in
 * flight (429 beyond). POST bodies are read at most MAX_BODY_BYTES (413
 * beyond), initialize requests at most MAX_INITIALIZE_BODY_BYTES.
 *
 * MCP sessions are bound to the subject that initialized them. McpServer
 * finds sessions by id alone, so a session id presented by another grant,
 * or one no longer tracked, is answered 404 like an unknown session and the
 * client starts a new one. Refreshing tokens keeps the grant, so sessions
 * survive refresh. A grant may hold SESSION_LIMITS.maxPerSubject sessions;
 * beyond that, initialization is refused (429) unless one of its sessions
 * has been idle for SESSION_LIMITS.idleMs, which is then ended in McpServer
 * (its id answers 404 from then on). The server as a whole holds
 * SESSION_LIMITS.maxTracked sessions the same way (503 when full).
 */
const mcpAuth = HttpRouter.middleware(
  Effect.gen(function* () {
    const auth = yield* Auth;
    const router = yield* HttpRouter.HttpRouter;
    const sessions = makeSessionOwners();
    const inFlight = new Map<string, number>();
    // The router's whole app, built on first use (after every route is added).
    let routed:
      | Effect.Effect<
          Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>,
          never,
          HttpServerRequest.HttpServerRequest | Scope.Scope
        >
      | undefined;

    /** Ends `session` in McpServer through its own DELETE handling: 204 when ended, 404 when it was gone already. */
    const terminate = (session: string, protocolVersion: string | undefined) => {
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      routed ??= Effect.exit(router.asHttpEffect());
      const request = HttpServerRequest.fromWeb(new Request(`http://fio-mcp.internal${MCP_PATH}`, { method: "DELETE" })).modify({
        headers: Headers.fromInput({
          [MCP_SESSION_HEADER]: session,
          ...(protocolVersion === undefined ? {} : { [MCP_PROTOCOL_VERSION_HEADER]: protocolVersion }),
        }),
      });
      return routed.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(InternalRequest, true),
        Effect.scoped,
        Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value.status : 500)),
      );
    };

    /** Records the session id McpServer set on the final response (in a pre-response handler appended before this one). */
    const settleOnResponse = (reservation: number | undefined, subject: string) =>
      HttpEffect.appendPreResponseHandler((_request, final) =>
        Effect.map(Clock.currentTimeMillis, (sent) => {
          sessions.settle(reservation, subject, final.headers[MCP_SESSION_HEADER], final.headers[MCP_PROTOCOL_VERSION_HEADER], sent);
          return final;
        }),
      );

    const initialize = Effect.fnUntraced(function* (
      subject: string,
      handle: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
    ) {
      const admission = sessions.admit(subject, yield* Clock.currentTimeMillis);
      if (admission._tag === "SubjectFull") return tooManySessions;
      if (admission._tag === "ServerFull") return unavailable;
      const { reservation, evicted } = admission;
      if (evicted !== undefined) {
        const status = yield* terminate(evicted.session, evicted.slot.protocolVersion);
        const ok = status === 204 || status === 404;
        sessions.ended(evicted, ok);
        if (!ok) {
          sessions.settle(reservation, subject, undefined, undefined, 0);
          yield* Effect.logWarning(`mcp: an idle session could not be ended (status ${status}); a new session was refused`);
          return unavailable;
        }
        if (status === 204) {
          yield* Effect.logInfo(`mcp: ended an idle session to make room (${sessions.size()} sessions tracked)`);
        }
      }
      // McpServer sets a new session's id in a pre-response handler; ours is
      // appended after it and runs even when the response fails or the
      // client went away.
      return yield* handle.pipe(Effect.ensuring(settleOnResponse(reservation, subject)));
    });

    const serve = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
      principal: Principal,
      httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
    ) {
      const subject = principal.subject;
      const session = request.headers[MCP_SESSION_HEADER];
      const handle = Effect.provideService(httpEffect, CurrentPrincipal, principal);
      let initializes = false;
      if (request.method === "POST") {
        const body = yield* readBody(request);
        if (body._tag === "TooLarge") return payloadTooLarge;
        if (body._tag === "Read" && session === undefined) {
          initializes = mayInitialize(body.text);
          if (initializes && body.bytes > MAX_INITIALIZE_BODY_BYTES) return payloadTooLarge;
        }
      }
      if (session !== undefined) {
        const slot = sessions.use(session, subject, yield* Clock.currentTimeMillis);
        if (slot === undefined) return unknownSession;
        const response = yield* handle.pipe(
          Effect.ensuring(Effect.map(Clock.currentTimeMillis, (now) => sessions.done(slot, now))),
        );
        if (request.method === "DELETE" && response.status < 300) sessions.forget(session);
        return response;
      }
      if (request.method !== "POST") return yield* handle;
      // Uninterruptible from admission until the session id is recorded, so
      // every session McpServer creates is counted.
      if (initializes) return yield* Effect.uninterruptible(initialize(subject, handle));
      return yield* handle.pipe(Effect.ensuring(settleOnResponse(undefined, subject)));
    });

    return Effect.fnUntraced(function* (
      httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
    ) {
      if (yield* InternalRequest) return yield* httpEffect;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const principal = yield* Effect.result(auth.authenticate(request));
      if (Result.isFailure(principal)) {
        const failure = principal.failure;
        return failure._tag === "AuthUnavailable" ? unavailable : unauthorized(failure.challenge);
      }
      const subject = principal.success.subject;
      const running = inFlight.get(subject) ?? 0;
      if (running >= MAX_CONCURRENT_REQUESTS) return tooManyRequests;
      inFlight.set(subject, running + 1);
      return yield* serve(request, principal.success, httpEffect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const left = (inFlight.get(subject) ?? 1) - 1;
            if (left === 0) inFlight.delete(subject);
            else inFlight.set(subject, left);
          }),
        ),
      );
    });
  }),
);

/**
 * The router app: `app` (tool registrations and anything else that needs
 * `McpServer`) at /mcp, with /healthz and the guards. `auth` is built inside
 * it, so it may add routes of its own (those pass the Host allowlist but not
 * `Auth`). Usable with `HttpRouter.serve` or `HttpRouter.toWebHandler`.
 */
export const httpRouterApp = <A, E, R, EA, RA>(
  app: Layer.Layer<A, E, R>,
  auth: Layer.Layer<Auth, EA, RA>,
  info: ServerInfo,
  config: HttpTransportConfig,
) =>
  Layer.mergeAll(app, HealthRoute, guard(config.allowedHosts)).pipe(
    Layer.provideMerge(
      McpServer.layerHttp({
        ...info,
        path: MCP_PATH,
        allowedOrigins: config.allowedOrigins,
        allowSessionTermination: true,
      }).pipe(Layer.provide(mcpAuth.layer)),
    ),
    Layer.provide(auth),
  );

/**
 * Serves the router app on a Node HTTP server. All sessions share the
 * services `app` is built from.
 */
export const serveHttp = <A, E, R, EA, RA>(
  app: Layer.Layer<A, E, R>,
  auth: Layer.Layer<Auth, EA, RA>,
  info: ServerInfo,
  config: HttpTransportConfig,
) =>
  HttpRouter.serve(httpRouterApp(app, auth, info, config)).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: config.host, port: config.port })),
  );
