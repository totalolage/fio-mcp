/**
 * A second, made-up app built on the core admin UI: "demo-mcp", whose tools
 * act on data boxes kept on shelves. It injects two tabs ("Boxes", at
 * /admin, first in the nav; "Shelves", right after "Connected clients",
 * with a further page and a form that may ask for the second factor), a
 * per-grant note on the connected-clients tab (its own oauth_grants
 * column), and keeps its admin password hash in memory. Served through a
 * web handler, with a cookie-keeping browser; PEER_HEADER sets the socket
 * peer address.
 */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Clock, Context, Effect, Exit, Layer, Option, Redacted, Ref, Scope, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { csrfField, type Flash, hidden } from "../../src/admin/pages.js";
import { AdminPassword, type AdminPasswordShape, type PasswordStore } from "../../src/admin/password.js";
import { AdminLive, type SecondFactorCheck } from "../../src/admin/server.js";
import { ADMIN_PATH } from "../../src/admin/sessions.js";
import { type AdminApp, type AdminFormFile, type AdminGrantSettings, type AdminTab, field, file } from "../../src/admin/tab.js";
import { hashPassword, PasswordHashError, parsePasswordHash } from "../../src/oauth/crypto.js";
import { type GrantSettings, GrantSettingsError } from "../../src/oauth/grant-settings.js";
import { escapeHtml } from "../../src/oauth/pages.js";
import { makeOAuthStore, OAUTH_MIGRATIONS, type OAuthStore } from "../../src/oauth/store.js";
import { type Resource, Resources } from "../../src/resources.js";
import { parseTrustedProxy } from "../../src/transport/client-address.js";

export const DEMO_IDENTITY = { name: "demo-mcp", idPrefix: "demo" };
export const ADMIN_COOKIE = "__Secure-demo-mcp-admin";
export const PUBLIC_URL = "https://demo.example.test";
export const PASSWORD = "correct horse battery staple";
/** The socket peer of a request (the web handler has none). */
export const PEER_HEADER = "x-test-peer";
const FAST_SCRYPT = { ln: 14, r: 8, p: 1 } as const;

/** The demo's grant setting: a note in its own oauth_grants column, for grants that may write boxes. */
export const NOTE_SETTINGS: GrantSettings = {
  columns: ["demo_note"],
  decode: (row) => {
    const note = row.demo_note;
    if (note === null || note === undefined) return Effect.succeed("");
    return typeof note === "string" ? Effect.succeed(note) : Effect.fail(new GrantSettingsError({ message: "malformed demo_note" }));
  },
  encode: (value) => ({ demo_note: typeof value === "string" && value !== "" ? value : null }),
  // Consent never sets a note.
  fromConsent: () => Effect.succeed(""),
};

/** The largest certificate import form (AdminFormLimits.maxBytes of /admin/boxes/import). */
export const IMPORT_MAX_BYTES = 256 * 1024;
/** The largest bulk-add form (url-encoded). */
export const BULK_MAX_BYTES = 64 * 1024;

/** What the multipart import action received. */
export interface DemoImport {
  readonly label: string | undefined;
  readonly passphrase: string | undefined;
  readonly certificate: AdminFormFile | undefined;
  readonly files: ReadonlyArray<AdminFormFile>;
}

/**
 * The demo app's tab: lists the boxes and adds one; imports a box
 * certificate (a multipart form with a file, up to IMPORT_MAX_BYTES, behind
 * the second factor) and adds boxes in bulk (url-encoded, up to
 * BULK_MAX_BYTES).
 */
const boxesTab = (boxes: Ref.Ref<ReadonlyArray<Resource>>, imports: Ref.Ref<ReadonlyArray<DemoImport>>): AdminTab => ({
  id: "boxes",
  label: "Boxes",
  path: ADMIN_PATH,
  render: (csrf) =>
    Effect.map(Ref.get(boxes), (list) => ({
      body: `<h1>Data boxes</h1>
<ul>${list.map((box) => `<li>${escapeHtml(box.label)}</li>`).join("")}</ul>
<form method="post" action="/admin/boxes/add">${csrfField(csrf)}<label>Box <input type="text" name="label"></label><button type="submit">Add box</button></form>`,
    })),
  actions: [
    {
      path: `${ADMIN_PATH}/boxes/add`,
      run: (form) => {
        const label = field(form, "label") ?? "";
        if (label === "") return Effect.fail({ message: "Name the box." });
        return Ref.update(boxes, (list) => [...list, { id: `box-${list.length + 1}`, label }]).pipe(
          Effect.as<Flash>({ kind: "ok", text: `Added box “${label}”.` }),
        );
      },
    },
    {
      path: `${ADMIN_PATH}/boxes/import`,
      form: { maxBytes: IMPORT_MAX_BYTES, multipart: true },
      run: (form, context) =>
        Effect.flatMap(context.checkSecondFactor, (factor) => {
          if (factor._tag !== "Accepted") return Effect.fail({ message: `Not imported: ${factor._tag}.` });
          const received: DemoImport = {
            label: field(form, "label"),
            passphrase: field(form, "passphrase"),
            certificate: file(context.files, "certificate"),
            files: context.files,
          };
          return Ref.update(imports, (list) => [...list, received]).pipe(
            Effect.as<Flash>({ kind: "ok", text: `Imported ${received.certificate === undefined ? "no" : "a"} certificate.` }),
          );
        }),
    },
    {
      path: `${ADMIN_PATH}/boxes/bulk`,
      form: { maxBytes: BULK_MAX_BYTES },
      run: (form) => Effect.succeed<Flash>({ kind: "ok", text: `Got ${(field(form, "labels") ?? "").length} characters.` }),
    },
  ],
});

/**
 * The second tab, after "Connected clients": `?shelf=` picks a shelf (an
 * unknown one is a 404 page with its own error), /admin/shelves/history is a
 * further page, and locking asks for the second factor once confirmed.
 */
const shelvesTab = (locked: Ref.Ref<number>): AdminTab => ({
  id: "shelves",
  label: "Shelves",
  path: `${ADMIN_PATH}/shelves`,
  nav: "after-clients",
  render: (csrf, request) => {
    const shelf = request.query.get("shelf") ?? "all";
    if (shelf === "missing") {
      return Effect.succeed({
        body: "<h1>Shelves</h1>",
        error: { kind: "error", text: "No such shelf." },
        status: 404,
      });
    }
    return Effect.succeed({
      body: `<h1>Shelves</h1><p>Showing shelf ${escapeHtml(shelf)}.</p>
<form method="post" action="/admin/shelves/lock">${csrfField(csrf)}${
        request.secondFactor ? `<input type="text" name="totp">` : ""
      }<button type="submit">Lock</button></form>`,
    });
  },
  pages: [
    {
      path: `${ADMIN_PATH}/shelves/history`,
      render: () => Effect.map(Ref.get(locked), (count) => ({ body: `<h1>Shelf history</h1><p>Locked ${count} times.</p>` })),
    },
  ],
  actions: [
    {
      path: `${ADMIN_PATH}/shelves/lock`,
      back: `${ADMIN_PATH}/shelves/history`,
      run: (form, context) => {
        if (field(form, "confirm") !== "yes") return Effect.fail({ message: "Tick the box to lock." });
        return Effect.flatMap(context.checkSecondFactor, (factor) =>
          factor._tag === "Accepted"
            ? Ref.update(locked, (count) => count + 1).pipe(Effect.as<Flash>({ kind: "ok", text: "Locked the shelves." }))
            : Effect.succeed<Flash>({ kind: "error", text: `Not locked: ${factor._tag}.` }),
        );
      },
    },
  ],
});

/** The connected-clients tab's note form for grants that may write boxes; saved through the app's own store. */
const noteSettings = (store: OAuthStore): AdminGrantSettings => ({
  codec: NOTE_SETTINGS,
  render: (grant, csrf) =>
    grant.scopes.includes("boxes:write")
      ? `
<tr><td colspan="5">Note “${escapeHtml(String(grant.settings))}” on ${grant.resources.map(escapeHtml).join(", ")} for <code>${escapeHtml(grant.clientId)}</code>
<form method="post" action="/admin/grants/note">${csrfField(csrf)}${hidden("grant", grant.grantId)}<input type="text" name="note"><button type="submit">Save note</button></form></td></tr>`
      : "",
  actions: [
    {
      path: `${ADMIN_PATH}/grants/note`,
      run: (form) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          store.updateGrantSettings(field(form, "grant") ?? "", field(form, "note") ?? "", now),
        ).pipe(
          Effect.mapError((error) => ({ message: error.description })),
          Effect.map((saved): Flash => (saved ? { kind: "ok", text: "Saved the note." } : { kind: "error", text: "That authorization is no longer active." })),
        ),
    },
  ],
});

const memoryPasswordStore = Effect.map(
  Ref.make(Option.none<string>()),
  (stored): PasswordStore => ({ get: Ref.get(stored), put: (line) => Ref.set(stored, Option.some(line)) }),
);

const database = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.forEach(
      Object.entries(OAUTH_MIGRATIONS).sort(([a], [b]) => a.localeCompare(b)),
      ([, migration]) => migration,
      { discard: true },
    );
    // The app's own grant column (NOTE_SETTINGS).
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE oauth_grants ADD COLUMN demo_note TEXT`;
  }),
).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })));

/** Takes the socket peer from PEER_HEADER. */
const peerFromHeader = HttpRouter.middleware(
  (httpEffect) =>
    httpEffect.pipe(
      Effect.updateService(HttpServerRequest.HttpServerRequest, (request) => {
        const peer = request.headers[PEER_HEADER];
        return peer === undefined ? request : request.modify({ remoteAddress: Option.some(peer) });
      }),
    ),
  { global: true },
);

export interface DemoAdminOptions {
  /** Replaces the second-factor check of tab actions (AdminSettings.secondFactor). */
  readonly secondFactor?: SecondFactorCheck | undefined;
  /** Changes the admin password service, e.g. a sign-in result or a second factor. */
  readonly password?: ((real: AdminPasswordShape) => AdminPasswordShape) | undefined;
  /** AdminSettings.allowedNetworks, as CIDR strings. */
  readonly allowedNetworks?: ReadonlyArray<string> | undefined;
  /** Serve on a Node HTTP server on 127.0.0.1 (as apps do) instead of a web handler. */
  readonly node?: boolean | undefined;
}

export interface DemoAdmin {
  readonly fetch: (request: Request) => Promise<Response>;
  /** Runs an OAuth store operation (with the app's grant settings) against the app's database. */
  readonly store: <A, E>(f: (store: OAuthStore) => Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;
  /** The certificate imports the multipart action received, oldest first. */
  readonly imports: () => Promise<ReadonlyArray<DemoImport>>;
  readonly close: () => Promise<void>;
}

export async function startDemoAdmin(options: DemoAdminOptions = {}): Promise<DemoAdmin> {
  const line = await Effect.runPromise(hashPassword(Redacted.make(PASSWORD), FAST_SCRYPT));
  const bootstrap = parsePasswordHash(line, DEMO_IDENTITY);
  if (bootstrap instanceof PasswordHashError) throw new Error(bootstrap.message);
  const scope = await Effect.runPromise(Scope.make());
  const db = await Effect.runPromise(Layer.buildWithScope(database, scope));
  const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(effect.pipe(Effect.provide(Layer.succeedContext(db))));
  const appStore = await withDb(makeOAuthStore(undefined, NOTE_SETTINGS));
  const boxes = await Effect.runPromise(Ref.make<ReadonlyArray<Resource>>([{ id: "box-1", label: "Inbox" }]));
  const locked = await Effect.runPromise(Ref.make(0));
  const imports = await Effect.runPromise(Ref.make<ReadonlyArray<DemoImport>>([]));
  const demoApp: AdminApp = {
    identity: DEMO_IDENTITY,
    resourcesHeading: "Boxes",
    passwordHashSource: "DEMO_MCP_ADMIN_PASSWORD_HASH_FILE",
    grantSettings: noteSettings(appStore),
  };
  const allowedNetworks = (options.allowedNetworks ?? []).flatMap((entry) => parseTrustedProxy(entry) ?? []);
  const realPassword = AdminPassword.layer(memoryPasswordStore, { app: DEMO_IDENTITY, bootstrap: Redacted.make(bootstrap), scrypt: FAST_SCRYPT });
  const override = options.password;
  const password =
    override === undefined
      ? realPassword
      : Layer.effect(
          AdminPassword,
          Effect.gen(function* () {
            return AdminPassword.of(override(yield* AdminPassword));
          }),
        ).pipe(
          Layer.provide(realPassword),
        );
  const admin = AdminLive({ publicUrl: PUBLIC_URL, allowedNetworks, secondFactor: options.secondFactor }, demoApp, Effect.succeed([boxesTab(boxes, imports), shelvesTab(locked)])).pipe(
    Layer.provide(password),
    Layer.provide(Layer.succeed(Resources, Resources.of({ list: Ref.get(boxes), changes: Stream.empty }))),
    Layer.provide(Layer.succeedContext(db)),
  );
  const store: DemoAdmin["store"] = (f) => withDb(Effect.flatMap(makeOAuthStore(undefined, NOTE_SETTINGS), f));
  const importsOf = () => Effect.runPromise(Ref.get(imports));
  if (options.node === true) {
    const served = HttpRouter.serve(Layer.mergeAll(admin, peerFromHeader), { disableLogger: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    );
    const context = await Effect.runPromise(Layer.buildWithScope(served, scope));
    const address = Context.get(context, HttpServer.HttpServer).address;
    const base = `http://127.0.0.1:${"port" in address ? address.port : 0}`;
    return {
      // The same request, sent over HTTP; redirects come back as they are.
      fetch: (request) => {
        const url = new URL(request.url);
        const init: RequestInit & { duplex?: "half" } = { method: request.method, headers: request.headers, redirect: "manual" };
        if (request.body !== null) {
          init.body = request.body;
          init.duplex = "half";
        }
        // @effect-diagnostics-next-line globalFetch:off
        return fetch(`${base}${url.pathname}${url.search}`, init);
      },
      store,
      imports: importsOf,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  }
  const app = Layer.mergeAll(admin, peerFromHeader).pipe(Layer.provide(HttpServer.layerServices));
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  return {
    fetch: (request) => web.handler(request),
    store,
    imports: importsOf,
    close: async () => {
      await web.dispose();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

/** A browser keeping the admin cookie; `csrf` is the last page's form token; `headers` go with every request. */
export class AdminBrowser {
  cookie: string | undefined;
  csrf: string | undefined;
  constructor(
    private readonly app: DemoAdmin,
    private readonly headers: Record<string, string> = {},
  ) {}

  private async absorb(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const at = (pair ?? "").indexOf("=");
      if (pair !== undefined && pair.slice(0, at) === ADMIN_COOKIE) this.cookie = pair.slice(at + 1) === "" ? undefined : pair;
    }
    const html = await response.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    if (csrf !== undefined) this.csrf = csrf;
    return { status: response.status, location: response.headers.get("location"), headers: response.headers, html };
  }

  async get(path: string) {
    const headers: Record<string, string> = { ...this.headers };
    if (this.cookie !== undefined) headers.cookie = this.cookie;
    return this.absorb(await this.app.fetch(new Request(new URL(path, PUBLIC_URL), { headers })));
  }

  async post(path: string, form: Record<string, string>, csrf: string | undefined = this.csrf) {
    const body = new URLSearchParams(form);
    if (csrf !== undefined) body.set("csrf", csrf);
    const headers: Record<string, string> = { ...this.headers, "content-type": "application/x-www-form-urlencoded", origin: PUBLIC_URL };
    if (this.cookie !== undefined) headers.cookie = this.cookie;
    return this.absorb(await this.app.fetch(new Request(new URL(path, PUBLIC_URL), { method: "POST", headers, body })));
  }

  /**
   * Posts any body (a multipart FormData, a string, a stream) with the
   * cookie and the public Origin; `headers` add to or replace those.
   */
  async send(path: string, body: FormData | string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
    const all: Record<string, string> = { ...this.headers, origin: PUBLIC_URL };
    if (this.cookie !== undefined) all.cookie = this.cookie;
    let payload = body;
    if (body instanceof FormData) {
      // Sent as bytes: undici's FormData stream fails unhandled when the server stops reading it.
      const encoded = new Response(body);
      all["content-type"] = encoded.headers.get("content-type") ?? "";
      payload = new Uint8Array(await encoded.arrayBuffer());
    }
    const init: RequestInit & { duplex?: "half" } = { method: "POST", headers: { ...all, ...headers }, body: payload };
    if (payload instanceof ReadableStream) init.duplex = "half";
    return this.absorb(await this.app.fetch(new Request(new URL(path, PUBLIC_URL), init)));
  }

  async signIn(extra: Record<string, string> = {}) {
    await this.get("/admin/login");
    return this.post("/admin/login", { password: PASSWORD, ...extra });
  }

  /** Posts a form and returns the one-shot message the redirected page shows. */
  async act(path: string, form: Record<string, string>) {
    const posted = await this.post(path, form);
    if (posted.status !== 303 || posted.location === null) return { status: posted.status, message: undefined };
    const page = await this.get(posted.location);
    const message = /<p class="(?:ok|error)" role="(?:status|alert)">([^<]*)<\/p>/.exec(page.html)?.[1];
    return { status: page.status, location: posted.location, message, html: page.html };
  }
}
