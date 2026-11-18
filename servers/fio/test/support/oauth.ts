/**
 * In-process harness for the OAuth authorization server and the admin UI:
 * the production router app (guards, OAuth and /admin routes, McpServer
 * behind Auth) with the accounts in an in-memory SQLite database (seeded
 * from the test config's main and savings accounts, encrypted with
 * DATA_KEY), served through a web handler; a cookie-keeping "browser"; an
 * SDK OAuth client provider; and a clock the test can move.
 */

import { createHash, randomBytes } from "node:crypto";
import { AdminPassword, type AdminPasswordShape } from "@mcps/core/admin/password.js";
import { adminRoutes } from "@mcps/core/admin/server.js";
import { hashPassword, type PasswordHash } from "@mcps/core/oauth/crypto.js";
import type { ThrottlePolicy } from "@mcps/core/oauth/login.js";
import { makeOAuthStore, type OAuthStore } from "@mcps/core/oauth/store.js";
import { parseTrustedProxy } from "@mcps/core/transport/client-address.js";
import { httpRouterApp } from "@mcps/core/transport/http.js";
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
import { Accounts, type AccountsShape } from "../../src/accounts.js";
import { AdminLive, adminPasswordLayer } from "../../src/admin/live.js";
import { SERVER_INFO, ToolsLive } from "../../src/app.js";
import { type Migrations, SERVER_MIGRATIONS } from "../../src/cache/db.js";
import { type AppConfigShape, accountSeedOf, type HttpAuthConfig, type HttpTransportConfig } from "../../src/config.js";
import type { FioApiShape } from "../../src/fio-api.js";
import { parsePasswordHash } from "../../src/identity.js";
import { PaymentControls, type PaymentControlsShape } from "../../src/payment-controls.js";
import { PaymentLedger } from "../../src/payment-ledger.js";
import { fioOAuth } from "../../src/transport/auth.js";
import { testDatabase } from "./database.js";
import { testConfig, testServices } from "./transport.js";

export const PUBLIC_URL = "https://fio.example.test";
export const RESOURCE = `${PUBLIC_URL}/mcp`;
export const PASSWORD = "correct horse battery staple";
/** The test data key (FIO_MCP_DATA_KEY_FILE). */
export const DATA_KEY = Redacted.make(new Uint8Array(32).fill(7));

/** Cheap scrypt parameters (ln=14, 16 MiB) for every hash the tests make; one test in oauth-units uses the real ones. */
export const FAST_SCRYPT = { ln: 14, r: 8, p: 1 } as const;

let cachedHash: PasswordHash | undefined;

/** A fast hash of PASSWORD, made once per test file. */
export async function passwordHash(): Promise<PasswordHash> {
  if (cachedHash === undefined) {
    const line = await Effect.runPromise(hashPassword(Redacted.make(PASSWORD), FAST_SCRYPT));
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

/** The in-process harness, which also reaches the server's payment controls. */
export interface InProcessHarness extends OAuthHarness {
  /** Runs an operation on the server's payment controls, on the harness clock. */
  readonly payments: <A, E>(f: (controls: PaymentControlsShape) => Effect.Effect<A, E>) => Promise<A>;
}

/** Requests carrying this header appear to come from that socket peer address. */
export const PEER_HEADER = "x-test-peer";

/** `real`, with the test's replacements of its parts (options.adminPassword). */
const wrapAdminPassword = <E, R>(
  real: Layer.Layer<AdminPassword, E, R>,
  wrap: ((real: AdminPasswordShape) => AdminPasswordShape) | undefined,
): Layer.Layer<AdminPassword, E, R> =>
  wrap === undefined
    ? real
    : Layer.effect(
        AdminPassword,
        Effect.gen(function* () {
          return AdminPassword.of(wrap(yield* AdminPassword));
        }),
      ).pipe(Layer.provide(real));

export async function startOAuth(
  options: {
    throttle?: ThrottlePolicy;
    trustedProxies?: ReadonlyArray<string>;
    /** FIO_MCP_ADMIN_ALLOWED_CIDRS entries. */
    allowedNetworks?: ReadonlyArray<string>;
    /** More admin routes, registered behind the same restriction as AdminLive's (adminRoutes). */
    extraAdminRoutes?: Layer.Layer<never, never, HttpRouter.HttpRouter>;
    /** A database file instead of memory (survives `close`, for restart tests). */
    dbPath?: string;
    migrations?: Migrations;
    /** The accounts FIO_TOKEN / FIO_ACCOUNTS would configure (default: main and savings). */
    configured?: AppConfigShape["accounts"];
    /** FIO_MCP_ADMIN_TOTP_SECRET_FILE's secret: sign-ins then need a code too. */
    totpSecret?: Redacted.Redacted<Uint8Array>;
    /** Replaces parts of the real AdminPassword, for outcomes a test cannot reach by timing (e.g. busy). */
    adminPassword?: (real: AdminPasswordShape) => AdminPasswordShape;
    /** FioApi methods beyond the slot-holding fake (e.g. importXml for payment uploads). */
    fio?: Partial<FioApiShape>;
  } = {},
): Promise<InProcessHarness> {
  const hash = await passwordHash();
  const trustedProxies = (options.trustedProxies ?? []).flatMap((entry) => parseTrustedProxy(entry) ?? []);
  const allowedNetworks = (options.allowedNetworks ?? []).flatMap((entry) => parseTrustedProxy(entry) ?? []);
  const adminSettings = { publicUrl: PUBLIC_URL, dataKey: DATA_KEY, trustedProxies, allowedNetworks };
  const accountSeed = accountSeedOf(options.configured ?? testConfig().accounts);
  const auth: HttpAuthConfig = {
    kind: "oauth",
    publicUrl: PUBLIC_URL,
    passwordHash: Redacted.make(hash),
    dataKey: DATA_KEY,
    accountSeed,
    totpSecret: options.totpSecret,
  };
  const transport: HttpTransportConfig = {
    kind: "http",
    host: "127.0.0.1",
    port: 0,
    auth,
    allowedOrigins: [],
    allowedHosts: [],
    trustedProxies,
    adminAllowedNetworks: allowedNetworks,
  };
  const config = testConfig(transport);
  const scope = await Effect.runPromise(Scope.make());
  const db: Context.Context<SqlClient.SqlClient> = await Effect.runPromise(
    Layer.buildWithScope(testDatabase(options.dbPath ?? ":memory:", options.migrations ?? SERVER_MIGRATIONS), scope),
  );
  const release = await Effect.runPromise(Deferred.make<void>());
  const clock = new SkewedClock();
  const logs: Array<string> = [];
  const capture = Logger.make<unknown, void>((entry) => {
    logs.push(Logger.formatLogFmt.log(entry));
  });
  // As authFromConfig builds it, with the test's throttling and scrypt parameters.
  const oauth = Layer.mergeAll(
    fioOAuth({ publicUrl: PUBLIC_URL, trustedProxies, allowedNetworks }),
    AdminLive(adminSettings),
    options.extraAdminRoutes === undefined ? Layer.empty : adminRoutes(adminSettings, options.extraAdminRoutes),
  ).pipe(
    Layer.provide(
      wrapAdminPassword(
        adminPasswordLayer(Redacted.make(hash), options.throttle, FAST_SCRYPT, options.totpSecret),
        options.adminPassword,
      ),
    ),
    Layer.provide(Accounts.resources),
  );
  let accounts: AccountsShape | undefined;
  const captureAccounts = Layer.effectDiscard(
    Effect.map(Effect.service(Accounts), (service) => {
      accounts = service;
    }),
  );
  let controls: PaymentControlsShape | undefined;
  const captureControls = Layer.effectDiscard(
    Effect.map(Effect.service(PaymentControls), (service) => {
      controls = service;
    }),
  );
  // Request handlers run with the router's context, not the layer's: clock and logger are provided per request.
  const captureLayer = Logger.layer([capture]);
  const withClock = HttpRouter.middleware(
    (httpEffect) =>
      httpEffect.pipe(
        Effect.updateService(HttpServerRequest.HttpServerRequest, (request) => {
          const peer = request.headers[PEER_HEADER];
          return peer === undefined ? request : request.modify({ remoteAddress: Option.some(peer) });
        }),
        Effect.provideService(Clock.Clock, clock),
        Effect.provide(captureLayer),
      ),
    { global: true },
  );
  const app = httpRouterApp(
    Layer.mergeAll(ToolsLive, withClock, AccountChangesLive, captureAccounts, captureControls),
    oauth,
    SERVER_INFO,
    transport,
  ).pipe(
    // One instance for the tools and /admin, on the server database, as PaymentControls.Live shares it.
    Layer.provide(
      testServices(
        config,
        release,
        Accounts.stored(DATA_KEY, accountSeed),
        options.fio,
        PaymentControls.Default.pipe(Layer.provideMerge(PaymentLedger.Default)),
      ),
    ),
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
    payments: (f) => {
      if (controls === undefined) throw new Error("the app has not started yet (make a request first)");
      return Effect.runPromise(f(controls).pipe(Effect.provideService(Clock.Clock, clock)));
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

/** The consent form's CSRF token and form id. */
export const consentFormOf = async (response: Response) => {
  const html = await response.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  const form = /name="form" value="([^"]+)"/.exec(html)?.[1];
  if (csrf === undefined || form === undefined) throw new Error(`no consent form in the page (status ${response.status})`);
  return { csrf, form };
};

export const csrfOf = async (response: Response) => {
  const match = /name="csrf" value="([^"]+)"/.exec(await response.text());
  if (match?.[1] === undefined) throw new Error(`no CSRF token in the page (status ${response.status})`);
  return match[1];
};

export interface Consent {
  readonly accounts?: ReadonlyArray<string>;
  readonly payments?: boolean;
  readonly decision?: "approve" | "deny";
  /** The authentication code for /login, when the harness has a TOTP secret. */
  readonly totp?: string;
}

/** Drives /authorize → /login → /consent and returns the redirect back to the client. */
export async function authorizeInBrowser(harness: OAuthHarness, authorizationUrl: string | URL, consent: Consent = {}) {
  const browser = new Browser(harness);
  const start = await browser.get(authorizationUrl);
  if (start.status !== 303 || start.headers.get("location") !== "/login") {
    throw new Error(`authorize answered ${start.status} ${start.headers.get("location")}: ${await start.text()}`);
  }
  const csrf = await csrfOf(await browser.get("/login"));
  const login = await browser.post("/login", { csrf, password: PASSWORD, ...(consent.totp === undefined ? {} : { totp: consent.totp }) });
  if (login.status !== 303) throw new Error(`login answered ${login.status}`);
  const consentForm = await consentFormOf(await browser.get("/consent"));
  const done = await browser.post("/consent", {
    ...consentForm,
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
