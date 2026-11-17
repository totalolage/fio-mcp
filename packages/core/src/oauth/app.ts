import type { AppIdentity } from "../app-identity.js";
import type { GrantSettings } from "./grant-settings.js";

/**
 * What the authorization server needs from the app it guards: its identity,
 * the scopes its tokens carry, and the words and fields of its consent page.
 * Core supplies the protocol, sessions and page frame; the app fills these in.
 */
export interface OAuthApp {
  readonly identity: AppIdentity;
  readonly scopes: ScopeCatalogue;
  readonly consent: ConsentRenderer;
  /** Per-grant settings the consent page collects; absent: grants carry none. */
  readonly grantSettings?: GrantSettings | undefined;
}

/** The scopes a token can carry and how an approval grants them. */
export interface ScopeCatalogue {
  /** Every scope a client may request, as the metadata lists them. */
  readonly supported: ReadonlyArray<string>;
  /** What an authorization request that names no scope asks for. */
  readonly defaults: ReadonlyArray<string>;
  /** The scope the 401 challenge on /mcp names. */
  readonly challenge: string;
  /** The scopes an approved consent form grants, from its posted fields. */
  readonly granted: (form: URLSearchParams) => ReadonlyArray<string>;
}

/** The app's part of the login and consent pages. */
export interface ConsentRenderer {
  /** What the login page says the client asks to use: `<client> asks to use <tools>.` */
  readonly tools: string;
  /**
   * The Permissions fieldset's contents for a request that asked for
   * `requested`: HTML, with every interpolated value escaped. Its inputs
   * are what `ScopeCatalogue.granted` (and `GrantSettings.fromConsent`) read
   * back. `posted` is the owner's own submission when the page is shown
   * again after an error, so the fields keep what was entered.
   */
  readonly permissions: (requested: ReadonlyArray<string>, posted?: URLSearchParams) => string;
  /** CSS appended to the pages' one style block (its CSP hash covers it). */
  readonly style?: string | undefined;
  readonly resources: ResourceWords;
}

/** How the consent page names the resources a grant covers. */
export interface ResourceWords {
  /** Legend of the resource checkboxes. */
  readonly legend: string;
  /** Form field of each resource checkbox; its value is the resource's label. */
  readonly field: string;
  /** Plural noun in the log line of an approval. */
  readonly plural: string;
  /** Shown when the resources changed while the consent page was open. */
  readonly changed: string;
  /** Shown when there is no resource to grant. */
  readonly none: string;
  /** Shown when the approval selected no resource. */
  readonly noneSelected: string;
}
