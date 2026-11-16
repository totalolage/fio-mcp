import { Effect, Option, Result } from "effect";
import type { HttpServerRequest } from "effect/http";
import { IpNetwork, NetAddress } from "effect/net";

/**
 * The client address used to throttle logins and authorization requests.
 *
 * Without trusted proxies (FIO_MCP_TRUSTED_PROXIES empty) it is the socket
 * peer and forwarding headers are ignored. When the peer is a trusted proxy,
 * X-Forwarded-For is walked from the right past trusted proxies; the first
 * address that is not one is the client (entries further left were written
 * by the client and are ignored). An entry that is not an IP address stops
 * the walk, and the peer is used. Forwarding headers never affect URLs,
 * the issuer or the resource.
 */

export const UNKNOWN_ADDRESS = "unknown";

/** An IP address, bracketed IPv6, or address:port; IPv4-mapped IPv6 becomes IPv4. */
const parseAddress = (input: string): NetAddress.IpAddress | undefined => {
  const bare = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  const ip = NetAddress.ipFromString(bare);
  if (Result.isSuccess(ip)) return NetAddress.toCanonical(ip.success);
  const inet = NetAddress.inetAddressFromString(input);
  return Result.isSuccess(inet) ? NetAddress.toCanonical(inet.success.address) : undefined;
};

/**
 * A FIO_MCP_TRUSTED_PROXIES entry: an IP address or a CIDR network.
 * IPv4-mapped IPv6 networks are refused (peers are matched as IPv4, so they
 * would never match); write them as IPv4.
 */
export const parseTrustedProxy = (entry: string): IpNetwork.IpNetwork | undefined => {
  if (entry.includes("/")) {
    const network = Result.getOrUndefined(IpNetwork.fromString(entry));
    const address = network?.address;
    return address !== undefined && NetAddress.isIpv6Address(address) && NetAddress.isIpv4Mapped(address) ? undefined : network;
  }
  const address = parseAddress(entry);
  return address === undefined ? undefined : Result.getOrUndefined(IpNetwork.fromAddress(address, NetAddress.width(address)));
};

/**
 * The client's IP address (see the module comment), or undefined when the
 * socket peer is unknown.
 */
export const clientIp = (
  request: HttpServerRequest.HttpServerRequest,
  trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>,
): NetAddress.IpAddress | undefined => {
  // The socket peer: nothing in this server overrides remoteAddress (no
  // HttpMiddleware.xForwardedHeaders), so it is not taken from a header.
  const peer = Option.getOrUndefined(Option.map(request.remoteAddress, parseAddress));
  if (peer === undefined) return undefined;
  const isTrusted = (address: NetAddress.IpAddress) => trustedProxies.some((network) => IpNetwork.contains(network, address));
  if (!isTrusted(peer)) return peer;
  const forwarded = (request.headers["x-forwarded-for"] ?? "").split(",").map((entry) => entry.trim());
  if (forwarded.length === 1 && forwarded[0] === "") return peer;
  for (let index = forwarded.length - 1; index >= 0; index--) {
    const address = parseAddress(forwarded[index] ?? "");
    if (address === undefined) break;
    // Every hop trusted: the leftmost is the best guess.
    if (index > 0 && isTrusted(address)) continue;
    return address;
  }
  return peer;
};

export const clientAddress = (
  request: HttpServerRequest.HttpServerRequest,
  trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>,
): string => {
  const ip = clientIp(request, trustedProxies);
  return ip === undefined ? UNKNOWN_ADDRESS : NetAddress.formatIp(ip);
};

export const UNTRUSTED_FORWARDING_WARNING =
  "X-Forwarded-For received from an untrusted peer; set FIO_MCP_TRUSTED_PROXIES to the proxy's address.";

/**
 * A check that logs UNTRUSTED_FORWARDING_WARNING the first time a request
 * carries X-Forwarded-For from a socket peer outside `trustedProxies` (a
 * reverse proxy that is not configured as trusted, so every client shares
 * its address for sign-in throttling). It warns once per check; no address
 * is logged. Each HTTP listener makes one.
 */
export const makeUntrustedForwardingCheck = (
  trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>,
): ((request: HttpServerRequest.HttpServerRequest) => Effect.Effect<void>) => {
  let warned = false;
  return (request) =>
    Effect.suspend(() => {
      if (warned || request.headers["x-forwarded-for"] === undefined) return Effect.void;
      const peer = Option.getOrUndefined(Option.map(request.remoteAddress, parseAddress));
      if (peer !== undefined && trustedProxies.some((network) => IpNetwork.contains(network, peer))) return Effect.void;
      warned = true;
      return Effect.logWarning(UNTRUSTED_FORWARDING_WARNING);
    });
};
