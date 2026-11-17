import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Migrations } from "../src/migrations.js";
import type { Consent, OAuthApp } from "../src/oauth/app.js";
import {
  type Browser,
  DEMO_OAUTH_NOTES,
  type DemoServer,
  hiddenField,
  NOTE_MIGRATIONS,
  principalAfter,
  RESOURCE,
  startDemo,
  toConsent,
} from "./support/demo-oauth.js";

/**
 * demo-mcp records every consent in an audit table of its own (no foreign
 * key to oauth_grants) through OAuthApp.afterConsent, inside the transaction
 * that stores the grant.
 */

const AUDIT_MIGRATIONS: Migrations = {
  ...NOTE_MIGRATIONS,
  "0007_demo_consent_audit": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE demo_consent_audit (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        grant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        detail_json TEXT NOT NULL
      )
    `;
  }),
};

type Mode = "commit" | "fail" | "die" | "throw";

/** The internal detail a failing hook carries; it reaches the log, never the page. */
const INTERNAL = "audit volume /srv/demo-secret is full";

/** Each table's rows as JSON, read on the app's database outside any request's transaction. */
const TABLES = ["oauth_grants", "oauth_codes", "oauth_clients", "demo_consent_audit"] as const;
const rowRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const sql = yield* SqlClient.SqlClient;
    for (const table of TABLES) {
      yield* router.add("GET", `/test/rows/${table}`, () =>
        sql.unsafe(`SELECT * FROM ${table}`).pipe(Effect.map(HttpServerResponse.jsonUnsafe), Effect.orDie),
      );
    }
  }),
);

describe("the app's post-consent hook (OAuthApp.afterConsent)", () => {
  let server: DemoServer;
  let mode: Mode;
  let seen: Array<Consent>;

  const audited: OAuthApp = {
    ...DEMO_OAUTH_NOTES,
    afterConsent: (consent) => {
      seen.push(consent);
      // A hook that throws before it returns its effect.
      if (mode === "throw") throw new Error(INTERNAL);
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { grant } = consent;
        yield* sql`
          INSERT INTO demo_consent_audit ${sql.insert({
            at: consent.at,
            grant_id: grant.grantId,
            client_id: grant.clientId,
            detail_json: JSON.stringify({ resources: grant.resources, scopes: grant.scopes, settings: grant.settings }),
          })}
        `;
        // Both failures come after the hook's own write: it is rolled back too.
        if (mode === "fail") return yield* Effect.fail({ message: INTERNAL });
        if (mode === "die") return yield* Effect.die(new Error(INTERNAL));
      });
    },
  };

  beforeEach(() => {
    mode = "commit";
    seen = [];
    server = startDemo(audited, AUDIT_MIGRATIONS, rowRoutes);
  });
  afterEach(() => server.close());

  const rows = async (table: (typeof TABLES)[number]) =>
    (await (await server.fetch(`/test/rows/${table}`)).json()) as Array<Record<string, unknown>>;

  const approve = async (browser: Browser, page: string, fields: Record<string, string | ReadonlyArray<string>>) =>
    browser.post("/consent", { csrf: hiddenField(page, "csrf"), form: hiddenField(page, "form"), decision: "approve", ...fields });

  const consentPage = async (browser: Browser) => (await browser.get("/consent")).text();

  it("hands the hook the grant it creates, and the hook's write commits with it", async () => {
    const { browser, clientId, verifier } = await toConsent(server, "demo:read demo:write");
    const consent = await approve(browser, await consentPage(browser), {
      box: ["Home"],
      scope: ["demo:write"],
      note: "for the office",
    });
    expect(consent.status).toBe(303);

    const [grant, ...otherGrants] = await rows("oauth_grants");
    expect(otherGrants).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      grant: {
        grantId: grant?.grant_id,
        clientId,
        scopes: ["demo:read", "demo:write"],
        resources: ["box-91c2"],
        resource: RESOURCE,
        settings: { note: "for the office" },
      },
      at: grant?.created_at,
    });
    expect(await rows("demo_consent_audit")).toEqual([
      {
        id: 1,
        at: grant?.created_at,
        grant_id: grant?.grant_id,
        client_id: clientId,
        detail_json: JSON.stringify({
          resources: ["box-91c2"],
          scopes: ["demo:read", "demo:write"],
          settings: { note: "for the office" },
        }),
      },
    ]);
    // The code the redirect carries is the one stored with the grant.
    const principal = await principalAfter(server, clientId, verifier, consent);
    expect(principal).toMatchObject({ clientId, scopes: ["demo:read", "demo:write"], resources: ["box-91c2"] });
    expect(principal.settings).toEqual({ note: "for the office" });
  });

  it.each(["fails", "dies", "throws"] as const)(
    "rolls the whole authorization back when the hook %s: no grant, no code, no redirect, a safe error page",
    async (outcome) => {
      const failure = ({ fails: "fail", dies: "die", throws: "throw" } as const)[outcome];
      const { browser } = await toConsent(server, "demo:read demo:write");
      const page = await consentPage(browser);
      mode = failure;
      const refused = await approve(browser, page, { box: ["Home"], scope: ["demo:write"], note: "for the office" });
      expect(refused.status).toBe(500);
      expect(refused.headers.get("location")).toBeNull();
      expect(refused.headers.get("content-type")).toContain("text/html");
      const body = await refused.text();
      expect(body).toContain("<h1>Server error</h1><p>The authorization could not be stored.</p>");
      expect(body).not.toContain("code=");
      expect(body).not.toContain("demo-secret");
      expect(seen).toHaveLength(1);
      expect(await rows("oauth_grants")).toEqual([]);
      expect(await rows("oauth_codes")).toEqual([]);
      expect(await rows("demo_consent_audit")).toEqual([]);
      expect((await rows("oauth_clients")).map((client) => client.last_used_at)).toEqual([null]);

      // Nothing half-done is left behind: the same approval succeeds once the hook does.
      mode = "commit";
      const again = await approve(browser, page, { box: ["Home"], scope: ["demo:write"], note: "for the office" });
      expect(again.status).toBe(303);
      expect(await rows("oauth_grants")).toHaveLength(1);
      expect(await rows("demo_consent_audit")).toHaveLength(1);
    },
  );

  it("calls the hook as a method of the app", async () => {
    const receivers: Array<string> = [];
    const methodical = {
      ...DEMO_OAUTH_NOTES,
      auditTable: "demo_consent_audit",
      afterConsent(this: { readonly auditTable: string }, _consent: Consent) {
        receivers.push(this.auditTable);
        return Effect.void;
      },
    };
    const other = startDemo(methodical, AUDIT_MIGRATIONS);
    try {
      const { browser } = await toConsent(other, "demo:read");
      const page = await consentPage(browser);
      expect((await approve(browser, page, { box: ["Home"] })).status).toBe(303);
      expect(receivers).toEqual(["demo_consent_audit"]);
    } finally {
      await other.close();
    }
  });

  it("runs no hook for a consent that stores no grant", async () => {
    const { browser } = await toConsent(server, "demo:read");
    const page = await consentPage(browser);
    expect((await approve(browser, page, {})).status).toBe(400);
    const denied = await browser.post("/consent", { csrf: hiddenField(page, "csrf"), form: hiddenField(page, "form"), decision: "deny" });
    expect(new URL(denied.headers.get("location") ?? "").searchParams.get("error")).toBe("access_denied");
    expect(seen).toEqual([]);
    expect(await rows("oauth_grants")).toEqual([]);
    expect(await rows("demo_consent_audit")).toEqual([]);
  });
});
