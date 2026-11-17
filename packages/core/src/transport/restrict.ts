import { Effect, type Types } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { IpNetwork } from "effect/net";
import { clientIp } from "./client-address.js";

/**
 * The network allowlist for the admin UI and the OAuth sign-in pages (an
 * app setting). A request whose client address
 * (clientAddress rules, so trusted proxies apply) is outside the list is
 * answered 404 without a body, as if the route did not exist. An empty list
 * restricts nothing.
 *
 * Attached to routes (a handler wrapper or route middleware), never compared
 * against the raw URL: the router also matches /ADMIN, //admin and
 * percent-encoded spellings.
 */

export interface Restriction {
  /** Networks allowed in; empty allows everyone. */
  readonly allowedNetworks: ReadonlyArray<IpNetwork.IpNetwork>;
  /** Proxies whose X-Forwarded-For names the client address. */
  readonly trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>;
}

export const restrictedResponse = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } });

/** Whether `request` comes from an allowed client. Unknown addresses are refused. */
export const isAllowedClient = (restriction: Restriction, request: HttpServerRequest.HttpServerRequest): boolean => {
  if (restriction.allowedNetworks.length === 0) return true;
  const ip = clientIp(request, restriction.trustedProxies);
  return ip !== undefined && restriction.allowedNetworks.some((network) => IpNetwork.contains(network, ip));
};

/** Wraps one route handler: 404 for clients outside the allowlist. */
export const restrictTo =
  (restriction: Restriction) =>
  <E, R>(
    handler: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) =>
  (request: HttpServerRequest.HttpServerRequest): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
    isAllowedClient(restriction, request) ? handler(request) : Effect.succeed(restrictedResponse());

/**
 * Route middleware with the same rule: provided to a layer, it covers every
 * route that layer adds to the router.
 */
export const restrictRoutes = (restriction: Restriction) =>
  HttpRouter.middleware(
    Effect.fnUntraced(function* (httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return isAllowedClient(restriction, request) ? yield* httpEffect : restrictedResponse();
    }),
  );
