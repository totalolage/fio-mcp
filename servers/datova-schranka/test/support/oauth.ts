/**
 * In-process harness for the OAuth authorization server: core's router app
 * (guards, OAuth routes, McpServer behind Auth.oauth for the datova-schranka
 * OAuthApp) over an in-memory SQLite database with APP_MIGRATIONS, data
 * boxes from a fake BoxRegistry, the real AuditLog on that database, and an
 * admin password from a fast scrypt hash; served through a web handler, with
 * a cookie-keeping "browser" and a clock the test can move.
 *
 * Extension hook (StartOptions.app, StartOptions.tools, StartOptions.wrapApp):
 * `app` is merged into the router app next to the OAuth routes and McpServer
 * and gets the harness services (HarnessServices) plus the router and
 * McpServer, so the app-composition phase passes its tool groups (registered
 * on McpServer) and admin routes here, with `tools` naming their ToolSpecs
 * for core's ToolPolicy; a live smoke test reuses the same entry point.
 * `wrapApp` replaces parts of the OAuthApp (e.g. a failing afterConsent).
 */

import { createHash, randomBytes } from "node:crypto";
import { AdminPassword, settingsPasswordStore } from "@mcps/core/admin/password.js";
import type { OAuthApp } from "@mcps/core/oauth/app.js";
import { hashPassword, type PasswordHash, parsePasswordHash } from "@mcps/core/oauth/crypto.js";
import type { ThrottlePolicy } from "@mcps/core/oauth/login.js";
import { makeOAuthStore, type OAuthStore } from "@mcps/core/oauth/store.js";
import { Redactor } from "@mcps/core/redaction.js";
import type { Resources } from "@mcps/core/resources.js";
import { makeServerSettings } from "@mcps/core/server-settings.js";
import { Auth } from "@mcps/core/transport/auth.js";
import { parseTrustedProxy } from "@mcps/core/transport/client-address.js";
import { type HttpTransportConfig, httpRouterApp } from "@mcps/core/transport/http.js";
import type { ServerInfo } from "@mcps/core/transport/server-info.js";
import { Clock, type Context, Duration, Effect, Exit, Layer, Logger, Option, Redacted, Scope } from "effect";
import { McpProtocol, type McpServer } from "effect/ai";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import type { SqlClient } from "effect/sql";
import { APP_MIGRATIONS } from "../../src/app/migrations.js";
import { AuditLog } from "../../src/domain/audit-log.js";
import { type Box, BoxRegistry } from "../../src/domain/boxes.js";
import { toolPolicyLayer } from "../../src/mcp/policy.js";
import { READ_SCOPE, type ToolSpec } from "../../src/mcp/tool-group.js";
import { makeOAuthApp } from "../../src/oauth/app.js";
import { DELIVERY_CONSENT_FIELD, SCOPE_FIELD } from "../../src/oauth/consent.js";
import { grantSettings } from "../../src/oauth/grant-settings.js";
import { APP_IDENTITY } from "../../src/oauth/identity.js";
import { memoryDatabase } from "../domain/support/database.js";
import { fakeBox, makeFakeBoxRegistry } from "../domain/support/fake-box-registry.js";
import { passwordCredentials } from "../domain/support/fake-isds.js";

export const PUBLIC_URL = "https://datova-schranka.example.test";
export const RESOURCE = `${PUBLIC_URL}/mcp`;
export const PASSWORD = "correct horse battery staple";
/** The session cookie core names after the app (`__Host-<name>-auth`). */
export const SESSION_COOKIE = `__Host-${APP_IDENTITY.name}-auth`;

/** Cheap scrypt parameters (ln=14, 16 MiB) for every hash the tests make. */
export const FAST_SCRYPT = { ln: 14, r: 8, p: 1 } as const;

/** The boxes the harness starts with: labels "Main" and "Other". */
export const DEFAULT_BOXES: ReadonlyArray<Box> = [
  { ...fakeBox("box_main", "abc2def"), label: "Main" },
  { ...fakeBox("box_other", "ghi3jkm"), label: "Other" },
];

export const MCP_PROTOCOLS = [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26] as const;

/** What the harness's McpServer announces unless StartOptions.info replaces it. */
export const TEST_SERVER_INFO: ServerInfo = {
  name: APP_IDENTITY.name,
  version: "0.0.0-test",
  instructions: "datova-schranka test server",
  protocols: MCP_PROTOCOLS,
};

let cachedHash: PasswordHash | undefined;

/** A fast hash of PASSWORD, made once per test file. */
export async function passwordHash(): Promise<PasswordHash> {
  if (cachedHash === undefined) {
    const line = await Effect.runPromise(hashPassword(Redacted.make(PASSWORD), FAST_SCRYPT));
    const parsed = parsePasswordHash(line, APP_IDENTITY);
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

/** The services the harness builds once and shares between the server, `run` and StartOptions.app. */
export type HarnessServices =
  | SqlClient.SqlClient
  | Redactor
  | AuditLog
  | BoxRegistry
  | Resources
  | AdminPassword;

/** Changes the fake box list (Resources streams the change to the server). */
export interface HarnessBoxes {
  readonly add: (box: Box) => Promise<void>;
  readonly remove: (boxId: string) => Promise<void>;
}

export interface OAuthHarness {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly clock: SkewedClock;
  readonly logs: Array<string>;
  /** Runs an OAuth store operation (with the app's grant settings) against the server's database. */
  readonly store: <A, E>(f: (store: OAuthStore) => Effect.Effect<A, E>) => Promise<A>;
  /** Runs an effect against the server's database. */
  readonly sql: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;
  /** Runs an effect with the server's own services (the AuditLog, BoxRegistry, …), on the harness clock. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, HarnessServices>) => Promise<A>;
  readonly boxes: HarnessBoxes;
  readonly close: () => Promise<void>;
}

export interface StartOptions {
  readonly throttle?: ThrottlePolicy;
  readonly trustedProxies?: ReadonlyArray<string>;
  /** Networks that reach /authorize, /login and /consent (empty: all). */
  readonly allowedNetworks?: ReadonlyArray<string>;
  /** The boxes the fake BoxRegistry starts with (default DEFAULT_BOXES). */
  readonly boxes?: ReadonlyArray<Box>;
  /**
   * Extension hook: more of the app, merged into the router app (tool
   * groups registering on McpServer, admin routes on HttpRouter, …). It gets
   * the harness services; failures and further requirements are the
   * caller's to provide before passing it.
   */
  readonly app?: Layer.Layer<never, never, HttpRouter.HttpRouter | McpServer.McpServer | HarnessServices>;
  /** The ToolSpecs of the tools `app` registers, for core's ToolPolicy (default none). */
  readonly tools?: ReadonlyArray<ToolSpec>;
  /** Replaces parts of the real OAuthApp (e.g. its afterConsent). */
  readonly wrapApp?: (real: OAuthApp) => OAuthApp;
  readonly info?: ServerInfo;
  /** HttpTransportConfig.maxBodyBytes (default core's MAX_BODY_BYTES). */
  readonly maxBodyBytes?: number;
}

/** Requests carrying this header appear to come from that socket peer address. */
export const PEER_HEADER = "x-test-peer";

const settingsFailure = (operation: string) =>
  Effect.mapError((error: unknown) => ({ message: `server settings: ${operation}: ${String(error)}` }));

export async function startOAuth(options: StartOptions = {}): Promise<OAuthHarness> {
  const hash = await passwordHash();
  const trustedProxies = (options.trustedProxies ?? []).flatMap((entry) => parseTrustedProxy(entry) ?? []);
  const allowedNetworks = (options.allowedNetworks ?? []).flatMap((entry) => parseTrustedProxy(entry) ?? []);
  const transport: HttpTransportConfig = {
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [],
    allowedHosts: [],
    trustedProxies,
    maxBodyBytes: options.maxBodyBytes,
  };
  const clock = new SkewedClock();
  const scope = await Effect.runPromise(Scope.make());
  const registry = await Effect.runPromise(
    makeFakeBoxRegistry(
      (options.boxes ?? DEFAULT_BOXES).map((box) => ({ box, credentials: passwordCredentials(`user-${box.id}`) })),
    ),
  );
  // One database, AuditLog and Resources for the server, the hook and `run`:
  // the consent row must join the grant's transaction on the same client.
  const services: Context.Context<HarnessServices> = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.mergeAll(
        AuditLog.Default,
        BoxRegistry.resources,
        AdminPassword.layer(Effect.map(makeServerSettings(settingsFailure), settingsPasswordStore), {
          app: APP_IDENTITY,
          bootstrap: Redacted.make(hash),
          throttle: options.throttle,
          scrypt: FAST_SCRYPT,
        }),
      ).pipe(
        Layer.provideMerge(registry.layer),
        Layer.provideMerge(Redactor.layer(Effect.succeed([]))),
        Layer.provideMerge(memoryDatabase(APP_MIGRATIONS)),
      ),
      scope,
    ),
  );
  const logs: Array<string> = [];
  const capture = Logger.make<unknown, void>((entry) => {
    logs.push(Logger.formatLogFmt.log(entry));
  });
  const captureLayer = Logger.layer([capture]);
  const wrap = options.wrapApp ?? ((real: OAuthApp) => real);
  const oauth = Layer.unwrap(
    Effect.map(makeOAuthApp, (app) => Auth.oauth(wrap(app), { publicUrl: PUBLIC_URL, trustedProxies, allowedNetworks })),
  );
  // Request handlers run with the router's context, not the layer's: clock, logger and peer address per request.
  const perRequest = HttpRouter.middleware(
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
  const routerApp = httpRouterApp(
    Layer.mergeAll(perRequest, options.app ?? Layer.empty),
    oauth,
    options.info ?? TEST_SERVER_INFO,
    transport,
  ).pipe(
    Layer.provide(toolPolicyLayer(options.tools ?? [])),
    Layer.provide(Layer.succeedContext(services)),
    Layer.provide(HttpServer.layerServices),
    Layer.provide(captureLayer),
    Layer.provide(Layer.succeed(Clock.Clock, clock)),
  );
  const web = HttpRouter.toWebHandler(routerApp, { disableLogger: true });
  const run = <A, E>(effect: Effect.Effect<A, E, HarnessServices>) =>
    Effect.runPromise(effect.pipe(Effect.provideContext(services), Effect.provideService(Clock.Clock, clock)));
  return {
    fetch: (input, init) => web.handler(input instanceof Request ? input : new Request(input, init)),
    clock,
    logs,
    store: (f) => run(Effect.flatMap(makeOAuthStore(undefined, grantSettings), f)),
    sql: run,
    run,
    boxes: {
      add: (box) => Effect.runPromise(registry.add({ box, credentials: passwordCredentials(`user-${box.id}`) })),
      remove: (boxId) => Effect.runPromise(registry.remove(boxId)),
    },
    close: async () => {
      await web.dispose();
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
      if (name === SESSION_COOKIE) this.cookie = value === "" ? undefined : `${name}=${value}`;
    }
    return response;
  }

  async get(url: string | URL) {
    const headers: Record<string, string> =
      this.cookie === undefined ? { ...this.extra } : { ...this.extra, cookie: this.cookie };
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

const formFields = (html: string) => {
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  const form = /name="form" value="([^"]+)"/.exec(html)?.[1];
  return csrf === undefined || form === undefined ? undefined : { csrf, form };
};

/** The consent form's CSRF token and form id. */
export const consentFormOf = async (response: Response) => {
  const fields = formFields(await response.text());
  if (fields === undefined) throw new Error(`no consent form in the page (status ${response.status})`);
  return fields;
};

export const csrfOf = async (response: Response) => {
  const match = /name="csrf" value="([^"]+)"/.exec(await response.text());
  if (match?.[1] === undefined) throw new Error(`no CSRF token in the page (status ${response.status})`);
  return match[1];
};

export interface Consent {
  /** Box labels to tick (default every DEFAULT_BOXES label). */
  readonly boxes?: ReadonlyArray<string>;
  /** Scopes to tick (default isds:read). */
  readonly scopes?: ReadonlyArray<string>;
  /** Tick the delivery consent (default true). */
  readonly deliveryConsent?: boolean;
  readonly decision?: "approve" | "deny";
}

/** A browser signed in on the consent page of `authorizationUrl`: the page's HTML and form fields. */
export interface ConsentPage {
  readonly browser: Browser;
  readonly html: string;
  readonly fields: { readonly csrf: string; readonly form: string };
}

/** Drives /authorize → /login → GET /consent. */
export async function openConsent(harness: OAuthHarness, authorizationUrl: string | URL): Promise<ConsentPage> {
  const browser = new Browser(harness);
  const start = await browser.get(authorizationUrl);
  if (start.status !== 303 || start.headers.get("location") !== "/login") {
    throw new Error(`authorize answered ${start.status} ${start.headers.get("location")}: ${await start.text()}`);
  }
  const csrf = await csrfOf(await browser.get("/login"));
  const login = await browser.post("/login", { csrf, password: PASSWORD });
  if (login.status !== 303) throw new Error(`login answered ${login.status}`);
  const page = await browser.get("/consent");
  const html = await page.text();
  const fields = formFields(html);
  if (fields === undefined) throw new Error(`no consent form in the page (status ${page.status})`);
  return { browser, html, fields };
}

/** Posts the consent form of `page` as `consent` ticks it. */
export const submitConsent = (page: ConsentPage, consent: Consent = {}) =>
  page.browser.post("/consent", {
    ...page.fields,
    decision: consent.decision ?? "approve",
    box: consent.boxes ?? DEFAULT_BOXES.map((box) => box.label),
    [SCOPE_FIELD]: consent.scopes ?? [READ_SCOPE],
    ...(consent.deliveryConsent === false ? {} : { [DELIVERY_CONSENT_FIELD]: "on" }),
  });

/** Drives /authorize → /login → /consent and returns the redirect back to the client. */
export async function authorizeInBrowser(harness: OAuthHarness, authorizationUrl: string | URL, consent: Consent = {}) {
  const done = await submitConsent(await openConsent(harness, authorizationUrl), consent);
  if (done.status !== 303) throw new Error(`consent answered ${done.status}: ${await done.text()}`);
  return new URL(done.headers.get("location") ?? "");
}

export const LOOPBACK_REDIRECT = "http://127.0.0.1:45678/callback";

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

/** A registered client and the authorization URL it would open, asking for `scopes` (default isds:read). */
export async function clientAuthorization(
  harness: OAuthHarness,
  scopes: ReadonlyArray<string> = [READ_SCOPE],
  redirectUri = LOOPBACK_REDIRECT,
) {
  const { body } = await register(harness, [redirectUri]);
  const clientId = String(body.client_id);
  const { verifier, challenge } = pkcePair();
  const url = authorizationUrl({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "xyz",
    scope: scopes.join(" "),
  });
  return { clientId, verifier, redirectUri, url };
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
  const client = await clientAuthorization(harness, consent.scopes ?? [READ_SCOPE], redirectUri);
  const callback = await authorizeInBrowser(harness, client.url, consent);
  const { clientId, verifier } = client;
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
