import { createHash, randomBytes } from "node:crypto";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect, Layer, Predicate, Redacted, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { AdminPassword } from "../../src/admin/password.js";
import type { AppIdentity } from "../../src/app-identity.js";
import type { Migrations } from "../../src/migrations.js";
import type { OAuthApp } from "../../src/oauth/app.js";
import { type GrantSettings, GrantSettingsError } from "../../src/oauth/grant-settings.js";
import { escapeHtml } from "../../src/oauth/pages.js";
import { OAUTH_MIGRATIONS } from "../../src/oauth/store.js";
import { type Resource, Resources } from "../../src/resources.js";
import { Auth } from "../../src/transport/auth.js";

/**
 * A second app on core OAuth, unrelated to any shipped server: "demo-mcp"
 * guards data boxes with demo:read and demo:write. Everything it supplies is
 * an OAuthApp, a Resources service and an admin password.
 */

export const DEMO_APP: AppIdentity = { name: "demo-mcp", idPrefix: "demo" };
export const SCOPE_READ = "demo:read";
export const SCOPE_WRITE = "demo:write";

export const DEMO_OAUTH: OAuthApp = {
  identity: DEMO_APP,
  scopes: {
    supported: [SCOPE_READ, SCOPE_WRITE],
    defaults: [SCOPE_READ],
    challenge: SCOPE_READ,
    granted: (form) => (form.getAll("scope").includes(SCOPE_WRITE) ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ]),
  },
  consent: {
    tools: "your data boxes",
    permissions: (requested) =>
      `<label><input type="checkbox" checked disabled> Read messages (<code>${SCOPE_READ}</code>, required)</label>
<label><input type="checkbox" name="scope" value="${SCOPE_WRITE}"${requested.includes(SCOPE_WRITE) ? " checked" : ""}> Send messages (<code>${escapeHtml(SCOPE_WRITE)}</code>)</label>`,
    resources: {
      legend: "Boxes",
      field: "box",
      plural: "boxes",
      changed: "The boxes changed while this page was open. Review the selection and approve again.",
      none: "No data boxes are set up yet.",
      noneSelected: "Select at least one box.",
    },
  },
};

/**
 * Per-grant settings of demo-mcp: with demo:write the owner writes a note
 * (1 to 40 lowercase letters and spaces) on the consent page; it lives in
 * oauth_grants.demo_note, which the app's own migration adds. Without
 * demo:write the note is null (NULL in the column).
 */
export interface DemoNote {
  readonly note: string | null;
}

const NOTE = /^[a-z ]{1,40}$/;

export const NOTE_MIGRATIONS: Migrations = {
  "0003_demo_grant_note": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE oauth_grants ADD COLUMN demo_note TEXT`;
  }),
};

const isNote = (value: unknown): value is DemoNote =>
  Predicate.hasProperty(value, "note") && (value.note === null || (Predicate.isString(value.note) && NOTE.test(value.note)));

export const DEMO_NOTES: GrantSettings = {
  columns: ["demo_note"],
  decode: (row) => {
    const note = row.demo_note === null ? { note: null } : { note: row.demo_note };
    return isNote(note) ? Effect.succeed(note) : Effect.fail(new GrantSettingsError({ message: "demo note: malformed" }));
  },
  encode: (value) => ({ demo_note: isNote(value) ? value.note : null }),
  fromConsent: (form, granted) => {
    if (!granted.includes(SCOPE_WRITE)) return Effect.succeed({ note: null });
    const note = form.get("note") ?? "";
    return NOTE.test(note) ? Effect.succeed({ note }) : Effect.fail({ message: "Note: 1 to 40 lowercase letters." });
  },
};

/** The note field's CSS, joined to the pages' style block. */
export const NOTE_STYLE = ".note{font-style:italic}";

/** demo-mcp with its per-grant note: the field keeps what the owner typed when the page comes back. */
export const DEMO_OAUTH_NOTES: OAuthApp = {
  ...DEMO_OAUTH,
  grantSettings: DEMO_NOTES,
  consent: {
    ...DEMO_OAUTH.consent,
    style: NOTE_STYLE,
    permissions: (requested, posted) =>
      `${DEMO_OAUTH.consent.permissions(requested, posted)}
<label class="note">Note <input type="text" name="note" value="${escapeHtml(posted?.get("note") ?? "")}"></label>`,
  },
};

export const BOXES: ReadonlyArray<Resource> = [
  { id: "box-7f3a", label: "Office" },
  { id: "box-91c2", label: "Home" },
];

export const PUBLIC_URL = "https://demo.example.test";
export const RESOURCE = `${PUBLIC_URL}/mcp`;
export const PASSWORD = "demo password";
export const REDIRECT_URI = "http://127.0.0.1:45678/callback";

const boxes = Layer.succeed(Resources, Resources.of({ list: Effect.succeed(BOXES), changes: Stream.make(BOXES) }));

/** Accepts PASSWORD; the admin password's own behaviour is tested with the admin UI. */
const password = Layer.succeed(
  AdminPassword,
  AdminPassword.of({
    signIn: (_address, entered) =>
      Effect.succeed(Redacted.value(entered) === PASSWORD ? { _tag: "Accepted", value: "stamp" } : { _tag: "Rejected" }),
    stamp: Effect.succeed("stamp"),
    change: () => Effect.succeed({ _tag: "Rejected" }),
    totpEnabled: false,
    verifyTotp: () => Effect.succeed({ _tag: "Rejected" }),
  }),
);

/** The demo database: core's OAuth migrations and the app's own (`extra`). */
export const demoDatabase = (extra: Migrations = {}) =>
  Layer.effectDiscard(
    SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ ...OAUTH_MIGRATIONS, ...extra }), table: "demo_migrations" }),
  ).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })));

/** GET /whoami answers with the principal `Auth` makes of the request, or 401 with the challenge. */
const whoami = Layer.effectDiscard(
  Effect.gen(function* () {
    const auth = yield* Auth;
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add("GET", "/whoami", (request) =>
      auth.authenticate(request).pipe(
        Effect.map((principal) => HttpServerResponse.jsonUnsafe(principal)),
        Effect.catchTags({
          Unauthorized: (error) =>
            Effect.succeed(HttpServerResponse.empty({ status: 401, headers: { "www-authenticate": error.challenge } })),
          AuthUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
        }),
      ),
    );
  }),
);

export interface DemoServer {
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly close: () => Promise<void>;
}

/** demo-mcp, or `app` (e.g. DEMO_OAUTH_NOTES) on a database with `migrations` too. */
export function startDemo(oauthApp: OAuthApp = DEMO_OAUTH, migrations: Migrations = {}): DemoServer {
  const app = whoami.pipe(
    Layer.provideMerge(Auth.oauth(oauthApp, { publicUrl: PUBLIC_URL })),
    Layer.provide(Layer.mergeAll(boxes, password, demoDatabase(migrations))),
    Layer.provide(HttpServer.layerServices),
  );
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  return {
    fetch: (input, init) => web.handler(new Request(new URL(input, PUBLIC_URL), init)),
    close: () => web.dispose(),
  };
}

export const pkcePair = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** A user agent that keeps demo-mcp's session cookie and does not follow redirects. */
export class Browser {
  cookie: string | undefined;
  readonly cookies: Array<string> = [];
  constructor(private readonly server: DemoServer) {}

  private absorb(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      this.cookies.push(header);
      const [pair] = header.split(";");
      const [name, value] = (pair ?? "").split("=");
      if (name === "__Host-demo-mcp-auth") this.cookie = value === "" ? undefined : `${name}=${value}`;
    }
    return response;
  }

  async get(url: string | URL) {
    const headers: Record<string, string> = this.cookie === undefined ? {} : { cookie: this.cookie };
    return this.absorb(await this.server.fetch(url, { headers }));
  }

  async post(path: string, form: Record<string, string | ReadonlyArray<string>>) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      for (const item of typeof value === "string" ? [value] : value) body.append(key, item);
    }
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC_URL };
    if (this.cookie !== undefined) headers.cookie = this.cookie;
    return this.absorb(await this.server.fetch(path, { method: "POST", headers, body }));
  }
}

export const hiddenField = (html: string, name: string) => {
  const value = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  if (value === undefined) throw new Error(`no ${name} field in the page`);
  return value;
};

/** Registers a client and signs in up to the consent page for `scope`. */
export async function toConsent(server: DemoServer, scope: string) {
  const registration = await server.fetch("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Box writer", redirect_uris: [REDIRECT_URI] }),
  });
  const clientId = String(((await registration.json()) as Record<string, unknown>).client_id);
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
    scope,
  })) {
    authorize.searchParams.set(key, value);
  }
  const browser = new Browser(server);
  await browser.get(authorize);
  const loginPage = await (await browser.get("/login")).text();
  await browser.post("/login", { csrf: hiddenField(loginPage, "csrf"), password: PASSWORD });
  return { browser, clientId, verifier };
}

/** Redeems the code in a consent redirect and returns the principal /whoami sees for the access token. */
export async function principalAfter(server: DemoServer, clientId: string, verifier: string, consent: Response) {
  const code = new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? "";
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
  const tokens = (await token.json()) as Record<string, unknown>;
  const whoami = await server.fetch("/whoami", { headers: { authorization: `Bearer ${String(tokens.access_token)}` } });
  return (await whoami.json()) as Record<string, unknown>;
}
