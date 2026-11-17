import { createHash } from "node:crypto";
import { Cause, Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GrantSettings } from "../src/oauth/grant-settings.js";
import { type Grant, makeOAuthStore } from "../src/oauth/store.js";
import {
  BOXES,
  Browser,
  DEMO_NOTES,
  DEMO_OAUTH_NOTES,
  type DemoServer,
  demoDatabase,
  hiddenField,
  NOTE_MIGRATIONS,
  NOTE_STYLE,
  PASSWORD,
  PUBLIC_URL,
  pkcePair,
  principalAfter,
  REDIRECT_URI,
  RESOURCE,
  startDemo,
  toConsent,
} from "./support/demo-oauth.js";

/**
 * Core OAuth with an app of its own (demo-mcp: data boxes, demo:read and
 * demo:write): its identity, scopes and resources reach every step from
 * metadata to the principal /mcp sees.
 */

describe("core OAuth for another app", () => {
  let server: DemoServer;
  beforeEach(() => {
    server = startDemo();
  });
  afterEach(() => server.close());

  it("names the app's scopes and identity in metadata and challenges", async () => {
    const metadata = (await (await server.fetch("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      resource: RESOURCE,
      resource_name: "demo-mcp",
      scopes_supported: ["demo:read", "demo:write"],
    });
    const unauthenticated = await server.fetch("/whoami");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain('scope="demo:read"');
  });

  it("authorizes, consents to boxes, issues tokens and authenticates a principal with demo scopes and box ids", async () => {
    const registration = await server.fetch("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Box reader", redirect_uris: [REDIRECT_URI] }),
    });
    expect(registration.status).toBe(201);
    const clientId = String(((await registration.json()) as Record<string, unknown>).client_id);
    expect(clientId).toMatch(/^demo_client_/);

    const { verifier, challenge } = pkcePair();
    const authorize = new URL("/authorize", PUBLIC_URL);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      state: "s1",
      scope: "demo:read demo:write",
    })) {
      authorize.searchParams.set(key, value);
    }

    const browser = new Browser(server);
    const start = await browser.get(authorize);
    expect(start.status).toBe(303);
    expect(start.headers.get("location")).toBe("/login");
    expect(browser.cookies[0]).toMatch(/^__Host-demo-mcp-auth=/);

    const loginPage = await (await browser.get("/login")).text();
    expect(loginPage).toContain("<title>demo-mcp sign-in</title>");
    expect(loginPage).toContain("asks to use your data boxes.");
    const login = await browser.post("/login", { csrf: hiddenField(loginPage, "csrf"), password: PASSWORD });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/consent");

    const consentPage = await (await browser.get("/consent")).text();
    expect(consentPage).toContain("<title>demo-mcp authorization</title>");
    expect(consentPage).toContain("<legend>Boxes</legend>");
    expect(consentPage).toContain('name="scope" value="demo:write" checked>');
    for (const box of BOXES) expect(consentPage).toContain(`name="box" value="${box.label}" checked>`);

    const consent = await browser.post("/consent", {
      csrf: hiddenField(consentPage, "csrf"),
      form: hiddenField(consentPage, "form"),
      decision: "approve",
      box: ["Home"],
      scope: ["demo:write"],
    });
    expect(consent.status).toBe(303);
    const callback = new URL(consent.headers.get("location") ?? "");
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("s1");
    const code = callback.searchParams.get("code") ?? "";
    expect(code).toMatch(/^demo_ac_/);

    const token = await server.fetch("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    });
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as Record<string, unknown>;
    expect(tokens.access_token).toMatch(/^demo_at_/);
    expect(tokens.refresh_token).toMatch(/^demo_rt_/);
    expect(tokens.scope).toBe("demo:read demo:write");

    const whoami = await server.fetch("/whoami", { headers: { authorization: `Bearer ${String(tokens.access_token)}` } });
    expect(whoami.status).toBe(200);
    const principal = (await whoami.json()) as Record<string, unknown>;
    expect(principal.subject).toMatch(/^demo_grant_/);
    expect(principal.scopes).toEqual(["demo:read", "demo:write"]);
    expect(principal.resources).toEqual(["box-91c2"]);
  });

  it("refuses an approval without a box in the app's words", async () => {
    const registration = await server.fetch("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    });
    const clientId = String(((await registration.json()) as Record<string, unknown>).client_id);
    const authorize = new URL("/authorize", PUBLIC_URL);
    const { challenge } = pkcePair();
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
    })) {
      authorize.searchParams.set(key, value);
    }
    const browser = new Browser(server);
    await browser.get(authorize);
    const loginPage = await (await browser.get("/login")).text();
    await browser.post("/login", { csrf: hiddenField(loginPage, "csrf"), password: PASSWORD });
    const consentPage = await (await browser.get("/consent")).text();
    expect(consentPage).toContain('name="scope" value="demo:write">');
    const refused = await browser.post("/consent", {
      csrf: hiddenField(consentPage, "csrf"),
      form: hiddenField(consentPage, "form"),
      decision: "approve",
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Select at least one box.");
  });
});

describe("per-grant app settings (OAuthApp.grantSettings)", () => {
  let server: DemoServer;
  beforeEach(() => {
    server = startDemo(DEMO_OAUTH_NOTES, NOTE_MIGRATIONS);
  });
  afterEach(() => server.close());

  const approve = async (browser: Browser, page: string, fields: Record<string, string | ReadonlyArray<string>>) =>
    browser.post("/consent", { csrf: hiddenField(page, "csrf"), form: hiddenField(page, "form"), decision: "approve", ...fields });

  it("stores the consent's settings and hands them, with the client, to the principal", async () => {
    const { browser, clientId, verifier } = await toConsent(server, "demo:read demo:write");
    const page = await (await browser.get("/consent")).text();
    expect(page).toContain('<input type="text" name="note" value="">');
    const consent = await approve(browser, page, { box: ["Home"], scope: ["demo:write"], note: "for the office" });
    expect(consent.status).toBe(303);
    const principal = await principalAfter(server, clientId, verifier, consent);
    expect(principal).toMatchObject({ clientId, scopes: ["demo:read", "demo:write"], resources: ["box-91c2"] });
    expect(principal.settings).toEqual({ note: "for the office" });
  });

  it("gives a grant without the app's scope the app's value for it", async () => {
    const { browser, clientId, verifier } = await toConsent(server, "demo:read");
    const page = await (await browser.get("/consent")).text();
    const consent = await approve(browser, page, { box: ["Office"], note: "IGNORED!" });
    expect(consent.status).toBe(303);
    expect((await principalAfter(server, clientId, verifier, consent)).settings).toEqual({ note: null });
  });

  it("shows the page again with the owner's own values when the app or core refuses the form", async () => {
    const { browser, clientId, verifier } = await toConsent(server, "demo:read demo:write");
    const page = await (await browser.get("/consent")).text();
    const refused = await approve(browser, page, { box: ["Home"], scope: ["demo:write"], note: "Not <ok>" });
    expect(refused.status).toBe(400);
    const again = await refused.text();
    expect(again).toContain("Note: 1 to 40 lowercase letters.");
    expect(again).toContain('name="note" value="Not &lt;ok&gt;"');
    // Core's own refusal (no box) also keeps what the owner typed.
    const noBox = await approve(browser, again, { scope: ["demo:write"], note: "kept note" });
    expect(noBox.status).toBe(400);
    const third = await noBox.text();
    expect(third).toContain("Select at least one box.");
    expect(third).toContain('name="note" value="kept note"');
    const consent = await approve(browser, third, { box: ["Home"], scope: ["demo:write"], note: "kept note" });
    expect(consent.status).toBe(303);
    expect((await principalAfter(server, clientId, verifier, consent)).settings).toEqual({ note: "kept note" });
  });

  it("joins the app's CSS to the one style block, and the CSP hash covers it", async () => {
    const { browser } = await toConsent(server, "demo:read");
    // The consent page, and an error page (no sign-in session).
    for (const response of [await browser.get("/consent"), await server.fetch("/consent")]) {
      expect(response.headers.get("content-type")).toContain("text/html");
      const style = /<style>([^<]*)<\/style>/.exec(await response.text())?.[1] ?? "";
      expect(style.endsWith(NOTE_STYLE)).toBe(true);
      const hash = createHash("sha256").update(style, "utf8").digest("base64");
      expect(response.headers.get("content-security-policy")).toContain(`style-src 'sha256-${hash}'`);
    }
  });

  it("gives an app without grant settings principals without settings", async () => {
    const plain = startDemo();
    try {
      const { browser, clientId, verifier } = await toConsent(plain, "demo:read");
      const page = await (await browser.get("/consent")).text();
      const principal = await principalAfter(plain, clientId, verifier, await approve(browser, page, { box: ["Home"] }));
      expect(principal.clientId).toBe(clientId);
      expect(principal).not.toHaveProperty("settings");
    } finally {
      await plain.close();
    }
  });
});

describe("grant settings in the OAuth store", () => {
  const CLIENT = "demo_client_store";
  const grant = (grantId: string, settings: unknown): Grant => ({
    grantId,
    clientId: CLIENT,
    scopes: ["demo:read", "demo:write"],
    resources: ["box-7f3a"],
    resource: RESOURCE,
    settings,
  });

  /** A store with `codec` on a database with or without the app's columns; one live grant with `settings`. */
  const withGrant = <A, E>(
    settings: unknown,
    use: (store: Effect.Success<ReturnType<typeof makeOAuthStore>>, now: number) => Effect.Effect<A, E, SqlClient.SqlClient>,
    codec: GrantSettings = DEMO_NOTES,
  ) =>
    Effect.gen(function* () {
      const store = yield* makeOAuthStore(undefined, codec);
      const now = 1_000_000;
      yield* store.insertClient({ clientId: CLIENT, clientName: null, redirectUris: [REDIRECT_URI], createdAt: now, lastUsedAt: null }, 10);
      yield* store.createGrant(
        grant("demo_grant_store", settings),
        { codeHash: "code_store", clientId: CLIENT, redirectUri: REDIRECT_URI, codeChallenge: "x", expiresAt: now + 60_000 },
        now,
      );
      yield* store.insertTokens("demo_grant_store", {
        accessHash: "access_store",
        accessExpiresAt: now + 60_000,
        refreshHash: "refresh_store",
        refreshExpiresAt: now + 120_000,
      });
      return yield* use(store, now);
    }).pipe(Effect.provide(demoDatabase(NOTE_MIGRATIONS)));

  it("writes the app's columns (null as NULL) and decodes them on every grant read", async () => {
    const stored = await Effect.runPromise(
      withGrant({ note: "desk" }, (store, now) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{ demo_note: string | null }>`SELECT demo_note FROM oauth_grants`;
          const [listed] = yield* store.listGrants(now);
          const access = yield* store.accessGrant("access_store", now);
          return { row, listed: listed?.settings, access: Option.map(access, (g) => g.settings) };
        }),
      ),
    );
    expect(stored).toEqual({ row: { demo_note: "desk" }, listed: { note: "desk" }, access: Option.some({ note: "desk" }) });
    const empty = await Effect.runPromise(
      withGrant({ note: null }, () =>
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ demo_note: string | null }>`SELECT demo_note FROM oauth_grants`),
      ),
    );
    expect(empty).toEqual([{ demo_note: null }]);
  });

  it("updates the settings of a live grant only", async () => {
    const result = await Effect.runPromise(
      withGrant({ note: null }, (store, now) =>
        Effect.gen(function* () {
          const updated = yield* store.updateGrantSettings("demo_grant_store", { note: "new note" }, now);
          const [listed] = yield* store.listGrants(now);
          const unknown = yield* store.updateGrantSettings("demo_grant_unknown", { note: "x" }, now);
          yield* store.revokeGrant("demo_grant_store", now);
          const revoked = yield* store.updateGrantSettings("demo_grant_store", { note: "late" }, now);
          return { updated, settings: listed?.settings, unknown, revoked };
        }),
      ),
    );
    expect(result).toEqual({ updated: true, settings: { note: "new note" }, unknown: false, revoked: false });
  });

  it("fails every grant read on a stored value the app cannot decode, never falling back", async () => {
    const result = await Effect.runPromise(
      withGrant({ note: "desk" }, (store, now) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE oauth_grants SET demo_note = 'NOT A NOTE'`;
          const listed = yield* Effect.exit(store.listGrants(now));
          const access = yield* Effect.exit(store.accessGrant("access_store", now));
          return { listed: Exit.isFailure(listed), access: Exit.isFailure(access) };
        }),
      ),
    );
    expect(result).toEqual({ listed: true, access: true });
  });

  it("fails code redemption and refresh rotation on a stored value the app cannot decode", async () => {
    const run = (corrupt: boolean) =>
      Effect.runPromise(
        withGrant({ note: "desk" }, (store, now) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            if (corrupt) yield* sql`UPDATE oauth_grants SET demo_note = 'NOT A NOTE'`;
            const redeemed = yield* Effect.exit(store.redeemCode("code_store", now));
            const rotated = yield* Effect.exit(store.rotateRefresh("refresh_store", CLIENT, now, () => undefined));
            return { redeemed: Exit.isFailure(redeemed), rotated: Exit.isFailure(rotated) };
          }),
        ),
      );
    expect(await run(false)).toEqual({ redeemed: false, rotated: false });
    expect(await run(true)).toEqual({ redeemed: true, rotated: true });
  });

  it("refuses an encoding that does not name exactly the declared columns", async () => {
    const exit = await Effect.runPromiseExit(withGrant({ note: "desk" }, () => Effect.void, { ...DEMO_NOTES, encode: () => ({}) }));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  });
});
