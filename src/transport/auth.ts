import { Context, Effect, Layer, Schema } from "effect";
import type { HttpServerRequest } from "effect/http";
import { LOCAL_PRINCIPAL, type Principal } from "./principal.js";

/**
 * Authentication for /mcp on the HTTP transport. The OAuth authorization
 * server (src/oauth) provides it in production; `layerOpen` is the
 * FIO_MCP_ALLOW_UNAUTHENTICATED escape hatch. An `Auth` layer is built
 * inside the HTTP router app, so it may also register its own routes
 * (`HttpRouter.add`); its `authenticate` answers 401 with its own
 * `WWW-Authenticate` challenge and returns the caller's principal for the
 * tool handlers.
 */

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  /** `WWW-Authenticate` value for the 401 response. */
  challenge: Schema.String,
}) {}

/** The credentials could not be checked (storage failure); answered with 503. */
export class AuthUnavailable extends Schema.TaggedError<AuthUnavailable>()("AuthUnavailable", {}) {}

export interface AuthShape {
  readonly authenticate: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<Principal, Unauthorized | AuthUnavailable>;
}

export class Auth extends Context.Service<Auth, AuthShape>()("fio-mcp/transport/Auth") {
  /** Everyone is let in with full access (FIO_MCP_ALLOW_UNAUTHENTICATED=true). */
  static readonly layerOpen = Layer.succeed(
    Auth,
    Auth.of({ authenticate: () => Effect.succeed(LOCAL_PRINCIPAL) }),
  );
}
