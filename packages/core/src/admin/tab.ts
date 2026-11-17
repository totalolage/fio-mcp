import type { Effect } from "effect";
import type { AppIdentity } from "../app-identity.js";
import type { GrantSettings } from "../oauth/grant-settings.js";
import type { LoginResult } from "../oauth/login.js";
import type { Flash } from "./pages.js";

/**
 * What an app adds to the admin UI. Core serves sign-in, sessions, the
 * connected-clients and password tabs; the app names the pages and injects
 * its product tabs (for example the resources its tools act on). A tab
 * renders its body into the core shell (pages.ts: csrfField, hidden,
 * formatTime) and gets its POST forms only after core checked the session,
 * CSRF token and origin. Every route of a tab sits behind the admin
 * allowed-networks restriction like core's own.
 */

export interface AdminApp {
  readonly identity: AppIdentity;
  /** Heading of the column naming the resources a grant covers, e.g. "Projects". */
  readonly resourcesHeading: string;
  /** Where the bootstrap password hash comes from, as the password page names it. */
  readonly passwordHashSource: string;
  /** Per-grant app settings shown and changed on the connected-clients tab. */
  readonly grantSettings?: AdminGrantSettings | undefined;
}

/** What the connected-clients tab knows about one live grant. */
export interface AdminGrantView {
  readonly grantId: string;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
  /** The resource ids the grant covers. */
  readonly resources: ReadonlyArray<string>;
  /** The grant's app settings, as `codec` decodes them (undefined without a codec). */
  readonly settings: unknown;
}

/**
 * The app's part of a grant's row on the connected-clients tab. The app
 * owns the form, its parsing, the scope check, saving (through its own
 * OAuth store built with `codec`), the messages and the logs.
 */
export interface AdminGrantSettings {
  /** The grant columns' codec; core reads grants with it. */
  readonly codec: GrantSettings;
  /** HTML (escaped) placed right after the grant's table row, e.g. a `<tr>` with a form; "" for none. */
  readonly render: (grant: AdminGrantView, csrf: string) => string;
  /** The forms `render` posts; their messages show once on the connected-clients tab. */
  readonly actions: ReadonlyArray<AdminTabAction>;
}

/** What a tab page is rendered for. */
export interface AdminTabRequest {
  /** The request's query string. */
  readonly query: URLSearchParams;
  /** A second factor (an authenticator code, form field `totp`) is configured. */
  readonly secondFactor: boolean;
}

/** A tab page as its `render` returns it. */
export interface AdminTabView {
  /** The content after the nav and the one-shot message. */
  readonly body: string;
  /**
   * Shown in place of the session's one-shot message, which then waits for
   * the next page (for example when loading the page's data failed).
   */
  readonly error?: Flash | undefined;
  /** The response status; 200 when absent. */
  readonly status?: number | undefined;
}

/** A further GET page of a tab; the nav marks the tab current. */
export interface AdminTabPage {
  readonly path: `/${string}`;
  readonly render: (csrf: string, request: AdminTabRequest) => Effect.Effect<AdminTabView>;
}

/** What a verified form gets besides its fields. */
export interface AdminActionContext {
  /**
   * Checks the form's second factor (field `totp`) for this client address,
   * sharing the sign-in's replay and throttle memory; Accepted when no
   * second factor is configured. Lazy: nothing is checked or counted
   * unless the action runs it. Core offers it only after the session,
   * Origin and CSRF checks passed.
   */
  readonly checkSecondFactor: Effect.Effect<LoginResult<void>>;
}

/** A form the tab handles. */
export interface AdminTabAction {
  /** The POST path. */
  readonly path: `/${string}`;
  /** Where the browser goes afterwards; the tab's (or, for grant settings, the clients) page when absent. */
  readonly back?: `/${string}` | undefined;
  /**
   * Runs a verified form. The result (or the error's message, which must not
   * hold a secret) shows once on the `back` page.
   */
  readonly run: (form: URLSearchParams, context: AdminActionContext) => Effect.Effect<Flash, { readonly message: string }>;
}

export interface AdminTab {
  /** Unique; "clients" and "password" are core's. */
  readonly id: string;
  /** The nav entry and the page title. */
  readonly label: string;
  /** The page's GET path. Sign-in lands on ADMIN_PATH, so one tab should be there. */
  readonly path: `/${string}`;
  /** Where the nav lists the tab: before core's tabs (default) or right after "Connected clients". */
  readonly nav?: "first" | "after-clients" | undefined;
  readonly render: (csrf: string, request: AdminTabRequest) => Effect.Effect<AdminTabView>;
  /** Further GET pages of this tab. */
  readonly pages?: ReadonlyArray<AdminTabPage> | undefined;
  readonly actions: ReadonlyArray<AdminTabAction>;
}

/** The one value of `name`; repeated or missing is undefined. */
export const field = (form: URLSearchParams, name: string) => {
  const values = form.getAll(name);
  return values.length === 1 ? values[0] : undefined;
};
