import { ADMIN_PASSWORD_HASH_KEY } from "@mcps/core/admin/password.js";
import { encodeBase32, newTotpSecret, otpauthUri } from "@mcps/core/admin/totp.js";
import type { ScryptParams } from "@mcps/core/oauth/crypto.js";
import type { ServerError } from "@mcps/core/oauth/errors.js";
import { makeOAuthStore } from "@mcps/core/oauth/store.js";
import { makeServerSettings } from "@mcps/core/server-settings.js";
import { Clock, DateTime, Effect } from "effect";
import { storeFailure } from "../domain/errors.js";
import { APP_IDENTITY } from "../oauth/identity.js";
import { CommandFailed, readNewPasswordHash, write } from "./io.js";

/**
 * Admin commands, Fio's set with datova-schranka's names: `hash-password` and
 * `totp-init` need no configuration; the OAuth client and token commands and
 * `reset-admin-password` work on the server's database while the server runs
 * (revocations take effect on the next request).
 */

const NAME = APP_IDENTITY.name;

/** The OAuth store's failures carry their value-free text in `description`. */
const storeFailed = (error: ServerError) => new CommandFailed({ message: error.description });

/**
 * `datova-schranka hash-password`: reads the admin password without echo
 * (twice on a terminal, once from a pipe) and prints its scrypt hash for
 * DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE on standard output.
 */
export const hashPasswordCommand = Effect.fn("cli.hashPassword")(function* (params?: ScryptParams) {
  const hash = yield* readNewPasswordHash(params);
  yield* write("stdout", `${hash}\n`);
});

/** `datova-schranka totp-init`: prints a new TOTP secret and its otpauth:// URI; stores nothing. */
export const totpInitCommand = Effect.fn("cli.totpInit")(function* () {
  const secret = yield* Effect.sync(newTotpSecret);
  yield* write("stdout", `${encodeBase32(secret)}\n${otpauthUri(APP_IDENTITY, secret)}\n`);
  yield* write(
    "stderr",
    `Line 1 is the secret: store it in the file DATOVA_SCHRANKA_ADMIN_TOTP_SECRET_FILE names (e.g. \`${NAME} totp-init | head -n 1 > totp_secret\`).\nLine 2 is the URI to add to an authenticator app (as a QR code or by hand). Nothing was stored.\n`,
  );
});

/**
 * `datova-schranka reset-admin-password`: removes the password set at
 * /admin, so the hash in DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE applies
 * again. With `--set`, stores the hash of a new password instead (read like
 * `hash-password`). The running server reads the stored hash on every
 * sign-in, so either applies at once.
 */
export const resetAdminPasswordCommand = Effect.fn("cli.resetAdminPassword")(function* (
  set: boolean,
  params?: ScryptParams,
) {
  const settings = yield* makeServerSettings(storeFailure);
  const failed = (error: { readonly message: string }) => new CommandFailed({ message: error.message });
  if (set) {
    const hash = yield* readNewPasswordHash(params);
    yield* settings.put(ADMIN_PASSWORD_HASH_KEY, hash).pipe(Effect.mapError(failed));
    return yield* write("stderr", "Stored the new admin password; it replaces DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE.\n");
  }
  const removed = yield* settings.remove(ADMIN_PASSWORD_HASH_KEY).pipe(Effect.mapError(failed));
  yield* write(
    "stderr",
    removed
      ? "Removed the admin password set at /admin; DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE applies again.\n"
      : "No admin password was set at /admin; DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE already applies.\n",
  );
});

const iso = (millis: number | null) => (millis === null ? "never" : DateTime.formatIso(DateTime.makeUnsafe(millis)));

/** `datova-schranka clients list`: one line per registered OAuth client. */
export const listClientsCommand = Effect.fn("cli.listClients")(function* () {
  const store = yield* makeOAuthStore();
  const clients = yield* store.listClients(yield* Clock.currentTimeMillis).pipe(Effect.mapError(storeFailed));
  if (clients.length === 0) return yield* write("stdout", "No registered clients.\n");
  const lines = clients.map((client) =>
    [
      client.clientId,
      `name=${JSON.stringify(client.clientName ?? "")}`,
      `registered=${iso(client.createdAt)}`,
      `last_authorized=${iso(client.lastUsedAt)}`,
      `active_grants=${client.liveGrants}`,
      // JSON-escaped: names and URIs come from unauthenticated registrations.
      `redirect_uris=${JSON.stringify(client.redirectUris)}`,
    ].join("  "),
  );
  yield* write("stdout", `${lines.join("\n")}\n`);
});

/** `datova-schranka clients revoke <id>`: removes the client with its grants, codes and tokens. */
export const revokeClientCommand = Effect.fn("cli.revokeClient")(function* (clientId: string) {
  const store = yield* makeOAuthStore();
  if (!(yield* store.deleteClient(clientId).pipe(Effect.mapError(storeFailed)))) {
    return yield* new CommandFailed({ message: `no registered client ${clientId} (see ${NAME} clients list)` });
  }
  yield* write("stdout", `Revoked client ${clientId} and all its tokens.\n`);
});

/** `datova-schranka tokens revoke-all`: ends every live grant. */
export const revokeAllTokensCommand = Effect.fn("cli.revokeAllTokens")(function* () {
  const store = yield* makeOAuthStore();
  const revoked = yield* store.revokeAll(yield* Clock.currentTimeMillis).pipe(Effect.mapError(storeFailed));
  yield* write("stdout", `Revoked ${revoked} active grants; every client must authorize again.\n`);
});
