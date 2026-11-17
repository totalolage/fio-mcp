import type { OAuthApp } from "@mcps/core/oauth/app.js";
import { DateTime, Effect } from "effect";
import { AuditLog } from "../domain/audit-log.js";
import { READ_SCOPE, SEND_SCOPE } from "../mcp/tool-group.js";
import { CONSENT_RENDERER, DELIVERY_CONSENT_SHA256, SCOPE_FIELD } from "./consent.js";
import { grantSettings, readDeliveryConsent } from "./grant-settings.js";
import { APP_IDENTITY } from "./identity.js";

const SUPPORTED: ReadonlyArray<string> = [READ_SCOPE, SEND_SCOPE];

/** The audit action of a consent row (actor kind "consent"). */
export const CONSENT_ACTION = "grant_consent";

/**
 * datova-schranka's side of the authorization server: isds:read (asked for
 * by default) and isds:send as ticked on the consent page, at least one;
 * read only with the delivery consent (grantSettings); data boxes as the
 * resources. Every approved consent writes one audit row inside the grant's
 * transaction, so the grant exists only with its record. The AuditLog must
 * run on the same database client as core's OAuth store for its row to join
 * that transaction.
 */
export const makeOAuthApp: Effect.Effect<OAuthApp, never, AuditLog> = Effect.map(
  Effect.service(AuditLog),
  (audit): OAuthApp => ({
    identity: APP_IDENTITY,
    scopes: {
      supported: SUPPORTED,
      defaults: [READ_SCOPE],
      challenge: READ_SCOPE,
      granted: (form) => {
        const posted = form.getAll(SCOPE_FIELD);
        return SUPPORTED.filter((scope) => posted.includes(scope));
      },
    },
    consent: CONSENT_RENDERER,
    grantSettings,
    afterConsent: Effect.fn("OAuthApp.afterConsent")(function* ({ grant, at }) {
      const { deliveryConsentVersion, deliveryConsentedAt } = readDeliveryConsent(grant.settings);
      yield* audit.record({
        actor: { kind: "consent", grantId: grant.grantId, clientId: grant.clientId, subject: grant.grantId },
        action: CONSENT_ACTION,
        outcome: "ok",
        detail: {
          boxIds: grant.resources,
          scopes: grant.scopes,
          deliveryConsentVersion,
          wordingSha256: deliveryConsentVersion === null ? null : DELIVERY_CONSENT_SHA256,
          // The time the grant records for a read consent, else the grant's creation.
          consentedAt: deliveryConsentedAt ?? DateTime.formatIso(DateTime.makeUnsafe(at)),
        },
      });
    }),
  }),
);
