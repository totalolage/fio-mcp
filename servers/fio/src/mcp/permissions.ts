import {
  coversResource,
  requireScopes as requireGrantedScopes,
  requireResource,
  type ToolPolicyShape,
} from "@mcps/core/mcp/grants.js";
import { CurrentPrincipal, type Principal } from "@mcps/core/transport/principal.js";
import { Effect } from "effect";
import type { Account, AccountsShape } from "../accounts.js";
import { PermissionDenied } from "../errors.js";

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
 * HTTP sessions list only what the grant allows (core's transport/grant-tools.ts,
 * driven by ConfiguredToolPolicy in tool-policy.ts):
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

/**
 * Tools that move the token's download marker in the bank (state shared with
 * any other program using the token). FIO_MCP_MARKER_TOOLS=disabled leaves
 * them out (SEC-10); a call by name then fails with PermissionDenied.
 */
export const MARKER_TOOLS: ReadonlySet<string> = new Set(["get_new_transactions", "set_download_marker"]);

/** Fails when FIO_MCP_MARKER_TOOLS=disabled. */
export const requireMarkerTools = (config: { readonly markerTools?: "enabled" | "disabled" }) =>
  config.markerTools === "disabled"
    ? Effect.fail(
        new PermissionDenied({
          detail: "The download-marker tools are disabled on this server (FIO_MCP_MARKER_TOOLS=disabled).",
        }),
      )
    : Effect.void;

/** Tools that act on no single account. Every other tool takes one. */
export const ACCOUNTLESS_TOOLS: ReadonlySet<string> = new Set(["get_server_status", "get_cache_status"]);

/** The scopes a tool needs to be listed and called. */
export const toolScopes = (name: string): ReadonlyArray<string> => (PAYMENT_TOOLS.has(name) ? PAYMENTS : READ);

/** For HTTP `tools/list`: the scopes above, ACCOUNTLESS_TOOLS, and the `account` parameter. */
export const TOOL_POLICY: ToolPolicyShape = {
  scopes: toolScopes,
  resourceless: (name) => ACCOUNTLESS_TOOLS.has(name),
  resourceParameter: "account",
};

export { holdsScopes } from "@mcps/core/mcp/grants.js";

/** The accounts in `list` that `principal`'s grant covers (by token fingerprint, the resource id). */
export const coveredAccounts = (principal: Principal, list: ReadonlyArray<Account>) =>
  list.filter((account) => coversResource(principal, account.tokenFingerprint));

/** Fails unless the caller holds every scope in `scopes`. */
export const requireScopes = (scopes: ReadonlyArray<string>) =>
  requireGrantedScopes(
    scopes,
    (missing) =>
      new PermissionDenied({
        detail: `This client's authorization does not include ${missing.join(" and ")}. Reconnect the client to fio-mcp and grant it on the consent page.`,
      }),
  );

/** Fails unless the caller's grant covers `account`. */
export const requireAccount = (account: Account) =>
  requireResource(
    account.tokenFingerprint,
    () =>
      new PermissionDenied({
        detail: `This client's authorization does not cover the account "${account.name}". Reconnect the client to fio-mcp and select the account on the consent page.`,
      }),
  );

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
