import { Context, Effect, Stream, type Types } from "effect";
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { IpNetwork } from "effect/net";
import { Redactor } from "../redaction.js";
import { makeUntrustedForwardingCheck } from "./client-address.js";
import { type FrameRedactor, makeFrameRedactor } from "./frame-redaction.js";

/**
 * The global middleware of every HTTP listener (the main one and the
 * optional admin listener): the Host allowlist and response redaction.
 */

export const HEALTH_PATH = "/healthz";

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

const forbidden = HttpServerResponse.empty({ status: 403 });

/**
 * Set on requests the HTTP transport dispatches itself (ending a session
 * through McpServer's DELETE handling); they skip the Host allowlist and
 * `Auth`. Only transport/http.ts sets it.
 */
export const InternalRequest = Context.Reference<boolean>("mcps/transport/http/InternalRequest", {
  defaultValue: () => false,
});

/**
 * Every route: response redaction, and (except /healthz) the Host allowlist.
 * Paths are compared literally; any other spelling of /healthz is checked.
 * Also warns once per listener about X-Forwarded-For from an untrusted peer
 * (makeUntrustedForwardingCheck; `trustedProxiesSetting` names the app's
 * setting in that warning).
 */
export const guard = (
  allowedHosts: ReadonlyArray<string>,
  trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>,
  trustedProxiesSetting?: string,
) =>
  HttpRouter.middleware(
    Effect.gen(function* () {
      const frames = makeFrameRedactor(yield* Redactor);
      const checkForwarding = makeUntrustedForwardingCheck(trustedProxies, trustedProxiesSetting);
      return Effect.fnUntraced(function* (
        httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
      ) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const internal = yield* InternalRequest;
        yield* checkForwarding(request);
        if (!internal && pathOf(request.url) !== HEALTH_PATH && !isAllowedHost(allowedHosts, request.headers.host)) {
          return forbidden;
        }
        return redactResponse(frames, yield* httpEffect);
      });
    }),
    { global: true },
  );
