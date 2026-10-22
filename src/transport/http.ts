import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Clock, Effect, Layer, Result, Stream, type Types } from "effect";
import { McpServer } from "effect/ai";
import { HttpBody, HttpEffect, HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { TransportConfig } from "../config.js";
import { Redactor } from "../redaction.js";
import { Auth } from "./auth.js";
import { type FrameRedactor, makeFrameRedactor } from "./frame-redaction.js";
import { CurrentPrincipal } from "./principal.js";
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

const MCP_SESSION_HEADER = "mcp-session-id";
/** Tracked MCP sessions across all subjects. */
const MAX_TRACKED_SESSIONS = 10_000;
/** Sessions one subject (OAuth grant) may hold. */
export const MAX_SESSIONS_PER_SUBJECT = 32;
/** A session unused this long gives up its slot when its subject or the server is at capacity. */
export const SESSION_IDLE_MS = 60 * 60_000;

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
        if (pathOf(request.url) !== HEALTH_PATH && !isAllowedHost(allowedHosts, request.headers.host)) {
          return forbidden;
        }
        return redactResponse(frames, yield* httpEffect);
      });
    }),
    { global: true },
  );

/** A session slot: the subject (OAuth grant) holding it and when it was last used. */
interface Slot {
  readonly subject: string;
  lastSeen: number;
}

/**
 * Which subject owns which MCP session, with admission limits. McpServer
 * keeps HTTP sessions until a DELETE and offers no other way to end them, so
 * new sessions are refused at capacity instead of forgetting live ones. A
 * slot is reserved before an initialization is dispatched and becomes the
 * session's once its id is known; a reservation whose response never went
 * out keeps its slot (a session may exist). A slot unused for
 * SESSION_IDLE_MS is given up when its subject or the server needs room (its
 * session then answers 404).
 */
const makeSessionOwners = () => {
  const sessions = new Map<string, Slot>();
  const reservations = new Map<number, Slot>();
  let nextReservation = 0;

  const countOf = (subject: string) => {
    let count = 0;
    for (const slot of sessions.values()) if (slot.subject === subject) count++;
    for (const slot of reservations.values()) if (slot.subject === subject) count++;
    return count;
  };

  /** Frees the longest-idle slot (of `subject`, or of anyone) idle beyond SESSION_IDLE_MS. */
  const reclaimIdle = (now: number, subject?: string): boolean => {
    let found: { readonly map: Map<string, Slot> | Map<number, Slot>; readonly key: string | number; readonly slot: Slot } | undefined;
    const consider = (map: Map<string, Slot> | Map<number, Slot>, key: string | number, slot: Slot) => {
      if (subject !== undefined && slot.subject !== subject) return;
      if (slot.lastSeen > now - SESSION_IDLE_MS) return;
      if (found === undefined || slot.lastSeen < found.slot.lastSeen) found = { map, key, slot };
    };
    for (const [key, slot] of sessions) consider(sessions, key, slot);
    for (const [key, slot] of reservations) consider(reservations, key, slot);
    if (found === undefined) return false;
    if (typeof found.key === "string") sessions.delete(found.key);
    else reservations.delete(found.key);
    return true;
  };

  /** A reservation for one new session, or which limit is reached. */
  const admit = (subject: string, now: number): number | "subject" | "global" => {
    if (countOf(subject) >= MAX_SESSIONS_PER_SUBJECT && !reclaimIdle(now, subject)) return "subject";
    if (sessions.size + reservations.size >= MAX_TRACKED_SESSIONS && !reclaimIdle(now)) return "global";
    const id = nextReservation++;
    reservations.set(id, { subject, lastSeen: now });
    return id;
  };

  /** The response for a reservation went out: it becomes `session`'s slot, or is freed when none was created. */
  const settle = (reservation: number, session: string | undefined, now: number) => {
    const slot = reservations.get(reservation);
    reservations.delete(reservation);
    if (slot !== undefined && session !== undefined) sessions.set(session, { subject: slot.subject, lastSeen: now });
  };

  /** Whether `session` belongs to `subject`; marks it used. */
  const owns = (session: string, subject: string, now: number) => {
    const slot = sessions.get(session);
    if (slot === undefined || slot.subject !== subject) return false;
    slot.lastSeen = now;
    return true;
  };

  const forget = (session: string) => sessions.delete(session);

  return { admit, settle, owns, forget };
};

const tooManySessions = HttpServerResponse.empty({ status: 429, headers: { "retry-after": "60" } });

/**
 * Authentication for every route McpServer registers. Route middleware, not
 * a path comparison: the router also matches /MCP, /mcp/, //mcp and
 * percent-encoded spellings. The principal reaches tool handlers as
 * `CurrentPrincipal`.
 *
 * MCP sessions are bound to the principal's subject (the OAuth grant) that
 * initialized them. McpServer finds sessions by id alone, so a session id
 * presented by another grant, or one no longer tracked, is answered 404 like
 * an unknown session and the client starts a new one. Refreshing tokens
 * keeps the grant, so sessions survive refresh. A grant may hold
 * MAX_SESSIONS_PER_SUBJECT sessions; beyond that, initialization is refused
 * (429) unless one of its sessions has been idle for SESSION_IDLE_MS.
 */
const mcpAuth = HttpRouter.middleware(
  Effect.gen(function* () {
    const auth = yield* Auth;
    const sessions = makeSessionOwners();
    return Effect.fnUntraced(function* (
      httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const principal = yield* Effect.result(auth.authenticate(request));
      if (Result.isFailure(principal)) {
        const failure = principal.failure;
        return failure._tag === "AuthUnavailable" ? unavailable : unauthorized(failure.challenge);
      }
      const subject = principal.success.subject;
      const session = request.headers[MCP_SESSION_HEADER];
      const now = yield* Clock.currentTimeMillis;
      const handle = Effect.provideService(httpEffect, CurrentPrincipal, principal.success);
      if (session !== undefined) {
        if (!sessions.owns(session, subject, now)) return unknownSession;
        const response = yield* handle;
        if (request.method === "DELETE" && response.status < 300) sessions.forget(session);
        return response;
      }
      if (request.method !== "POST") return yield* handle;
      // A POST without a session id may initialize one: reserve its slot first.
      const reservation = sessions.admit(subject, now);
      if (reservation === "subject") return tooManySessions;
      if (reservation === "global") return unavailable;
      const response = yield* handle;
      // McpServer sets a new session's id in a pre-response handler; this
      // one is appended after it, and runs before the client sees the id.
      // Without a response (interrupted), the reservation keeps its slot.
      yield* HttpEffect.appendPreResponseHandler((_request, final) =>
        Effect.map(Clock.currentTimeMillis, (sent) => {
          sessions.settle(reservation, final.headers[MCP_SESSION_HEADER], sent);
          return final;
        }),
      );
      return response;
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
