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

/** A tracked MCP session: the subject (OAuth grant) that opened it and when it was last used. */
interface SessionOwner {
  readonly subject: string;
  lastSeen: number;
}

/**
 * Which subject owns which MCP session, with admission limits. McpServer
 * keeps HTTP sessions until a DELETE and offers no other way to end them, so
 * new sessions are refused at capacity instead of forgetting live ones; a
 * session idle for SESSION_IDLE_MS gives up its slot (it then answers 404).
 */
const makeSessionOwners = () => {
  const owners = new Map<string, SessionOwner>();
  const pending = new Map<string, number>();
  let pendingTotal = 0;

  const countOf = (subject: string) => {
    let count = pending.get(subject) ?? 0;
    for (const owner of owners.values()) if (owner.subject === subject) count++;
    return count;
  };

  /** The longest-idle session (of `subject`, or of anyone) idle beyond SESSION_IDLE_MS. */
  const idlest = (now: number, subject?: string) => {
    let found: [string, SessionOwner] | undefined;
    for (const entry of owners) {
      const [, owner] = entry;
      if (subject !== undefined && owner.subject !== subject) continue;
      if (owner.lastSeen > now - SESSION_IDLE_MS) continue;
      if (found === undefined || owner.lastSeen < found[1].lastSeen) found = entry;
    }
    return found?.[0];
  };

  /** Reserves room for one new session; "subject" or "global" when full. */
  const admit = (subject: string, now: number): "ok" | "subject" | "global" => {
    if (countOf(subject) >= MAX_SESSIONS_PER_SUBJECT) {
      const idle = idlest(now, subject);
      if (idle === undefined) return "subject";
      owners.delete(idle);
    }
    if (owners.size + pendingTotal >= MAX_TRACKED_SESSIONS) {
      const idle = idlest(now);
      if (idle === undefined) return "global";
      owners.delete(idle);
    }
    pending.set(subject, (pending.get(subject) ?? 0) + 1);
    pendingTotal++;
    return "ok";
  };

  const release = (subject: string) => {
    const left = (pending.get(subject) ?? 1) - 1;
    if (left <= 0) pending.delete(subject);
    else pending.set(subject, left);
    pendingTotal = Math.max(0, pendingTotal - 1);
  };

  /** Whether `session` belongs to `subject`; marks it used. */
  const owns = (session: string, subject: string, now: number) => {
    const owner = owners.get(session);
    if (owner === undefined || owner.subject !== subject) return false;
    owner.lastSeen = now;
    return true;
  };

  const bind = (session: string, subject: string, now: number) => owners.set(session, { subject, lastSeen: now });
  const forget = (session: string) => owners.delete(session);

  return { admit, release, owns, bind, forget };
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
      const admission = sessions.admit(subject, now);
      if (admission !== "ok") return admission === "subject" ? tooManySessions : unavailable;
      let released = false;
      const release = () => {
        if (!released) sessions.release(subject);
        released = true;
      };
      // McpServer sets a new session's id in a pre-response handler; this
      // one is appended after it, and runs before the client sees the id.
      return yield* handle.pipe(
        Effect.tap(() =>
          HttpEffect.appendPreResponseHandler((_request, final) =>
            Effect.sync(() => {
              const created = final.headers[MCP_SESSION_HEADER];
              if (created !== undefined) sessions.bind(created, subject, now);
              release();
              return final;
            }),
          ),
        ),
        Effect.ensuring(Effect.sync(release)),
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
