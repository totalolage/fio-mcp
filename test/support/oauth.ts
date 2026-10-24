/**
 * In-process harness for the OAuth authorization server and the admin UI:
 * the production router app (guards, OAuth and /admin routes, McpServer
 * behind Auth) with the accounts in an in-memory SQLite database (seeded
 * from the test config's main and savings accounts, encrypted with
 * DATA_KEY), served through a web handler; a cookie-keeping "browser"; an
 * SDK OAuth client provider; and a clock the test can move.
 */

import { createHash, randomBytes } from "node:crypto";
import { NodeFileSystem } from "@effect/platform-node";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Clock, type Context, Deferred, Duration, Effect, Exit, Layer, Logger, Option, Redacted, Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import type { SqlClient } from "effect/sql";
import { AccountChangesLive } from "../../src/account-runtime.js";
import { StoredAccountsLive } from "../../src/account-store.js";
import { Accounts, type AccountsShape } from "../../src/accounts.js";
import { AdminPassword } from "../../src/admin/password.js";
import { AdminLive } from "../../src/admin/server.js";
import { SERVER_INFO, ToolsLive } from "../../src/app.js";
import { databaseLayer, SERVER_MIGRATIONS } from "../../src/cache/db.js";
import type { AppConfigShape, HttpAuthConfig } from "../../src/config.js";
import { hashPassword, type PasswordHash, parsePasswordHash } from "../../src/oauth/crypto.js";
import type { ThrottlePolicy } from "../../src/oauth/login.js";
import { OAuthLive } from "../../src/oauth/server.js";
import { makeOAuthStore, type OAuthStore } from "../../src/oauth/store.js";
import { parseTrustedProxy } from "../../src/transport/client-address.js";
import { type HttpTransportConfig, httpRouterApp } from "../../src/transport/http.js";
import { testConfig, testServices } from "./transport.js";

export const PUBLIC_URL = "https://fio.example.test";
export const RESOURCE = `${PUBLIC_URL}/mcp`;
export const PASSWORD = "correct horse battery staple";
/** The test data key (FIO_MCP_DATA_KEY_FILE). */
export const DATA_KEY = Redacted.make(new Uint8Array(32).fill(7));

let cachedHash: PasswordHash | undefined;

/** A fast (ln=14) hash of PASSWORD, made once per test file. */
export async function passwordHash(): Promise<PasswordHash> {
  if (cachedHash === undefined) {
    const line = await Effect.runPromise(hashPassword(Redacted.make(PASSWORD), { ln: 14, r: 8, p: 1 }));
    const parsed = parsePasswordHash(line);
    if (!("hash" in parsed)) throw new Error("hash did not parse");
    cachedHash = parsed;
  }
  return cachedHash;
}

/** Real time plus an offset the test controls. */
export class SkewedClock implements Clock.Clock {
  skewMs = 0;
  private now = () => Date.now() + this.skewMs;
  currentTimeMillisUnsafe = () => this.now();
  currentTimeMillis = Effect.sync(() => this.now());
  currentTimeNanosUnsafe = () => BigInt(this.now()) * 1_000_000n;
  currentTimeNanos = Effect.sync(() => BigInt(this.now()) * 1_000_000n);
  monotonicTimeNanosUnsafe = () => process.hrtime.bigint();
  monotonicTimeNanos = Effect.sync(() => process.hrtime.bigint());
  sleep = (duration: Duration.Duration) =>
    Effect.callback<void>((resume) => {
      const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
      return Effect.sync(() => clearTimeout(timer));
    });
  advance(ms: number) {
    this.skewMs += ms;
  }
}

export interface OAuthHarness {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly clock: SkewedClock;
  readonly logs: Array<string>;
  /** Runs a store operation against the server's database. */
  readonly store: <A, E>(f: (store: OAuthStore) => Effect.Effect<A, E>) => Promise<A>;
  /** Runs an effect against the server's database. */
  readonly sql: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;
  /** The server's accounts (as /admin changes them). */
  readonly accounts: () => AccountsShape;
  readonly close: () => Promise<void>;
}

/** Requests carrying this header appear to come from that socket peer address. */
export const PEER_HEADER = "x-test-peer";

export async function startOAuth(
  options: {
    throttle?: ThrottlePolicy;
    trustedProxies?: ReadonlyArray<string>;
    /** A database file instead of memory (survives `close`, for restart tests). */
    dbPath?: string;
    /** The accounts FIO_TOKEN / FIO_ACCOUNTS would configure (default: main and savings). */
    configured?: AppConfigShape["accounts"];
  } = {},
): Promise<OAuthHarness> {
  const hash = await passwordHash();
  const trustedProxies = (options.trustedProxies ?? []).flatMap((entry) => parseTrustedProxy(entry) ?? []);
  const auth: HttpAuthConfig = { kind: "oauth", publicUrl: PUBLIC_URL, passwordHash: Redacted.make(hash), dataKey: DATA_KEY };
  const transport: HttpTransportConfig = {
    kind: "http",
    host: "127.0.0.1",
    port: 0,
    auth,
    allowedOrigins: [],
    allowedHosts: [],
    trustedProxies,
  };
  const base = testConfig(transport);
  const config = options.configured === undefined ? base : { ...base, accounts: options.configured };
  const scope = await Effect.runPromise(Scope.make());
  const db: Context.Context<SqlClient.SqlClient> = await Effect.runPromise(
    Layer.buildWithScope(databaseLayer(options.dbPath ?? ":memory:", SERVER_MIGRATIONS).pipe(Layer.provide(NodeFileSystem.layer)), scope),
  );
  const release = await Effect.runPromise(Deferred.make<void>());
  const clock = new SkewedClock();
  const logs: Array<string> = [];
  const capture = Logger.make<unknown, void>((entry) => {
    logs.push(Logger.formatLogFmt.log(entry));
  });
  const oauth = Layer.mergeAll(
    OAuthLive({ publicUrl: PUBLIC_URL, trustedProxies }),
    AdminLive({ publicUrl: PUBLIC_URL, dataKey: DATA_KEY, trustedProxies }),
  ).pipe(Layer.provide(AdminPassword.layer(Redacted.make(hash), options.throttle)));
  let accounts: AccountsShape | undefined;
  const captureAccounts = Layer.effectDiscard(
    Effect.map(Effect.service(Accounts), (service) => {
      accounts = service;
    }),
  );
  // Request handlers run with the router's context, not the layer's: clock and logger are provided per request.
  const captureLayer = Logger.layer([capture]);
  const withClock = HttpRouter.middleware(
    (httpEffect) =>
      httpEffect.pipe(
        Effect.updateService(HttpServerRequest.HttpServerRequest, (request) => {
          const peer = request.headers[PEER_HEADER];
          return peer === undefined ? request : request.modify({ remoteAddress: Option.some(peer), peerAddress: Option.some(peer) });
        }),
        Effect.provideService(Clock.Clock, clock),
        Effect.provide(captureLayer),
      ),
    { global: true },
  );
  const app = httpRouterApp(Layer.mergeAll(ToolsLive, withClock, AccountChangesLive, captureAccounts), oauth, SERVER_INFO, transport).pipe(
    Layer.provide(testServices(config, release, StoredAccountsLive(DATA_KEY))),
    Layer.provide(Layer.succeedContext(db)),
    Layer.provide(HttpServer.layerServices),
    Layer.provide(Logger.layer([capture])),
    Layer.provide(Layer.succeed(Clock.Clock, clock)),
  );
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  return {
    fetch: (input, init) => web.handler(input instanceof Request ? input : new Request(input, init)),
    clock,
    logs,
    store: (f) =>
      Effect.runPromise(
        Effect.flatMap(makeOAuthStore(), f).pipe(Effect.provide(Layer.succeedContext(db)), Effect.provideService(Clock.Clock, clock)),
      ),
    sql: (effect) => Effect.runPromise(effect.pipe(Effect.provide(Layer.succeedContext(db)), Effect.provideService(Clock.Clock, clock))),
    accounts: () => {
      if (accounts === undefined) throw new Error("the app has not started yet (make a request first)");
      return accounts;
    },
    close: async () => {
      await web.dispose();
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

export const pkcePair = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** A user agent that keeps the session cookie and does not follow redirects. */
export class Browser {
  cookie: string | undefined;
  constructor(
    private readonly harness: OAuthHarness,
    /** Sent with every request (e.g. PEER_HEADER, X-Forwarded-For). */
    private readonly extra: Record<string, string> = {},
  ) {}

  private absorb(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const [name, value] = (pair ?? "").split("=");
      if (name === "__Host-fio-mcp-auth") this.cookie = value === "" ? undefined : `${name}=${value}`;
    }
    return response;
  }

  async get(url: string | URL) {
    const headers: Record<string, string> = this.cookie === undefined ? { ...this.extra } : { ...this.extra, cookie: this.cookie };
    return this.absorb(await this.harness.fetch(new URL(url, PUBLIC_URL), { headers }));
  }

  async post(path: string, form: Record<string, string | ReadonlyArray<string>>, origin: string | undefined = PUBLIC_URL) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      for (const item of typeof value === "string" ? [value] : value) body.append(key, item);
    }
    const headers: Record<string, string> = { ...this.extra, "content-type": "application/x-www-form-urlencoded" };
    if (this.cookie !== undefined) headers.cookie = this.cookie;
    if (origin !== undefined) headers.origin = origin;
    return this.absorb(await this.harness.fetch(new URL(path, PUBLIC_URL), { method: "POST", headers, body }));
  }
}

export const csrfOf = async (response: Response) => {
  const match = /name="csrf" value="([^"]+)"/.exec(await response.text());
  if (match?.[1] === undefined) throw new Error(`no CSRF token in the page (status ${response.status})`);
  return match[1];
};

export interface Consent {
  readonly accounts?: ReadonlyArray<string>;
  readonly payments?: boolean;
  readonly decision?: "approve" | "deny";
}

/** Drives /authorize → /login → /consent and returns the redirect back to the client. */
export async function authorizeInBrowser(harness: OAuthHarness, authorizationUrl: string | URL, consent: Consent = {}) {
  const browser = new Browser(harness);
  const start = await browser.get(authorizationUrl);
  if (start.status !== 303 || start.headers.get("location") !== "/login") {
    throw new Error(`authorize answered ${start.status} ${start.headers.get("location")}: ${await start.text()}`);
  }
  const csrf = await csrfOf(await browser.get("/login"));
  const login = await browser.post("/login", { csrf, password: PASSWORD });
  if (login.status !== 303) throw new Error(`login answered ${login.status}`);
  const consentCsrf = await csrfOf(await browser.get("/consent"));
  const done = await browser.post("/consent", {
    csrf: consentCsrf,
    decision: consent.decision ?? "approve",
    account: consent.accounts ?? ["main", "savings"],
    scope: consent.payments === true ? ["fio:payments"] : [],
  });
  if (done.status !== 303) throw new Error(`consent answered ${done.status}: ${await done.text()}`);
  return new URL(done.headers.get("location") ?? "");
}

export const LOOPBACK_REDIRECT = "http://127.0.0.1:45678/callback";

/** OAuthClientProvider for the SDK client, kept in memory; captures the authorization URL. */
export class TestProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;
  constructor(private readonly scope?: string) {}
  get redirectUrl() {
    return LOOPBACK_REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "SDK test client",
      redirect_uris: [LOOPBACK_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope === undefined ? {} : { scope: this.scope }),
    };
  }
  state() {
    return "sdk-state-123";
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** Registers a client directly and returns its id. */
export async function register(harness: OAuthHarness, redirectUris: ReadonlyArray<string>, name = "Direct test client") {
  const response = await harness.fetch(`${PUBLIC_URL}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: redirectUris }),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

export function authorizationUrl(params: Record<string, string | undefined>) {
  const url = new URL("/authorize", PUBLIC_URL);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url;
}

export async function tokenRequest(harness: OAuthHarness, params: Record<string, string | undefined>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) body.set(key, value);
  const response = await harness.fetch(`${PUBLIC_URL}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

/** Registers a client, runs the browser flow, and returns what a token request needs. */
export async function codeFor(harness: OAuthHarness, consent: Consent = {}, redirectUri = LOOPBACK_REDIRECT) {
  const { body } = await register(harness, [redirectUri]);
  const clientId = String(body.client_id);
  const { verifier, challenge } = pkcePair();
  const callback = await authorizeInBrowser(
    harness,
    authorizationUrl({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      state: "xyz",
      scope: consent.payments === true ? "fio:read fio:payments" : "fio:read",
    }),
    consent,
  );
  return { clientId, verifier, redirectUri, code: callback.searchParams.get("code") ?? "", callback };
}

/** A token pair from a fresh grant. */
export async function tokensFor(harness: OAuthHarness, consent: Consent = {}) {
  const grant = await codeFor(harness, consent);
  const { body } = await tokenRequest(harness, {
    grant_type: "authorization_code",
    client_id: grant.clientId,
    code: grant.code,
    redirect_uri: grant.redirectUri,
    code_verifier: grant.verifier,
    resource: RESOURCE,
  });
  return { ...grant, access: String(body.access_token), refresh: String(body.refresh_token) };
}

export const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

export const postMcp = (harness: OAuthHarness, headers: Record<string, string> = {}, path = "/mcp", body = INITIALIZE) =>
  harness.fetch(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body,
  });
