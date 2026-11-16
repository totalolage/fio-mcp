import { Context, Effect, Layer, Schedule } from "effect";
import { HttpRouter, type HttpServerRequest } from "effect/http";
import type { SqlClient } from "effect/sql";
import { Accounts } from "../accounts.js";
import { AdminPassword } from "../admin/password.js";
import { AdminLive } from "../admin/server.js";
import { Database } from "../cache/db.js";
import { Transactions } from "../cache/service.js";
import { AppConfig } from "../config.js";
import { FioApi } from "../fio-api.js";
import { makeOAuthServer, type OAuthSettings } from "../oauth/server.js";
import { serveAdminListener } from "./admin-listener.js";
import type { AuthUnavailable, Unauthorized } from "./auth-errors.js";
import { LOCAL_PRINCIPAL, type Principal } from "./principal.js";

export { AuthUnavailable, Unauthorized } from "./auth-errors.js";

/**
 * Authentication for /mcp on the HTTP transport. The OAuth authorization
 * server (src/oauth) provides it in production (`oauth`); `Open` is the
 * FIO_MCP_ALLOW_UNAUTHENTICATED escape hatch. An `Auth` layer is built
 * inside the HTTP router app, so it may also register its own routes
 * (`HttpRouter.add`); its `authenticate` answers 401 with its own
 * `WWW-Authenticate` challenge and returns the caller's principal for the
 * tool handlers.
 */

export interface AuthShape {
  readonly authenticate: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<Principal, Unauthorized | AuthUnavailable>;
}

export const UNAUTHENTICATED_WARNING =
  "SECURITY WARNING: FIO_MCP_ALLOW_UNAUTHENTICATED=true. /mcp accepts every request without authentication and gives it full access to every account, including payment orders. Anyone who can reach this port can use your bank tools. Set FIO_MCP_PUBLIC_URL and FIO_MCP_ADMIN_PASSWORD_HASH_FILE to require OAuth.";

export const TRUSTED_PROXIES_EMPTY_WARNING =
  "FIO_MCP_TRUSTED_PROXIES is empty: if fio-mcp runs behind a reverse proxy, all clients share one sign-in throttle.";

/** How often the unauthenticated warning repeats with FIO_MCP_ALLOW_UNAUTHENTICATED_ON_NETWORK. */
export const UNAUTHENTICATED_WARNING_INTERVAL = "10 minutes";

/**
 * The unauthenticated-mode warning at startup; on a network bind address
 * (FIO_MCP_ALLOW_UNAUTHENTICATED_ON_NETWORK) it repeats every 10 minutes
 * while the server runs.
 */
export const unauthenticatedWarning = (onNetwork: boolean): Layer.Layer<never> =>
  Layer.effectDiscard(
    onNetwork
      ? Effect.forkScoped(
          Effect.logWarning(UNAUTHENTICATED_WARNING).pipe(Effect.repeat(Schedule.spaced(UNAUTHENTICATED_WARNING_INTERVAL))),
        )
      : Effect.logWarning(UNAUTHENTICATED_WARNING),
  );

export class Auth extends Context.Service<Auth, AuthShape>()("fio-mcp/transport/Auth") {
  /** Everyone is let in with full access (FIO_MCP_ALLOW_UNAUTHENTICATED=true). */
  static readonly Open = Layer.succeed(
    Auth,
    Auth.of({ authenticate: () => Effect.succeed(LOCAL_PRINCIPAL) }),
  );

  /**
   * `Auth` backed by the authorization server, which also registers its
   * routes on the router and purges expired state hourly.
   */
  static readonly oauth = (
    settings: OAuthSettings,
  ): Layer.Layer<Auth, never, HttpRouter.HttpRouter | SqlClient.SqlClient | Accounts | AdminPassword> =>
    Layer.effect(
      Auth,
      Effect.gen(function* () {
        if ((settings.trustedProxies ?? []).length === 0) yield* Effect.logWarning(TRUSTED_PROXIES_EMPTY_WARNING);
        const allowed = (settings.allowedNetworks ?? []).length;
        if (allowed > 0) {
          yield* Effect.logInfo(`FIO_MCP_ADMIN_ALLOWED_CIDRS: /admin and the sign-in pages accept ${allowed} network(s)`);
        }
        const server = yield* makeOAuthServer(settings);
        const router = yield* HttpRouter.HttpRouter;
        for (const route of server.routes) yield* router.add(route.method, route.path, route.handler);
        yield* Effect.forkScoped(server.purge.pipe(Effect.ignore, Effect.repeat(Schedule.spaced("1 hour"))));
        return Auth.of({ authenticate: server.authenticate });
      }),
    );

  /**
   * /mcp authentication from configuration: the OAuth server with the
   * admin UI (/admin) on the server's database, or `Open` with a startup
   * warning and no admin UI. Leaves `HttpRouter` open, since the HTTP
   * transport provides it. With FIO_MCP_ADMIN_PORT the admin UI gets its
   * own listener instead of routes on this router; both share one
   * AdminPassword (throttling, replay memory) and the same accounts and
   * database.
   */
  static readonly Live = Layer.unwrap(
    Effect.gen(function* () {
      const { transport } = yield* AppConfig;
      if (transport.kind === "http" && transport.auth.kind === "oauth") {
        const { publicUrl, passwordHash, dataKey } = transport.auth;
        const { trustedProxies, adminListener } = transport;
        const allowedNetworks = transport.adminAllowedNetworks ?? [];
        const admin = AdminLive({ publicUrl, dataKey, trustedProxies, allowedNetworks });
        return Layer.mergeAll(
          Auth.oauth({ publicUrl, trustedProxies, allowedNetworks }),
          adminListener === undefined ? admin : serveAdminListener(admin, adminListener, transport),
        ).pipe(
          Layer.provide(AdminPassword.layer(passwordHash)),
          Layer.provide(Layer.mergeAll(Database.Live, Accounts.Live, FioApi.Live, Transactions.Live)),
        );
      }
      const onNetwork = transport.kind === "http" && transport.auth.kind === "unauthenticated" && transport.auth.onNetwork === true;
      return Layer.merge(Auth.Open, unauthenticatedWarning(onNetwork));
    }),
  ).pipe(Layer.provide(AppConfig.Live));
}
