import { assert, describe, it } from "@effect/vitest";
import { CurrentPrincipal } from "@mcps/core/transport/principal.js";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { currentCaller } from "../../src/mcp/caller.js";
import { READ_SCOPE, SEND_SCOPE } from "../../src/mcp/tool-group.js";
import { DELIVERY_CONSENT_VERSION } from "../../src/oauth/consent.js";
import { grantSettings } from "../../src/oauth/grant-settings.js";

const form = (entries: ReadonlyArray<readonly [string, string]>) => new URLSearchParams(entries.map(([k, v]) => [k, v]));
const TICKED = form([["isds_delivery_consent", "on"]]);

describe("grantSettings", () => {
  it.effect("decodes stored columns into the caller-visible settings", () =>
    Effect.gen(function* () {
      const read = yield* grantSettings.decode({
        delivery_consent_version: DELIVERY_CONSENT_VERSION,
        delivery_consented_at: "2026-11-17T10:00:00.000Z",
      });
      assert.deepStrictEqual(read, {
        deliveryConsentVersion: DELIVERY_CONSENT_VERSION,
        deliveryConsentedAt: "2026-11-17T10:00:00.000Z",
      });
      const caller = yield* currentCaller.pipe(
        Effect.provideService(CurrentPrincipal, {
          subject: "ds_grant_1",
          clientId: "client_1",
          scopes: [READ_SCOPE],
          resources: ["box_main"],
          settings: read,
        }),
      );
      assert.strictEqual(caller.deliveryConsentVersion, DELIVERY_CONSENT_VERSION);
      const none = yield* grantSettings.decode({ delivery_consent_version: null, delivery_consented_at: null });
      assert.deepStrictEqual(none, { deliveryConsentVersion: null, deliveryConsentedAt: null });
    }),
  );

  it.effect("fails on stored columns that are not a consent", () =>
    Effect.gen(function* () {
      for (const row of [
        { delivery_consent_version: DELIVERY_CONSENT_VERSION, delivery_consented_at: null },
        { delivery_consent_version: null, delivery_consented_at: "2026-11-17T10:00:00.000Z" },
        { delivery_consent_version: "", delivery_consented_at: "2026-11-17T10:00:00.000Z" },
        { delivery_consent_version: DELIVERY_CONSENT_VERSION, delivery_consented_at: "yesterday" },
        { delivery_consent_version: 1, delivery_consented_at: "2026-11-17T10:00:00.000Z" },
        { delivery_consent_version: "garbage", delivery_consented_at: "2026-11-17T10:00:00.000Z" },
        { delivery_consent_version: "2026-11-17", delivery_consented_at: "2026-11-17T10:00:00.000Z" },
        { delivery_consent_version: ` ${DELIVERY_CONSENT_VERSION}`, delivery_consented_at: "2026-11-17T10:00:00.000Z" },
        { delivery_consent_version: DELIVERY_CONSENT_VERSION, delivery_consented_at: "2026-11-17" },
        { delivery_consent_version: DELIVERY_CONSENT_VERSION, delivery_consented_at: "2026-11-17T10:00:00+01:00" },
        { delivery_consent_version: DELIVERY_CONSENT_VERSION, delivery_consented_at: "2026-13-45T10:00:00.000Z" },
        { delivery_consent_version: DELIVERY_CONSENT_VERSION, delivery_consented_at: 1_763_373_600_000 },
        {},
      ]) {
        const error = yield* Effect.flip(Effect.asVoid(grantSettings.decode(row)));
        assert.strictEqual(error._tag, "GrantSettingsError", JSON.stringify(row));
      }
    }),
  );

  it.effect("records the current version and time for read, nothing for send only", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-17T12:34:56.789Z"));
      const read = yield* grantSettings.fromConsent(TICKED, [READ_SCOPE, SEND_SCOPE]);
      assert.deepStrictEqual(read, {
        deliveryConsentVersion: DELIVERY_CONSENT_VERSION,
        deliveryConsentedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse("2026-11-17T12:34:56.789Z"))),
      });
      assert.deepStrictEqual(grantSettings.encode(read), {
        delivery_consent_version: DELIVERY_CONSENT_VERSION,
        delivery_consented_at: "2026-11-17T12:34:56.789Z",
      });
      for (const posted of [TICKED, form([])]) {
        const send = yield* grantSettings.fromConsent(posted, [SEND_SCOPE]);
        assert.deepStrictEqual(send, { deliveryConsentVersion: null, deliveryConsentedAt: null });
        assert.deepStrictEqual(grantSettings.encode(send), { delivery_consent_version: null, delivery_consented_at: null });
      }
    }),
  );

  it.effect("refuses read without exactly one ticked consent, and a grant without scopes", () =>
    Effect.gen(function* () {
      for (const posted of [
        form([]),
        form([["isds_delivery_consent", "yes"]]),
        form([
          ["isds_delivery_consent", "on"],
          ["isds_delivery_consent", "on"],
        ]),
      ]) {
        const error = yield* Effect.flip(Effect.asVoid(grantSettings.fromConsent(posted, [READ_SCOPE])));
        assert.include(error.message, "delivery consent", posted.toString());
      }
      const none = yield* Effect.flip(Effect.asVoid(grantSettings.fromConsent(TICKED, [])));
      assert.strictEqual(none.message, "Select at least one permission.");
    }),
  );
});
