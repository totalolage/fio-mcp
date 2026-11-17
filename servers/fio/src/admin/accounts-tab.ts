import { csrfField, type Flash, formatTime, hidden } from "@mcps/core/admin/pages.js";
import { ADMIN_PATH } from "@mcps/core/admin/sessions.js";
import { type AdminTab, field } from "@mcps/core/admin/tab.js";
import { escapeHtml } from "@mcps/core/oauth/pages.js";
import { Effect, type Redacted } from "effect";
import { tokenHint } from "../accounts.js";
import { makeAccountAdmin, type RemovedCache } from "./accounts.js";

/**
 * The admin UI's Fio accounts tab at /admin: add, rename, test, replace the
 * token of, and remove accounts. Tokens are never rendered, only their last
 * four characters.
 */

interface AccountRow {
  readonly id: string;
  readonly name: string;
  /** Last four characters of the token. */
  readonly tokenHint: string;
  readonly accountNumber: string | undefined;
  readonly currency: string | undefined;
  readonly createdAt: number;
  readonly tokenUpdatedAt: number;
}

const accountRow = (csrf: string, row: AccountRow) => `<tr>
<td><strong>${escapeHtml(row.name)}</strong></td>
<td><code>…${escapeHtml(row.tokenHint)}</code></td>
<td>${escapeHtml(row.accountNumber ?? "learned from statements")}${row.currency === undefined ? "" : ` (${escapeHtml(row.currency)})`}</td>
<td>${formatTime(row.createdAt)}<br><span class="muted">token set ${formatTime(row.tokenUpdatedAt)}</span></td>
<td>
<form method="post" action="/admin/accounts/test">${csrfField(csrf)}${hidden("id", row.id)}<button type="submit">Test token</button></form>
<details><summary>Rename</summary><form method="post" action="/admin/accounts/rename">${csrfField(csrf)}${hidden("id", row.id)}
<label>New name <input type="text" name="name" value="${escapeHtml(row.name)}" maxlength="256" required></label>
<button type="submit">Rename</button><span class="muted">Connected clients keep access.</span></form></details>
<details><summary>Replace token</summary><form method="post" action="/admin/accounts/rotate">${csrfField(csrf)}${hidden("id", row.id)}
<label>New FIO token <input type="password" name="token" autocomplete="off" required></label>
<button type="submit">Replace</button><span class="muted">Connected clients lose this account until they reconnect and select it again.</span></form></details>
<details><summary class="danger">Remove</summary><form method="post" action="/admin/accounts/remove">${csrfField(csrf)}${hidden("id", row.id)}
<label><input type="radio" name="cache" value="keep" checked> Keep cached transactions</label>
<label><input type="radio" name="cache" value="purge"> Delete cached transactions</label>
<label><input type="checkbox" name="confirm" value="yes" required> Remove “${escapeHtml(row.name)}”</label>
<button type="submit">Remove</button></form></details>
</td>
</tr>`;

const accountsBody = (csrf: string, accounts: ReadonlyArray<AccountRow>) =>
  `<h1>FIO accounts</h1>
<p class="muted">Tokens are stored encrypted and never shown; only their last four characters are. Renaming keeps every client's access; replacing a token removes the account from existing client authorizations.</p>
${
  accounts.length === 0
    ? "<p>No accounts yet. Add one below.</p>"
    : `<table><thead><tr><th>Name</th><th>Token</th><th>Account</th><th>Added</th><th>Actions</th></tr></thead><tbody>
${accounts.map((row) => accountRow(csrf, row)).join("\n")}
</tbody></table>`
}
<h2>Add an account</h2>
<form method="post" action="/admin/accounts/add">
${csrfField(csrf)}
<label>Name <input type="text" name="name" maxlength="256" required></label>
<label>FIO token <input type="password" name="token" autocomplete="off" required></label>
<label>Account number (optional, without bank code) <input type="text" name="accountNumber" inputmode="numeric" maxlength="10"></label>
<label>Currency (optional, e.g. CZK) <input type="text" name="currency" maxlength="3"></label>
<p><button type="submit">Add account</button></p>
</form>`;

const quoted = (names: ReadonlyArray<string>) => names.map((name) => `“${name}”`).join(", ");

/** `accounts` kept data because a token they have, or had, is bound to the same bank account. */
const purgedText = (deleted: number, accounts: ReadonlyArray<string>): string => {
  const holders = `${quoted(accounts)} ${accounts.length === 1 ? "has or had a token" : "have or had tokens"} for the same bank account`;
  if (deleted > 0 && accounts.length > 0) return `Its cached transactions were deleted, except where ${holders}.`;
  if (deleted > 0) return "Its cached transactions were deleted.";
  if (accounts.length > 0) return `Its cached transactions were kept: ${holders}.`;
  return "Nothing was cached under its tokens, so nothing was deleted.";
};

const removedCacheText = (cache: RemovedCache): string => {
  switch (cache.kind) {
    case "kept":
      return "Its cached transactions were kept.";
    case "purged": {
      const text = purgedText(cache.deleted, cache.accounts);
      if (cache.unattributed === 0) return text;
      const one = cache.unattributed === 1;
      const which = one ? "1 cached bank account" : `${cache.unattributed} cached bank accounts`;
      return `${text} ${which} could not be linked to any configured account and ${one ? "was" : "were"} not touched.`;
    }
  }
};

export const makeAccountsTab = Effect.fn("AccountsTab.make")(function* (dataKey: Redacted.Redacted<Uint8Array>) {
  const admin = yield* makeAccountAdmin(dataKey);

  const render = (csrf: string) =>
    admin.records.pipe(
      Effect.map((records) =>
        records.map((record) => ({
          id: record.account.id,
          name: record.account.name,
          tokenHint: tokenHint(record.account.token),
          accountNumber: record.account.configuredAccountNumber,
          currency: record.account.configuredCurrency,
          createdAt: record.createdAt,
          tokenUpdatedAt: record.tokenUpdatedAt,
        })),
      ),
      Effect.map((rows) => ({ rows, error: undefined as Flash | undefined })),
      Effect.catch((error) => Effect.succeed({ rows: [], error: { kind: "error", text: error.message } as Flash })),
      Effect.map(({ rows, error }) => ({ body: accountsBody(csrf, rows), error })),
    );

  const idOf = (form: URLSearchParams) => field(form, "id") ?? "";

  const addAccount = (form: URLSearchParams) =>
    admin
      .add({
        name: field(form, "name") ?? "",
        token: field(form, "token") ?? "",
        accountNumber: field(form, "accountNumber"),
        currency: field(form, "currency"),
      })
      .pipe(Effect.map((name): Flash => ({ kind: "ok", text: `Added “${name}”. Connected clients see it after they reconnect and select it.` })));

  const renameAccount = (form: URLSearchParams) =>
    admin
      .rename(idOf(form), field(form, "name") ?? "")
      .pipe(Effect.map((name): Flash => ({ kind: "ok", text: `Renamed to “${name}”.` })));

  const rotateToken = (form: URLSearchParams) =>
    admin.rotate(idOf(form), field(form, "token") ?? "").pipe(
      Effect.map(
        (name): Flash => ({
          kind: "ok",
          text: `Replaced the token of “${name}”. Clients authorized before must reconnect and select the account again.`,
        }),
      ),
    );

  const removeAccount = (form: URLSearchParams) => {
    if (field(form, "confirm") !== "yes") return Effect.succeed<Flash>({ kind: "error", text: "Tick the box to confirm the removal." });
    return admin.remove(idOf(form), field(form, "cache") === "purge").pipe(
      Effect.map(({ name, cache }): Flash => ({ kind: "ok", text: `Removed “${name}”. ${removedCacheText(cache)}` })),
    );
  };

  const testToken = (form: URLSearchParams) =>
    admin.test(idOf(form)).pipe(
      Effect.map(
        ({ name, latestStatement }): Flash => ({
          kind: "ok",
          text: `FIO accepted the token of “${name}” for reading${latestStatement === undefined ? "" : ` (latest statement ${latestStatement})`}. This does not show whether it may submit payment orders.`,
        }),
      ),
    );

  return {
    id: "accounts",
    label: "Accounts",
    path: ADMIN_PATH,
    nav: "first",
    render,
    actions: [
      { path: `${ADMIN_PATH}/accounts/add`, run: addAccount },
      { path: `${ADMIN_PATH}/accounts/rename`, run: renameAccount },
      { path: `${ADMIN_PATH}/accounts/rotate`, run: rotateToken },
      { path: `${ADMIN_PATH}/accounts/remove`, run: removeAccount },
      { path: `${ADMIN_PATH}/accounts/test`, run: testToken },
    ],
  } satisfies AdminTab;
});
