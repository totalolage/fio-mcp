import { Effect } from "effect";
import type { Account, AccountsShape } from "../accounts.js";
import { PermissionDenied } from "../errors.js";
import { CurrentPrincipal, type Principal } from "../transport/principal.js";

/**
 * Per-call authorization of tool calls against the caller's grant. Every
 * tool stays listed; a call outside the grant fails with PermissionDenied
 * ("You don't have permissions to do that.").
 *
 * fio:read     every tool, including sync, the download marker, and payment previews
 * fio:payments additionally needed by submit_payment_orders
 *
 * Tools that act on an account also need that account in the grant.
 */

export const SCOPE_READ = "fio:read";
export const SCOPE_PAYMENTS = "fio:payments";
export const SCOPES = [SCOPE_READ, SCOPE_PAYMENTS] as const;

export const READ: ReadonlyArray<string> = [SCOPE_READ];
export const PAYMENTS: ReadonlyArray<string> = [SCOPE_READ, SCOPE_PAYMENTS];

const allows = (granted: Principal["scopes"] | Principal["accounts"], item: string) =>
  granted === "all" || granted.includes(item);

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
  if (!allows(principal.accounts, account.name)) {
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
  Effect.map(CurrentPrincipal, (principal) => list.filter((account) => allows(principal.accounts, account.name)));
