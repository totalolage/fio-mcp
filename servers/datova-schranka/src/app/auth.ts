import { AdminPassword, settingsPasswordStore } from "@mcps/core/admin/password.js";
import { AdminLive } from "@mcps/core/admin/server.js";
import type { AdminApp, AdminTab } from "@mcps/core/admin/tab.js";
import type { OAuthSettings } from "@mcps/core/oauth/server.js";
import { makeServerSettings } from "@mcps/core/server-settings.js";
import { serveAdminListener } from "@mcps/core/transport/admin-listener.js";
import { Auth } from "@mcps/core/transport/auth.js";
import { Effect, Layer } from "effect";
import { AppConfig } from "../config.js";
import { storeFailure } from "../domain/errors.js";
import { makeOAuthApp } from "../oauth/app.js";
import { APP_IDENTITY } from "../oauth/identity.js";

/**
 * Authentication for /mcp and the admin UI: core's OAuth authorization
 * server for the datova-schranka OAuthApp, with /admin on the main listener
 * or, with DATOVA_SCHRANKA_ADMIN_PORT, on its own. There is no
 * unauthenticated mode (every /mcp request needs an OAuth token).
 */

/** Names the trusted-proxy setting in core's X-Forwarded-For warning. */
export const TRUSTED_PROXIES_SETTING = "DATOVA_SCHRANKA_TRUSTED_PROXIES";

export const TRUSTED_PROXIES_EMPTY_WARNING =
  "DATOVA_SCHRANKA_TRUSTED_PROXIES is empty: if datova-schranka runs behind a reverse proxy, all clients share one sign-in throttle.";

/** datova-schranka's admin app: core's sign-in, clients and password tabs, named for datova-schranka. */
export const ADMIN_APP: AdminApp = {
  identity: APP_IDENTITY,
  resourcesHeading: "Data boxes",
  passwordHashSource: "DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE",
};

/**
 * The admin password: the hash file's, until one is set at /admin (stored
 * as the `admin_password_hash` server setting); with
 * DATOVA_SCHRANKA_ADMIN_TOTP_SECRET_FILE sign-in also asks for the
 * authenticator code. One instance serves the sign-in pages and /admin on
 * either listener (one throttle, one replay memory).
 */
export const AdminPasswordLive = Layer.unwrap(
  Effect.gen(function* () {
    const { oauth } = yield* AppConfig;
    return AdminPassword.layer(Effect.map(makeServerSettings(storeFailure), settingsPasswordStore), {
      app: APP_IDENTITY,
      bootstrap: oauth.passwordHash,
      totpSecret: oauth.totpSecret,
    });
  }),
);

/**
 * Core's `Auth.oauth` for the datova-schranka OAuthApp, after the startup
 * diagnostics (an empty DATOVA_SCHRANKA_TRUSTED_PROXIES, and how many
 * networks DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS admits). The OAuthApp's
 * AuditLog is the app's, on the database the OAuth store uses, so the
 * consent row joins the grant's transaction.
 */
export const oauthLive = (settings: OAuthSettings) =>
  Layer.unwrap(Effect.map(makeOAuthApp, (app) => Auth.oauth(app, settings))).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.gen(function* () {
          if ((settings.trustedProxies ?? []).length === 0) yield* Effect.logWarning(TRUSTED_PROXIES_EMPTY_WARNING);
          const allowed = (settings.allowedNetworks ?? []).length;
          if (allowed > 0) {
            yield* Effect.logInfo(
              `DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS: /admin and the sign-in pages accept ${allowed} network(s)`,
            );
          }
        }),
      ),
    ),
  );

/**
 * /mcp authentication with the admin UI, from configuration: `tabs` follow
 * core's built-in tabs. Leaves `HttpRouter` open, since the HTTP transport
 * provides it, and takes the database, AdminPassword (AdminPasswordLive),
 * Resources and the tabs' services from the app. With
 * DATOVA_SCHRANKA_ADMIN_PORT /admin gets its own listener instead of routes
 * on this router. DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS limits /admin and the
 * sign-in pages (/authorize, /login, /consent) to those networks.
 */
export const authLive = <R>(tabs: Effect.Effect<ReadonlyArray<AdminTab>, never, R>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { http, oauth } = yield* AppConfig;
      const { trustedProxies, adminListener } = http;
      const allowedNetworks = http.adminAllowedNetworks;
      const admin = AdminLive({ publicUrl: oauth.publicUrl, trustedProxies, allowedNetworks }, ADMIN_APP, tabs);
      return Layer.mergeAll(
        oauthLive({ publicUrl: oauth.publicUrl, trustedProxies, allowedNetworks }),
        adminListener === undefined
          ? admin
          : serveAdminListener(admin, adminListener, { ...http, trustedProxiesSetting: TRUSTED_PROXIES_SETTING }),
      );
    }),
  );
