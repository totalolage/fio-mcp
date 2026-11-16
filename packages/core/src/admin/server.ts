import { ByteSize, Clock, Effect, Layer, Option, Redacted, Result, type Scope } from "effect";
import { Cookies, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { IpNetwork } from "effect/net";
import type { SqlClient } from "effect/sql";
import { Accounts, tokenHint } from "../accounts.js";
import type { Transactions } from "../cache/service.js";
import { AppConfig } from "../config.js";
import type { FioApi } from "../fio-api.js";
import { SCOPE_PAYMENTS } from "../mcp/permissions.js";
import { safeEqual } from "../oauth/crypto.js";
import type { LoginResult } from "../oauth/login.js";
import { pageHeaders } from "../oauth/pages.js";
import { makeWindowLimiter } from "../oauth/rate-limit.js";
import { makeOAuthStore } from "../oauth/store.js";
import { PaymentControls } from "../payment-controls.js";
import { parsePaymentForm, paymentFormValues, readPaymentForm } from "../payment-form.js";
import { formatAuditCursor, parseAuditCursor } from "../payment-ledger.js";
import { unlistedPayees } from "../payment-limits.js";
import { clientAddress } from "../transport/client-address.js";
import { restrictRoutes } from "../transport/restrict.js";
import { makeAccountAdmin, type RemovedCache } from "./accounts.js";
import {
  ADMIN_STYLE_HASH,
  accountsPage,
  adminLoginPage,
  adminRefusedPage,
  type ClientRow,
  clientsPage,
  type Flash,
  type PendingRow,
  passwordPage,
  paymentsPage,
  pendingPage,
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

/** Checks the second factor of a payment approval (see `verifySecondFactor`). */
export type SecondFactorCheck = (request: Request, form: URLSearchParams) => Effect.Effect<LoginResult<void>>;

export interface AdminSettings {
  readonly publicUrl: string;
  readonly dataKey: Redacted.Redacted<Uint8Array>;
  readonly trustedProxies?: ReadonlyArray<IpNetwork.IpNetwork> | undefined;
  /** FIO_MCP_ADMIN_ALLOWED_CIDRS: only these clients reach any /admin route (404 otherwise); empty allows all. */
  readonly allowedNetworks?: ReadonlyArray<IpNetwork.IpNetwork> | undefined;
  /** Replaces the built-in second-factor check of payment approvals (tests). */
  readonly secondFactor?: SecondFactorCheck | undefined;
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

/** Audit rows per page of /admin/payments. */
const AUDIT_PAGE_ROWS = 100;

/** The query string of a GET (request.url is the path and query). */
const queryOf = (request: Request) => {
  const start = request.url.indexOf("?");
  return new URLSearchParams(start < 0 ? "" : request.url.slice(start + 1));
};

const quoted = (names: ReadonlyArray<string>) => names.map((name) => `“${name}”`).join(", ");

/** `accounts` kept data because a token they have, or had, is bound to the same bank account. */
const purgedText = (deleted: number, accounts: ReadonlyArray<string>): string => {
  const holders = `${quoted(accounts)} ${accounts.length === 1 ? "has or had a token" : "have or had tokens"} for the same bank account`;
  if (deleted > 0 && accounts.length > 0) return `Its cached transactions were deleted, except where ${holders}.`;
  if (deleted > 0) return "Its cached transactions were deleted.";
  if (accounts.length > 0) return `Its cached transactions were kept: ${holders}.`;
  return "Nothing was cached under its tokens, so nothing was deleted.";
};

const removedCacheText = (cache: RemovedCache): string => {
  switch (cache.kind) {
    case "kept":
      return "Its cached transactions were kept.";
    case "purged": {
      const text = purgedText(cache.deleted, cache.accounts);
      if (cache.unattributed === 0) return text;
      const one = cache.unattributed === 1;
      const which = one ? "1 cached bank account" : `${cache.unattributed} cached bank accounts`;
      return `${text} ${which} could not be linked to any configured account and ${one ? "was" : "were"} not touched.`;
    }
  }
};

export const makeAdminServer = Effect.fn("AdminServer.make")(function* (settings: AdminSettings) {
  const password = yield* AdminPassword;
  const accounts = yield* Accounts;
  const sessions = yield* makeAdminSessions();
  const admin = yield* makeAccountAdmin(settings.dataKey);
  const oauth = yield* makeOAuthStore();
  const payments = yield* PaymentControls;
  // Server defaults and ceilings of grant payment limits (SEC-26).
  const { paymentLimits } = yield* AppConfig;
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
  ) => html(adminLoginPage({ csrf: Redacted.value(csrf), error, totp: password.totpEnabled }), status, extra, cookies);

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
        return redirect(ADMIN_PATH, sessionCookie(Redacted.value(next.cookie), ADMIN_ABSOLUTE_MS));
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
      Effect.map(({ name, cache }): Flash => ({ kind: "ok", text: `Removed “${name}”. ${removedCacheText(cache)}` })),
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
                payments: grant.scopes.includes(SCOPE_PAYMENTS)
                  ? { values: paymentFormValues(grant.payments, paymentLimits), followsDefaults: grant.payments.limits === null }
                  : undefined,
              };
            }),
        }),
      );
      return rows;
  });

  const showClients = page((session) =>
    clientRows.pipe(
      Effect.map((rows) =>
        html(
          clientsPage({
            csrf: Redacted.value(session.csrf),
            flash: takeFlash(session),
            clients: rows,
            paymentCeiling: paymentLimits,
          }),
        ),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          html(
            clientsPage({
              csrf: Redacted.value(session.csrf),
              flash: { kind: "error", text: error.description },
              clients: [],
              paymentCeiling: paymentLimits,
            }),
            500,
          ),
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

  /** A live grant's payment limits and allowlist, never above the ceilings (SEC-26, SEC-27). */
  const updateGrantPayments = action(
    CLIENTS,
    Effect.fnUntraced(function* (form: URLSearchParams) {
      const grantId = field(form, "grant") ?? "";
      const parsed = parsePaymentForm(readPaymentForm(form), paymentLimits);
      if (Result.isFailure(parsed)) return { kind: "error", text: `Payment settings not saved: ${parsed.failure}` } satisfies Flash;
      const now = yield* Clock.currentTimeMillis;
      const grant = (yield* oauth.listGrants(now)).find((candidate) => candidate.grantId === grantId);
      if (grant === undefined || !grant.scopes.includes(SCOPE_PAYMENTS)) {
        return { kind: "error", text: "That authorization is no longer active or cannot submit payments." } satisfies Flash;
      }
      if (!(yield* oauth.updateGrantPayments(grantId, parsed.success, now))) {
        return { kind: "error", text: "That authorization is no longer active." } satisfies Flash;
      }
      yield* Effect.logInfo(`admin: changed the payment settings of a grant (allowlist ${parsed.success.allowlist.mode})`);
      return { kind: "ok", text: "Saved the payment limits and payee allowlist." } satisfies Flash;
    }, Effect.mapError((error) => ({ message: error.description }))),
  );

  // -- Payments (SEC-27, SEC-29) ---------------------------------------------

  const PAYMENTS = `${ADMIN_PATH}/payments`;
  const PENDING = `${PAYMENTS}/pending`;

  /**
   * The second factor for approving a held payment batch (SEC-27 confirm,
   * SEC-03): the single place an approval is checked beyond the signed-in
   * session, Origin and CSRF. Nothing is uploaded unless it is Accepted.
   *
   * `settings.secondFactor` replaces the check (tests). Otherwise, with
   * FIO_MCP_ADMIN_TOTP_SECRET_FILE set, the form's `totp` code is checked
   * like a sign-in code: it fails closed (a missing, wrong or already used
   * code is Rejected, and counts as a failure for this client address).
   * Without TOTP, every approval is Accepted.
   */
  const verifySecondFactor: SecondFactorCheck = (request, form) => {
    if (settings.secondFactor !== undefined) return settings.secondFactor(request, form);
    if (!password.totpEnabled) return Effect.succeed({ _tag: "Accepted", value: undefined });
    return password.verifyTotp(clientAddress(request, trustedProxies), field(form, "totp") ?? "");
  };
  /** The pending page asks for an authentication code (`totp`). */
  const secondFactor = password.totpEnabled;

  /** Audit rows newest first, `?grant=` filters, `?before=` pages back. */
  const showPayments = (request: Request) => {
    const query = queryOf(request);
    const grant = query.get("grant") || undefined;
    // A malformed or legacy cursor shows the first page.
    const before = parseAuditCursor(query.get("before") ?? "");
    return page((session) =>
      payments.listAudit({ limit: AUDIT_PAGE_ROWS, ...(grant === undefined ? {} : { grantId: grant }), ...(before === undefined ? {} : { before }) }).pipe(
        Effect.map((rows) => {
          const last = rows.at(-1);
          const older =
            rows.length < AUDIT_PAGE_ROWS || last === undefined
              ? undefined
              : `${PAYMENTS}?${new URLSearchParams({ ...(grant === undefined ? {} : { grant }), before: formatAuditCursor(last) })}`;
          return html(paymentsPage({ csrf: Redacted.value(session.csrf), flash: takeFlash(session), rows, grant, older }));
        }),
        Effect.catch((error) =>
          Effect.succeed(
            html(
              paymentsPage({
                csrf: Redacted.value(session.csrf),
                flash: { kind: "error", text: error.message },
                rows: [],
                grant,
                older: undefined,
              }),
              500,
            ),
          ),
        ),
      ),
    )(request);
  };

  /** Held batches (the service drops expired ones first), payees marked against the grant's allowlist now. */
  const pendingRows = Effect.gen(function* () {
    const views = yield* payments.listPending;
    const grants = yield* oauth
      .listGrants(yield* Clock.currentTimeMillis)
      .pipe(Effect.mapError((error) => ({ message: error.description })));
    return views.map(({ batch, audit }): PendingRow => {
      const grant = grants.find((candidate) => candidate.grantId === batch.grantId);
      return {
        pendingId: batch.pendingId,
        accountName: batch.accountName,
        xml: batch.xml,
        xmlSha256: batch.xmlSha256,
        expiresAt: batch.expiresAt,
        audit,
        unlisted: grant === undefined ? undefined : unlistedPayees(grant.payments.allowlist, audit.payees),
      };
    });
  });

  const showPending = page((session) =>
    pendingRows.pipe(
      Effect.map((rows) => html(pendingPage({ csrf: Redacted.value(session.csrf), flash: takeFlash(session), rows, secondFactor }))),
      Effect.catch((error) =>
        Effect.succeed(
          html(
            pendingPage({ csrf: Redacted.value(session.csrf), flash: { kind: "error", text: error.message }, rows: [], secondFactor }),
            500,
          ),
        ),
      ),
    ),
  );

  /** Uploads the held batch's exact XML once, after the second factor (SEC-27 confirm). */
  const approvePayment = action(
    PENDING,
    Effect.fnUntraced(function* (form: URLSearchParams, _session: AdminSession, request: Request) {
      const factor = yield* verifySecondFactor(request, form);
      switch (factor._tag) {
        case "Rejected":
          return { kind: "error", text: "The authentication code is wrong. Nothing was uploaded." } satisfies Flash;
        case "Throttled":
          return {
            kind: "error",
            text: `Too many failed attempts. Try again in ${factor.retryAfterSeconds} s. Nothing was uploaded.`,
          } satisfies Flash;
        case "Unavailable":
          return { kind: "error", text: "The authentication code could not be checked. Nothing was uploaded." } satisfies Flash;
        case "Accepted":
          break;
      }
      // Checked again under the grant's lock: a grant revoked after the
      // page loaded makes the approval upload nothing.
      const grantLive = (grantId: string) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => oauth.listGrants(now)).pipe(
          Effect.map((grants) => grants.some((grant) => grant.grantId === grantId)),
          Effect.mapError((error) => ({ message: error.description })),
        );
      const result = yield* payments.approvePending(field(form, "pending") ?? "", grantLive);
      yield* Effect.logInfo(`admin: approved a held payment batch (${result.outcome})`);
      return {
        kind: result.outcome === "accepted" ? "ok" : "error",
        text: `Batch ${result.pendingId}: ${result.outcome}. ${result.message}`,
      } satisfies Flash;
    }),
  );

  const declinePayment = action(PENDING, (form) =>
    payments.declinePending(field(form, "pending") ?? "").pipe(
      Effect.tap((declined) => (declined ? Effect.logInfo("admin: declined a held payment batch") : Effect.void)),
      Effect.map(
        (declined): Flash =>
          declined
            ? { kind: "ok", text: "Declined the batch; nothing was sent to FIO." }
            : { kind: "error", text: "That batch is no longer pending (approved, declined or expired)." },
      ),
    ),
  );

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
    { method: "POST", path: `${ADMIN_PATH}/grants/payments`, handler: updateGrantPayments },
    { method: "GET", path: PAYMENTS, handler: showPayments },
    { method: "GET", path: PENDING, handler: showPending },
    { method: "POST", path: `${PENDING}/approve`, handler: approvePayment },
    { method: "POST", path: `${PENDING}/decline`, handler: declinePayment },
    { method: "GET", path: `${ADMIN_PATH}/password`, handler: showPassword },
    { method: "POST", path: `${ADMIN_PATH}/password`, handler: changePassword },
  ];

  return { routes };
});

/**
 * Admin routes: every route `routes` adds to the router answers 404 to
 * clients outside `settings.allowedNetworks` (FIO_MCP_ADMIN_ALLOWED_CIDRS).
 * The restriction is route middleware over the whole layer, so a route
 * registered here is covered without being listed anywhere.
 */
export const adminRoutes = <E, R>(settings: AdminSettings, routes: Layer.Layer<never, E, R>) =>
  routes.pipe(
    Layer.provide(
      restrictRoutes({ allowedNetworks: settings.allowedNetworks ?? [], trustedProxies: settings.trustedProxies ?? [] }).layer,
    ),
  );

/** Registers the admin routes on the router (HTTP mode with OAuth), behind `adminRoutes`. */
export const AdminLive = (
  settings: AdminSettings,
): Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | SqlClient.SqlClient | Accounts | AdminPassword | FioApi | Transactions | PaymentControls | AppConfig
> =>
  adminRoutes(
    settings,
    Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* makeAdminServer(settings);
        const router = yield* HttpRouter.HttpRouter;
        for (const route of server.routes) yield* router.add(route.method, route.path, route.handler);
      }),
    ),
  );
