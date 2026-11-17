import type { OAuthSettings } from "@mcps/core/oauth/server.js";
import { serveAdminListener } from "@mcps/core/transport/admin-listener.js";
import { Auth } from "@mcps/core/transport/auth.js";
import { Effect, Layer, Schedule } from "effect";
import { Accounts } from "../accounts.js";
import { AdminLive, adminPasswordLayer } from "../admin/live.js";
import { Database } from "../cache/db.js";
import { Transactions } from "../cache/service.js";
import { AppConfig } from "../config.js";
import { FioApi } from "../fio-api.js";
import { fioOAuthApp } from "../oauth/app.js";
import { PaymentControls } from "../payment-controls.js";

/**
 * Authentication for /mcp on the HTTP transport, from configuration. The
 * OAuth authorization server provides `Auth` in production; `Auth.Open` is
 * the FIO_MCP_ALLOW_UNAUTHENTICATED escape hatch.
 */

/** Names the trusted-proxy setting in core's X-Forwarded-For warning. */
export const TRUSTED_PROXIES_SETTING = "FIO_MCP_TRUSTED_PROXIES";

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

/**
 * fio-mcp's authorization server: core's `Auth.oauth` for the Fio app (its
 * consent checks payment settings against the configured ceilings, so it
 * needs AppConfig), after the startup diagnostics (an empty
 * FIO_MCP_TRUSTED_PROXIES, and how many networks FIO_MCP_ADMIN_ALLOWED_CIDRS
 * admits).
 */
export const fioOAuth = (settings: OAuthSettings) =>
  Layer.unwrap(
    Effect.map(Effect.service(AppConfig), (config) => Auth.oauth(fioOAuthApp(config.paymentLimits), settings)),
  ).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.gen(function* () {
          if ((settings.trustedProxies ?? []).length === 0) yield* Effect.logWarning(TRUSTED_PROXIES_EMPTY_WARNING);
          const allowed = (settings.allowedNetworks ?? []).length;
          if (allowed > 0) {
            yield* Effect.logInfo(`FIO_MCP_ADMIN_ALLOWED_CIDRS: /admin and the sign-in pages accept ${allowed} network(s)`);
          }
        }),
      ),
    ),
  );

/**
 * /mcp authentication from configuration: the OAuth server with the admin
 * UI (/admin) on the server's database, or `Auth.Open` with a startup
 * warning and no admin UI. Leaves `HttpRouter` open, since the HTTP
 * transport provides it. With FIO_MCP_ADMIN_PORT the admin UI gets its own
 * listener instead of routes on this router; both share one AdminPassword
 * (throttling, replay memory) and the same accounts and database.
 */
export const authFromConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { transport } = yield* AppConfig;
    if (transport.kind === "http" && transport.auth.kind === "oauth") {
      const { publicUrl, passwordHash, dataKey, totpSecret } = transport.auth;
      const { trustedProxies, adminListener } = transport;
      const allowedNetworks = transport.adminAllowedNetworks ?? [];
      const admin = AdminLive({ publicUrl, dataKey, trustedProxies, allowedNetworks });
      return Layer.mergeAll(
        fioOAuth({ publicUrl, trustedProxies, allowedNetworks }),
        adminListener === undefined
          ? admin
          : serveAdminListener(admin, adminListener, { ...transport, trustedProxiesSetting: TRUSTED_PROXIES_SETTING }),
      ).pipe(
        Layer.provide(adminPasswordLayer(passwordHash, undefined, undefined, totpSecret)),
        Layer.provide(Accounts.resources),
        Layer.provide(Layer.mergeAll(Database.Live, Accounts.Live, FioApi.Live, Transactions.Live, PaymentControls.Live)),
      );
    }
    const onNetwork = transport.kind === "http" && transport.auth.kind === "unauthenticated" && transport.auth.onNetwork === true;
    return Layer.merge(Auth.Open, unauthenticatedWarning(onNetwork));
  }),
).pipe(Layer.provide(AppConfig.Live));
