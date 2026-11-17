import { Context, Layer } from "effect";

/**
 * Who is calling a tool. The HTTP guard provides it per request on /mcp from
 * `Auth.authenticate`; stdio provides LOCAL_PRINCIPAL when tools register.
 * Tool handlers read it with `yield* CurrentPrincipal` and check scopes and
 * resources (src/mcp/grants.ts).
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
  /** Ids (Resource.id) of the granted resources. */
  readonly resources: "all" | ReadonlyArray<string>;
  /** The OAuth client behind the grant; absent for local and unauthenticated callers. */
  readonly clientId?: string | undefined;
  /**
   * The grant's app settings (OAuthApp.grantSettings, as decoded); absent
   * for local and unauthenticated callers, whom the app gives its defaults.
   */
  readonly settings?: unknown;
}

/** The stdio client (the user's own process) and the unauthenticated HTTP mode. */
export const LOCAL_PRINCIPAL: Principal = { subject: "local", scopes: "all", resources: "all" };

/** No identity: every scope and resource check fails. */
export const NO_PRINCIPAL: Principal = { subject: "none", scopes: [], resources: [] };

export const CurrentPrincipal = Context.Reference<Principal>("mcps/transport/CurrentPrincipal", {
  defaultValue: () => NO_PRINCIPAL,
});

/** For transports with one trusted local client (stdio): full access, provided at tool registration. */
export const LocalPrincipalLive = Layer.succeed(CurrentPrincipal, LOCAL_PRINCIPAL);
