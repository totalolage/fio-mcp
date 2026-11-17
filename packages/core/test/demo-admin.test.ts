import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoginResult } from "../src/oauth/login.js";
import {
  ADMIN_COOKIE,
  AdminBrowser,
  type DemoAdmin,
  type DemoAdminOptions,
  PASSWORD,
  PEER_HEADER,
  PUBLIC_URL,
  startDemoAdmin,
} from "./support/demo-admin.js";

/**
 * The core admin UI composed by a second app: its name, cookie, password
 * hint and resources heading come from the app, and its injected tabs sit
 * where they ask in the nav (first, at /admin, or right after "Connected
 * clients"), with their pages, actions and per-grant settings behind the
 * same session, CSRF, second-factor and allowed-network checks as the core
 * tabs.
 */

let app: DemoAdmin;

/** Client demo_client_1 ("Desk") with live grant demo_grant_1 over box-1 and a removed box. */
const seedClient = (target: DemoAdmin, scopes: ReadonlyArray<string>) => {
  const now = Date.now();
  const redirectUri = "http://127.0.0.1:45678/callback";
  return target.store((store) =>
    Effect.gen(function* () {
      yield* store.insertClient(
        { clientId: "demo_client_1", clientName: "Desk", redirectUris: [redirectUri], createdAt: now, lastUsedAt: null },
        100,
      );
      yield* store.createGrant(
        { grantId: "demo_grant_1", clientId: "demo_client_1", scopes, resources: ["box-1", "box-gone"], resource: `${PUBLIC_URL}/mcp`, settings: "" },
        { codeHash: "code-hash", clientId: "demo_client_1", redirectUri, codeChallenge: "challenge", expiresAt: now + 60_000 },
        now,
      );
    }),
  );
};

/** Restarts the app with `options`. */
const restart = async (options: DemoAdminOptions) => {
  await app.close();
  app = await startDemoAdmin(options);
};

beforeEach(async () => {
  app = await startDemoAdmin();
});

afterEach(async () => {
  await app.close();
});

describe("demo app admin", () => {
  it("signs in under the app's name and shows its tab in the shell", async () => {
    const browser = new AdminBrowser(app);
    expect((await browser.get("/admin")).location).toBe("/admin/login");

    const login = await browser.get("/admin/login");
    expect(login.status).toBe(200);
    expect(login.html).toContain("<title>demo-mcp admin sign-in</title>");
    expect(login.html).toContain("<h1>demo-mcp admin</h1>");
    expect(browser.cookie?.startsWith(`${ADMIN_COOKIE}=`)).toBe(true);

    expect((await browser.post("/admin/login", { password: "wrong password!" })).status).toBe(401);
    const signedIn = await browser.signIn();
    expect(signedIn.status).toBe(303);
    expect(signedIn.location).toBe("/admin");

    const home = await browser.get("/admin");
    expect(home.status).toBe(200);
    expect(home.html).toContain("<title>demo-mcp admin: Boxes</title>");
    expect(home.html).toContain(
      '<nav><strong>demo-mcp admin</strong><span aria-current="page">Boxes</span><a href="/admin/clients">Connected clients</a><a href="/admin/shelves">Shelves</a><a href="/admin/password">Admin password</a>',
    );
    expect(home.html).toContain("<li>Inbox</li>");

    const password = await browser.get("/admin/password");
    expect(password.html).toContain("<title>demo-mcp admin: Admin password</title>");
    expect(password.html).toContain(
      "it then replaces the hash in DEMO_MCP_ADMIN_PASSWORD_HASH_FILE until <code>demo-mcp reset-admin-password</code> is run.",
    );
  });

  it("runs the tab's action for a verified form only", async () => {
    const browser = new AdminBrowser(app);
    await browser.signIn();
    await browser.get("/admin");

    expect((await browser.post("/admin/boxes/add", { label: "Archive" }, "x".repeat(43))).status).toBe(403);
    expect((await browser.get("/admin/boxes/add")).status).toBe(404);
    expect((await new AdminBrowser(app).post("/admin/boxes/add", { label: "Archive" })).location).toBe("/admin/login");

    const added = await browser.act("/admin/boxes/add", { label: "Archive" });
    expect(added.location).toBe("/admin");
    expect(added.message).toBe("Added box “Archive”.");
    expect(added.html).toContain("<li>Inbox</li><li>Archive</li>");

    expect((await browser.act("/admin/boxes/add", { label: "" })).message).toBe("Name the box.");
  });

  it("lists, revokes and removes clients, naming the app's resources", async () => {
    await seedClient(app, ["boxes:read"]);
    const browser = new AdminBrowser(app);
    await browser.signIn();

    const clients = await browser.get("/admin/clients");
    expect(clients.html).toContain("<title>demo-mcp admin: Connected clients</title>");
    expect(clients.html).toContain("<h2>“Desk”</h2>");
    expect(clients.html).toContain("<th>Scopes</th><th>Boxes</th>");
    expect(clients.html).toContain('<td>Inbox; <span class="muted">1 replaced or removed</span></td>');

    expect((await browser.act("/admin/grants/revoke", { grant: "demo_grant_1" })).message).toBe("Revoked the authorization.");
    const removed = await browser.act("/admin/clients/revoke", { client: "demo_client_1" });
    expect(removed.message).toBe("Removed the client and revoked its access.");
    expect(removed.html).toContain("<p>No registered clients.</p>");
  });

  it("places the tabs in the nav where they ask and serves a tab's further pages with the tab current", async () => {
    const browser = new AdminBrowser(app);
    await browser.signIn();

    const shelves = await browser.get("/admin/shelves?shelf=top");
    expect(shelves.status).toBe(200);
    expect(shelves.html).toContain("<title>demo-mcp admin: Shelves</title>");
    expect(shelves.html).toContain(
      '<a href="/admin">Boxes</a><a href="/admin/clients">Connected clients</a><span aria-current="page">Shelves</span><a href="/admin/password">Admin password</a>',
    );
    expect(shelves.html).toContain("<p>Showing shelf top.</p>");
    // No second factor configured: the form does not ask for a code.
    expect(shelves.html).not.toContain('name="totp"');

    const history = await browser.get("/admin/shelves/history");
    expect(history.status).toBe(200);
    expect(history.html).toContain("<title>demo-mcp admin: Shelves</title>");
    expect(history.html).toContain('<span aria-current="page">Shelves</span>');
    expect(history.html).toContain("<h1>Shelf history</h1>");
    expect((await new AdminBrowser(app).get("/admin/shelves/history")).location).toBe("/admin/login");
  });

  it("answers with a page's own status and error, keeping the one-shot message for the next page", async () => {
    const browser = new AdminBrowser(app);
    await browser.signIn();
    await browser.get("/admin");
    // Leaves "Name the box." in the session; the redirect target is not followed.
    expect((await browser.post("/admin/boxes/add", { label: "" })).status).toBe(303);

    const missing = await browser.get("/admin/shelves?shelf=missing");
    expect(missing.status).toBe(404);
    expect(missing.html).toContain('<p class="error" role="alert">No such shelf.</p>');
    expect(missing.html).not.toContain("Name the box.");

    const next = await browser.get("/admin/shelves");
    expect(next.status).toBe(200);
    expect(next.html).toContain('<p class="error" role="alert">Name the box.</p>');
  });

  it("sends an action to its own back page and offers the second factor only to verified forms, lazily", async () => {
    const checked: Array<string | null> = [];
    let answer: LoginResult<void> = { _tag: "Rejected" };
    await restart({
      secondFactor: (_request, form) =>
        Effect.sync(() => {
          checked.push(form.get("totp"));
          return answer;
        }),
    });
    const browser = new AdminBrowser(app);
    await browser.signIn();
    await browser.get("/admin/shelves");

    // Not verified: no check runs.
    expect((await browser.post("/admin/shelves/lock", { confirm: "yes" }, "x".repeat(43))).status).toBe(403);
    expect((await new AdminBrowser(app).post("/admin/shelves/lock", { confirm: "yes" })).location).toBe("/admin/login");
    const foreign = await app.fetch(
      new Request(`${PUBLIC_URL}/admin/shelves/lock`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie: browser.cookie ?? "" },
        body: new URLSearchParams({ confirm: "yes", csrf: browser.csrf ?? "" }),
      }),
    );
    expect(foreign.status).toBe(403);
    // Verified, but the action does not run the check.
    const unconfirmed = await browser.act("/admin/shelves/lock", {});
    expect(unconfirmed.location).toBe("/admin/shelves/history");
    expect(unconfirmed.message).toBe("Tick the box to lock.");
    expect(checked).toEqual([]);

    const rejected = await browser.act("/admin/shelves/lock", { confirm: "yes", totp: "000000" });
    expect(rejected.message).toBe("Not locked: Rejected.");
    expect(checked).toEqual(["000000"]);

    answer = { _tag: "Accepted", value: undefined };
    const locked = await browser.act("/admin/shelves/lock", { confirm: "yes", totp: "123456" });
    expect(locked.location).toBe("/admin/shelves/history");
    expect(locked.message).toBe("Locked the shelves.");
    expect(locked.html).toContain("<p>Locked 1 times.</p>");
    expect(checked).toEqual(["000000", "123456"]);
  });

  it("checks the second factor with the admin password's code check for the client address", async () => {
    const verified: Array<readonly [string, string | undefined]> = [];
    await restart({
      password: (real) => ({
        ...real,
        totpEnabled: true,
        signIn: (address, password, code) =>
          code === "111111" ? real.signIn(address, password) : Effect.succeed<LoginResult<string>>({ _tag: "Rejected" }),
        verifyTotp: (address, code) =>
          Effect.sync((): LoginResult<void> => {
            verified.push([address, code]);
            return code === "222222" ? { _tag: "Accepted", value: undefined } : { _tag: "Throttled", retryAfterSeconds: 30 };
          }),
      }),
    });
    const browser = new AdminBrowser(app, { [PEER_HEADER]: "192.0.2.7" });
    expect((await browser.signIn({ totp: "111111" })).location).toBe("/admin");

    const shelves = await browser.get("/admin/shelves");
    expect(shelves.html).toContain('<input type="text" name="totp">');
    expect((await browser.act("/admin/shelves/lock", {})).message).toBe("Tick the box to lock.");
    expect(verified).toEqual([]);

    expect((await browser.act("/admin/shelves/lock", { confirm: "yes", totp: "999999" })).message).toBe("Not locked: Throttled.");
    expect((await browser.act("/admin/shelves/lock", { confirm: "yes", totp: "222222" })).message).toBe("Locked the shelves.");
    expect((await browser.act("/admin/shelves/lock", { confirm: "yes" })).message).toBe("Not locked: Throttled.");
    expect(verified).toEqual([
      ["192.0.2.7", "999999"],
      ["192.0.2.7", "222222"],
      ["192.0.2.7", ""],
    ]);
  });

  it("asks for the code at sign-in when a second factor is configured, and names busy sign-ins", async () => {
    let next: LoginResult<string> | undefined;
    const codes: Array<string | undefined> = [];
    await restart({
      password: (real) => ({
        ...real,
        totpEnabled: true,
        signIn: (address, password, code) => {
          codes.push(code);
          return next === undefined ? real.signIn(address, password) : Effect.succeed(next);
        },
      }),
    });
    const browser = new AdminBrowser(app);
    const login = await browser.get("/admin/login");
    expect(login.html).toContain('name="totp"');

    next = { _tag: "Rejected" };
    const wrong = await browser.post("/admin/login", { password: "wrong password!", totp: "123456" });
    expect(wrong.status).toBe(401);
    expect(wrong.html).toContain('<p class="error" role="alert">Wrong password or code.</p>');

    next = { _tag: "Throttled", retryAfterSeconds: 9, busy: true };
    const busy = await browser.post("/admin/login", { password: "x", totp: "123456" });
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(busy.html).toContain("Sign-in busy, try again.");

    next = { _tag: "Throttled", retryAfterSeconds: 9 };
    const throttled = await browser.post("/admin/login", { password: "x", totp: "123456" });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("9");
    expect(throttled.html).toContain("Too many failed attempts. Try again in 9 s.");

    next = undefined;
    expect((await browser.post("/admin/login", { password: PASSWORD, totp: "654321" })).location).toBe("/admin");
    expect(codes).toEqual(["123456", "123456", "123456", "654321"]);
  });

  it("names a wrong password without a second factor and keeps the code field off the sign-in page", async () => {
    const browser = new AdminBrowser(app);
    const login = await browser.get("/admin/login");
    expect(login.html).not.toContain('name="totp"');
    const wrong = await browser.post("/admin/login", { password: "wrong password!" });
    expect(wrong.status).toBe(401);
    expect(wrong.html).toContain('<p class="error" role="alert">Wrong password.</p>');
  });

  it("puts the app's grant settings after each grant row and runs their form, back on the clients tab", async () => {
    await seedClient(app, ["boxes:read", "boxes:write"]);
    const browser = new AdminBrowser(app);
    await browser.signIn();

    const clients = await browser.get("/admin/clients");
    expect(clients.html).toContain(
      '<button type="submit">Revoke</button></form></td>\n</tr>\n<tr><td colspan="5">Note “” on box-1, box-gone for <code>demo_client_1</code>',
    );
    expect((await browser.post("/admin/grants/note", { grant: "demo_grant_1", note: "fragile" }, "x".repeat(43))).status).toBe(403);
    expect((await browser.get("/admin/grants/note")).status).toBe(404);

    const saved = await browser.act("/admin/grants/note", { grant: "demo_grant_1", note: "fragile" });
    expect(saved.location).toBe("/admin/clients");
    expect(saved.message).toBe("Saved the note.");
    expect(saved.html).toContain("Note “fragile” on box-1, box-gone");
    const grants = await app.store((store) => store.listGrants(Date.now()));
    expect(grants.map((grant) => grant.settings)).toEqual(["fragile"]);

    expect((await browser.act("/admin/grants/note", { grant: "gone", note: "x" })).message).toBe("That authorization is no longer active.");
  });

  it("renders nothing after a grant row the app has no settings for", async () => {
    await seedClient(app, ["boxes:read"]);
    const browser = new AdminBrowser(app);
    await browser.signIn();
    const clients = await browser.get("/admin/clients");
    expect(clients.html).toContain('<button type="submit">Revoke</button></form></td>\n</tr>\n</tbody></table>');
  });

  it("answers 404 outside the allowed networks on every core and injected route", async () => {
    await restart({ allowedNetworks: ["10.0.0.0/8"] });
    const outside = new AdminBrowser(app, { [PEER_HEADER]: "192.0.2.1" });
    for (const path of ["/admin", "/admin/login", "/admin/clients", "/admin/password", "/admin/shelves", "/admin/shelves/history", "/ADMIN/shelves"]) {
      const page = await outside.get(path);
      expect([path, page.status, page.html]).toEqual([path, 404, ""]);
    }
    for (const path of ["/admin/login", "/admin/boxes/add", "/admin/shelves/lock", "/admin/grants/note", "/admin/grants/revoke"]) {
      expect([path, (await outside.post(path, { label: "x" })).status]).toEqual([path, 404]);
    }

    const inside = new AdminBrowser(app, { [PEER_HEADER]: "10.1.2.3" });
    expect((await inside.signIn()).location).toBe("/admin");
    expect((await inside.get("/admin/shelves/history")).status).toBe(200);
    expect((await inside.act("/admin/boxes/add", { label: "Archive" })).message).toBe("Added box “Archive”.");
  });
});
