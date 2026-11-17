/**
 * The delivery-consent wording versions an isds:read call accepts (exact
 * set membership; a grant without one of these is refused).
 *
 * Placeholder until integration: src/oauth/consent.ts (the app part)
 * exports ACCEPTED_DELIVERY_CONSENT_VERSIONS, and this module then
 * re-exports it instead of defining its own.
 */
export const ACCEPTED_DELIVERY_CONSENT_VERSIONS: ReadonlySet<string> = new Set(["2026-11-17.1"]);
