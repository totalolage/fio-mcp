import { ByteSize, Clock, Effect, Layer, Option, Redacted, type Scope } from "effect";
import { Cookies, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { IpNetwork } from "effect/net";
import type { SqlClient } from "effect/sql";
import { Accounts, tokenHint } from "../accounts.js";
import type { TransactionCache } from "../cache/service.js";
import type { FioApi } from "../fio-api.js";
import { safeEqual } from "../oauth/crypto.js";
import { pageHeaders } from "../oauth/pages.js";
import { makeWindowLimiter } from "../oauth/rate-limit.js";
import { makeOAuthStore } from "../oauth/store.js";
import { clientAddress } from "../transport/client-address.js";
import { makeAccountAdmin } from "./accounts.js";
import {
  ADMIN_STYLE_HASH,
  accountsPage,
  adminLoginPage,
  adminRefusedPage,
  type ClientRow,
  clientsPage,
  type Flash,
  passwordPage,
} from "./pages.js";
import { AdminPassword, checkNewPassword } from "./password.js";
import { ADMIN_ABSOLUTE_MS, ADMIN_COOKIE, ADMIN_PATH, ADMIN_PRELOGIN_MS, type AdminSession, makeAdminSessions } from "./sessions.js";

/**
 * The admin UI at /admin (HTTP mode with OAuth): FIO accounts and tokens,
 * connected OAuth clients, and the admin password.
 *
 * Separate from OAuth: only the admin session cookie (src/admin/sessions.ts)
 * signs in here; the Authorization header is never read, so an MCP bearer
 * token grants nothing. Sign-in uses the shared admin password check
 * (throttling, lockout, one scrypt at a time). Every state change is a POST
 * with the session's CSRF token (compared in constant time) and, when the
 * browser sends Origin, the public origin; results come back on the next
 * page as a one-shot message held in the session (Post/Redirect/Get), never
 * in the URL. Pages carry the strict headers of the sign-in pages (CSP
 * without scripts, frame-ancestors 'none', no-store).
 */

export interface AdminSettings {
  readonly publicUrl: string;
  readonly dataKey: Redacted.Redacted<Uint8Array>;
  readonly trustedProxies?: ReadonlyArray<IpNetwork.IpNetwork> | undefined;
}

const MAX_FORM_BYTES = 16 * 1024;
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

const sessionCookie = (value: string, maxAgeMs: number) =>
  Cookies.setUnsafe(Cookies.empty, ADMIN_COOKIE, value, {
    path: ADMIN_PATH,
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: `${Math.max(0, Math.floor(maxAgeMs / 1000))} seconds`,
  });

const clearedCookie = sessionCookie("", 0);

const redirect = (location: string, cookies?: Cookies.Cookies) =>
  HttpServerResponse.redirect(location, { status: 303, headers: NO_STORE, cookies });

const toLogin = redirect(`${ADMIN_PATH}/login`);

type Form = { readonly _tag: "Form"; readonly params: URLSearchParams } | { readonly _tag: "Invalid" };

/** A url-encoded form of at most MAX_FORM_BYTES. */
const readForm = (request: Request): Effect.Effect<Form> => {
  const type = (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return Effect.succeed({ _tag: "Invalid" });
  return request.text.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_FORM_BYTES)),
    Effect.map((text): Form => ({ _tag: "Form", params: new URLSearchParams(text) })),
    Effect.orElseSucceed((): Form => ({ _tag: "Invalid" })),
  );
};

/** The one value of `name`; repeated or missing is undefined. */
const field = (form: URLSearchParams, name: string) => {
  const values = form.getAll(name);
  return values.length === 1 ? values[0] : undefined;
};

const refused = html(adminRefusedPage(), 403);

export const makeAdminServer = Effect.fn("AdminServer.make")(function* (settings: AdminSettings) {
  const password = yield* AdminPassword;
  const accounts = yield* Accounts;
  const sessions = yield* makeAdminSessions();
  const admin = yield* makeAccountAdmin(settings.dataKey);
  const oauth = yield* makeOAuthStore();
  const issuer = settings.publicUrl;
  const trustedProxies = settings.trustedProxies ?? [];
  // Anyone can open the sign-in form; each holds a session for a while.
  const formsByAddress = makeWindowLimiter({ limit: 20, windowMs: 10 * 60_000, maxKeys: 10_000 });

  /** The signed-in session the cookie names, unless the password changed since its sign-in. */
  const signedIn = Effect.fnUntraced(function* (request: Request) {
    const session = yield* sessions.find(request.cookies[ADMIN_COOKIE]);
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
  ) => html(adminLoginPage({ csrf: Redacted.value(csrf), error }), status, extra, cookies);

  const showLogin = Effect.fnUntraced(function* (request: Request) {
    if (Option.isSome(yield* signedIn(request))) return redirect(ADMIN_PATH);
    const existing = yield* sessions.find(request.cookies[ADMIN_COOKIE]);
    if (Option.isSome(existing) && !existing.value.signedIn) return renderLogin(existing.value.csrf, 200);
    const address = clientAddress(request, trustedProxies);
    const now = yield* Clock.currentTimeMillis;
    const wait = formsByAddress.retryAfter(address, now);
    if (wait > 0) {
      return html(adminLoginPage({ csrf: "", error: `Too many sign-in forms were opened. Try again in ${wait} s.` }), 429, {
        "retry-after": String(wait),
      });
    }
    formsByAddress.record(address, now);
    const started = yield* sessions.start();
    return renderLogin(started.session.csrf, 200, undefined, {}, sessionCookie(Redacted.value(started.cookie), ADMIN_PRELOGIN_MS));
  });

  const submitLogin = Effect.fnUntraced(function* (request: Request) {
    const found = yield* sessions.find(request.cookies[ADMIN_COOKIE]);
    const form = yield* readForm(request);
    if (Option.isNone(found) || found.value.signedIn) {
      // Expired or never started: a fresh form.
      const started = yield* sessions.start();
      return renderLogin(
        started.session.csrf,
        400,
        "The sign-in form expired. Enter the password again.",
        {},
        sessionCookie(Redacted.value(started.cookie), ADMIN_PRELOGIN_MS),
      );
    }
    const session = found.value;
    if (form._tag === "Invalid" || !verified(request, session, form.params)) return refused;
    const entered = Redacted.make(field(form.params, "password") ?? "");
    const result = yield* password.signIn(clientAddress(request, trustedProxies), entered);
    switch (result._tag) {
      case "Accepted": {
        // Bound to the hash the password matched: a change in between ends this session.
        const next = yield* sessions.signIn(session, result.value);
        yield* Effect.logInfo("admin: signed in");
        return redirect(ADMIN_PATH, sessionCookie(Redacted.value(next.cookie), ADMIN_ABSOLUTE_MS));
      }
      case "Rejected":
        return renderLogin(session.csrf, 401, "Wrong password.");
      case "Throttled":
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
    (render: (session: AdminSession) => Effect.Effect<Response>) =>
    (request: Request): Effect.Effect<Response> =>
      Effect.flatMap(signedIn(request), (session) => (Option.isNone(session) ? Effect.succeed(toLogin) : render(session.value)));

  /**
   * POST: a verified form from a signed-in session; `act` returns the
   * message for the next page, and its expected failures become an error
   * message (their text never holds a token or password).
   */
  const action =
    <E extends { readonly message: string }>(
      back: string,
      act: (form: URLSearchParams, session: AdminSession, request: Request) => Effect.Effect<Flash | Response, E, Scope.Scope>,
    ) =>
    (request: Request): Effect.Effect<Response, never, Scope.Scope> =>
      Effect.gen(function* () {
        const session = yield* signedIn(request);
        if (Option.isNone(session)) return toLogin;
        const form = yield* readForm(request);
        if (form._tag === "Invalid" || !verified(request, session.value, form.params)) return refused;
        const outcome = yield* act(form.params, session.value, request).pipe(
          Effect.catch((error) => Effect.succeed<Flash>({ kind: "error", text: error.message })),
        );
        if (HttpServerResponse.isHttpServerResponse(outcome)) return outcome;
        session.value.flash = outcome;
        return redirect(back);
      });

  const showAccounts = page((session) =>
    admin.records.pipe(
      Effect.map((records) =>
        records.map((record) => ({
          id: record.account.id,
          name: record.account.name,
          tokenHint: tokenHint(record.account.token),
          accountNumber: record.account.configuredAccountNumber,
          currency: record.account.configuredCurrency,
          createdAt: record.createdAt,
          tokenUpdatedAt: record.tokenUpdatedAt,
        })),
      ),
      Effect.map((rows) => ({ rows, error: undefined as Flash | undefined })),
      Effect.catch((error) => Effect.succeed({ rows: [], error: { kind: "error", text: error.message } as Flash })),
      Effect.map(({ rows, error }) =>
        html(accountsPage({ csrf: Redacted.value(session.csrf), flash: error ?? takeFlash(session), accounts: rows })),
      ),
    ),
  );

  const idOf = (form: URLSearchParams) => field(form, "id") ?? "";

  const addAccount = action(ADMIN_PATH, (form) =>
    admin
      .add({
        name: field(form, "name") ?? "",
        token: field(form, "token") ?? "",
        accountNumber: field(form, "accountNumber"),
        currency: field(form, "currency"),
      })
      .pipe(Effect.map((name): Flash => ({ kind: "ok", text: `Added “${name}”. Connected clients see it after they reconnect and select it.` }))),
  );

  const renameAccount = action(ADMIN_PATH, (form) =>
    admin
      .rename(idOf(form), field(form, "name") ?? "")
      .pipe(Effect.map((name): Flash => ({ kind: "ok", text: `Renamed to “${name}”.` }))),
  );

  const rotateToken = action(ADMIN_PATH, (form) =>
    admin.rotate(idOf(form), field(form, "token") ?? "").pipe(
      Effect.map(
        (name): Flash => ({
          kind: "ok",
          text: `Replaced the token of “${name}”. Clients authorized before must reconnect and select the account again.`,
        }),
      ),
    ),
  );

  const removeAccount = action(ADMIN_PATH, (form) => {
    if (field(form, "confirm") !== "yes") return Effect.succeed<Flash>({ kind: "error", text: "Tick the box to confirm the removal." });
    return admin.remove(idOf(form), field(form, "cache") === "purge").pipe(
      Effect.map(({ name, purged, shared }): Flash => {
        let cache = " Its cached transactions were kept.";
        if (purged) cache = " Its cached transactions were deleted.";
        else if (shared) cache = " Its cached transactions were kept: another account uses the same token.";
        return { kind: "ok", text: `Removed “${name}”.${cache}` };
      }),
    );
  });

  const testToken = action(ADMIN_PATH, (form) =>
    admin.test(idOf(form)).pipe(
      Effect.map(
        ({ name, latestStatement }): Flash => ({
          kind: "ok",
          text: `FIO accepted the token of “${name}” for reading${latestStatement === undefined ? "" : ` (latest statement ${latestStatement})`}. This does not show whether it may submit payment orders.`,
        }),
      ),
    ),
  );

  /** Registered clients with their live grants, accounts by current name. */
  const clientRows = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const clients = yield* oauth.listClients(now);
      const grants = yield* oauth.listGrants(now);
      const configured = yield* accounts.list;
      const rows = clients.map(
        (client): ClientRow => ({
          clientId: client.clientId,
          clientName: client.clientName,
          redirectUris: client.redirectUris,
          createdAt: client.createdAt,
          lastUsedAt: client.lastUsedAt,
          grants: grants
            .filter((grant) => grant.clientId === client.clientId)
            .map((grant) => {
              const covered = configured.filter((account) => grant.accountFingerprints.includes(account.tokenFingerprint));
              const known = new Set(configured.map((account) => account.tokenFingerprint));
              return {
                grantId: grant.grantId,
                scopes: grant.scopes,
                accounts: covered.map((account) => account.name),
                staleTokens: grant.accountFingerprints.filter((fingerprint) => !known.has(fingerprint)).length,
                createdAt: grant.createdAt,
                lastUsedAt: grant.lastUsedAt,
              };
            }),
        }),
      );
      return rows;
  });

  const showClients = page((session) =>
    clientRows.pipe(
      Effect.map((rows) => html(clientsPage({ csrf: Redacted.value(session.csrf), flash: takeFlash(session), clients: rows }))),
      Effect.catch((error) =>
        Effect.succeed(
          html(clientsPage({ csrf: Redacted.value(session.csrf), flash: { kind: "error", text: error.description }, clients: [] }), 500),
        ),
      ),
    ),
  );

  const CLIENTS = `${ADMIN_PATH}/clients`;

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

  const showPassword = page((session) =>
    Effect.succeed(html(passwordPage({ csrf: Redacted.value(session.csrf), flash: takeFlash(session) }))),
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
          return { kind: "error", text: `Too many failed attempts. Try again in ${result.retryAfterSeconds} s.` } satisfies Flash;
        case "Unavailable":
          return { kind: "error", text: "The password could not be checked. See the server log." } satisfies Flash;
        case "Accepted": {
          // This browser stays signed in under a new session; every other one ends.
          const renewed = yield* sessions.signIn(session, result.value);
          yield* sessions.endOthers(renewed.session);
          renewed.session.flash = { kind: "ok", text: "Password changed. Every other admin session was signed out." };
          return redirect(`${ADMIN_PATH}/password`, sessionCookie(Redacted.value(renewed.cookie), ADMIN_ABSOLUTE_MS));
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

  const routes: ReadonlyArray<{
    readonly method: "GET" | "POST";
    readonly path: `/${string}`;
    readonly handler: (request: Request) => Effect.Effect<Response, never, Scope.Scope>;
  }> = [
    { method: "GET", path: ADMIN_PATH, handler: showAccounts },
    { method: "GET", path: `${ADMIN_PATH}/login`, handler: showLogin },
    { method: "POST", path: `${ADMIN_PATH}/login`, handler: submitLogin },
    { method: "POST", path: `${ADMIN_PATH}/logout`, handler: logout },
    { method: "POST", path: `${ADMIN_PATH}/accounts/add`, handler: addAccount },
    { method: "POST", path: `${ADMIN_PATH}/accounts/rename`, handler: renameAccount },
    { method: "POST", path: `${ADMIN_PATH}/accounts/rotate`, handler: rotateToken },
    { method: "POST", path: `${ADMIN_PATH}/accounts/remove`, handler: removeAccount },
    { method: "POST", path: `${ADMIN_PATH}/accounts/test`, handler: testToken },
    { method: "GET", path: CLIENTS, handler: showClients },
    { method: "POST", path: `${CLIENTS}/revoke`, handler: revokeClient },
    { method: "POST", path: `${ADMIN_PATH}/grants/revoke`, handler: revokeGrant },
    { method: "POST", path: `${CLIENTS}/revoke-all`, handler: revokeAll },
    { method: "GET", path: `${ADMIN_PATH}/password`, handler: showPassword },
    { method: "POST", path: `${ADMIN_PATH}/password`, handler: changePassword },
  ];

  return { routes };
});

/** Registers the admin routes on the router (HTTP mode with OAuth). */
export const AdminLive = (
  settings: AdminSettings,
): Layer.Layer<never, never, HttpRouter.HttpRouter | SqlClient.SqlClient | Accounts | AdminPassword | FioApi | TransactionCache> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* makeAdminServer(settings);
      const router = yield* HttpRouter.HttpRouter;
      for (const route of server.routes) yield* router.add(route.method, route.path, route.handler);
    }),
  );
