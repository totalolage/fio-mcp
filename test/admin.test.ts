import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CallToolResult, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, Redacted, Sink, Stdio, Stream, Terminal } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tokenFingerprint } from "../src/accounts.js";
import { makeCacheStore } from "../src/cache/store.js";
import { resetAdminPasswordCommand } from "../src/oauth/cli.js";
import { NOW, statement, TODAY, tx } from "./support/cache.js";
import {
  authorizationUrl,
  Browser,
  consentFormOf,
  csrfOf,
  LOOPBACK_REDIRECT,
  type OAuthHarness,
  PASSWORD,
  PUBLIC_URL,
  pkcePair,
  postMcp,
  RESOURCE,
  register,
  startOAuth,
  tokensFor,
} from "./support/oauth.js";
import { FIO_TOKEN, LAST_STATEMENT, SAVINGS_TOKEN } from "./support/transport.js";

const ADMIN_COOKIE = "__Secure-fio-mcp-admin";
const NEW_MAIN_TOKEN = "rotatedT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN";
const THIRD_TOKEN = "thirdT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ";
const NEW_PASSWORD = "a brand new admin password";

let harness: OAuthHarness;

beforeEach(async () => {
  harness = await startOAuth();
});

afterEach(async () => {
  await harness.close();
});

/** A browser for /admin: keeps the admin cookie and the last page's CSRF token, follows no redirects. */
class Admin {
  cookie: string | undefined;
  csrf: string | undefined;
  readonly setCookies: Array<string> = [];
  constructor(private readonly extra: Record<string, string> = {}) {}

  private absorb(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      this.setCookies.push(header);
      const [pair = ""] = header.split(";");
      const at = pair.indexOf("=");
      if (pair.slice(0, at) === ADMIN_COOKIE) {
        const value = pair.slice(at + 1);
        this.cookie = value === "" ? undefined : `${ADMIN_COOKIE}=${value}`;
      }
    }
    return response;
  }

  private headers(extra: Record<string, string> = {}) {
    return { ...this.extra, ...(this.cookie === undefined ? {} : { cookie: this.cookie }), ...extra };
  }

  async get(path: string, extra: Record<string, string> = {}) {
    return this.absorb(await harness.fetch(new URL(path, PUBLIC_URL), { headers: this.headers(extra) }));
  }

  /** GET a page and remember its CSRF token. */
  async page(path: string) {
    const response = await this.get(path);
    const html = await response.text();
    this.csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] ?? this.csrf;
    return { response, html };
  }

  async post(
    path: string,
    form: Record<string, string>,
    options: { origin?: string | undefined; csrf?: string | undefined; headers?: Record<string, string> } = {},
  ) {
    const body = new URLSearchParams(form);
    const csrf = "csrf" in options ? options.csrf : this.csrf;
    if (csrf !== undefined) body.set("csrf", csrf);
    const origin = "origin" in options ? options.origin : PUBLIC_URL;
    const headers = this.headers({
      "content-type": "application/x-www-form-urlencoded",
      ...(origin === undefined ? {} : { origin }),
      ...options.headers,
    });
    return this.absorb(await harness.fetch(new URL(path, PUBLIC_URL), { method: "POST", headers, body }));
  }

  async signIn(password = PASSWORD) {
    await this.page("/admin/login");
    const response = await this.post("/admin/login", { password });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin");
    return this.page("/admin");
  }

  /** POSTs a form, follows the redirect back, and returns the page's message. */
  async act(path: string, form: Record<string, string>) {
    const response = await this.post(path, form);
    expect(response.status, await response.clone().text()).toBe(303);
    const back = await this.page(response.headers.get("location") ?? "/admin");
    return { html: back.html, message: messageOf(back.html) };
  }
}

const messageOf = (html: string) => /<p class="(?:ok|error)" role="(?:status|alert)">([^<]*)<\/p>/.exec(html)?.[1] ?? "";

/** The account id in the row of `name` (from the accounts page). */
const idOf = (html: string, name: string) => {
  const rows = html.split("<tr>");
  const row = rows.find((candidate) => candidate.includes(`<strong>${name}</strong>`));
  const id = /name="id" value="([^"]+)"/.exec(row ?? "")?.[1];
  if (id === undefined) throw new Error(`no row for ${name}`);
  return id;
};

const signedIn = async () => {
  const admin = new Admin();
  await admin.signIn();
  return admin;
};

/** An MCP session with a bearer token; counts the tools/list_changed notifications it receives. */
const mcpSession = async (access: string) => {
  const client = new Client({ name: "admin-test", version: "1.0.0" });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changes++;
  });
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    requestInit: { headers: { authorization: `Bearer ${access}` } },
    fetch: (url, init) => harness.fetch(url, init),
  });
  await client.connect(transport);
  const enumOf = async (tool = "get_transactions") => {
    const listed = (await client.listTools()).tools.find((candidate) => candidate.name === tool);
    if (listed === undefined) return undefined;
    const account = listed.inputSchema.properties?.account as { enum?: ReadonlyArray<string> } | undefined;
    return account?.enum ?? [];
  };
  return { client, changes: () => changes, enumOf };
};

const text = (result: CallToolResult) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("admin sign-in and sessions", () => {
  it("is separate from OAuth: an MCP bearer token signs nothing in", async () => {
    const { access } = await tokensFor(harness);
    const bearer = { authorization: `Bearer ${access}` };
    const page = await harness.fetch(`${PUBLIC_URL}/admin`, { headers: bearer });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/admin/login");
    const add = await harness.fetch(`${PUBLIC_URL}/admin/accounts/add`, {
      method: "POST",
      headers: { ...bearer, "content-type": "application/x-www-form-urlencoded", origin: PUBLIC_URL },
      body: new URLSearchParams({ name: "sneaky", token: THIRD_TOKEN }),
    });
    expect(add.status).toBe(303);
    expect(add.headers.get("location")).toBe("/admin/login");
    expect((await harness.accounts().list.pipe(Effect.runPromise)).map((account) => account.name)).toEqual(["main", "savings"]);
  });

  it("signs in under a fresh session id with a strict cookie and strict page headers", async () => {
    const admin = new Admin();
    const login = await admin.page("/admin/login");
    expect(login.response.status).toBe(200);
    const csp = login.response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("unsafe-inline");
    expect(login.response.headers.get("x-frame-options")).toBe("DENY");
    expect(login.response.headers.get("cache-control")).toBe("no-store");
    const cookie = admin.setCookies[0] ?? "";
    expect(cookie).toMatch(/^__Secure-fio-mcp-admin=/);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/admin"]) expect(cookie).toContain(attribute);
    expect(cookie).not.toMatch(/Domain=/i);
    const preLogin = admin.cookie;

    const wrong = await admin.post("/admin/login", { password: "not the password" });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Wrong password.");
    const right = await admin.post("/admin/login", { password: PASSWORD });
    expect(right.status).toBe(303);
    expect(admin.cookie).toBeDefined();
    expect(admin.cookie).not.toBe(preLogin);
    expect((await admin.page("/admin")).response.status).toBe(200);
    // The pre-login id does not become a signed-in session (no fixation).
    const stale = await harness.fetch(`${PUBLIC_URL}/admin`, { headers: { cookie: preLogin ?? "" } });
    expect(stale.status).toBe(303);
  });

  it("refuses state changes without the session's CSRF token, from another origin, or as GET", async () => {
    const admin = await signedIn();
    const form = { name: "third", token: THIRD_TOKEN };
    expect((await admin.post("/admin/accounts/add", form, { csrf: undefined })).status).toBe(403);
    expect((await admin.post("/admin/accounts/add", form, { csrf: "x".repeat(43) })).status).toBe(403);
    expect((await admin.post("/admin/accounts/add", form, { origin: "https://evil.example" })).status).toBe(403);
    expect((await admin.get("/admin/accounts/add")).status).toBe(404);
    expect((await harness.accounts().list.pipe(Effect.runPromise)).length).toBe(2);
    expect((await admin.act("/admin/accounts/add", form)).message).toContain("Added “third”");
  });

  it("creates no session for sign-in posts without a sign-in form", async () => {
    const legit = new Admin();
    await legit.page("/admin/login");
    for (let i = 0; i < 150; i++) {
      const response = await harness.fetch(`${PUBLIC_URL}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC_URL },
        body: new URLSearchParams({ password: "guess" }),
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/admin/login");
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    // The pool of sign-in forms (100) was not churned: the open form still signs in.
    const right = await legit.post("/admin/login", { password: PASSWORD });
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe("/admin");
  });

  it("ends a session after 15 minutes without a request", async () => {
    const admin = await signedIn();
    harness.clock.advance(10 * 60_000);
    expect((await admin.get("/admin")).status).toBe(200);
    harness.clock.advance(10 * 60_000);
    expect((await admin.get("/admin")).status).toBe(200);
    harness.clock.advance(15 * 60_000 + 1_000);
    const expired = await admin.get("/admin");
    expect(expired.status).toBe(303);
    expect(expired.headers.get("location")).toBe("/admin/login");
  });

  it("shares failed-sign-in throttling with the OAuth sign-in page", async () => {
    const admin = new Admin();
    await admin.page("/admin/login");
    for (let i = 0; i < 6; i++) expect((await admin.post("/admin/login", { password: "wrong" })).status).toBe(401);
    expect((await admin.post("/admin/login", { password: PASSWORD })).status).toBe(429);
    // The OAuth sign-in from the same address waits too.
    const { body } = await register(harness, [LOOPBACK_REDIRECT]);
    const browser = new Browser(harness);
    const { challenge } = pkcePair();
    await browser.get(
      authorizationUrl({
        response_type: "code",
        client_id: String(body.client_id),
        redirect_uri: LOOPBACK_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      }),
    );
    const csrf = await csrfOf(await browser.get("/login"));
    expect((await browser.post("/login", { csrf, password: PASSWORD })).status).toBe(429);
  });
});

describe("accounts at /admin", () => {
  it("changes accounts at runtime: the next tools/list of a live session follows", async () => {
    const { access } = await tokensFor(harness, { accounts: ["main", "savings"] });
    const session = await mcpSession(access);
    expect(await session.enumOf()).toEqual(["main", "savings"]);
    const admin = await signedIn();

    // Rename keeps the grant.
    const renamed = await admin.act("/admin/accounts/rename", { id: idOf((await admin.page("/admin")).html, "savings"), name: "rainy day" });
    expect(renamed.message).toContain("Renamed to “rainy day”");
    expect(await session.enumOf()).toEqual(["main", "rainy day"]);
    // tools/list_changed is queued for the session and arrives with its next
    // tool call (a streamed response): Effect's Streamable HTTP endpoint has
    // no GET event stream (405) to push it sooner.
    expect(session.changes()).toBe(0);
    await session.client.callTool({ name: "get_server_status", arguments: {} });
    expect(session.changes()).toBe(1);
    const stream = await harness.fetch(RESOURCE, {
      headers: { authorization: `Bearer ${access}`, accept: "text/event-stream", "mcp-protocol-version": "2025-11-25" },
    });
    expect(stream.status).toBe(405);

    // A new token drops the account from existing grants.
    const page = await admin.page("/admin");
    expect((await admin.act("/admin/accounts/rotate", { id: idOf(page.html, "main"), token: NEW_MAIN_TOKEN })).message).toContain(
      "Replaced the token of “main”",
    );
    expect(await session.enumOf()).toEqual(["rainy day"]);
    const refused = (await session.client.callTool({ name: "get_server_status", arguments: {} })) as CallToolResult;
    expect(text(refused)).not.toContain('"main"');

    // An added account is not in anyone's grant.
    expect((await admin.act("/admin/accounts/add", { name: "third", token: THIRD_TOKEN, currency: "eur" })).message).toContain(
      "Added “third”",
    );
    expect(await session.enumOf()).toEqual(["rainy day"]);

    // Removing the last granted account hides the tools that take one.
    const before = await admin.page("/admin");
    expect((await admin.act("/admin/accounts/remove", { id: idOf(before.html, "rainy day"), cache: "keep", confirm: "yes" })).message).toContain(
      "Removed “rainy day”",
    );
    expect(await session.enumOf()).toBeUndefined();
    const status = (await session.client.callTool({ name: "get_server_status", arguments: {} })) as CallToolResult;
    expect(text(status)).not.toContain("rainy day");

    const accounts = await harness.accounts().list.pipe(Effect.runPromise);
    expect(accounts.map((account) => [account.name, account.configuredCurrency])).toEqual([
      ["main", "CZK"],
      ["third", "EUR"],
    ]);
    // The page shows the last four characters and never a token.
    const final = await admin.page("/admin");
    expect(final.html).toContain(`…${NEW_MAIN_TOKEN.slice(-4)}`);
    for (const token of [FIO_TOKEN, SAVINGS_TOKEN, NEW_MAIN_TOKEN, THIRD_TOKEN]) expect(final.html).not.toContain(token);
    expect(session.changes()).toBeGreaterThan(1);
    await session.client.close();
  });

  it("purges a removed account's cached data unless an account still reads that bank account, and says which", async () => {
    const admin = await signedIn();
    const commit = (token: string, accountName: string, ids: ReadonlyArray<number>, accountId?: string) =>
      harness.sql(
        Effect.flatMap(makeCacheStore(), (store) =>
          store.commit({
            accountName,
            tokenFingerprint: tokenFingerprint(Redacted.make(token)),
            statement: statement(TODAY, TODAY, ids.map((id) => tx(id, TODAY, 5)), accountId),
            fetchedAt: NOW,
          }),
        ),
      );
    const cached = () =>
      harness.sql(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          Effect.all({
            movements: Effect.map(sql<{ id: number }>`SELECT movement_id AS id FROM transactions ORDER BY movement_id`, (rows) =>
              rows.map((row) => row.id),
            ),
            bindings: Effect.map(sql<{ n: number }>`SELECT COUNT(*) AS n FROM bindings`, ([row]) => row?.n),
          }),
        ),
      );
    const remove = async (name: string) =>
      (await admin.act("/admin/accounts/remove", { id: idOf((await admin.page("/admin")).html, name), cache: "purge", confirm: "yes" })).message;

    // Cached under the first token, then under the replacing one: the old token's binding must not keep the data.
    await commit(FIO_TOKEN, "main", [101]);
    await admin.act("/admin/accounts/rotate", { id: idOf((await admin.page("/admin")).html, "main"), token: NEW_MAIN_TOKEN });
    await commit(NEW_MAIN_TOKEN, "main", [202]);
    expect(await cached()).toEqual({ movements: [101, 202], bindings: 2 });
    expect(await remove("main")).toContain("Removed “main”. Its cached transactions were deleted.");
    expect(await cached()).toEqual({ movements: [], bindings: 0 });

    // Another configured account reading the same bank account keeps it, and is named.
    await admin.act("/admin/accounts/add", { name: "third", token: THIRD_TOKEN });
    await commit(SAVINGS_TOKEN, "savings", [303], "2000000009");
    await commit(THIRD_TOKEN, "third", [404], "2000000009");
    expect(await remove("savings")).toContain("Removed “savings”. Its cached transactions were kept: “third” reads the same bank account.");
    expect(await cached()).toEqual({ movements: [303, 404], bindings: 1 });
    expect(await remove("third")).toContain("Removed “third”. Its cached transactions were deleted.");
    expect(await cached()).toEqual({ movements: [], bindings: 0 });

    // A token that never cached anything deletes nothing and says so.
    await admin.act("/admin/accounts/add", { name: "fourth", token: NEW_MAIN_TOKEN });
    expect(await remove("fourth")).toContain("Nothing was cached under its current token, so nothing was deleted.");
  });

  it("tests a token with one read-only call through its rate limiter, which follows a replaced token", async () => {
    const admin = await signedIn();
    const page = await admin.page("/admin");
    const main = idOf(page.html, "main");
    const first = await admin.act("/admin/accounts/test", { id: main });
    expect(first.message).toContain("FIO accepted the token of “main” for reading (latest statement 2026/7)");
    expect(LAST_STATEMENT).toContain("2026");
    // FIO allows one request per token every 30 s: the limiter refuses at once instead of waiting past its budget.
    const second = await admin.act("/admin/accounts/test", { id: main });
    expect(second.message).toMatch(/^The token test failed: Rate limited: .*Retry after \d+ s\.$/);
    // A replaced token has a limiter of its own.
    await admin.act("/admin/accounts/rotate", { id: main, token: NEW_MAIN_TOKEN });
    expect((await admin.act("/admin/accounts/test", { id: main })).message).toContain("FIO accepted the token");
    // The fake FioApi dies on last/set-last-*: nothing moved the download marker.
    expect(harness.logs.join("\n")).not.toMatch(/not used by transport tests/);
  });

  it("checks names and tokens without echoing them", async () => {
    const admin = await signedIn();
    const badToken = await admin.act("/admin/accounts/add", { name: "x", token: "short-secret<b>" });
    expect(badToken.message).toContain("The token must be at least 32 characters");
    expect(badToken.html).not.toContain("short-secret");
    const duplicate = await admin.act("/admin/accounts/add", { name: "  MAIN ", token: THIRD_TOKEN });
    expect(duplicate.message).toContain("Another account already has this name");
    const invisible = await admin.act("/admin/accounts/add", { name: "ma​in", token: THIRD_TOKEN });
    expect(invisible.message).toContain("The name must be 1-64 Unicode code points");
    const tooLong = await admin.act("/admin/accounts/add", { name: "😀".repeat(65), token: THIRD_TOKEN });
    expect(tooLong.message).toContain("The name must be 1-64");
    expect((await harness.accounts().list.pipe(Effect.runPromise)).length).toBe(2);
  });

  it("escapes account names and client names in every page", async () => {
    const admin = await signedIn();
    const evil = `<img src=x onerror="alert(1)">&'`;
    await admin.act("/admin/accounts/add", { name: evil, token: THIRD_TOKEN });
    const accounts = await admin.page("/admin");
    expect(accounts.html).not.toContain("<img src=x");
    expect(accounts.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;");
    await register(harness, [LOOPBACK_REDIRECT], `<script>alert("client")</script>`);
    const clients = await admin.page("/admin/clients");
    expect(clients.html).not.toContain("<script>");
    expect(clients.html).toContain("&lt;script&gt;alert(&quot;client&quot;)&lt;/script&gt;");
  });

  it("does not authorize a token that changed while the consent page was open", async () => {
    const { body } = await register(harness, [LOOPBACK_REDIRECT]);
    const browser = new Browser(harness);
    const { challenge } = pkcePair();
    await browser.get(
      authorizationUrl({
        response_type: "code",
        client_id: String(body.client_id),
        redirect_uri: LOOPBACK_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      }),
    );
    const csrf = await csrfOf(await browser.get("/login"));
    await browser.post("/login", { csrf, password: PASSWORD });
    // Tab A shows main's old token; then the token changes and tab B shows the new one.
    const tabA = await consentFormOf(await browser.get("/consent"));
    const admin = await signedIn();
    await admin.act("/admin/accounts/rotate", { id: idOf((await admin.page("/admin")).html, "main"), token: NEW_MAIN_TOKEN });
    const tabB = await consentFormOf(await browser.get("/consent"));
    // Tab A cannot approve the token it never showed, even after tab B rendered it.
    const changed = await browser.post("/consent", { ...tabA, decision: "approve", account: "main" });
    expect(changed.status).toBe(409);
    expect(await changed.text()).toContain("The accounts changed while this page was open");
    // Neither can a form id that was never issued.
    expect((await browser.post("/consent", { ...tabB, form: "made-up", decision: "approve", account: "main" })).status).toBe(409);
    const approved = await browser.post("/consent", { ...tabB, decision: "approve", account: "main" });
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toContain("code=");
  });
});

describe("connected clients at /admin", () => {
  it("lists clients and grants by account name, and revokes a grant, a client, or everything", async () => {
    const alice = await tokensFor(harness, { accounts: ["main"], payments: true });
    const bob = await tokensFor(harness, { accounts: ["savings"] });
    expect((await postMcp(harness, { authorization: `Bearer ${alice.access}` })).status).toBe(200);
    const admin = await signedIn();
    const page = await admin.page("/admin/clients");
    expect(page.html).toContain(alice.clientId);
    expect(page.html).toContain("<code>fio:payments</code>");
    expect(page.html).toMatch(/<td>main<\/td>/);
    expect(page.html).toMatch(/<td>savings<\/td>/);
    // Alice used her token; Bob did not.
    expect(page.html.match(/UTC<\/td>\n<td>never<\/td>/g)?.length).toBe(1);

    const grantId = /name="grant" value="([^"]+)"/.exec(page.html.slice(page.html.indexOf(alice.clientId)))?.[1] ?? "";
    expect((await admin.act("/admin/grants/revoke", { grant: grantId })).message).toBe("Revoked the authorization.");
    expect((await postMcp(harness, { authorization: `Bearer ${alice.access}` })).status).toBe(401);
    expect((await postMcp(harness, { authorization: `Bearer ${bob.access}` })).status).toBe(200);

    expect((await admin.act("/admin/clients/revoke", { client: bob.clientId })).message).toContain("Removed the client");
    expect((await postMcp(harness, { authorization: `Bearer ${bob.access}` })).status).toBe(401);
    expect((await harness.store((store) => store.client(bob.clientId))).valueOf()).toMatchObject({ _tag: "None" });

    const carol = await tokensFor(harness);
    expect((await admin.act("/admin/clients/revoke-all", {})).message).toBe("Tick the box to confirm.");
    expect((await admin.act("/admin/clients/revoke-all", { confirm: "yes" })).message).toContain("Revoked 1 active authorizations");
    expect((await postMcp(harness, { authorization: `Bearer ${carol.access}` })).status).toBe(401);
  });
});

/** Runs `fio-mcp reset-admin-password [--set]` against the harness's database. */
const resetPassword = (set: boolean, stdin = "") => {
  const stdio = Stdio.layerTest({
    stdin: Stream.make(new TextEncoder().encode(stdin)),
    stdinIsTerminal: Effect.succeed(false),
    stdout: () => Sink.drain,
    stderr: () => Sink.drain,
  });
  const terminal = Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readLine: Effect.die("no terminal"),
      readInput: Effect.die("no terminal"),
      display: () => Effect.void,
    }),
  );
  return harness.sql(resetAdminPasswordCommand(set, { ln: 14, r: 8, p: 1 }).pipe(Effect.provide(Layer.mergeAll(stdio, terminal))));
};

describe("admin password", () => {
  it("changes the password after checking the current one, signing out every other session", async () => {
    const admin = await signedIn();
    const other = await signedIn();
    expect((await admin.act("/admin/password", { current: PASSWORD, next: "short", confirm: "short" })).message).toContain(
      "12 to 1024 characters",
    );
    expect(
      (await admin.act("/admin/password", { current: PASSWORD, next: NEW_PASSWORD, confirm: `${NEW_PASSWORD}!` })).message,
    ).toBe("The new passwords do not match.");
    expect((await admin.act("/admin/password", { current: "wrong", next: NEW_PASSWORD, confirm: NEW_PASSWORD })).message).toBe(
      "The current password is wrong.",
    );
    const before = admin.cookie;
    const changed = await admin.act("/admin/password", { current: PASSWORD, next: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(changed.message).toBe("Password changed. Every other admin session was signed out.");
    expect(admin.cookie).not.toBe(before);
    expect((await admin.get("/admin")).status).toBe(200);
    expect((await other.get("/admin")).status).toBe(303);
    // The new password signs in at /admin and on the OAuth page; the old one no longer does.
    const fresh = new Admin();
    await fresh.page("/admin/login");
    expect((await fresh.post("/admin/login", { password: PASSWORD })).status).toBe(401);
    expect((await fresh.post("/admin/login", { password: NEW_PASSWORD })).status).toBe(303);
    // The hash lives in the database, never the password.
    const stored = await harness.sql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ value: string }>`SELECT value FROM server_settings WHERE key = 'admin_password_hash'`;
      }),
    );
    expect(stored[0]?.value).toMatch(/^\$scrypt\$ln=17,r=8,p=1\$/);
    expect(JSON.stringify(stored)).not.toContain(NEW_PASSWORD);

    // Recovery: `fio-mcp reset-admin-password` drops it; the hash file applies again and sessions end.
    await resetPassword(false);
    expect((await fresh.get("/admin")).status).toBe(303);
    const recovered = new Admin();
    await recovered.signIn(PASSWORD);
    // `--set` stores a new one read from standard input.
    await resetPassword(true, "a password from the cli\n");
    expect((await recovered.get("/admin")).status).toBe(303);
    await new Admin().signIn("a password from the cli");
  });
});
