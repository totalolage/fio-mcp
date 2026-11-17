import type { AppIdentity } from "@mcps/core/app-identity.js";

/**
 * datova-schranka as core names it in pages, cookies (`__Host-datova-schranka-auth`),
 * command hints and identifiers (`ds_at_…`, `ds_grant_…`). The OAuth app and
 * the admin composition share it.
 */
export const APP_IDENTITY: AppIdentity = { name: "datova-schranka", idPrefix: "ds" };
