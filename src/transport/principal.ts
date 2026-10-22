import { Context } from "effect";

/**
 * Who is calling a tool. The HTTP guard provides it per request on /mcp from
 * `Auth.authenticate`; tool handlers read it with `yield* CurrentPrincipal`.
 * Nothing checks scopes or accounts yet.
 *
 * A Reference, not a layer-provided service: `McpServer.toolkit` captures the
 * services present when tools are registered and lays them over each call,
 * so a principal provided at registration would shadow the per-request one.
 * Left out of the layers, the handler sees the request fiber's value.
 */
export interface Principal {
  readonly subject: string;
  readonly scopes: "all" | ReadonlyArray<string>;
  readonly accounts: "all" | ReadonlyArray<string>;
}

/** The stdio client (the user's own process) and the open/static-bearer HTTP modes. */
export const LOCAL_PRINCIPAL: Principal = { subject: "local", scopes: "all", accounts: "all" };

export const CurrentPrincipal = Context.Reference<Principal>("fio-mcp/transport/CurrentPrincipal", {
  defaultValue: () => LOCAL_PRINCIPAL,
});
