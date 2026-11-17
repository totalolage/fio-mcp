import { Clock, Effect, Layer, Option, Redacted, type Scope, Stream } from "effect";
import { Cookies, HttpRouter, type HttpServerRequest, HttpServerResponse, Multipart } from "effect/http";
import type { IpNetwork } from "effect/net";
import type { SqlClient } from "effect/sql";
import { safeEqual } from "../oauth/crypto.js";
import type { LoginResult } from "../oauth/login.js";
import { pageHeaders } from "../oauth/pages.js";
import { makeWindowLimiter } from "../oauth/rate-limit.js";
import { makeOAuthStore } from "../oauth/store.js";
import { Resources } from "../resources.js";
import { clientAddress } from "../transport/client-address.js";
import { restrictRoutes } from "../transport/restrict.js";
import {
  ADMIN_STYLE_HASH,
  type AdminShell,
  adminLoginPage,
  adminRefusedPage,
  type ClientRow,
  clientsPage,
  type Flash,
  passwordPage,
  signedInPage,
} from "./pages.js";
import { AdminPassword, checkNewPassword } from "./password.js";
import { ADMIN_ABSOLUTE_MS, ADMIN_PATH, ADMIN_PRELOGIN_MS, type AdminSession, adminCookie, makeAdminSessions } from "./sessions.js";
import {
  type AdminActionContext,
  type AdminApp,
  type AdminFormFile,
  type AdminFormLimits,
  type AdminTab,
  type AdminTabAction,
  type AdminTabRequest,
  type AdminTabView,
  field,
} from "./tab.js";

/**
 * The admin UI at /admin (HTTP mode with OAuth): the app's tabs (tab.ts),
 * connected OAuth clients, and the admin password.
 *
 * Separate from OAuth: only the admin session cookie (src/admin/sessions.ts)
 * signs in here; the Authorization header is never read, so an MCP bearer
 * token grants nothing. Sign-in uses the shared admin password check
 * (throttling, lockout, one scrypt at a time, the optional authenticator
 * code). Every state change is a POST with the session's CSRF token
 * (compared in constant time) and, when the browser sends Origin, the public
 * origin; results come back on the next page as a one-shot message held in
 * the session (Post/Redirect/Get), never in the URL. Pages carry the strict
 * headers of the sign-in pages (CSP without scripts, frame-ancestors 'none',
 * no-store). Every route sits behind the admin allowed-networks restriction
 * (`adminRoutes`).
 */

/** Checks the second factor of a verified form (see `verifySecondFactor`). */
export type SecondFactorCheck = (request: Request, form: URLSearchParams) => Effect.Effect<LoginResult<void>>;

export interface AdminSettings {
  readonly publicUrl: string;
  readonly trustedProxies?: ReadonlyArray<IpNetwork.IpNetwork> | undefined;
  /** Only these clients reach any /admin route (404 otherwise); empty allows all. */
  readonly allowedNetworks?: ReadonlyArray<IpNetwork.IpNetwork> | undefined;
  /** Replaces the built-in second-factor check of tab actions (tests). */
  readonly secondFactor?: SecondFactorCheck | undefined;
}

/** The largest form of a POST whose action does not raise it (AdminFormLimits.maxBytes). */
export const DEFAULT_MAX_FORM_BYTES = 16 * 1024;
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

type Request = HttpServerRequest.HttpServerRequest;
type Response = HttpServerResponse.HttpServerResponse;

const html = (body: string, status = 200, extra: Record<string, string> = {}, cookies?: Cookies.Cookies) =>
  HttpServerResponse.text(body, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: { ...pageHeaders([], ADMIN_STYLE_HASH), ...extra },
    cookies,
  });

const sessionCookie = (name: string, value: string, maxAgeMs: number) =>
  Cookies.setUnsafe(Cookies.empty, name, value, {
    path: ADMIN_PATH,
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: `${Math.max(0, Math.floor(maxAgeMs / 1000))} seconds`,
  });

const redirect = (location: string, cookies?: Cookies.Cookies) =>
  HttpServerResponse.redirect(location, { status: 303, headers: NO_STORE, cookies });

const toLogin = redirect(`${ADMIN_PATH}/login`);

type Form =
  | { readonly _tag: "Form"; readonly params: URLSearchParams; readonly files: ReadonlyArray<AdminFormFile> }
  | { readonly _tag: "Invalid" };

const invalid: Form = { _tag: "Invalid" };

const textDecoder = new TextDecoder();

/**
 * The raw body, read only up to `maxBytes`; undefined when it is longer (or
 * unreadable). Counting the bytes received, not the parsed form, also counts
 * whatever follows a multipart form's closing boundary.
 */
const readBody = (request: Request, maxBytes: number): Effect.Effect<Uint8Array | undefined> =>
  Effect.suspend(() => {
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    return request.stream.pipe(
      Stream.runForEachWhile((chunk) =>
        Effect.sync(() => {
          size += chunk.length;
          if (size > maxBytes) return false;
          chunks.push(chunk);
          return true;
        }),
      ),
      Effect.map(() => {
        if (size > maxBytes) return undefined;
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        return body;
      }),
      Effect.orElseSucceed(() => undefined),
    );
  });

/** A multipart body's text fields into `params` and its files, in the order sent. */
const parseMultipart = (request: Request, body: Uint8Array, maxBytes: number): Effect.Effect<Form> => {
  const params = new URLSearchParams();
  const files: Array<AdminFormFile> = [];
  return Stream.make(body).pipe(
    Stream.pipeThroughChannel(Multipart.makeChannel(request.headers)),
    Stream.runForEach((part) =>
      part._tag === "Field"
        ? Effect.sync(() => params.append(part.key, part.value))
        : Effect.map(part.contentEffect, (bytes) => {
            files.push({ field: part.key, name: part.name, contentType: part.contentType, content: Redacted.make(bytes) });
          }),
    ),
    Effect.as<Form>({ _tag: "Form", params, files }),
    // The action's own limits, whatever the route's; text fields may be as large as the body (the default field limit is 10 MiB).
    Effect.provideContext(Multipart.limitsServices({ maxTotalSize: maxBytes, maxFieldSize: maxBytes, maxFileSize: maxBytes })),
    // A malformed body; its cause (which may quote the body) is dropped unlogged.
    Effect.orElseSucceed(() => invalid),
  );
};

/**
 * A form of at most `limits.maxBytes` (DEFAULT_MAX_FORM_BYTES): url-encoded,
 * or multipart when `limits.multipart`. A larger declared length is refused
 * unread, a longer body stops being read at the limit.
 */
const readForm = Effect.fnUntraced(function* (request: Request, limits: AdminFormLimits = {}) {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_FORM_BYTES;
  const type = (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
  const multipart = type === "multipart/form-data" && limits.multipart === true;
  if (!multipart && type !== "application/x-www-form-urlencoded") return invalid;
  if (Number(request.headers["content-length"]) > maxBytes) return invalid;
  const body = yield* readBody(request, maxBytes);
  if (body === undefined) return invalid;
  if (multipart) return yield* parseMultipart(request, body, maxBytes);
  return { _tag: "Form", params: new URLSearchParams(textDecoder.decode(body)), files: [] } satisfies Form;
});

/** The query string of a GET (request.url is the path and query). */
const queryOf = (request: Request) => {
  const start = request.url.indexOf("?");
  return new URLSearchParams(start < 0 ? "" : request.url.slice(start + 1));
};

export const makeAdminServer = Effect.fn("AdminServer.make")(function* (
  settings: AdminSettings,
  app: AdminApp,
  tabs: ReadonlyArray<AdminTab>,
) {
  const password = yield* AdminPassword;
  const resources = yield* Resources;
  const sessions = yield* makeAdminSessions();
  const grantSettings = app.grantSettings;
  // Grants are read with the app's settings codec, so each carries its decoded settings.
  const oauth = yield* makeOAuthStore(undefined, grantSettings?.codec);
  const issuer = settings.publicUrl;
  const trustedProxies = settings.trustedProxies ?? [];
  // Anyone can open the sign-in form; each holds a session for a while.
  const formsByAddress = makeWindowLimiter({ limit: 20, windowMs: 10 * 60_000, maxKeys: 10_000 });
  const name = app.identity.name;
  const cookieName = adminCookie(app.identity);
  const cookie = (value: string, maxAgeMs: number) => sessionCookie(cookieName, value, maxAgeMs);
  const clearedCookie = cookie("", 0);
  const refused = html(adminRefusedPage(name), 403);
  const CLIENTS = `${ADMIN_PATH}/clients`;
  const navEntry = (tab: AdminTab) => ({ id: tab.id, href: tab.path, label: tab.label });
  const shell: AdminShell = {
    name,
    tabs: [
      ...tabs.filter((tab) => (tab.nav ?? "first") === "first").map(navEntry),
      { id: "clients", href: CLIENTS, label: "Connected clients" },
      ...tabs.filter((tab) => tab.nav === "after-clients").map(navEntry),
      { id: "password", href: `${ADMIN_PATH}/password`, label: "Admin password" },
    ],
    resourcesHeading: app.resourcesHeading,
    passwordHashSource: app.passwordHashSource,
  };

  /** The signed-in session the cookie names, unless the password changed since its sign-in. */
  const signedIn = Effect.fnUntraced(function* (request: Request) {
    const session = yield* sessions.find(request.cookies[cookieName]);
    if (Option.isNone(session) || !session.value.signedIn) return Option.none<AdminSession>();
    const stamp = yield* password.stamp.pipe(Effect.orElseSucceed(() => undefined));
    if (stamp === undefined || stamp !== session.value.passwordStamp) {
      yield* sessions.end(session.value);
      return Option.none<AdminSession>();
    }
    return session;
  });

  /** Same origin (when the browser says) and the session's CSRF token. */
  const verified = (request: Request, session: AdminSession, form: URLSearchParams) => {
    const origin = request.headers.origin;
    const csrf = field(form, "csrf");
    return (origin === undefined || origin === issuer) && csrf !== undefined && safeEqual(csrf, Redacted.value(session.csrf));
  };

  const takeFlash = (session: AdminSession) => {
    const flash = session.flash;
    session.flash = undefined;
    return flash;
  };

  // -- Sign-in ---------------------------------------------------------------

  const renderLogin = (
    csrf: Redacted.Redacted<string>,
    status: number,
    error?: string,
    extra: Record<string, string> = {},
    cookies?: Cookies.Cookies,
  ) => html(adminLoginPage(name, { csrf: Redacted.value(csrf), error, totp: password.totpEnabled }), status, extra, cookies);

  const showLogin = Effect.fnUntraced(function* (request: Request) {
    if (Option.isSome(yield* signedIn(request))) return redirect(ADMIN_PATH);
    const existing = yield* sessions.find(request.cookies[cookieName]);
    if (Option.isSome(existing) && !existing.value.signedIn) return renderLogin(existing.value.csrf, 200);
    const address = clientAddress(request, trustedProxies);
    const now = yield* Clock.currentTimeMillis;
    const wait = formsByAddress.retryAfter(address, now);
    if (wait > 0) {
      return html(adminLoginPage(name, { csrf: "", error: `Too many sign-in forms were opened. Try again in ${wait} s.` }), 429, {
        "retry-after": String(wait),
      });
    }
    formsByAddress.record(address, now);
    const started = yield* sessions.start();
    return renderLogin(started.session.csrf, 200, undefined, {}, cookie(Redacted.value(started.cookie), ADMIN_PRELOGIN_MS));
  });

  const submitLogin = Effect.fnUntraced(function* (request: Request) {
    const found = yield* sessions.find(request.cookies[cookieName]);
    // Expired or never started: back to the form, whose sessions are limited per address.
    if (Option.isNone(found) || found.value.signedIn) return redirect(`${ADMIN_PATH}/login`);
    const form = yield* readForm(request);
    const session = found.value;
    if (form._tag === "Invalid" || !verified(request, session, form.params)) return refused;
    const entered = Redacted.make(field(form.params, "password") ?? "");
    const result = yield* password.signIn(clientAddress(request, trustedProxies), entered, field(form.params, "totp"));
    switch (result._tag) {
      case "Accepted": {
        // Bound to the hash the password matched: a change in between ends this session.
        const next = yield* sessions.signIn(session, result.value);
        yield* Effect.logInfo("admin: signed in");
        return redirect(ADMIN_PATH, cookie(Redacted.value(next.cookie), ADMIN_ABSOLUTE_MS));
      }
      case "Rejected":
        return renderLogin(session.csrf, 401, password.totpEnabled ? "Wrong password or code." : "Wrong password.");
      case "Throttled":
        // Busy: another check is running; this attempt was not counted.
        if (result.busy === true) return renderLogin(session.csrf, 429, "Sign-in busy, try again.", { "retry-after": "1" });
        return renderLogin(session.csrf, 429, `Too many failed attempts. Try again in ${result.retryAfterSeconds} s.`, {
          "retry-after": String(result.retryAfterSeconds),
        });
      case "Unavailable":
        return renderLogin(session.csrf, 503, "Sign-in is unavailable. See the server log.");
    }
  });

  // -- Signed-in pages ---------------------------------------------------------

  /** GET: the page for a signed-in session, else the sign-in page. */
  const page =
    (render: (session: AdminSession, request: Request) => Effect.Effect<Response>) =>
    (request: Request): Effect.Effect<Response> =>
      Effect.flatMap(signedIn(request), (session) =>
        Option.isNone(session) ? Effect.succeed(toLogin) : render(session.value, request),
      );

  /**
   * POST: a verified form from a signed-in session; `act` returns the
   * message for the next page, and its expected failures become an error
   * message (their text never holds a token or password).
   */
  const action =
    <E extends { readonly message: string }>(
      back: string,
      act: (
        form: URLSearchParams,
        session: AdminSession,
        request: Request,
        files: ReadonlyArray<AdminFormFile>,
      ) => Effect.Effect<Flash | Response, E, Scope.Scope>,
      limits?: AdminFormLimits,
    ) =>
    (request: Request): Effect.Effect<Response, never, Scope.Scope> =>
      Effect.gen(function* () {
        const session = yield* signedIn(request);
        if (Option.isNone(session)) return toLogin;
        const form = yield* readForm(request, limits);
        if (form._tag === "Invalid" || !verified(request, session.value, form.params)) return refused;
        const outcome = yield* act(form.params, session.value, request, form.files).pipe(
          Effect.catch((error) => Effect.succeed<Flash>({ kind: "error", text: error.message })),
        );
        if (HttpServerResponse.isHttpServerResponse(outcome)) return outcome;
        session.value.flash = outcome;
        return redirect(back);
      });

  // -- App tabs ------------------------------------------------------------------

  /**
   * The second factor of a verified form (for example approving a held
   * operation): the single place a tab action is checked beyond the signed-in session,
   * Origin and CSRF.
   *
   * `settings.secondFactor` replaces the check (tests). Otherwise, with an
   * authenticator secret configured, the form's `totp` code is checked like
   * a sign-in code: it fails closed (a missing, wrong or already used code
   * is Rejected, and counts as a failure for this client address). Without
   * one, every form is Accepted.
   */
  const verifySecondFactor: SecondFactorCheck = (request, form) => {
    if (settings.secondFactor !== undefined) return settings.secondFactor(request, form);
    if (!password.totpEnabled) return Effect.succeed({ _tag: "Accepted", value: undefined });
    return password.verifyTotp(clientAddress(request, trustedProxies), field(form, "totp") ?? "");
  };

  /** Built only for a verified form; nothing is checked or counted unless the action runs it. */
  const actionContext = (request: Request, form: URLSearchParams, files: ReadonlyArray<AdminFormFile>): AdminActionContext => ({
    checkSecondFactor: Effect.suspend(() => verifySecondFactor(request, form)),
    files,
  });

  /** A tab action as a POST route; its message shows once on `back`, else on `fallback`. */
  const tabAction = (act: AdminTabAction, fallback: string) =>
    action(act.back ?? fallback, (form, _session, request, files) => act.run(form, actionContext(request, form, files)), act.form);

  const tabRequest = (request: Request): AdminTabRequest => ({ query: queryOf(request), secondFactor: password.totpEnabled });

  /** A tab's page, with the tab current in the nav. */
  const showTabPage = (tab: AdminTab, render: (csrf: string, request: AdminTabRequest) => Effect.Effect<AdminTabView>) =>
    page((session, request) => {
      const csrf = Redacted.value(session.csrf);
      return Effect.map(render(csrf, tabRequest(request)), (view) =>
        // A page's own error leaves the session's message for the next page.
        html(signedInPage(shell, tab.id, csrf, view.error ?? takeFlash(session), view.body), view.status ?? 200),
      );
    });

  // -- Connected clients ---------------------------------------------------------

  /** Registered clients with their live grants, resources by current label, and the app's part of each grant's row. */
  const clientRows = Effect.fnUntraced(function* (csrf: string) {
    const now = yield* Clock.currentTimeMillis;
    const clients = yield* oauth.listClients(now);
    const grants = yield* oauth.listGrants(now);
    const current = yield* resources.list;
    const known = new Set(current.map((resource) => resource.id));
    return clients.map(
      (client): ClientRow => ({
        clientId: client.clientId,
        clientName: client.clientName,
        redirectUris: client.redirectUris,
        createdAt: client.createdAt,
        lastUsedAt: client.lastUsedAt,
        grants: grants
          .filter((grant) => grant.clientId === client.clientId)
          .map((grant) => ({
            grantId: grant.grantId,
            scopes: grant.scopes,
            resources: current.filter((resource) => grant.resources.includes(resource.id)).map((resource) => resource.label),
            staleResources: grant.resources.filter((id) => !known.has(id)).length,
            createdAt: grant.createdAt,
            lastUsedAt: grant.lastUsedAt,
            settings:
              grantSettings === undefined
                ? ""
                : grantSettings.render(
                    {
                      grantId: grant.grantId,
                      clientId: grant.clientId,
                      scopes: grant.scopes,
                      resources: grant.resources,
                      settings: grant.settings,
                    },
                    csrf,
                  ),
          })),
      }),
    );
  });

  const showClients = page((session) => {
    const csrf = Redacted.value(session.csrf);
    return clientRows(csrf).pipe(
      Effect.map((rows) => html(clientsPage(shell, { csrf, flash: takeFlash(session), clients: rows }))),
      Effect.catch((error) =>
        Effect.succeed(html(clientsPage(shell, { csrf, flash: { kind: "error", text: error.description }, clients: [] }), 500)),
      ),
    );
  });

  const revokeClient = action(CLIENTS, (form) =>
    oauth.deleteClient(field(form, "client") ?? "").pipe(
      Effect.mapError((error) => ({ message: error.description })),
      Effect.tap((removed) => (removed ? Effect.logInfo("admin: removed a client") : Effect.void)),
      Effect.map((removed): Flash => (removed ? { kind: "ok", text: "Removed the client and revoked its access." } : { kind: "error", text: "The client no longer exists." })),
    ),
  );

  const revokeGrant = action(CLIENTS, (form) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => oauth.revokeGrant(field(form, "grant") ?? "", now)).pipe(
      Effect.mapError((error) => ({ message: error.description })),
      Effect.tap(() => Effect.logInfo("admin: revoked a grant")),
      Effect.as<Flash>({ kind: "ok", text: "Revoked the authorization." }),
    ),
  );

  const revokeAll = action(CLIENTS, (form) => {
    if (field(form, "confirm") !== "yes") return Effect.succeed<Flash>({ kind: "error", text: "Tick the box to confirm." });
    return Effect.flatMap(Clock.currentTimeMillis, (now) => oauth.revokeAll(now)).pipe(
      Effect.mapError((error) => ({ message: error.description })),
      Effect.tap((count) => Effect.logInfo(`admin: revoked all grants (${count} active)`)),
      Effect.map((count): Flash => ({ kind: "ok", text: `Revoked ${count} active authorizations; every client must authorize again.` })),
    );
  });

  // -- Admin password --------------------------------------------------------------

  const showPassword = page((session) =>
    Effect.succeed(html(passwordPage(shell, { csrf: Redacted.value(session.csrf), flash: takeFlash(session) }))),
  );

  const changePassword = action(
    `${ADMIN_PATH}/password`,
    Effect.fnUntraced(function* (form: URLSearchParams, session: AdminSession, request: Request) {
      const next = field(form, "next") ?? "";
      const invalid = checkNewPassword(next, field(form, "confirm") ?? "");
      if (invalid !== undefined) return { kind: "error", text: invalid.message } satisfies Flash;
      const current = Redacted.make(field(form, "current") ?? "");
      const result = yield* password.change(clientAddress(request, trustedProxies), current, Redacted.make(next));
      switch (result._tag) {
        case "Rejected":
          return { kind: "error", text: "The current password is wrong." } satisfies Flash;
        case "Throttled":
          // Busy: another check is running; this attempt was not counted.
          if (result.busy === true) return { kind: "error", text: "Sign-in busy, try again." } satisfies Flash;
          return { kind: "error", text: `Too many failed attempts. Try again in ${result.retryAfterSeconds} s.` } satisfies Flash;
        case "Unavailable":
          return { kind: "error", text: "The password could not be checked. See the server log." } satisfies Flash;
        case "Accepted": {
          // This browser stays signed in under a new session; every other one ends.
          const renewed = yield* sessions.signIn(session, result.value);
          yield* sessions.endOthers(renewed.session);
          renewed.session.flash = { kind: "ok", text: "Password changed. Every other admin session was signed out." };
          return redirect(`${ADMIN_PATH}/password`, cookie(Redacted.value(renewed.cookie), ADMIN_ABSOLUTE_MS));
        }
      }
    }),
  );

  const logout = Effect.fnUntraced(function* (request: Request) {
    const session = yield* signedIn(request);
    if (Option.isNone(session)) return redirect(`${ADMIN_PATH}/login`, clearedCookie);
    const form = yield* readForm(request);
    if (form._tag === "Invalid" || !verified(request, session.value, form.params)) return refused;
    yield* sessions.end(session.value);
    return redirect(`${ADMIN_PATH}/login`, clearedCookie);
  });

  // -- Routes ----------------------------------------------------------------------

  const routes: ReadonlyArray<{
    readonly method: "GET" | "POST";
    readonly path: `/${string}`;
    readonly handler: (request: Request) => Effect.Effect<Response, never, Scope.Scope>;
  }> = [
    ...tabs.map((tab) => ({ method: "GET" as const, path: tab.path, handler: showTabPage(tab, tab.render) })),
    ...tabs.flatMap((tab) =>
      (tab.pages ?? []).map((sub) => ({ method: "GET" as const, path: sub.path, handler: showTabPage(tab, sub.render) })),
    ),
    { method: "GET", path: `${ADMIN_PATH}/login`, handler: showLogin },
    { method: "POST", path: `${ADMIN_PATH}/login`, handler: submitLogin },
    { method: "POST", path: `${ADMIN_PATH}/logout`, handler: logout },
    ...tabs.flatMap((tab) => tab.actions.map((act) => ({ method: "POST" as const, path: act.path, handler: tabAction(act, tab.path) }))),
    { method: "GET", path: CLIENTS, handler: showClients },
    { method: "POST", path: `${CLIENTS}/revoke`, handler: revokeClient },
    { method: "POST", path: `${ADMIN_PATH}/grants/revoke`, handler: revokeGrant },
    { method: "POST", path: `${CLIENTS}/revoke-all`, handler: revokeAll },
    ...(grantSettings?.actions ?? []).map((act) => ({ method: "POST" as const, path: act.path, handler: tabAction(act, CLIENTS) })),
    { method: "GET", path: `${ADMIN_PATH}/password`, handler: showPassword },
    { method: "POST", path: `${ADMIN_PATH}/password`, handler: changePassword },
  ];

  return { routes };
});

/**
 * Admin routes: every route `routes` adds to the router answers 404 to
 * clients outside `settings.allowedNetworks`. The restriction is route
 * middleware over the whole layer, so a route registered here (an app tab's
 * page or form among them) is covered without being listed anywhere.
 */
export const adminRoutes = <E, R>(settings: AdminSettings, routes: Layer.Layer<never, E, R>) =>
  routes.pipe(
    Layer.provide(
      restrictRoutes({ allowedNetworks: settings.allowedNetworks ?? [], trustedProxies: settings.trustedProxies ?? [] }).layer,
    ),
  );

/**
 * Registers the admin routes on the router (HTTP mode with OAuth), behind
 * `adminRoutes`, with the app's tabs in the nav where each asks; `tabs` is
 * built once, with the layer.
 */
export const AdminLive = <R>(
  settings: AdminSettings,
  app: AdminApp,
  tabs: Effect.Effect<ReadonlyArray<AdminTab>, never, R>,
): Layer.Layer<never, never, HttpRouter.HttpRouter | SqlClient.SqlClient | Resources | AdminPassword | R> =>
  adminRoutes(
    settings,
    Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* makeAdminServer(settings, app, yield* tabs);
        const router = yield* HttpRouter.HttpRouter;
        for (const route of server.routes) yield* router.add(route.method, route.path, route.handler);
      }),
    ),
  );
