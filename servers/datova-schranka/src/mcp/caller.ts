import { CurrentPrincipal } from "@mcps/core/transport/principal.js";
import { Effect, Schema } from "effect";

/**
 * The OAuth grant behind the current MCP call. This server only serves
 * OAuth callers, so a principal without a client id or with "all" scopes or
 * resources is never a caller.
 */
export interface Caller {
  /** The OAuth grant id (Principal.subject). */
  readonly grantId: string;
  readonly clientId: string;
  readonly subject: string;
  readonly scopes: ReadonlySet<string>;
  /** Box ids (Resource.id) the grant covers. */
  readonly boxIds: ReadonlySet<string>;
  /** Delivery-consent wording version recorded on the grant; null when the grant has no read consent. */
  readonly deliveryConsentVersion: string | null;
}

export class CallerMissing extends Schema.TaggedError<CallerMissing>()("CallerMissing", {}) {}

const consentVersion = (settings: unknown): string | null => {
  if (typeof settings !== "object" || settings === null) return null;
  const version: unknown = (settings as { readonly deliveryConsentVersion?: unknown }).deliveryConsentVersion;
  return typeof version === "string" && version.length > 0 ? version : null;
};

/** The current call's grant, read from core's request-scoped CurrentPrincipal. */
export const currentCaller: Effect.Effect<Caller, CallerMissing> = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  if (principal.clientId === undefined || principal.scopes === "all" || principal.resources === "all") {
    return yield* new CallerMissing();
  }
  return {
    grantId: principal.subject,
    clientId: principal.clientId,
    subject: principal.subject,
    scopes: new Set(principal.scopes),
    boxIds: new Set(principal.resources),
    deliveryConsentVersion: consentVersion(principal.settings),
  };
});
