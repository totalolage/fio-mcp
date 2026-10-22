import { createHash, timingSafeEqual } from "node:crypto";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import type { HttpServerRequest } from "effect/http";
import { LOCAL_PRINCIPAL, type Principal } from "./principal.js";

/**
 * Authentication for /mcp on the HTTP transport. One implementation today:
 * an optional static bearer token. An OAuth authorization server replaces it
 * by providing another `Auth` layer: that layer is built inside the HTTP
 * router app, so it may also register its own routes (`HttpRouter.add`), and
 * its `authenticate` answers 401 with its own `WWW-Authenticate` challenge
 * and returns the caller's principal for the tool handlers.
 */

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  /** `WWW-Authenticate` value for the 401 response. */
  challenge: Schema.String,
}) {}

export interface AuthShape {
  readonly authenticate: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Principal, Unauthorized>;
}

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Accepts `Authorization: Bearer <token>`. Both sides are hashed first so the
 * comparison takes the same time whatever the presented length.
 */
export function makeBearerAuth(token: Redacted.Redacted<string>): AuthShape {
  const expected = digest(Redacted.value(token));
  return {
    authenticate: (request) => {
      const presented = BEARER.exec(request.headers.authorization ?? "")?.[1];
      if (presented === undefined) return Effect.fail(new Unauthorized({ challenge: "Bearer" }));
      return timingSafeEqual(digest(presented), expected)
        ? Effect.succeed(LOCAL_PRINCIPAL)
        : Effect.fail(new Unauthorized({ challenge: 'Bearer error="invalid_token"' }));
    },
  };
}

export class Auth extends Context.Service<Auth, AuthShape>()("fio-mcp/transport/Auth") {
  /** Everyone is let in: no token configured. */
  static readonly layerOpen = Layer.succeed(Auth, Auth.of({ authenticate: () => Effect.succeed(LOCAL_PRINCIPAL) }));

  static readonly layerBearer = (token: Redacted.Redacted<string>) => Layer.succeed(Auth, makeBearerAuth(token));

  /** Bearer auth when a token is configured, open otherwise. */
  static readonly layerFrom = (token: Redacted.Redacted<string> | undefined) =>
    token === undefined ? Auth.layerOpen : Auth.layerBearer(token);
}
