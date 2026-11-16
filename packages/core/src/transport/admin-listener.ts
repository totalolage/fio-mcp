import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Scope } from "effect";
import { HttpRouter } from "effect/http";
import type { IpNetwork } from "effect/net";
import { guard } from "./guard.js";

/**
 * The optional admin listener (FIO_MCP_ADMIN_PORT): its own router with only
 * the admin routes and the guard middleware (Host allowlist, redaction), on
 * a second Node HTTP server. The admin layer's services (accounts, admin
 * password, database) come from the caller, so the main listener's tools
 * see every change made here.
 *
 * Built apart from the main listener: HttpRouter.serve takes its router from
 * the shared HttpRouter.layer through the current memo map (which already
 * holds the main router) and exports everything it built (its router
 * included). A fresh memo map and a layer that exports nothing keep the two
 * routers apart.
 */
export const serveAdminListener = <E, R>(
  admin: Layer.Layer<never, E, R>,
  listener: { readonly host: string; readonly port: number },
  config: { readonly allowedHosts: ReadonlyArray<string>; readonly trustedProxies: ReadonlyArray<IpNetwork.IpNetwork> },
) => {
  const served = HttpRouter.serve(Layer.merge(admin, guard(config.allowedHosts, config.trustedProxies))).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { host: listener.host, port: listener.port })),
  );
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const memoMap = yield* Layer.makeMemoMap;
      yield* Layer.buildWithMemoMap(served, memoMap, yield* Scope.Scope);
    }),
  );
};
