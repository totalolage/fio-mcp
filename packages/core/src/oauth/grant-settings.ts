import { type Effect, Schema } from "effect";

/** Stored grant settings that cannot be read: the grant read fails (logged, never a fallback). */
export class GrantSettingsError extends Schema.TaggedError<GrantSettingsError>()("GrantSettingsError", {
  message: Schema.String,
}) {}

/**
 * Settings the app keeps per grant, next to its scopes and resources: an
 * opaque value core stores, hands back on every grant read and puts on the
 * principal (Principal.settings), but never interprets. The app adds the
 * columns to oauth_grants in its own migrations and owns their meaning.
 */
export interface GrantSettings {
  /** What the app calls these settings in store errors and logs, e.g. "payment settings" (default "settings"). */
  readonly label?: string;
  /** oauth_grants columns the value lives in (added by the app's migrations). */
  readonly columns: ReadonlyArray<string>;
  /**
   * The stored columns (exactly `columns`, NULL as null) -> the value. Must
   * fail on malformed data: the grant read then fails like any other stored
   * grant that cannot be read, and never falls back to another value.
   */
  readonly decode: (row: Readonly<Record<string, unknown>>) => Effect.Effect<unknown, GrantSettingsError>;
  /** The value -> column values: exactly the keys of `columns`, null to store NULL. */
  readonly encode: (value: unknown) => Readonly<Record<string, string | null>>;
  /**
   * The approved consent form -> the new grant's value; `granted` is what
   * ScopeCatalogue.granted made of the same form. A failure shows the consent
   * page again with its message.
   */
  readonly fromConsent: (
    form: URLSearchParams,
    granted: ReadonlyArray<string>,
  ) => Effect.Effect<unknown, { readonly message: string }>;
}
