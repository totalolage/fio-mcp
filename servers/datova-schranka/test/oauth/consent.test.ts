import { afterEach, assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { AuditLog } from "../../src/domain/audit-log.js";
import { BoxLocks } from "../../src/domain/box-locks.js";
import { BoxRegistry } from "../../src/domain/boxes.js";
import { DataKey, DomainConfig } from "../../src/domain/config.js";
import { READ_SCOPE, SEND_SCOPE } from "../../src/mcp/tool-group.js";
import { CONSENT_ACTION } from "../../src/oauth/app.js";
import { DELIVERY_CONSENT_SHA256, DELIVERY_CONSENT_VERSION, DELIVERY_CONSENT_WORDING } from "../../src/oauth/consent.js";
import { fakeIsdsTransports, loginResponder, passwordCredentials } from "../domain/support/fake-isds.js";
import { DATA_KEY } from "../domain/support/registry-harness.js";
import {
  clientAuthorization,
  DEFAULT_BOXES,
  type OAuthHarness,
  openConsent,
  PUBLIC_URL,
  type StartOptions,
  startOAuth,
  submitConsent,
  tokensFor,
} from "../support/oauth.js";

interface GrantRow {
  readonly grant_id: string;
  readonly client_id: string;
  readonly scopes: string;
  readonly account_fingerprints_json: string;
  readonly delivery_consent_version: string | null;
  readonly delivery_consented_at: string | null;
}

interface AuditRow {
  readonly actor_kind: string;
  readonly grant_id: string | null;
  readonly client_id: string | null;
  readonly subject: string | null;
  readonly action: string;
  readonly box_id: string | null;
  readonly outcome: string;
  readonly detail_json: string | null;
}

let harness: OAuthHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const start = async (options: StartOptions = {}) => {
  harness = await startOAuth(options);
  return harness;
};

const state = (h: OAuthHarness) =>
  h.sql(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const grants = yield* sql<GrantRow>`
        SELECT grant_id, client_id, scopes, account_fingerprints_json, delivery_consent_version, delivery_consented_at
        FROM oauth_grants`;
      const codes = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM oauth_codes`;
      const audit = yield* sql<AuditRow>`
        SELECT actor_kind, grant_id, client_id, subject, action, box_id, outcome, detail_json FROM audit_log`;
      return { grants, codes: codes[0]?.total ?? 0, audit };
    }),
  );

const BOX_IDS = DEFAULT_BOXES.map((box) => box.id);
const LABELS = DEFAULT_BOXES.map((box) => box.label);

/** The <input …> tag named `name` with `value`, or undefined. */
const inputTag = (html: string, name: string, value: string) =>
  new RegExp(`<input [^>]*name="${name}" value="${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`).exec(html)?.[0];

describe("consent page", () => {
  it("offers the boxes, isds:read ticked, isds:send unticked and the unticked delivery consent", async () => {
    const h = await start();
    const { url } = await clientAuthorization(h, [READ_SCOPE]);
    const { html } = await openConsent(h, url);
    for (const label of LABELS) assert.isDefined(inputTag(html, "box", label), label);
    assert.include(inputTag(html, "scope", READ_SCOPE) ?? "", " checked");
    assert.notInclude(inputTag(html, "scope", SEND_SCOPE) ?? "missing checked", " checked");
    const consent = inputTag(html, "isds_delivery_consent", "on");
    assert.isDefined(consent);
    assert.notInclude(consent ?? "", "checked");
    assert.notInclude(consent ?? "", "required");
    assert.include(html, DELIVERY_CONSENT_WORDING.cs);
    assert.include(html, DELIVERY_CONSENT_WORDING.en);
    assert.include(html, DELIVERY_CONSENT_VERSION);
    assert.include(html, "required for read access");
  });

  it("ticks the scopes the client asked for", async () => {
    const h = await start();
    const { url } = await clientAuthorization(h, [SEND_SCOPE]);
    const { html } = await openConsent(h, url);
    assert.notInclude(inputTag(html, "scope", READ_SCOPE) ?? "missing checked", " checked");
    assert.include(inputTag(html, "scope", SEND_SCOPE) ?? "", " checked");
  });
});

describe("consent approval", () => {
  it("refuses read without the delivery consent and stores nothing", async () => {
    const h = await start();
    const { url } = await clientAuthorization(h);
    const response = await submitConsent(await openConsent(h, url), { deliveryConsent: false });
    assert.strictEqual(response.status, 400);
    const html = await response.text();
    assert.include(html, "Read access needs the delivery consent");
    // Shown again as submitted: read still ticked, the consent still unticked.
    assert.include(inputTag(html, "scope", READ_SCOPE) ?? "", " checked");
    assert.notInclude(inputTag(html, "isds_delivery_consent", "on") ?? "missing checked", "checked");
    assert.deepStrictEqual(await state(h), { grants: [], codes: 0, audit: [] });
  });

  it("shows the page again with the posted scopes and the delivery consent unticked", async () => {
    const h = await start();
    for (const scopes of [[SEND_SCOPE], [READ_SCOPE]]) {
      const { url } = await clientAuthorization(h, [READ_SCOPE, SEND_SCOPE]);
      // Ticked, but no box selected: core shows the page again.
      const response = await submitConsent(await openConsent(h, url), { scopes, boxes: [], deliveryConsent: true });
      assert.strictEqual(response.status, 400);
      const html = await response.text();
      for (const scope of [READ_SCOPE, SEND_SCOPE]) {
        const tag = inputTag(html, "scope", scope) ?? "";
        assert.strictEqual(tag.includes(" checked"), scopes.includes(scope), `${scope} after posting ${scopes}`);
      }
      assert.notInclude(inputTag(html, "isds_delivery_consent", "on") ?? "missing checked", "checked");
    }
    assert.deepStrictEqual(await state(h), { grants: [], codes: 0, audit: [] });
  });

  it("judges the consent by the scopes ticked, not the scopes requested", async () => {
    const h = await start();
    // Asked for send only, read ticked without the consent: refused.
    const send = await clientAuthorization(h, [SEND_SCOPE]);
    const refused = await submitConsent(await openConsent(h, send.url), {
      scopes: [READ_SCOPE, SEND_SCOPE],
      deliveryConsent: false,
    });
    assert.strictEqual(refused.status, 400);
    assert.include(await refused.text(), "Read access needs the delivery consent");
    assert.deepStrictEqual(await state(h), { grants: [], codes: 0, audit: [] });
    // Asked for read, only send ticked, no consent: a send-only grant.
    const read = await clientAuthorization(h, [READ_SCOPE]);
    const approved = await submitConsent(await openConsent(h, read.url), { scopes: [SEND_SCOPE], deliveryConsent: false });
    assert.strictEqual(approved.status, 303);
    const { grants, audit } = await state(h);
    assert.deepStrictEqual(
      grants.map((grant) => [grant.scopes, grant.delivery_consent_version]),
      [[SEND_SCOPE, null]],
    );
    assert.strictEqual(audit.length, 1);
  });

  it("refuses an approval without any scope and stores nothing", async () => {
    const h = await start();
    const { url } = await clientAuthorization(h);
    const response = await submitConsent(await openConsent(h, url), { scopes: [] });
    assert.strictEqual(response.status, 400);
    assert.include(await response.text(), "Select at least one permission.");
    assert.deepStrictEqual(await state(h), { grants: [], codes: 0, audit: [] });
  });

  it("stores a read grant with its consent and exactly one consent audit row", async () => {
    const h = await start();
    const { url, clientId } = await clientAuthorization(h, [READ_SCOPE, SEND_SCOPE]);
    const response = await submitConsent(await openConsent(h, url), { scopes: [READ_SCOPE, SEND_SCOPE] });
    assert.strictEqual(response.status, 303);
    assert.isNotNull(new URL(response.headers.get("location") ?? "").searchParams.get("code"));
    const { grants, codes, audit } = await state(h);
    assert.strictEqual(codes, 1);
    assert.strictEqual(grants.length, 1);
    const [grant] = grants;
    assert.strictEqual(grant?.client_id, clientId);
    assert.strictEqual(grant?.scopes, `${READ_SCOPE} ${SEND_SCOPE}`);
    assert.deepStrictEqual(JSON.parse(grant?.account_fingerprints_json ?? ""), BOX_IDS);
    assert.strictEqual(grant?.delivery_consent_version, DELIVERY_CONSENT_VERSION);
    const consentedAt = grant?.delivery_consented_at ?? "";
    assert.isFalse(Number.isNaN(Date.parse(consentedAt)), consentedAt);
    assert.strictEqual(audit.length, 1);
    const [row] = audit;
    assert.deepStrictEqual(
      { ...row, detail_json: JSON.parse(row?.detail_json ?? "null") },
      {
        actor_kind: "consent",
        grant_id: grant?.grant_id ?? "",
        client_id: clientId,
        subject: grant?.grant_id ?? "",
        action: CONSENT_ACTION,
        box_id: null,
        outcome: "ok",
        detail_json: {
          boxIds: BOX_IDS,
          scopes: [READ_SCOPE, SEND_SCOPE],
          deliveryConsentVersion: DELIVERY_CONSENT_VERSION,
          wordingSha256: DELIVERY_CONSENT_SHA256,
          consentedAt,
        },
      },
    );
  });

  it("stores a send-only grant without the consent, ticked or not, and audits it with nulls", async () => {
    const h = await start();
    for (const deliveryConsent of [false, true]) {
      const { url } = await clientAuthorization(h, [SEND_SCOPE]);
      const response = await submitConsent(await openConsent(h, url), {
        scopes: [SEND_SCOPE],
        boxes: ["Main"],
        deliveryConsent,
      });
      assert.strictEqual(response.status, 303, String(deliveryConsent));
    }
    const { grants, audit } = await state(h);
    assert.strictEqual(grants.length, 2);
    assert.strictEqual(audit.length, 2);
    for (const grant of grants) {
      assert.strictEqual(grant.scopes, SEND_SCOPE);
      assert.strictEqual(grant.delivery_consent_version, null);
      assert.strictEqual(grant.delivery_consented_at, null);
    }
    for (const row of audit) {
      const detail = JSON.parse(row.detail_json ?? "null");
      assert.strictEqual(row.action, CONSENT_ACTION);
      assert.deepStrictEqual(
        { ...detail, consentedAt: typeof detail.consentedAt },
        {
          boxIds: ["box_main"],
          scopes: [SEND_SCOPE],
          deliveryConsentVersion: null,
          wordingSha256: null,
          consentedAt: "string",
        },
      );
    }
  });

  it("rolls the grant and its audit row back when the consent hook fails after writing", async () => {
    const h = await start({
      wrapApp: (real) => ({
        ...real,
        afterConsent: (consent) =>
          (real.afterConsent?.(consent) ?? Effect.void).pipe(Effect.andThen(Effect.fail({ message: "hook failed" }))),
      }),
    });
    const { url } = await clientAuthorization(h);
    const response = await submitConsent(await openConsent(h, url));
    assert.strictEqual(response.status, 500);
    assert.notInclude(await response.text(), "hook failed");
    // The audit row the real hook wrote joined the grant's transaction, so it is gone too.
    assert.deepStrictEqual(await state(h), { grants: [], codes: 0, audit: [] });
  });

  it("rolls the audit row back with the grant over the app's real BoxRegistry", async () => {
    const isds = fakeIsdsTransports(loginResponder({ owner: "abc2def" }));
    const registry = BoxRegistry.Default.pipe(
      Layer.provide(isds.layer),
      Layer.provide(DataKey.layer(DATA_KEY)),
      Layer.provide(DomainConfig.layer({ dataDir: "/nonexistent", environment: "production" })),
      Layer.provide(BoxLocks.Default),
    );
    const failing = await start({
      registry,
      wrapApp: (real) => ({
        ...real,
        afterConsent: (consent) =>
          (real.afterConsent?.(consent) ?? Effect.void).pipe(Effect.andThen(Effect.fail({ message: "hook failed" }))),
      }),
    });
    await failing.run(
      Effect.flatMap(Effect.service(BoxRegistry), (boxes) =>
        boxes.add({ label: "Real", environment: "production", credentials: passwordCredentials("owner") }),
      ),
    );
    const { url } = await clientAuthorization(failing);
    const response = await submitConsent(await openConsent(failing, url), { boxes: ["Real"] });
    assert.strictEqual(response.status, 500);
    const after = await state(failing);
    assert.deepStrictEqual({ grants: after.grants, codes: after.codes }, { grants: [], codes: 0 });
    // Only the registry's own audit of the add remains, never a consent row.
    assert.deepStrictEqual(
      after.audit.filter((row) => row.action === CONSENT_ACTION),
      [],
    );
  });

  it("rolls the grant back when the consent audit row cannot be written", async () => {
    const h = await start();
    await h.sql(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP TABLE audit_log`));
    const { url } = await clientAuthorization(h);
    const response = await submitConsent(await openConsent(h, url));
    assert.strictEqual(response.status, 500);
    const grants = await h.sql(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT grant_id FROM oauth_grants`));
    assert.deepStrictEqual(grants, []);
  });

  it("puts the decoded consent on the grant core reads back", async () => {
    const h = await start();
    await tokensFor(h);
    const grants = await h.store((store) => store.listGrants(Date.now()));
    assert.strictEqual(grants.length, 1);
    const { grants: rows } = await state(h);
    assert.deepStrictEqual(grants[0]?.settings, {
      deliveryConsentVersion: DELIVERY_CONSENT_VERSION,
      deliveryConsentedAt: rows[0]?.delivery_consented_at ?? "",
    });
  });
});

describe("harness extension hook", () => {
  it("serves the extra app with the harness services", async () => {
    // As an app part would: services captured when the layer builds, a route on the router.
    const probe = Layer.effectDiscard(
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add(
          "GET",
          "/probe",
          audit.list().pipe(
            Effect.map((page) => HttpServerResponse.text(`entries=${page.entries.length}`)),
            Effect.orDie,
          ),
        );
      }),
    );
    const h = await start({ app: probe });
    await tokensFor(h);
    const response = await h.fetch(`${PUBLIC_URL}/probe`);
    assert.strictEqual(await response.text(), "entries=1");
  });
});
