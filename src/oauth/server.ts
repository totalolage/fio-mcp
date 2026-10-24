import { ByteSize, Clock, Effect, Layer, Option, Redacted, Result, Schedule, Schema } from "effect";
import { Cookies, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { IpNetwork } from "effect/net";
import type { SqlClient } from "effect/sql";
import { Accounts } from "../accounts.js";
import type { HttpAuthConfig } from "../config.js";
import { SCOPE_PAYMENTS, SCOPE_READ, SCOPES } from "../mcp/permissions.js";
import { Auth, AuthUnavailable, Unauthorized } from "../transport/auth.js";
import { clientAddress } from "../transport/client-address.js";
import type { Principal } from "../transport/principal.js";
import { CODE_CHALLENGE, hashSecret, pkceMatches, randomId, randomSecret, safeEqual } from "./crypto.js";
import {
  AccessDenied,
  InvalidClient,
  InvalidClientMetadata,
  InvalidGrant,
  InvalidRedirectUri,
  InvalidRequest,
  InvalidScope,
  InvalidTarget,
  OAUTH_ERRORS,
  type OAuthError,
  PageError,
  TemporarilyUnavailable,
  TooManyRequests,
  UnsupportedGrantType,
  UnsupportedResponseType,
} from "./errors.js";
import { DEFAULT_THROTTLE, makeLoginGuard, type ThrottlePolicy } from "./login.js";
import { consentPage, errorPage, loginPage, pageHeaders, redirectFormTarget } from "./pages.js";
import { makeWindowLimiter } from "./rate-limit.js";
import { type AuthSession, makeSessions, type PendingAuthorization, SESSION_COOKIE, SESSION_TTL_MS } from "./sessions.js";
import { type Client, type Grant, makeOAuthStore, type OAuthStore } from "./store.js";
import { isResource, MCP_RESOURCE_PATH, redirectUriMatches, redirectUriProblem, withParams } from "./urls.js";

/**
 * The embedded OAuth 2.1 authorization server and the resource-server side
 * of /mcp (MCP authorization, revision 2026-07-28). fio-mcp is both: the
 * issuer is FIO_MCP_PUBLIC_URL and every token's audience is that origin
 * plus /mcp. It makes no outbound requests.
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata
 *   GET  /.well-known/oauth-authorization-server      RFC 8414 metadata
 *   POST /register   RFC 7591 dynamic registration (public clients only)
 *   GET  /authorize  authorization code request (PKCE S256, RFC 8707 resource)
 *   GET  /login, POST /login      admin password
 *   GET  /consent, POST /consent  scopes and accounts
 *   POST /token      authorization_code and refresh_token grants
 *   POST /revoke     RFC 7009 revocation
 */

export const LIMITS = {
  codeTtlMs: 60_000,
  accessTtlMs: 60 * 60_000,
  refreshTtlMs: 30 * 24 * 60 * 60_000,
  maxClients: 100,
  /** Registrations accepted per window (all callers together). */
  registrationsPerWindow: 20,
  registrationWindowMs: 60 * 60_000,
  /** A client that never completed an authorization is dropped after this. */
  unusedClientMs: 60 * 60_000,
  /** A client without a live grant is dropped this long after its last use. */
  idleClientMs: 24 * 60 * 60_000,
  maxRedirectUris: 5,
  maxClientName: 100,
  maxState: 1024,
  maxBodyBytes: 16 * 1024,
  /** Sign-ins (/authorize requests that start a session) per client address per window. */
  authorizationsPerAddress: 20,
  authorizationWindowMs: 10 * 60_000,
} as const;

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

/** Endpoints browser-based clients may call cross-origin. */
const CORS_PATHS = [
  PROTECTED_RESOURCE_PATH,
  `${PROTECTED_RESOURCE_PATH}${MCP_RESOURCE_PATH}`,
  AUTHORIZATION_SERVER_PATH,
  "/register",
  "/token",
  "/revoke",
] as const;

export interface OAuthSettings {
  readonly publicUrl: string;
  readonly passwordHash: Extract<HttpAuthConfig, { kind: "oauth" }>["passwordHash"];
  readonly throttle?: ThrottlePolicy | undefined;
  /** Proxies whose X-Forwarded-For names the client address (see clientAddress). */
  readonly trustedProxies?: ReadonlyArray<IpNetwork.IpNetwork> | undefined;
}

const ACCESS_PREFIX = "fio_at_";
const REFRESH_PREFIX = "fio_rt_";
const CODE_PREFIX = "fio_ac_";

const BEARER = /^Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)[ \t]*$/i;
// Control and bidirectional-override characters are dropped from client names.
const UNSAFE_NAME_CHARS = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;
// Token, registration and metadata endpoints carry no cookies, so any origin may call them.
const CORS = { "access-control-allow-origin": "*" } as const;

const json = (body: unknown, status = 200, headers: Record<string, string> = NO_STORE) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...headers, ...CORS } });

const errorJson = (error: OAuthError) => {
  const { code, status } = OAUTH_ERRORS[error._tag];
  const retry: Record<string, string> =
    "retryAfterSeconds" in error ? { "retry-after": String(error.retryAfterSeconds) } : {};
  return json({ error: code, error_description: error.description }, status, { ...NO_STORE, ...retry });
};

const html = (body: string, status = 200, formTargets: ReadonlyArray<string> = [], extra: Record<string, string> = {}) =>
  HttpServerResponse.text(body, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: { ...pageHeaders(formTargets), ...extra },
  });

const pageError = (error: PageError) =>
  html(
    errorPage(error.title, error.detail),
    error.status,
    [],
    error.retryAfterSeconds === undefined ? {} : { "retry-after": String(error.retryAfterSeconds) },
  );

const sessionCookie = (value: string, maxAgeMs: number) =>
  Cookies.setUnsafe(Cookies.empty, SESSION_COOKIE, value, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: `${Math.max(0, Math.floor(maxAgeMs / 1000))} seconds`,
  });

const expiredCookie = sessionCookie("", 0);

const redirect = (location: string, cookies?: Cookies.Cookies) =>
  HttpServerResponse.redirect(location, { status: 303, headers: NO_STORE, cookies });

const expired = new PageError({
  status: 400,
  title: "Sign-in expired",
  detail: "This sign-in is no longer valid. Start the connection again from your application.",
});

/** One value of a parameter; repeating it is an error (RFC 6749 §3.1). Empty counts as absent. */
const single = (params: URLSearchParams, name: string): Result.Result<string | undefined, string> => {
  const values = params.getAll(name);
  if (values.length > 1) return Result.fail(`${name} must not be repeated`);
  const value = values[0];
  return Result.succeed(value === undefined || value === "" ? undefined : value);
};

const param = (params: URLSearchParams, name: string): Effect.Effect<string | undefined, InvalidRequest> =>
  Result.match(single(params, name), {
    onFailure: (description) => Effect.fail(new InvalidRequest({ description })),
    onSuccess: Effect.succeed,
  });

const required = (params: URLSearchParams, name: string) =>
  param(params, name).pipe(
    Effect.filterOrFail(
      (value): value is string => value !== undefined,
      () => new InvalidRequest({ description: `${name} is required` }),
    ),
  );

const contentType = (request: HttpServerRequest.HttpServerRequest) =>
  (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";

/** The body as text, at most LIMITS.maxBodyBytes. */
const bodyText = (request: HttpServerRequest.HttpServerRequest) =>
  request.text.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(LIMITS.maxBodyBytes)),
    Effect.mapError(() => new InvalidRequest({ description: `the request body could not be read (at most ${LIMITS.maxBodyBytes} bytes)` })),
  );

const readForm = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  if (contentType(request) !== "application/x-www-form-urlencoded") {
    return yield* new InvalidRequest({ description: "send parameters as application/x-www-form-urlencoded" });
  }
  return new URLSearchParams(yield* bodyText(request));
});

const RegistrationRequest = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  client_name: Schema.optional(Schema.String),
  grant_types: Schema.optional(Schema.Array(Schema.String)),
  response_types: Schema.optional(Schema.Array(Schema.String)),
  token_endpoint_auth_method: Schema.optional(Schema.String),
});

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeRegistration = Schema.decodeUnknownResult(RegistrationRequest);

/** Scopes from an authorization or refresh request; offline_access is accepted and ignored. */
const parseScopes = (raw: string | undefined): Result.Result<ReadonlyArray<string>, InvalidScope> => {
  const requested = (raw ?? "").split(" ").filter((scope) => scope !== "" && scope !== "offline_access");
  const unknown = requested.filter((scope) => !(SCOPES as ReadonlyArray<string>).includes(scope));
  if (unknown.length > 0) {
    return Result.fail(new InvalidScope({ description: `unknown scope; supported scopes are ${SCOPES.join(" ")}` }));
  }
  return Result.succeed(requested.length === 0 ? [SCOPE_READ] : [...new Set(requested)]);
};

export const makeOAuthServer = Effect.fn("OAuthServer.make")(function* (settings: OAuthSettings) {
  const store: OAuthStore = yield* makeOAuthStore();
  const accounts = yield* Accounts;
  const sessions = yield* makeSessions();
  const guard = yield* makeLoginGuard(settings.passwordHash, settings.throttle ?? DEFAULT_THROTTLE);
  const issuer = settings.publicUrl;
  const resource = `${issuer}${MCP_RESOURCE_PATH}`;
  const resourceMetadataUrl = `${issuer}${PROTECTED_RESOURCE_PATH}${MCP_RESOURCE_PATH}`;
  const accountNames = accounts.list.map((account) => account.name);
  const registrations: Array<number> = [];
  const authorizationsByAddress = makeWindowLimiter({
    limit: LIMITS.authorizationsPerAddress,
    windowMs: LIMITS.authorizationWindowMs,
    maxKeys: 10_000,
  });
  const trustedProxies = settings.trustedProxies ?? [];
  const addressOf = (request: HttpServerRequest.HttpServerRequest) => clientAddress(request, trustedProxies);

  const challenge = (error?: string) =>
    `Bearer resource_metadata="${resourceMetadataUrl}", scope="${SCOPE_READ}"${error === undefined ? "" : `, error="${error}"`}`;

  const purge = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    store.purge(now, { unusedClientMs: LIMITS.unusedClientMs, idleClientMs: LIMITS.idleClientMs }),
  );

  // -- Resource server -------------------------------------------------------

  const authenticate = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    const header = request.headers.authorization;
    if (header === undefined || header === "") return yield* new Unauthorized({ challenge: challenge() });
    const token = BEARER.exec(header)?.[1];
    if (token === undefined) return yield* new Unauthorized({ challenge: challenge("invalid_request") });
    const now = yield* Clock.currentTimeMillis;
    const grant = yield* store.accessGrant(hashSecret(token), now).pipe(Effect.mapError(() => new AuthUnavailable()));
    // The audience check: only tokens issued for this server's /mcp resource.
    if (Option.isNone(grant) || grant.value.resource !== resource) {
      return yield* new Unauthorized({ challenge: challenge("invalid_token") });
    }
    return {
      subject: grant.value.grantId,
      scopes: grant.value.scopes,
      accountFingerprints: grant.value.accountFingerprints,
    } satisfies Principal;
  });

  // -- Metadata ----------------------------------------------------------------

  const protectedResource = json(
    {
      resource,
      authorization_servers: [issuer],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "fio-mcp",
    },
    200,
    { "cache-control": "max-age=300" },
  );

  const authorizationServer = json(
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`,
      scopes_supported: SCOPES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    },
    200,
    { "cache-control": "max-age=300" },
  );

  // -- Registration (RFC 7591) -------------------------------------------------

  const register = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    if (contentType(request) !== "application/json") {
      return yield* new InvalidClientMetadata({ description: "send the client metadata as application/json" });
    }
    const body = decodeJson(yield* bodyText(request));
    if (Result.isFailure(body)) return yield* new InvalidClientMetadata({ description: "the body is not valid JSON" });
    const metadata = decodeRegistration(body.success);
    if (Result.isFailure(metadata)) {
      return yield* new InvalidClientMetadata({
        description: "expected redirect_uris (array of strings) and optional client_name, grant_types, response_types",
      });
    }
    const { redirect_uris, client_name, grant_types, response_types } = metadata.success;
    if (redirect_uris.length === 0 || redirect_uris.length > LIMITS.maxRedirectUris) {
      return yield* new InvalidRedirectUri({ description: `register 1 to ${LIMITS.maxRedirectUris} redirect URIs` });
    }
    for (const uri of redirect_uris) {
      const problem = redirectUriProblem(uri);
      if (problem !== undefined) return yield* new InvalidRedirectUri({ description: problem });
    }
    if (grant_types?.some((type) => type !== "authorization_code" && type !== "refresh_token") === true) {
      return yield* new InvalidClientMetadata({ description: "only the authorization_code and refresh_token grant types are supported" });
    }
    if (response_types?.some((type) => type !== "code") === true) {
      return yield* new InvalidClientMetadata({ description: "only the code response type is supported" });
    }
    const now = yield* Clock.currentTimeMillis;
    while (registrations.length > 0 && (registrations[0] ?? now) <= now - LIMITS.registrationWindowMs) registrations.shift();
    if (registrations.length >= LIMITS.registrationsPerWindow) {
      const retry = Math.ceil(((registrations[0] ?? now) + LIMITS.registrationWindowMs - now) / 1000);
      return yield* new TooManyRequests({
        description: "too many client registrations; try again later",
        retryAfterSeconds: retry,
      });
    }
    // Reserved before anything yields, so concurrent requests cannot exceed the window.
    registrations.push(now);
    yield* purge;
    const name = client_name?.replace(UNSAFE_NAME_CHARS, "").trim().slice(0, LIMITS.maxClientName);
    const client: Client = {
      clientId: yield* randomId("fio_client_"),
      clientName: name === undefined || name === "" ? null : name,
      redirectUris: [...new Set(redirect_uris)],
      createdAt: now,
      lastUsedAt: null,
    };
    if (!(yield* store.insertClient(client, LIMITS.maxClients))) {
      return yield* new TemporarilyUnavailable({
        description: "the client registry is full; remove unused clients with `fio-mcp clients revoke <id>`",
        retryAfterSeconds: LIMITS.unusedClientMs / 1000,
      });
    }
    yield* Effect.logInfo(`oauth: registered client ${client.clientId}`);
    return json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(now / 1000),
        ...(client.clientName === null ? {} : { client_name: client.clientName }),
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // Public clients only: any requested client authentication is replaced (RFC 7591 §3.2.1).
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  // -- Authorization endpoint ------------------------------------------------

  /** Client and redirect URI; failures are shown to the user, never redirected. */
  const authorizationTarget = Effect.fnUntraced(function* (params: URLSearchParams) {
    const bad = (detail: string) => new PageError({ status: 400, title: "Invalid authorization request", detail });
    const clientId = single(params, "client_id");
    const redirectUri = single(params, "redirect_uri");
    if (Result.isFailure(clientId) || clientId.success === undefined) {
      return yield* bad("The request has no single client_id.");
    }
    if (Result.isFailure(redirectUri)) return yield* bad("The request repeats redirect_uri.");
    const client = yield* store.client(clientId.success).pipe(
      Effect.mapError(() => new PageError({ status: 500, title: "Server error", detail: "The client could not be read." })),
    );
    if (Option.isNone(client)) {
      return yield* bad("This application is not registered (or its registration expired). Remove the server from the application and connect again.");
    }
    const registered = client.value.redirectUris;
    const uri = redirectUri.success ?? (registered.length === 1 ? registered[0] : undefined);
    if (uri === undefined || !registered.some((candidate) => redirectUriMatches(candidate, uri))) {
      return yield* bad("The redirect URI does not match the application's registration.");
    }
    return { client: client.value, redirectUri: uri };
  });

  /** The rest of the request; failures are redirected to the client. */
  const authorizationRequest = Effect.fnUntraced(function* (params: URLSearchParams, client: Client, redirectUri: string) {
    const responseType = yield* param(params, "response_type");
    if (responseType !== "code") {
      return yield* new UnsupportedResponseType({ description: "response_type must be code" });
    }
    const challengeValue = yield* required(params, "code_challenge");
    const method = yield* param(params, "code_challenge_method");
    if (method !== "S256") return yield* new InvalidRequest({ description: "code_challenge_method must be S256" });
    if (!CODE_CHALLENGE.test(challengeValue)) {
      return yield* new InvalidRequest({ description: "code_challenge must be a base64url SHA-256 value" });
    }
    const resources = params.getAll("resource");
    if (resources.length === 0) return yield* new InvalidRequest({ description: `resource is required (${resource})` });
    if (resources.length > 1 || !isResource(resources[0] ?? "", resource)) {
      return yield* new InvalidTarget({ description: `the only resource is ${resource}` });
    }
    const scopes = parseScopes(yield* param(params, "scope"));
    if (Result.isFailure(scopes)) return yield* scopes.failure;
    return {
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri,
      state: yield* param(params, "state"),
      codeChallenge: challengeValue,
      requestedScopes: scopes.success,
      resource,
    } satisfies PendingAuthorization;
  });

  const errorRedirect = (redirectUri: string, state: string | undefined, error: OAuthError, cookies?: Cookies.Cookies) =>
    redirect(
      withParams(redirectUri, {
        error: OAUTH_ERRORS[error._tag].code,
        error_description: error.description,
        state,
        iss: issuer,
      }),
      cookies,
    );

  const authorize = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    // The router also routes absolute-form targets that are not URLs (`GET http://[/authorize`).
    if (!URL.canParse(request.url, issuer)) {
      return yield* new PageError({ status: 400, title: "Invalid authorization request", detail: "The request URL is malformed." });
    }
    const params = new URL(request.url, issuer).searchParams;
    const target = yield* authorizationTarget(params);
    const state = Result.getOrUndefined(single(params, "state"));
    if (state !== undefined && state.length > LIMITS.maxState) {
      return errorRedirect(target.redirectUri, undefined, new InvalidRequest({ description: "state is too long" }));
    }
    const pending = yield* Effect.result(authorizationRequest(params, target.client, target.redirectUri));
    if (Result.isFailure(pending)) return errorRedirect(target.redirectUri, state, pending.failure);
    // Anyone can start sign-ins; each holds memory for SESSION_TTL_MS. Not
    // limited per client: client ids are public, so anyone could block the
    // admin's client (sessions.ts makes room per client instead).
    const now = yield* Clock.currentTimeMillis;
    const address = addressOf(request);
    const wait = authorizationsByAddress.retryAfter(address, now);
    if (wait > 0) {
      yield* Effect.logDebug("oauth: refused a sign-in: too many started from one address");
      return yield* new PageError({
        status: 429,
        title: "Too many sign-in attempts",
        detail: `Too many sign-ins were started recently. Try again in ${wait} s.`,
        retryAfterSeconds: wait,
      });
    }
    authorizationsByAddress.record(address, now);
    const issued = yield* sessions.start(pending.success);
    return redirect("/login", sessionCookie(Redacted.value(issued.cookie), SESSION_TTL_MS));
  });

  // -- Login and consent pages -----------------------------------------------

  const currentSession = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    const session = yield* sessions.find(request.cookies[SESSION_COOKIE]);
    if (Option.isNone(session)) return yield* expired;
    return session.value;
  });

  /** Origin (when sent) must be ours, the CSRF token must match the session's. */
  const checkForm = Effect.fnUntraced(function* (
    request: HttpServerRequest.HttpServerRequest,
    session: AuthSession,
    form: URLSearchParams,
  ) {
    const origin = request.headers.origin;
    const csrf = Result.getOrUndefined(single(form, "csrf"));
    if ((origin !== undefined && origin !== issuer) || csrf === undefined || !safeEqual(csrf, Redacted.value(session.csrf))) {
      return yield* new PageError({
        status: 403,
        title: "Request refused",
        detail: "The form could not be verified. Reload the page and try again.",
      });
    }
  });

  const pageForm = (request: HttpServerRequest.HttpServerRequest) =>
    readForm(request).pipe(
      Effect.mapError((error) => new PageError({ status: 400, title: "Invalid request", detail: error.description })),
    );

  const renderLogin = (session: AuthSession, status = 200, error?: string, extra: Record<string, string> = {}) =>
    html(
      loginPage({
        clientName: session.request.clientName,
        redirectUri: session.request.redirectUri,
        csrf: Redacted.value(session.csrf),
        error,
      }),
      status,
      [],
      extra,
    );

  const renderConsent = (session: AuthSession, status = 200, error?: string) =>
    html(
      consentPage({
        clientId: session.request.clientId,
        clientName: session.request.clientName,
        redirectUri: session.request.redirectUri,
        csrf: Redacted.value(session.csrf),
        paymentsRequested: session.request.requestedScopes.includes(SCOPE_PAYMENTS),
        accounts: accountNames,
        error,
      }),
      status,
      redirectFormTarget(session.request.redirectUri),
    );

  const showLogin = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    const session = yield* currentSession(request);
    return session.loggedIn ? redirect("/consent") : renderLogin(session);
  });

  const submitLogin = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    const session = yield* currentSession(request);
    const form = yield* pageForm(request);
    yield* checkForm(request, session, form);
    if (session.loggedIn) return redirect("/consent");
    const password = Result.getOrUndefined(single(form, "password")) ?? "";
    const result = yield* guard.attempt(addressOf(request), Redacted.make(password));
    switch (result._tag) {
      case "Accepted": {
        const next = yield* sessions.login(session);
        const now = yield* Clock.currentTimeMillis;
        return redirect("/consent", sessionCookie(Redacted.value(next.cookie), next.session.expiresAt - now));
      }
      case "Rejected":
        return renderLogin(session, 401, "Wrong password.");
      case "Throttled":
        return renderLogin(
          session,
          429,
          `Too many failed attempts. Try again in ${result.retryAfterSeconds} s.`,
          { "retry-after": String(result.retryAfterSeconds) },
        );
    }
  });

  const showConsent = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    const session = yield* currentSession(request);
    return session.loggedIn ? renderConsent(session) : redirect("/login");
  });

  const submitConsent = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    const session = yield* currentSession(request);
    const form = yield* pageForm(request);
    yield* checkForm(request, session, form);
    if (!session.loggedIn) return redirect("/login");
    const pending = session.request;
    const decision = Result.getOrUndefined(single(form, "decision"));
    if (decision !== "approve") {
      yield* sessions.end(session);
      return errorRedirect(
        pending.redirectUri,
        pending.state,
        new AccessDenied({ description: "the user denied the request" }),
        expiredCookie,
      );
    }
    // The form carries names for display; the grant binds the tokens behind them.
    const chosen = form.getAll("account");
    const chosenAccounts = accounts.list.filter((account) => chosen.includes(account.name));
    if (chosenAccounts.length === 0) return renderConsent(session, 400, "Select at least one account.");
    const scopes = form.getAll("scope").includes(SCOPE_PAYMENTS) ? [SCOPE_READ, SCOPE_PAYMENTS] : [SCOPE_READ];
    const client = yield* store.client(pending.clientId).pipe(Effect.orElseSucceed(() => Option.none<Client>()));
    if (Option.isNone(client)) {
      yield* sessions.end(session);
      return yield* new PageError({
        status: 400,
        title: "Application removed",
        detail: "The application's registration was revoked or expired. Connect again from the application.",
      });
    }
    const code = yield* randomSecret(CODE_PREFIX);
    const now = yield* Clock.currentTimeMillis;
    const grant: Grant = {
      grantId: yield* randomId("fio_grant_"),
      clientId: pending.clientId,
      scopes,
      accountFingerprints: [...new Set(chosenAccounts.map((account) => account.tokenFingerprint))],
      resource: pending.resource,
    };
    yield* store
      .createGrant(
        grant,
        {
          codeHash: hashSecret(code),
          clientId: pending.clientId,
          redirectUri: pending.redirectUri,
          codeChallenge: pending.codeChallenge,
          expiresAt: now + LIMITS.codeTtlMs,
        },
        now,
      )
      .pipe(
        Effect.mapError(
          () => new PageError({ status: 500, title: "Server error", detail: "The authorization could not be stored." }),
        ),
      );
    yield* sessions.end(session);
    yield* Effect.logInfo(`oauth: client ${pending.clientId} authorized (${scopes.join(" ")}; ${chosenAccounts.length} accounts)`);
    return redirect(
      withParams(pending.redirectUri, { code: Redacted.value(code), state: pending.state, iss: issuer }),
      expiredCookie,
    );
  });

  // -- Token endpoint ----------------------------------------------------------

  /** Public clients identify themselves with client_id in the body (token_endpoint_auth_method none). */
  const clientOf = Effect.fnUntraced(function* (form: URLSearchParams) {
    const clientId = yield* param(form, "client_id");
    if (clientId === undefined) return yield* new InvalidClient({ description: "client_id is required" });
    const client = yield* store.client(clientId);
    if (Option.isNone(client)) return yield* new InvalidClient({ description: "unknown client" });
    return client.value;
  });

  const checkResource = Effect.fnUntraced(function* (form: URLSearchParams, isRequired: boolean) {
    const values = form.getAll("resource");
    if (values.length === 0) {
      if (isRequired) return yield* new InvalidRequest({ description: `resource is required (${resource})` });
      return;
    }
    if (values.length > 1 || !isResource(values[0] ?? "", resource)) {
      return yield* new InvalidTarget({ description: `the only resource is ${resource}` });
    }
  });

  const newPair = Effect.fnUntraced(function* () {
    const access = yield* randomSecret(ACCESS_PREFIX);
    const refresh = yield* randomSecret(REFRESH_PREFIX);
    const now = yield* Clock.currentTimeMillis;
    return {
      access,
      refresh,
      pair: {
        accessHash: hashSecret(access),
        accessExpiresAt: now + LIMITS.accessTtlMs,
        refreshHash: hashSecret(refresh),
        refreshExpiresAt: now + LIMITS.refreshTtlMs,
      },
    };
  });

  const tokenResponse = (grant: Grant, issued: Effect.Success<ReturnType<typeof newPair>>) =>
    json({
      access_token: Redacted.value(issued.access),
      token_type: "Bearer",
      expires_in: LIMITS.accessTtlMs / 1000,
      refresh_token: Redacted.value(issued.refresh),
      scope: grant.scopes.join(" "),
    });

  const exchangeCode = Effect.fnUntraced(function* (client: Client, form: URLSearchParams) {
    const code = yield* required(form, "code");
    const redirectUri = yield* required(form, "redirect_uri");
    const verifier = yield* param(form, "code_verifier");
    yield* checkResource(form, true);
    const now = yield* Clock.currentTimeMillis;
    const redemption = yield* store.redeemCode(hashSecret(code), now);
    switch (redemption._tag) {
      case "Unknown":
      case "Expired":
        return yield* new InvalidGrant({ description: "the authorization code is invalid or expired" });
      case "Reused":
        yield* Effect.logWarning("oauth: an authorization code was used twice; its grant is revoked");
        return yield* new InvalidGrant({ description: "the authorization code was already used" });
      case "Redeemed":
        break;
    }
    const issuedFor = redemption.code;
    if (issuedFor.clientId !== client.clientId) {
      return yield* new InvalidGrant({ description: "the authorization code was issued to another client" });
    }
    if (issuedFor.redirectUri !== redirectUri) {
      return yield* new InvalidGrant({ description: "redirect_uri does not match the authorization request" });
    }
    if (verifier === undefined || !pkceMatches(verifier, issuedFor.codeChallenge)) {
      return yield* new InvalidGrant({ description: "code_verifier does not match the code challenge" });
    }
    const issued = yield* newPair();
    yield* store.insertTokens(issuedFor.grant.grantId, issued.pair);
    return tokenResponse(issuedFor.grant, issued);
  });

  const refresh = Effect.fnUntraced(function* (client: Client, form: URLSearchParams) {
    const token = yield* required(form, "refresh_token");
    yield* checkResource(form, true);
    const scope = yield* param(form, "scope");
    const requested = scope === undefined ? undefined : parseScopes(scope);
    if (requested !== undefined && Result.isFailure(requested)) return yield* requested.failure;
    const issued = yield* newPair();
    const now = yield* Clock.currentTimeMillis;
    // A narrower scope keeps the grant's scopes (the response reports them); a wider one is refused.
    const withinGrant = (grant: Grant) =>
      requested === undefined || (Result.isSuccess(requested) && requested.success.every((s) => grant.scopes.includes(s)));
    const rotation = yield* store.rotateRefresh(hashSecret(token), client.clientId, now, (grant) =>
      withinGrant(grant) ? issued.pair : undefined,
    );
    switch (rotation._tag) {
      case "Unknown":
        return yield* new InvalidGrant({ description: "the refresh token is invalid, expired, or revoked" });
      case "Reused":
        yield* Effect.logWarning(`oauth: a refresh token of client ${rotation.clientId} was reused; its grant is revoked`);
        return yield* new InvalidGrant({ description: "the refresh token was already used; the authorization is revoked" });
      case "Declined":
        return yield* new InvalidScope({ description: "the requested scope exceeds the grant" });
      case "Exhausted":
        yield* Effect.logWarning(`oauth: a grant of client ${client.clientId} reached the refresh limit and ended`);
        return yield* new InvalidGrant({ description: "the authorization reached its refresh limit; authorize again" });
      case "Rotated":
        return tokenResponse(rotation.grant, issued);
    }
  });

  const token = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    const form = yield* readForm(request);
    const grantType = yield* required(form, "grant_type");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return yield* new UnsupportedGrantType({ description: "supported grant types: authorization_code, refresh_token" });
    }
    const client = yield* clientOf(form);
    return grantType === "authorization_code" ? yield* exchangeCode(client, form) : yield* refresh(client, form);
  });

  // -- Revocation (RFC 7009) -------------------------------------------------

  const revoke = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    const form = yield* readForm(request);
    const client = yield* clientOf(form);
    const value = yield* required(form, "token");
    const owner = yield* store.tokenOwner(hashSecret(value));
    if (Option.isSome(owner)) {
      if (owner.value.clientId !== client.clientId) {
        return yield* new InvalidGrant({ description: "the token was issued to another client" });
      }
      yield* store.revokeGrant(owner.value.grantId, yield* Clock.currentTimeMillis);
    }
    // Unknown tokens are answered like revoked ones (RFC 7009 §2.2).
    return HttpServerResponse.empty({ status: 200, headers: { ...NO_STORE, ...CORS } });
  });

  // -- Routing -----------------------------------------------------------------

  type Handler<E> = (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E>;
  interface Route {
    readonly method: "GET" | "POST" | "OPTIONS";
    readonly path: `/${string}`;
    readonly handler: Handler<never>;
  }

  const jsonEndpoint = (handler: Handler<OAuthError>) => (request: HttpServerRequest.HttpServerRequest) =>
    handler(request).pipe(Effect.catch((error) => Effect.succeed(errorJson(error))));

  const pageEndpoint = (handler: Handler<PageError>) => (request: HttpServerRequest.HttpServerRequest) =>
    handler(request).pipe(Effect.catch((error) => Effect.succeed(pageError(error))));

  const preflight = HttpServerResponse.empty({
    status: 204,
    headers: {
      ...CORS,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
      "access-control-max-age": "600",
    },
  });

  const routes: ReadonlyArray<Route> = [
    { method: "GET", path: PROTECTED_RESOURCE_PATH, handler: () => Effect.succeed(protectedResource) },
    { method: "GET", path: `${PROTECTED_RESOURCE_PATH}${MCP_RESOURCE_PATH}`, handler: () => Effect.succeed(protectedResource) },
    { method: "GET", path: AUTHORIZATION_SERVER_PATH, handler: () => Effect.succeed(authorizationServer) },
    { method: "POST", path: "/register", handler: jsonEndpoint(register) },
    { method: "POST", path: "/token", handler: jsonEndpoint(token) },
    { method: "POST", path: "/revoke", handler: jsonEndpoint(revoke) },
    { method: "GET", path: "/authorize", handler: pageEndpoint(authorize) },
    { method: "GET", path: "/login", handler: pageEndpoint(showLogin) },
    { method: "POST", path: "/login", handler: pageEndpoint(submitLogin) },
    { method: "GET", path: "/consent", handler: pageEndpoint(showConsent) },
    { method: "POST", path: "/consent", handler: pageEndpoint(submitConsent) },
    ...CORS_PATHS.map((path): Route => ({ method: "OPTIONS", path, handler: () => Effect.succeed(preflight) })),
  ];

  return { authenticate, routes, purge, store, resource, resourceMetadataUrl };
});

/**
 * `Auth` backed by the authorization server, which also registers its
 * routes on the router and purges expired state hourly.
 */
export const OAuthLive = (settings: OAuthSettings): Layer.Layer<Auth, never, HttpRouter.HttpRouter | SqlClient.SqlClient | Accounts> =>
  Layer.effect(
    Auth,
    Effect.gen(function* () {
      const server = yield* makeOAuthServer(settings);
      const router = yield* HttpRouter.HttpRouter;
      for (const route of server.routes) yield* router.add(route.method, route.path, route.handler);
      yield* Effect.forkScoped(
        server.purge.pipe(Effect.ignore, Effect.repeat(Schedule.spaced("1 hour"))),
      );
      return Auth.of({ authenticate: server.authenticate });
    }),
  );
