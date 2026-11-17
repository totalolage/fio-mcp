import type { Migrations } from "@mcps/core/migrations.js";
import { OAUTH_MIGRATIONS } from "@mcps/core/oauth/store.js";
import { createServerSettings } from "@mcps/core/server-settings.js";
import { DOMAIN_MIGRATIONS } from "../domain/migrations.js";
import { OAUTH_APP_MIGRATIONS } from "../oauth/migrations.js";
import { EXTENSION_MIGRATIONS } from "./extensions.js";

/** The app's migrations table. */
export const MIGRATIONS_TABLE = "datova_schranka_migrations";

/**
 * Every migration in id order: core OAuth (0002, 0004, 0006), core
 * server_settings (0007), domain (0101–0105), app (0106–0149), extensions
 * (0201+).
 *
 * The ranges describe the first release only. The migrator skips every id
 * at or below the highest one already applied, so once a database exists,
 * every new migration (including one newly exported by core) must take an id
 * above the highest id this app has shipped, whatever range it belongs to.
 */
export const APP_MIGRATIONS: Migrations = {
  ...OAUTH_MIGRATIONS,
  "0007_create_server_settings": createServerSettings,
  ...DOMAIN_MIGRATIONS,
  ...OAUTH_APP_MIGRATIONS,
  ...EXTENSION_MIGRATIONS,
};
