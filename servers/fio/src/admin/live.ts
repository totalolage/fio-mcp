import {
  AdminPassword,
  makeAdminPassword as makeCoreAdminPassword,
  type PasswordStore,
} from "@mcps/core/admin/password.js";
import { type AdminSettings, AdminLive as CoreAdminLive } from "@mcps/core/admin/server.js";
import type { AdminApp } from "@mcps/core/admin/tab.js";
import type { PasswordHash, ScryptParams } from "@mcps/core/oauth/crypto.js";
import type { ThrottlePolicy } from "@mcps/core/oauth/login.js";
import { makeOAuthStore } from "@mcps/core/oauth/store.js";
import { Effect, Layer, type Redacted } from "effect";
import type { HttpRouter } from "effect/http";
import type { SqlClient } from "effect/sql";
import { makeSettingsStore, SETTING } from "../account-store.js";
import { Accounts } from "../accounts.js";
import type { Transactions } from "../cache/service.js";
import { AppConfig } from "../config.js";
import type { FioApi } from "../fio-api.js";
import { FIO_APP } from "../identity.js";
import { grantPaymentSettings } from "../oauth/grant-payments.js";
import type { PaymentControls } from "../payment-controls.js";
import { makeAccountsTab } from "./accounts-tab.js";
import { makeGrantPaymentSettings } from "./grant-settings.js";
import { makePaymentsTab } from "./payments-tab.js";

/**
 * fio-mcp's admin UI: core's sign-in, clients and password tabs, named for
 * fio-mcp, plus the Fio accounts tab (first), the payments tab (after the
 * clients) and each payments grant's settings on the clients tab; the
 * admin password's changed hash lives in `server_settings`.
 */

/** fio-mcp's admin app; `AdminLive` adds the payments grant settings, which need the ceilings. */
export const FIO_ADMIN: AdminApp = {
  identity: FIO_APP,
  resourcesHeading: "Accounts",
  passwordHashSource: "FIO_MCP_ADMIN_PASSWORD_HASH_FILE",
};

export interface FioAdminSettings extends AdminSettings {
  /** Seals account tokens at rest. */
  readonly dataKey: Redacted.Redacted<Uint8Array>;
}

/** Registers the admin routes on the router (HTTP mode with OAuth). */
export const AdminLive = (
  settings: FioAdminSettings,
): Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | SqlClient.SqlClient | Accounts | AdminPassword | FioApi | Transactions | PaymentControls | AppConfig
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { paymentLimits } = yield* AppConfig;
      const codec = grantPaymentSettings(paymentLimits);
      const oauth = yield* makeOAuthStore(undefined, codec);
      return CoreAdminLive(
        settings,
        { ...FIO_ADMIN, grantSettings: makeGrantPaymentSettings(oauth, codec, paymentLimits) },
        Effect.all([makeAccountsTab(settings.dataKey), makePaymentsTab(oauth)]),
      );
    }),
  ).pipe(Layer.provide(Accounts.resources));

/** The changed admin password's hash, as the `admin_password_hash` setting. */
const passwordStore = Effect.map(
  makeSettingsStore(),
  (settings): PasswordStore => ({
    get: settings.get(SETTING.adminPasswordHash),
    put: (line) => settings.put(SETTING.adminPasswordHash, line),
  }),
);

/**
 * `scrypt` hashes a changed password; tests pass cheaper parameters.
 * `totpSecret` (FIO_MCP_ADMIN_TOTP_SECRET_FILE) adds the authenticator
 * code to sign-in and payment approval.
 */
export const makeAdminPassword = Effect.fn("FioAdminPassword.make")(function* (
  bootstrap: Redacted.Redacted<PasswordHash>,
  throttle?: ThrottlePolicy,
  scrypt?: ScryptParams,
  totpSecret?: Redacted.Redacted<Uint8Array>,
) {
  return yield* makeCoreAdminPassword(yield* passwordStore, { app: FIO_APP, bootstrap, throttle, scrypt, totpSecret });
});

export const adminPasswordLayer = (
  bootstrap: Redacted.Redacted<PasswordHash>,
  throttle?: ThrottlePolicy,
  scrypt?: ScryptParams,
  totpSecret?: Redacted.Redacted<Uint8Array>,
): Layer.Layer<AdminPassword, never, SqlClient.SqlClient> =>
  AdminPassword.layer(passwordStore, { app: FIO_APP, bootstrap, throttle, scrypt, totpSecret });
