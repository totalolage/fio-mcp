import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Clock, Effect, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashSecret, randomSecret } from "../src/oauth/crypto.js";
import { DEFAULT_THROTTLE } from "../src/oauth/login.js";
import { LIMITS } from "../src/oauth/server.js";
import { MAX_BODY_BYTES, MAX_CONCURRENT_REQUESTS, SESSION_LIMITS } from "../src/transport/http.js";
import {
  authorizationUrl,
  authorizeInBrowser,
  Browser,
  codeFor,
  csrfOf,
  LOOPBACK_REDIRECT,
  type OAuthHarness,
  PASSWORD,
  PEER_HEADER,
  PUBLIC_URL,
  pkcePair,
  postMcp,
  RESOURCE,
  register,
  startOAuth,
  TestProvider,
  tokenRequest,
  tokensFor,
} from "./support/oauth.js";

const MAX_SESSIONS_PER_SUBJECT = SESSION_LIMITS.maxPerSubject;

const CHALLENGE = `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="fio:read"`;

/** JSON response body; tests compare fields with expect, which accepts unknown values. */
const readJson = async (response: Response) => (await response.json()) as Record<string, unknown>;

const text = (result: CallToolResult) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

const ORDER = { type: "domestic", amount: 100, accountTo: "2212-2000000699", bankCode: "0300", date: "2025-11-03" };

let harness: OAuthHarness;

beforeEach(async () => {
  harness = await startOAuth();
});

afterEach(async () => {
  await harness.close();
});

const sdkClient = async (provider: TestProvider) => {
  const client = new Client({ name: "sdk-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    authProvider: provider,
    fetch: (url, init) => harness.fetch(url, init),
  });
  await client.connect(transport);
  return { client, transport };
};

describe("OAuth end to end with the MCP SDK client", () => {
  it("discovers, registers, authorizes, calls tools, refreshes, and revokes", async () => {
    const provider = new TestProvider();

    // 1. Unauthenticated: 401 with the resource_metadata challenge; the SDK
    // discovers both metadata documents, registers, and asks for the browser.
    await expect(sdkClient(provider)).rejects.toThrow(/Unauthorized/);
    expect(provider.info?.client_id).toMatch(/^fio_client_/);
    const authUrl = provider.authorizationUrl;
    expect(authUrl).toBeDefined();
    expect(authUrl?.origin).toBe(PUBLIC_URL);
    expect(authUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl?.searchParams.get("resource")).toBe(RESOURCE);

    // 2. The user signs in and grants fio:read on "main" only.
    const callback = await authorizeInBrowser(harness, authUrl ?? "", { accounts: ["main"] });
    expect(`${callback.origin}${callback.pathname}`).toBe(LOOPBACK_REDIRECT);
    expect(callback.searchParams.get("state")).toBe("sdk-state-123");
    expect(callback.searchParams.get("iss")).toBe(PUBLIC_URL);

    // 3. Code exchange with PKCE through the SDK.
    const first = new StreamableHTTPClientTransport(new URL(RESOURCE), {
      authProvider: provider,
      fetch: (url, init) => harness.fetch(url, init),
    });
    await first.finishAuth(callback.searchParams.get("code") ?? "");
    expect(provider.saved?.token_type).toBe("Bearer");
    expect(provider.saved?.scope).toBe("fio:read");
    expect(provider.saved?.refresh_token).toMatch(/^fio_rt_/);

    // 4. /mcp calls with the token: only the granted account is visible;
    // other accounts and payments are refused per call, every tool stays listed.
    const { client } = await sdkClient(provider);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("submit_payment_orders");
    const status = JSON.parse(text((await client.callTool({ name: "get_server_status", arguments: {} })) as CallToolResult));
    expect(status.accounts.map((a: { name: string }) => a.name)).toEqual(["main"]);
    const preview = (await client.callTool({
      name: "preview_payment_orders",
      arguments: { account: "main", orders: [ORDER] },
    })) as CallToolResult;
    expect(preview.isError).not.toBe(true);
    const otherAccount = (await client.callTool({
      name: "preview_payment_orders",
      arguments: { account: "savings", orders: [ORDER] },
    })) as CallToolResult;
    expect(otherAccount.isError).toBe(true);
    expect(text(otherAccount)).toMatch(/^You don't have permissions to do that\./);
    expect(text(otherAccount)).toContain('"savings"');
    const submit = (await client.callTool({
      name: "submit_payment_orders",
      arguments: { account: "main", orders: [ORDER], confirm: true },
    })) as CallToolResult;
    expect(submit.isError).toBe(true);
    expect(text(submit)).toMatch(/^You don't have permissions to do that\./);
    expect(text(submit)).toContain("fio:payments");

    // 5. The access token expires after an hour; the SDK refreshes (rotating
    // the refresh token) and the session continues.
    const before = provider.saved;
    harness.clock.advance(LIMITS.accessTtlMs + 1000);
    const afterExpiry = (await client.callTool({ name: "get_server_status", arguments: {} })) as CallToolResult;
    expect(afterExpiry.isError).not.toBe(true);
    expect(provider.saved?.access_token).not.toBe(before?.access_token);
    expect(provider.saved?.refresh_token).not.toBe(before?.refresh_token);

    // 6. Revocation (RFC 7009) ends the grant: access and refresh tokens stop working.
    const revoked = await harness.fetch(`${PUBLIC_URL}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: provider.info?.client_id ?? "", token: provider.saved?.access_token ?? "" }),
    });
    expect(revoked.status).toBe(200);
    const denied = await postMcp(harness, { authorization: `Bearer ${provider.saved?.access_token}` });
    expect(denied.status).toBe(401);
    const refreshAfterRevoke = await tokenRequest(harness, {
      grant_type: "refresh_token",
      client_id: provider.info?.client_id,
      refresh_token: provider.saved?.refresh_token,
      resource: RESOURCE,
    });
    expect(refreshAfterRevoke.body.error).toBe("invalid_grant");
    await client.close();

    // Nothing secret reached the logs.
    const logged = harness.logs.join("\n");
    for (const secret of [PASSWORD, before?.access_token, before?.refresh_token, callback.searchParams.get("code")]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("grants payments when the user selects them, and a granted payment call reaches the tool", async () => {
    const provider = new TestProvider("fio:read fio:payments");
    await expect(sdkClient(provider)).rejects.toThrow(/Unauthorized/);
    const callback = await authorizeInBrowser(harness, provider.authorizationUrl ?? "", { payments: true });
    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
      authProvider: provider,
      fetch: (url, init) => harness.fetch(url, init),
    });
    await transport.finishAuth(callback.searchParams.get("code") ?? "");
    expect(provider.saved?.scope).toBe("fio:read fio:payments");
    const { client } = await sdkClient(provider);
    const status = JSON.parse(text((await client.callTool({ name: "get_server_status", arguments: {} })) as CallToolResult));
    expect(status.accounts.map((a: { name: string }) => a.name)).toEqual(["main", "savings"]);
    await client.close();
  });
});

describe("metadata and the /mcp challenge", () => {
  it("serves RFC 9728 and RFC 8414 metadata", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await harness.fetch(`${PUBLIC_URL}${path}`);
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.resource).toBe(RESOURCE);
      expect(body.authorization_servers).toEqual([PUBLIC_URL]);
      expect(body.scopes_supported).toEqual(["fio:read", "fio:payments"]);
    }
    const response = await harness.fetch(`${PUBLIC_URL}/.well-known/oauth-authorization-server`);
    const body = await readJson(response);
    expect(body).toMatchObject({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/authorize`,
      token_endpoint: `${PUBLIC_URL}/token`,
      registration_endpoint: `${PUBLIC_URL}/register`,
      revocation_endpoint: `${PUBLIC_URL}/revoke`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("answers unauthenticated /mcp (every path spelling) with 401 and the resource_metadata challenge", async () => {
    for (const path of ["/mcp", "/MCP", "/mcp/", "//mcp", "/%6dcp"]) {
      const response = await postMcp(harness, {}, path);
      expect(response.status, path).toBe(401);
      expect(response.headers.get("www-authenticate"), path).toBe(CHALLENGE);
    }
    const garbage = await postMcp(harness, { authorization: "Bearer fio_at_not-a-real-token" });
    expect(garbage.status).toBe(401);
    expect(garbage.headers.get("www-authenticate")).toBe(`${CHALLENGE}, error="invalid_token"`);
    const query = await harness.fetch(`${PUBLIC_URL}/mcp?access_token=x`, { method: "POST" });
    expect(query.status).toBe(401);
  });

  it("rejects a token whose audience is another resource", async () => {
    const { clientId } = await tokensFor(harness);
    const token = await Effect.runPromise(randomSecret("fio_at_"));
    await harness.store((store) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const grant = {
          grantId: "fio_grant_foreign",
          clientId,
          scopes: ["fio:read"],
          accounts: ["main"],
          resource: "https://other.example.test/mcp",
        };
        yield* store.createGrant(
          grant,
          { codeHash: "unused", clientId, redirectUri: LOOPBACK_REDIRECT, codeChallenge: "x", expiresAt: 0 },
          now,
        );
        yield* store.insertTokens(grant.grantId, {
          accessHash: hashSecret(token),
          accessExpiresAt: now + 60_000,
          refreshHash: "unused-refresh",
          refreshExpiresAt: now + 60_000,
        });
      }),
    );
    const response = await postMcp(harness, { authorization: `Bearer ${Redacted.value(token)}` });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("never admits more sessions per grant than the limit, even concurrently", async () => {
    const { access } = await tokensFor(harness);
    const before = MAX_SESSIONS_PER_SUBJECT + 8 - MAX_CONCURRENT_REQUESTS;
    for (let i = 0; i < before; i++) {
      expect((await postMcp(harness, { authorization: `Bearer ${access}` })).status).toBe(200);
    }
    // The last requests race for the remaining slots.
    const statuses = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_REQUESTS }, () => postMcp(harness, { authorization: `Bearer ${access}` })),
    ).then((responses) => responses.map((r) => r.status));
    expect(statuses.filter((s) => s === 200)).toHaveLength(MAX_SESSIONS_PER_SUBJECT - before);
    expect(statuses.filter((s) => s === 429)).toHaveLength(8);
  });

  it("limits the requests a grant has in flight", async () => {
    const { access } = await tokensFor(harness);
    // Bodies that never end keep their requests in flight.
    const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    const pending = Array.from({ length: MAX_CONCURRENT_REQUESTS }, () =>
      harness.fetch(
        new Request(`${PUBLIC_URL}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${access}`,
          },
          body: new ReadableStream<Uint8Array>({ start: (controller) => void streams.push(controller) }),
          duplex: "half",
        } as RequestInit),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const refused = await postMcp(harness, { authorization: `Bearer ${access}` });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    // Other grants are not affected.
    const other = await tokensFor(harness);
    expect((await postMcp(harness, { authorization: `Bearer ${other.access}` })).status).toBe(200);
    for (const stream of streams) stream.close();
    await Promise.all(pending);
    expect((await postMcp(harness, { authorization: `Bearer ${access}` })).status).toBe(200);
  });

  it("refuses request bodies over the limit with 413 and keeps serving", async () => {
    const { access } = await tokensFor(harness);
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(MAX_BODY_BYTES) } });
    const refused = await postMcp(harness, { authorization: `Bearer ${access}` }, "/mcp", big);
    expect(refused.status).toBe(413);
    // An initialize request may not carry more than 64 KiB of client data.
    const bigInit = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x".repeat(70_000), version: "0" } },
    });
    expect((await postMcp(harness, { authorization: `Bearer ${access}` }, "/mcp", bigInit)).status).toBe(413);
    expect((await postMcp(harness, { authorization: `Bearer ${access}` })).status).toBe(200);
  });

  it("ends an idle session in McpServer when its slot is needed", async () => {
    const { access, refresh, clientId } = await tokensFor(harness);
    const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const first = (await postMcp(harness, { authorization: `Bearer ${access}` })).headers.get("mcp-session-id") ?? "";
    for (let i = 1; i < MAX_SESSIONS_PER_SUBJECT; i++) {
      expect((await postMcp(harness, { authorization: `Bearer ${access}` })).status).toBe(200);
    }
    expect((await postMcp(harness, { authorization: `Bearer ${access}` })).status).toBe(429);
    harness.clock.advance(SESSION_LIMITS.idleMs + 1000);
    const refreshed = await tokenRequest(harness, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refresh,
      resource: RESOURCE,
    });
    const token = String(refreshed.body.access_token);
    const fresh = await postMcp(harness, { authorization: `Bearer ${token}` });
    expect(fresh.status).toBe(200);
    // McpServer answered the internal DELETE with 204: it held the session and ended it.
    expect(harness.logs.filter((line) => line.includes("ended an idle session"))).toHaveLength(1);
    const headers = { "mcp-session-id": first, "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${token}` };
    expect((await postMcp(harness, headers, "/mcp", list)).status).toBe(404);
    expect(harness.logs.join("\n")).not.toContain(first);
  });

  it("rejects an expired access token and accepts it before expiry", async () => {
    const { access } = await tokensFor(harness);
    expect((await postMcp(harness, { authorization: `Bearer ${access}` })).status).toBe(200);
    harness.clock.advance(LIMITS.accessTtlMs + 1);
    const expired = await postMcp(harness, { authorization: `Bearer ${access}` });
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("binds MCP sessions to the grant that created them", async () => {
    const alice = await tokensFor(harness);
    const bob = await tokensFor(harness);
    const init = await postMcp(harness, { authorization: `Bearer ${alice.access}` });
    const session = init.headers.get("mcp-session-id") ?? "";
    expect(session).not.toBe("");
    const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const headers = { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" };
    const own = await postMcp(harness, { ...headers, authorization: `Bearer ${alice.access}` }, "/mcp", list);
    expect(own.status).toBe(200);
    const foreign = await postMcp(harness, { ...headers, authorization: `Bearer ${bob.access}` }, "/mcp", list);
    expect(foreign.status).toBe(404);
    const made = await postMcp(harness, { "mcp-session-id": "made-up", authorization: `Bearer ${alice.access}` }, "/mcp", list);
    expect(made.status).toBe(404);

    // A grant at its session limit is refused new sessions; its live ones and other grants' keep working.
    const bobInit = await postMcp(harness, { authorization: `Bearer ${bob.access}` });
    const bobSession = bobInit.headers.get("mcp-session-id") ?? "";
    const statuses: Array<number> = [];
    for (let i = 0; i < MAX_SESSIONS_PER_SUBJECT; i++) {
      statuses.push((await postMcp(harness, { authorization: `Bearer ${alice.access}` })).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(MAX_SESSIONS_PER_SUBJECT - 1);
    expect(statuses.at(-1)).toBe(429);
    expect((await postMcp(harness, { ...headers, authorization: `Bearer ${alice.access}` }, "/mcp", list)).status).toBe(200);
    const bobStill = await postMcp(
      harness,
      { "mcp-session-id": bobSession, "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${bob.access}` },
      "/mcp",
      list,
    );
    expect(bobStill.status).toBe(200);
    // After an hour without use, an old session gives up its slot (with a refreshed token).
    harness.clock.advance(SESSION_LIMITS.idleMs + 1000);
    const refreshed = await tokenRequest(harness, {
      grant_type: "refresh_token",
      client_id: alice.clientId,
      refresh_token: alice.refresh,
      resource: RESOURCE,
    });
    const fresh = String(refreshed.body.access_token);
    expect((await postMcp(harness, { authorization: `Bearer ${fresh}` })).status).toBe(200);
  });
});

describe("dynamic client registration", () => {
  it("registers public clients and replaces requested client authentication with none", async () => {
    const response = await harness.fetch(`${PUBLIC_URL}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Evil‮Name\u0007",
        redirect_uris: ["https://app.example.test/cb", "http://localhost/cb", "http://[::1]:9/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    });
    expect(response.status).toBe(201);
    const body = await readJson(response);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();
    expect(body.client_name).toBe("EvilName");
  });

  it("refuses non-loopback http, custom schemes, fragments and missing redirect URIs", async () => {
    for (const uris of [["http://app.example.test/cb"], ["myapp://cb"], ["https://app.example.test/cb#x"], []]) {
      const { response, body } = await register(harness, uris);
      expect(response.status, JSON.stringify(uris)).toBe(400);
      expect(body.error).toBe("invalid_redirect_uri");
    }
    const bad = await harness.fetch(`${PUBLIC_URL}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] }),
    });
    expect((await readJson(bad)).error).toBe("invalid_client_metadata");
  });

  it("enforces the registration rate limit under concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: LIMITS.registrationsPerWindow + 5 }, () => register(harness, ["https://app.example.test/cb"])),
    );
    const statuses = results.map((r) => r.response.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(LIMITS.registrationsPerWindow);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  it("rate-limits registrations and expires clients that never authorize", async () => {
    const ids: Array<string> = [];
    for (let i = 0; i < LIMITS.registrationsPerWindow; i++) {
      const { response, body } = await register(harness, ["https://app.example.test/cb"]);
      expect(response.status).toBe(201);
      ids.push(String(body.client_id));
    }
    const limited = await register(harness, ["https://app.example.test/cb"]);
    expect(limited.response.status).toBe(429);
    expect(limited.body.error).toBe("temporarily_unavailable");
    expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);

    harness.clock.advance(LIMITS.unusedClientMs + 1000);
    const next = await register(harness, ["https://app.example.test/cb"]);
    expect(next.response.status).toBe(201);
    const remaining = await harness.store((store) => store.listClients(Date.now() + harness.clock.skewMs));
    expect(remaining.map((c) => c.clientId)).toEqual([String(next.body.client_id)]);
  });
});

// Loopback redirect URIs that differ from LOOPBACK_REDIRECT only in an invalid port, userinfo, or a fragment.
const MALFORMED_REDIRECTS = [
  "http://127.0.0.1:99999/callback",
  "http://127.0.0.1:0/callback",
  "http://user@127.0.0.1/callback",
  "http://127.0.0.1:5555/callback#x",
];

describe("authorization endpoint", () => {
  const validParams = async (redirectUri = LOOPBACK_REDIRECT) => {
    const { body } = await register(harness, [redirectUri]);
    const { challenge } = pkcePair();
    return {
      response_type: "code",
      client_id: String(body.client_id),
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      state: "s1",
    };
  };

  it("shows an error page (no redirect) for unknown clients and unregistered redirect URIs", async () => {
    const params = await validParams();
    for (const bad of [
      { ...params, client_id: "fio_client_unknown" },
      { ...params, redirect_uri: "https://attacker.example/cb" },
      { ...params, redirect_uri: "http://127.0.0.1:45678/other" },
    ]) {
      const response = await harness.fetch(authorizationUrl(bad));
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-type")).toContain("text/html");
    }
  });

  it("shows an error page (no redirect) for malformed redirect URIs", async () => {
    const params = await validParams();
    for (const uri of MALFORMED_REDIRECTS) {
      const response = await harness.fetch(authorizationUrl({ ...params, redirect_uri: uri }));
      expect(response.status, uri).toBe(400);
      expect(response.headers.get("location"), uri).toBeNull();
      expect(response.headers.get("content-type"), uri).toContain("text/html");
    }
  });

  it("accepts a loopback redirect URI on another port", async () => {
    const params = await validParams();
    const response = await harness.fetch(authorizationUrl({ ...params, redirect_uri: "http://127.0.0.1:5555/callback" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("redirects protocol errors back to the client with state and iss", async () => {
    const params = await validParams();
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ ...params, resource: "https://other.example.test/mcp" }, "invalid_target"],
      [{ ...params, resource: PUBLIC_URL }, "invalid_target"],
      [{ ...params, resource: undefined }, "invalid_request"],
      [{ ...params, code_challenge_method: "plain" }, "invalid_request"],
      [{ ...params, code_challenge: undefined }, "invalid_request"],
      [{ ...params, response_type: "token" }, "unsupported_response_type"],
      [{ ...params, scope: "fio:admin" }, "invalid_scope"],
    ];
    for (const [query, error] of cases) {
      const response = await harness.fetch(authorizationUrl(query));
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location") ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(LOOPBACK_REDIRECT);
      expect(location.searchParams.get("error"), JSON.stringify(query)).toBe(error);
      expect(location.searchParams.get("state")).toBe("s1");
      expect(location.searchParams.get("iss")).toBe(PUBLIC_URL);
    }
  });

  it("returns access_denied when the user denies", async () => {
    const params = await validParams();
    const callback = await authorizeInBrowser(harness, authorizationUrl(params), { decision: "deny" });
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("code")).toBeNull();
  });
});

describe("login and consent pages", () => {
  const begin = async (headers: Record<string, string> = {}) => {
    const { body } = await register(harness, [LOOPBACK_REDIRECT], "<script>alert(1)</script>");
    const browser = new Browser(harness, headers);
    const start = await browser.get(
      authorizationUrl({
        response_type: "code",
        client_id: String(body.client_id),
        redirect_uri: LOOPBACK_REDIRECT,
        code_challenge: pkcePair().challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      }),
    );
    return { browser, start };
  };

  it("sets a hardened session cookie and strict page headers, and escapes client names", async () => {
    const { browser, start } = await begin();
    const cookie = start.headers.getSetCookie().join("\n");
    expect(cookie).toMatch(/^__Host-fio-mcp-auth=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    const page = await browser.get("/login");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    // no-referrer would make browsers send `Origin: null` on the form posts.
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    const html = await page.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("refuses form posts without the CSRF token, from another origin, or without the session", async () => {
    const { browser } = await begin();
    const csrf = await csrfOf(await browser.get("/login"));
    expect((await browser.post("/login", { password: PASSWORD })).status).toBe(403);
    expect((await browser.post("/login", { csrf: `${csrf}x`, password: PASSWORD })).status).toBe(403);
    expect((await browser.post("/login", { csrf, password: PASSWORD }, "https://evil.example")).status).toBe(403);
    expect((await browser.post("/login", { csrf, password: PASSWORD }, "null")).status).toBe(403);
    const stranger = new Browser(harness);
    expect((await stranger.post("/login", { csrf, password: PASSWORD })).status).toBe(400);
    // Consent needs a signed-in session.
    expect((await browser.get("/consent")).headers.get("location")).toBe("/login");
    // The legitimate post still works.
    expect((await browser.post("/login", { csrf, password: PASSWORD })).status).toBe(303);
  });

  it("throttles failed logins with exponential backoff and a lockout", async () => {
    const { browser } = await begin();
    const csrf = await csrfOf(await browser.get("/login"));
    const attempt = (password: string) => browser.post("/login", { csrf, password });
    for (let i = 1; i <= 6; i++) expect((await attempt("wrong password!")).status, `attempt ${i}`).toBe(401);
    // Six failures: the next attempt must wait a second, even with the right password.
    const throttled = await attempt(PASSWORD);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("1");
    harness.clock.advance(1000);
    expect((await attempt("wrong password!")).status).toBe(401);
    harness.clock.advance(2000);
    expect((await attempt("wrong password!")).status).toBe(401);
    harness.clock.advance(4000);
    expect((await attempt("wrong password!")).status).toBe(401);
    harness.clock.advance(8000);
    // Tenth consecutive failure: locked out for 15 minutes.
    expect((await attempt("wrong password!")).status).toBe(401);
    // The lockout outlasts the 10-minute sign-in, and applies to new sign-ins from the address.
    harness.clock.advance(14 * 60_000);
    const later = await begin();
    const laterCsrf = await csrfOf(await later.browser.get("/login"));
    expect((await later.browser.post("/login", { csrf: laterCsrf, password: PASSWORD })).status).toBe(429);
    harness.clock.advance(60_000);
    expect((await later.browser.post("/login", { csrf: laterCsrf, password: PASSWORD })).status).toBe(303);
    // Logs count failures, never the password or the client address.
    const logged = harness.logs.join("\n");
    expect(logged).toContain("admin login failed");
    expect(logged).not.toContain("wrong password!");
  });

  it("rate-limits sign-ins per address; a flood ends neither a signed-in session nor another client's sign-in", async () => {
    const flooder = String((await register(harness, [LOOPBACK_REDIRECT])).body.client_id);
    const start = (peer: string) =>
      new Browser(harness, { [PEER_HEADER]: peer }).get(
        authorizationUrl({
          response_type: "code",
          client_id: flooder,
          redirect_uri: LOOPBACK_REDIRECT,
          code_challenge: pkcePair().challenge,
          code_challenge_method: "S256",
          resource: RESOURCE,
        }),
      );
    // The admin signs in, and a second sign-in (another client) waits at the password page.
    const { browser: admin } = await begin({ [PEER_HEADER]: "192.0.2.10" });
    const csrf = await csrfOf(await admin.get("/login"));
    expect((await admin.post("/login", { csrf, password: PASSWORD })).status).toBe(303);
    const { browser: waiting } = await begin({ [PEER_HEADER]: "192.0.2.11" });
    // 150 sign-ins from 150 addresses: more than the 100 sign-ins held.
    for (let i = 0; i < 150; i++) expect((await start(`198.51.100.${i}`)).status, `sign-in ${i}`).toBe(303);
    expect((await admin.get("/consent")).status).toBe(200);
    expect((await waiting.get("/login")).status).toBe(200);
    // One address may start 20 sign-ins per 10 minutes.
    for (let i = 0; i < LIMITS.authorizationsPerAddress; i++) expect((await start("203.0.113.2")).status).toBe(303);
    const refused = await start("203.0.113.2");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await start("203.0.113.3")).status).toBe(303);
    harness.clock.advance(LIMITS.authorizationWindowMs);
    expect((await start("203.0.113.2")).status).toBe(303);
  });

  it("throttles logins per client behind a trusted proxy, and per peer otherwise", async () => {
    await harness.close();
    const throttle = { ...DEFAULT_THROTTLE, freeFailures: 1, lockoutFailures: 2 };
    harness = await startOAuth({ throttle, trustedProxies: ["172.18.0.0/16"] });
    const via = (peer: string, forwardedFor: string) => ({ [PEER_HEADER]: peer, "x-forwarded-for": forwardedFor });
    const login = async (headers: Record<string, string>, password: string) => {
      const { browser } = await begin(headers);
      const csrf = await csrfOf(await browser.get("/login"));
      return (await browser.post("/login", { csrf, password })).status;
    };
    // Two failures lock the client at 203.0.113.9 out...
    expect(await login(via("172.18.0.2", "203.0.113.9"), "wrong password!")).toBe(401);
    expect(await login(via("172.18.0.2", "203.0.113.9"), "wrong password!")).toBe(401);
    expect(await login(via("172.18.0.2", "203.0.113.9"), PASSWORD)).toBe(429);
    // ...including when it prepends another address; Traefik appends the real one.
    expect(await login(via("172.18.0.3", "198.51.100.7, 203.0.113.9"), PASSWORD)).toBe(429);
    // The admin behind the same proxy is not affected.
    expect(await login(via("172.18.0.2", "198.51.100.7"), PASSWORD)).toBe(303);
    // An untrusted peer's X-Forwarded-For is ignored: the peer is the client.
    expect(await login(via("10.9.9.9", "192.0.2.1"), "wrong password!")).toBe(401);
    expect(await login(via("10.9.9.9", "192.0.2.2"), "wrong password!")).toBe(401);
    expect(await login(via("10.9.9.9", "192.0.2.3"), PASSWORD)).toBe(429);
    expect(harness.logs.join("\n")).not.toMatch(/203\.0\.113\.9|10\.9\.9\.9|172\.18\./);
  });
});

describe("token endpoint", () => {
  const exchange = (grant: Awaited<ReturnType<typeof codeFor>>, overrides: Record<string, string | undefined> = {}) =>
    tokenRequest(harness, {
      grant_type: "authorization_code",
      client_id: grant.clientId,
      code: grant.code,
      redirect_uri: grant.redirectUri,
      code_verifier: grant.verifier,
      resource: RESOURCE,
      ...overrides,
    });

  it("issues opaque tokens that are stored only as hashes", async () => {
    const grant = await codeFor(harness);
    const { response, body } = await exchange(grant);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "fio:read" });
    const accessToken = String(body.access_token);
    const stored = await harness.store((store) => store.tokenOwner(accessToken));
    expect(stored._tag).toBe("None");
    const byHash = await harness.store((store) => store.tokenOwner(hashSecret(accessToken)));
    expect(byHash._tag).toBe("Some");
  });

  it("rejects a missing or wrong PKCE verifier", async () => {
    const missing = await codeFor(harness);
    expect((await exchange(missing, { code_verifier: undefined })).body.error).toBe("invalid_grant");
    const wrong = await codeFor(harness);
    expect((await exchange(wrong, { code_verifier: pkcePair().verifier })).body.error).toBe("invalid_grant");
  });

  it("rejects a reused code and revokes what the first use issued", async () => {
    const grant = await codeFor(harness);
    const first = await exchange(grant);
    expect(first.response.status).toBe(200);
    const second = await exchange(grant);
    expect(second.response.status).toBe(400);
    expect(second.body.error).toBe("invalid_grant");
    expect((await postMcp(harness, { authorization: `Bearer ${first.body.access_token}` })).status).toBe(401);
  });

  it("rejects a malformed redirect_uri", async () => {
    for (const uri of MALFORMED_REDIRECTS) {
      const { response, body } = await exchange(await codeFor(harness), { redirect_uri: uri });
      expect(response.status, uri).toBe(400);
      expect(body.error, uri).toBe("invalid_grant");
    }
  });

  it("rejects an expired code", async () => {
    const grant = await codeFor(harness);
    harness.clock.advance(LIMITS.codeTtlMs + 1);
    expect((await exchange(grant)).body.error).toBe("invalid_grant");
  });

  it("rejects a mismatched redirect_uri, another client, and a wrong or missing resource", async () => {
    const redirect = await codeFor(harness);
    expect((await exchange(redirect, { redirect_uri: "http://127.0.0.1:45679/callback" })).body.error).toBe("invalid_grant");
    const other = await codeFor(harness);
    const { body } = await register(harness, [LOOPBACK_REDIRECT]);
    expect((await exchange(other, { client_id: String(body.client_id) })).body.error).toBe("invalid_grant");
    const target = await codeFor(harness);
    expect((await exchange(target, { resource: "https://other.example.test/mcp" })).body.error).toBe("invalid_target");
    const missing = await codeFor(harness);
    expect((await exchange(missing, { resource: undefined })).body.error).toBe("invalid_request");
    const unknownClient = await codeFor(harness);
    const unknown = await exchange(unknownClient, { client_id: "fio_client_nope" });
    expect(unknown.response.status).toBe(401);
    expect(unknown.body.error).toBe("invalid_client");
  });

  it("rejects unsupported grant types and non-form bodies", async () => {
    const { body } = await tokenRequest(harness, { grant_type: "password", client_id: "x" });
    expect(body.error).toBe("unsupported_grant_type");
    const json = await harness.fetch(`${PUBLIC_URL}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect((await readJson(json)).error).toBe("invalid_request");
  });

  it("rotates refresh tokens; reusing an old one revokes the whole grant family", async () => {
    const first = await tokensFor(harness);
    const refreshed = await tokenRequest(harness, {
      grant_type: "refresh_token",
      client_id: first.clientId,
      refresh_token: first.refresh,
      resource: RESOURCE,
    });
    expect(refreshed.response.status).toBe(200);
    const second = { access: String(refreshed.body.access_token), refresh: String(refreshed.body.refresh_token) };
    expect(second.refresh).not.toBe(first.refresh);
    // The superseded access token ends with the rotation; the new one works.
    expect((await postMcp(harness, { authorization: `Bearer ${first.access}` })).status).toBe(401);
    expect((await postMcp(harness, { authorization: `Bearer ${second.access}` })).status).toBe(200);

    const replay = await tokenRequest(harness, {
      grant_type: "refresh_token",
      client_id: first.clientId,
      refresh_token: first.refresh,
      resource: RESOURCE,
    });
    expect(replay.body.error).toBe("invalid_grant");
    // Family revoked: the current access and refresh tokens die too.
    expect((await postMcp(harness, { authorization: `Bearer ${second.access}` })).status).toBe(401);
    const afterReplay = await tokenRequest(harness, {
      grant_type: "refresh_token",
      client_id: first.clientId,
      refresh_token: second.refresh,
      resource: RESOURCE,
    });
    expect(afterReplay.body.error).toBe("invalid_grant");
  });

  it("refuses a refresh token presented by another client, and scope beyond the grant", async () => {
    const owner = await tokensFor(harness);
    const { body } = await register(harness, [LOOPBACK_REDIRECT]);
    const stolen = await tokenRequest(harness, {
      grant_type: "refresh_token",
      client_id: String(body.client_id),
      refresh_token: owner.refresh,
      resource: RESOURCE,
    });
    expect(stolen.body.error).toBe("invalid_grant");
    const wider = await tokenRequest(harness, {
      grant_type: "refresh_token",
      client_id: owner.clientId,
      refresh_token: owner.refresh,
      resource: RESOURCE,
      scope: "fio:read fio:payments",
    });
    expect(wider.body.error).toBe("invalid_scope");
    // The refused request did not consume the refresh token.
    const still = await tokenRequest(harness, {
      grant_type: "refresh_token",
      client_id: owner.clientId,
      refresh_token: owner.refresh,
      resource: RESOURCE,
      scope: "fio:read",
    });
    expect(still.response.status).toBe(200);
  });

  it("requires this server's resource on refresh without consuming the token", async () => {
    const owner = await tokensFor(harness);
    const refresh = { grant_type: "refresh_token", client_id: owner.clientId, refresh_token: owner.refresh };
    const missing = await tokenRequest(harness, refresh);
    expect(missing.response.status).toBe(400);
    expect(missing.body.error).toBe("invalid_request");
    const foreign = await tokenRequest(harness, { ...refresh, resource: "https://other.example.test/mcp" });
    expect(foreign.body.error).toBe("invalid_target");
    const ok = await tokenRequest(harness, { ...refresh, resource: RESOURCE });
    expect(ok.response.status).toBe(200);
  });

  it("revocation of another client's token is refused; unknown tokens are accepted", async () => {
    const owner = await tokensFor(harness);
    const { body } = await register(harness, [LOOPBACK_REDIRECT]);
    const revoke = (clientId: string, token: string) =>
      harness.fetch(`${PUBLIC_URL}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, token }),
      });
    const foreign = await revoke(String(body.client_id), owner.refresh);
    expect(foreign.status).toBe(400);
    expect((await postMcp(harness, { authorization: `Bearer ${owner.access}` })).status).toBe(200);
    expect((await revoke(owner.clientId, "fio_rt_unknown")).status).toBe(200);
    expect((await revoke(owner.clientId, owner.refresh)).status).toBe(200);
    expect((await postMcp(harness, { authorization: `Bearer ${owner.access}` })).status).toBe(401);
  });
});
