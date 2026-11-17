import { type GrantSettings, GrantSettingsError } from "@mcps/core/oauth/grant-settings.js";
import { DateTime, Effect, Schema } from "effect";
import { READ_SCOPE } from "../mcp/tool-group.js";
import { DELIVERY_CONSENT_FIELD, DELIVERY_CONSENT_VERSION, DELIVERY_CONSENT_VERSION_PATTERN } from "./consent.js";

/**
 * A grant's delivery consent (principal.settings, src/mcp/caller.ts): the
 * wording version the owner ticked and when (ISO 8601 UTC). Both are null on
 * a grant without isds:read, and both are set on every grant with it. A
 * stored value of any other shape fails the grant read (fail closed); which
 * versions a tool accepts is ACCEPTED_DELIVERY_CONSENT_VERSIONS.
 */
export interface DeliveryConsentSettings {
  readonly deliveryConsentVersion: string | null;
  readonly deliveryConsentedAt: string | null;
}

// As DateTime.formatIso writes it: UTC with milliseconds.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const IsoTimestamp = Schema.String.check(
  Schema.makeFilter((text) => (ISO_UTC.test(text) && !Number.isNaN(Date.parse(text))) || "an ISO 8601 UTC timestamp"),
);

const ConsentVersion = Schema.String.check(
  Schema.makeFilter((text) => DELIVERY_CONSENT_VERSION_PATTERN.test(text) || "a delivery consent version"),
);

const SettingsSchema = Schema.Union([
  Schema.Struct({ deliveryConsentVersion: ConsentVersion, deliveryConsentedAt: IsoTimestamp }),
  Schema.Struct({ deliveryConsentVersion: Schema.Null, deliveryConsentedAt: Schema.Null }),
]);

const NO_CONSENT: DeliveryConsentSettings = { deliveryConsentVersion: null, deliveryConsentedAt: null };

/**
 * A grant's (or principal's) settings as DeliveryConsentSettings; anything
 * else fails the assertion (a defect), never a permissive fallback.
 */
export const readDeliveryConsent = (settings: unknown): DeliveryConsentSettings => {
  Schema.asserts(SettingsSchema, settings);
  return settings;
};

/**
 * The grant settings of datova-schranka: the delivery consent in the
 * oauth_grants columns of migration 0106 (src/oauth/migrations.ts). The
 * consent form must tick `isds_delivery_consent` whenever the granted scopes
 * include isds:read; a grant needs at least one scope.
 */
export const grantSettings: GrantSettings = {
  label: "delivery consent",
  columns: ["delivery_consent_version", "delivery_consented_at"],
  // A stored value that does not decode fails the grant read.
  decode: (row) =>
    Schema.decodeUnknownEffect(SettingsSchema)({
      deliveryConsentVersion: row.delivery_consent_version,
      deliveryConsentedAt: row.delivery_consented_at,
    }).pipe(
      Effect.map((settings): DeliveryConsentSettings => settings),
      Effect.mapError((error) => new GrantSettingsError({ message: `grant delivery consent: ${error.message}` })),
    ),
  encode: (value) => {
    const settings = readDeliveryConsent(value);
    return {
      delivery_consent_version: settings.deliveryConsentVersion,
      delivery_consented_at: settings.deliveryConsentedAt,
    };
  },
  // Without isds:read the tick is ignored and nothing is recorded.
  fromConsent: Effect.fnUntraced(function* (form, granted) {
    if (granted.length === 0) return yield* Effect.fail({ message: "Select at least one permission." });
    if (!granted.includes(READ_SCOPE)) return NO_CONSENT;
    const ticked = form.getAll(DELIVERY_CONSENT_FIELD);
    if (ticked.length !== 1 || ticked[0] !== "on") {
      return yield* Effect.fail({
        message: "Read access needs the delivery consent: tick it, or untick read access.",
      });
    }
    const now = yield* DateTime.now;
    return { deliveryConsentVersion: DELIVERY_CONSENT_VERSION, deliveryConsentedAt: DateTime.formatIso(now) };
  }),
};
