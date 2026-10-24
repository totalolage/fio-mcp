import { Context, Layer } from "effect";

/**
 * Who is calling a tool. The HTTP guard provides it per request on /mcp from
 * `Auth.authenticate`; stdio provides LOCAL_PRINCIPAL when tools register.
 * Tool handlers read it with `yield* CurrentPrincipal` and check scopes and
 * accounts (src/mcp/permissions.ts).
 *
 * A Reference, not a layer-provided service: `McpServer.toolkit` captures the
 * services present when tools are registered and lays them over each call,
 * so on HTTP a principal provided at registration would shadow the
 * per-request one. Left out of the HTTP layers, the handler sees the request
 * fiber's value. The default grants nothing, so a call that somehow misses
 * the guard is denied.
 */
export interface Principal {
  readonly subject: string;
  readonly scopes: "all" | ReadonlyArray<string>;
  /** Token fingerprints (Account.tokenFingerprint) of the granted accounts. */
  readonly accountFingerprints: "all" | ReadonlyArray<string>;
}

/** The stdio client (the user's own process) and the unauthenticated HTTP mode. */
export const LOCAL_PRINCIPAL: Principal = { subject: "local", scopes: "all", accountFingerprints: "all" };

/** No identity: every scope and account check fails. */
export const NO_PRINCIPAL: Principal = { subject: "none", scopes: [], accountFingerprints: [] };

export const CurrentPrincipal = Context.Reference<Principal>("fio-mcp/transport/CurrentPrincipal", {
  defaultValue: () => NO_PRINCIPAL,
});

/** For transports with one trusted local client (stdio): full access, provided at tool registration. */
export const LocalPrincipalLive = Layer.succeed(CurrentPrincipal, LOCAL_PRINCIPAL);
