import { Effect } from "effect";
import type { Account, AccountsShape } from "../accounts.js";
import { PermissionDenied } from "../errors.js";
import { CurrentPrincipal, type Principal } from "../transport/principal.js";

/**
 * Authorization of tool calls against the caller's grant. Every call is
 * checked; a call outside the grant fails with PermissionDenied ("You don't
 * have permissions to do that."), also for a tool the client was not shown.
 *
 * fio:read     every tool, including sync and the download marker
 * fio:payments additionally needed by preview_payment_orders and submit_payment_orders
 *
 * Tools that act on an account also need that account in the grant. Grants
 * name accounts by token fingerprint, never by display name: renaming an
 * account keeps its grants, a new token under an old name gets none, and a
 * rotated token drops the account from existing grants until the user
 * consents again.
 *
 * HTTP sessions list only what the grant allows (src/transport/grant-tools.ts):
 * tools whose scopes it lacks are left out, the `account` enum names only the
 * granted accounts, and tools that take an account are left out when it
 * covers none. stdio lists every tool.
 */

export const SCOPE_READ = "fio:read";
export const SCOPE_PAYMENTS = "fio:payments";
export const SCOPES = [SCOPE_READ, SCOPE_PAYMENTS] as const;

export const READ: ReadonlyArray<string> = [SCOPE_READ];
export const PAYMENTS: ReadonlyArray<string> = [SCOPE_READ, SCOPE_PAYMENTS];

/** Tools that need fio:payments; their handlers check PAYMENTS. */
export const PAYMENT_TOOLS: ReadonlySet<string> = new Set(["preview_payment_orders", "submit_payment_orders"]);

/** Tools that act on no single account. Every other tool takes one. */
export const ACCOUNTLESS_TOOLS: ReadonlySet<string> = new Set(["get_server_status", "get_cache_status"]);

/** The scopes a tool needs to be listed and called. */
export const toolScopes = (name: string): ReadonlyArray<string> => (PAYMENT_TOOLS.has(name) ? PAYMENTS : READ);

const allows = (granted: Principal["scopes"] | Principal["accountFingerprints"], item: string) =>
  granted === "all" || granted.includes(item);

/** Whether `principal` holds every scope in `scopes`. */
export const holdsScopes = (principal: Principal, scopes: ReadonlyArray<string>) =>
  scopes.every((scope) => allows(principal.scopes, scope));

/** The accounts in `list` that `principal`'s grant covers. */
export const coveredAccounts = (principal: Principal, list: ReadonlyArray<Account>) =>
  list.filter((account) => allows(principal.accountFingerprints, account.tokenFingerprint));

/** Fails unless the caller holds every scope in `scopes`. */
export const requireScopes = Effect.fnUntraced(function* (scopes: ReadonlyArray<string>) {
  const principal = yield* CurrentPrincipal;
  const missing = scopes.filter((scope) => !allows(principal.scopes, scope));
  if (missing.length > 0) {
    return yield* new PermissionDenied({
      detail: `This client's authorization does not include ${missing.join(" and ")}. Reconnect the client to fio-mcp and grant it on the consent page.`,
    });
  }
});

/** Fails unless the caller's grant covers `account`. */
export const requireAccount = Effect.fnUntraced(function* (account: Account) {
  const principal = yield* CurrentPrincipal;
  if (!allows(principal.accountFingerprints, account.tokenFingerprint)) {
    return yield* new PermissionDenied({
      detail: `This client's authorization does not cover the account "${account.name}". Reconnect the client to fio-mcp and select the account on the consent page.`,
    });
  }
});

/**
 * The account a tool call names (or the only configured one), after the
 * scope and account checks. Checks run before anything is read or sent.
 */
export const permittedAccount = Effect.fnUntraced(function* (
  accounts: AccountsShape,
  name: string | undefined,
  scopes: ReadonlyArray<string> = READ,
) {
  yield* requireScopes(scopes);
  const account = yield* accounts.resolve(name);
  yield* requireAccount(account);
  return account;
});

/** The configured accounts the caller's grant covers. */
export const visibleAccounts = (list: ReadonlyArray<Account>) =>
  Effect.map(CurrentPrincipal, (principal) => coveredAccounts(principal, list));
