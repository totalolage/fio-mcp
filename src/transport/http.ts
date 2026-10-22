import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Result, Stream, type Types } from "effect";
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
/** Tracked MCP sessions; beyond this the oldest are forgotten (their clients re-initialize). */
const MAX_TRACKED_SESSIONS = 10_000;
/** Sessions per subject; a client that keeps initializing loses its own oldest, not others'. */
const MAX_SESSIONS_PER_SUBJECT = 32;

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
 * keeps the grant, so sessions survive refresh.
 */
const mcpAuth = HttpRouter.middleware(
  Effect.gen(function* () {
    const auth = yield* Auth;
    const owners = new Map<string, string>();
    const bind = (session: string, subject: string) => {
      owners.set(session, subject);
      const own = [...owners].filter(([, owner]) => owner === subject);
      for (const [oldest] of own.slice(0, Math.max(0, own.length - MAX_SESSIONS_PER_SUBJECT))) owners.delete(oldest);
      while (owners.size > MAX_TRACKED_SESSIONS) {
        const oldest = owners.keys().next();
        if (oldest.done === true) break;
        owners.delete(oldest.value);
      }
    };
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
      if (session !== undefined && owners.get(session) !== subject) return unknownSession;
      const response = yield* Effect.provideService(httpEffect, CurrentPrincipal, principal.success);
      if (session === undefined) {
        // McpServer sets a new session's id in a pre-response handler; this
        // one is appended after it, and runs before the client sees the id.
        yield* HttpEffect.appendPreResponseHandler((_request, final) =>
          Effect.sync(() => {
            const created = final.headers[MCP_SESSION_HEADER];
            if (created !== undefined) bind(created, subject);
            return final;
          }),
        );
      } else if (request.method === "DELETE" && response.status < 300) {
        owners.delete(session);
      }
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
