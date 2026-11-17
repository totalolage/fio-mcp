import { Context, Effect, Layer, Schedule } from "effect";
import { HttpRouter, type HttpServerRequest } from "effect/http";
import type { SqlClient } from "effect/sql";
import type { AdminPassword } from "../admin/password.js";
import type { OAuthApp } from "../oauth/app.js";
import { makeOAuthServer, type OAuthSettings } from "../oauth/server.js";
import type { Resources } from "../resources.js";
import type { AuthUnavailable, Unauthorized } from "./auth-errors.js";
import { LOCAL_PRINCIPAL, type Principal } from "./principal.js";

export { AuthUnavailable, Unauthorized } from "./auth-errors.js";

/**
 * Authentication for /mcp on the HTTP transport. The OAuth authorization
 * server (src/oauth) provides it in production (`oauth`), for the app it
 * is given (identity, scopes, consent words); `Open` lets every
 * request in, for deployments that opt out of authentication. An `Auth`
 * layer is built inside the HTTP router app, so it may also register its own
 * routes (`HttpRouter.add`); its `authenticate` answers 401 with its own
 * `WWW-Authenticate` challenge and returns the caller's principal for the
 * tool handlers. The app composes the layer it runs from its configuration.
 */

export interface AuthShape {
  readonly authenticate: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<Principal, Unauthorized | AuthUnavailable>;
}

export class Auth extends Context.Service<Auth, AuthShape>()("mcps/transport/Auth") {
  /** Everyone is let in with full access. */
  static readonly Open = Layer.succeed(
    Auth,
    Auth.of({ authenticate: () => Effect.succeed(LOCAL_PRINCIPAL) }),
  );

  /**
   * `Auth` backed by the authorization server for `app`, which also
   * registers its routes on the router and purges expired state hourly.
   * Consent offers the app's `Resources`.
   */
  static readonly oauth = (
    app: OAuthApp,
    settings: OAuthSettings,
  ): Layer.Layer<Auth, never, HttpRouter.HttpRouter | SqlClient.SqlClient | Resources | AdminPassword> =>
    Layer.effect(
      Auth,
      Effect.gen(function* () {
        const server = yield* makeOAuthServer(app, settings);
        const router = yield* HttpRouter.HttpRouter;
        for (const route of server.routes) yield* router.add(route.method, route.path, route.handler);
        yield* Effect.forkScoped(server.purge.pipe(Effect.ignore, Effect.repeat(Schedule.spaced("1 hour"))));
        return Auth.of({ authenticate: server.authenticate });
      }),
    );
}
