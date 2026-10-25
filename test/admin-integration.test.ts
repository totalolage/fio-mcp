/**
 * End to end over real HTTP: the production HttpAppLive (OAuth, /admin, the
 * cache and its background sync) on an ephemeral loopback port, its FIO
 * client pointed at a fake FIO server on another loopback port. Account
 * changes made through the /admin forms reach what an OAuth-authorized MCP
 * session lists and calls, and a purge removes the cached data.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConfigProvider, Context, Effect, Exit, Layer, Logger, Redacted, Scope } from "effect";
import { HttpServer } from "effect/http";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenFingerprint } from "../src/accounts.js";
import { HttpAppLive } from "../src/app.js";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import { formatPasswordHash } from "../src/oauth/crypto.js";
import { makeOAuthStore } from "../src/oauth/store.js";
import { loadConfigFrom } from "./fixtures.js";
import { testDatabase } from "./support/database.js";
import { type OAuthHarness, PASSWORD, PUBLIC_URL, SkewedClock, passwordHash, tokensFor } from "./support/oauth.js";
import { FIO_TOKEN, SAVINGS_TOKEN } from "./support/transport.js";

// Real sockets, SQLite on disk, scrypt and background sync on a shared, often
// loaded host: the flow takes under 1 s on an idle machine but took 15 s under
// memory pressure (sign-in alone 4 s), far past the 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ADMIN_COOKIE = "__Secure-fio-mcp-admin";
const TRAVEL_TOKEN = "travelT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNO";
const ROTATED_TOKEN = "rotatedT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN";

/** A day in Prague (FIO's time zone), `offset` days from today. */
const day = (offset: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date(Date.now() + offset * 86_400_000));
const RANGE = { dateFrom: day(-7), dateTo: day(0) };

interface Movement {
  readonly id: number;
  readonly date: string;
  readonly amount: number;
  readonly payee: string;
}

/** What the fake FIO serves per token: the bank account behind it and its movements. */
const BANK: Record<string, { readonly accountId: string; readonly movements: ReadonlyArray<Movement> }> = {
  [FIO_TOKEN]: { accountId: "2900000000", movements: [{ id: 101, date: day(-2), amount: -100, payee: "Main Grocer" }] },
  [SAVINGS_TOKEN]: { accountId: "2900000001", movements: [{ id: 201, date: day(-2), amount: 500, payee: "Savings Interest" }] },
  [TRAVEL_TOKEN]: { accountId: "2900000777", movements: [{ id: 701, date: day(-3), amount: -2500, payee: "Travel Agency" }] },
  // The same bank account through the replacement token, one movement later.
  [ROTATED_TOKEN]: {
    accountId: "2900000777",
    movements: [
      { id: 701, date: day(-3), amount: -2500, payee: "Travel Agency" },
      { id: 702, date: day(-1), amount: -80, payee: "After Rotation" },
    ],
  },
};

const PERIODS = /^\/v1\/rest\/periods\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\/transactions\.json$/;

/** FIO's JSON statement for `from`..`to` (the shape of test/fio-api.test.ts's STATEMENT). */
const statementJson = (accountId: string, from: string, to: string, movements: ReadonlyArray<Movement>) => ({
  accountStatement: {
    info: {
      accountId,
      bankId: "2010",
      currency: "CZK",
      iban: `CZ002010000000${accountId}`,
      bic: "FIOBCZPPXXX",
      openingBalance: 0,
      closingBalance: 1000,
      dateStart: `${from}+0100`,
      dateEnd: `${to}+0100`,
      yearList: null,
      idList: null,
      idFrom: null,
      idTo: null,
      idLastDownload: null,
    },
    transactionList: {
      transaction: movements
        .filter((m) => m.date >= from && m.date <= to)
        .map((m) => ({
          column22: { value: m.id, name: "ID pohybu", id: 22 },
          column0: { value: `${m.date}+0100`, name: "Datum", id: 0 },
          column1: { value: m.amount, name: "Objem", id: 1 },
          column14: { value: "CZK", name: "Měna", id: 14 },
          column10: { value: m.payee, name: "Název protiúčtu", id: 10 },
        })),
    },
  },
});

/** The fake FIO API on a loopback port: GET /periods per BANK, anything else 404; records the token of each request. */
async function startFakeFio() {
  const tokens: Array<string> = [];
  const server: Server = createServer((request, response) => {
    const match = PERIODS.exec(new URL(request.url ?? "/", "http://fio").pathname);
    const [, token = "", from = "", to = ""] = match ?? [];
    const bank = BANK[token];
    tokens.push(token);
    if (match === null || bank === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(statementJson(bank.accountId, from, to, bank.movements)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1/rest`,
    tokens,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface App {
  /** The app's origin on loopback (PUBLIC_URL is only its configured public name). */
  readonly base: string;
  readonly fio: Awaited<ReturnType<typeof startFakeFio>>;
  /** test/support/oauth.ts's helpers, over the socket. */
  readonly harness: OAuthHarness;
  readonly sql: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;
  /** The app's log lines, printed when the test fails. */
  readonly logs: Array<string>;
  readonly close: () => Promise<void>;
}

/**
 * Builds HttpAppLive as `fio-mcp` builds it from the environment, with the
 * environment given as a ConfigProvider (process.env stays untouched).
 */
async function startApp(): Promise<App> {
  const dir = mkdtempSync(join(tmpdir(), "fio-mcp-admin-it-"));
  const fio = await startFakeFio();
  // The hash carries FAST_SCRYPT's parameters, so signing in costs little.
  writeFileSync(join(dir, "password.hash"), formatPasswordHash(await passwordHash()));
  writeFileSync(join(dir, "data.key"), "07".repeat(32));
  const dbPath = join(dir, "fio-mcp.db");
  const env = {
    FIO_MCP_TRANSPORT: "http",
    FIO_MCP_HOST: "127.0.0.1",
    FIO_MCP_PUBLIC_URL: PUBLIC_URL,
    FIO_MCP_ADMIN_PASSWORD_HASH_FILE: join(dir, "password.hash"),
    FIO_MCP_DATA_KEY_FILE: join(dir, "data.key"),
    // Seeds the empty account database: two accounts, as a fresh install would have.
    FIO_ACCOUNTS: JSON.stringify([
      { name: "main", token: FIO_TOKEN },
      { name: "savings", token: SAVINGS_TOKEN },
    ]),
    FIO_API_BASE_URL: fio.baseUrl,
    FIO_DB_PATH: dbPath,
    FIO_CACHE_ENABLED: "true",
    // Every new token gets a startup sync: one recent range, one FIO request.
    FIO_SYNC_ON_STARTUP: "true",
    FIO_BACKFILL_FROM: day(-7),
  };
  const scope = await Effect.runPromise(Scope.make());
  const close = async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await fio.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    return await build(env, dbPath, scope, fio, close);
  } catch (error) {
    await close();
    throw error;
  }
}

async function build(
  env: Record<string, string>,
  dbPath: string,
  scope: Scope.Scope,
  fio: App["fio"],
  close: () => Promise<void>,
): Promise<App> {
  const config = await Effect.runPromise(loadConfigFrom(env));
  if (config.transport.kind !== "http") throw new Error("expected the HTTP transport");
  const logs: Array<string> = [];
  const capture = Logger.make<unknown, void>((entry) => {
    logs.push(Logger.formatLogFmt.log(entry));
  });
  const app = HttpAppLive({ ...config.transport, port: 0 }).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: "/home/test", ...env } }))),
    Layer.provide(Logger.layer([capture])),
  );
  const built = await Effect.runPromise(Layer.buildWithScope(app, scope));
  const address = Context.get(built, HttpServer.HttpServer).address;
  const port = "port" in address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  // A second connection to the app's database, to inspect the cache.
  const db = await Effect.runPromise(Layer.buildWithScope(testDatabase(dbPath, SERVER_MIGRATIONS), scope));
  const sql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(effect.pipe(Effect.provide(db)));
  const harness: OAuthHarness = {
    // PUBLIC_URL's requests to the socket; redirects come back to the caller, as in the in-process harness.
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== PUBLIC_URL) throw new Error(`not the app: ${url.origin}`);
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      return fetch(`${base}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body, redirect: "manual" });
    },
    clock: new SkewedClock(),
    logs,
    store: (f) => sql(Effect.flatMap(makeOAuthStore(), f)),
    sql,
    accounts: () => {
      throw new Error("HttpAppLive does not expose its Accounts; use /admin");
    },
    close: async () => {},
  };
  return { base, fio, harness, sql, logs, close };
}

/** A browser for /admin: keeps the admin cookie and the last page's CSRF token, follows no redirects. */
class Admin {
  cookie: string | undefined;
  csrf: string | undefined;
  constructor(private readonly harness: OAuthHarness) {}

  private absorb(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const at = pair.indexOf("=");
      if (pair.slice(0, at) === ADMIN_COOKIE) this.cookie = pair.slice(at + 1) === "" ? undefined : pair;
    }
    return response;
  }

  async page(path: string) {
    const headers: Record<string, string> = this.cookie === undefined ? {} : { cookie: this.cookie };
    const response = this.absorb(await this.harness.fetch(new URL(path, PUBLIC_URL), { headers }));
    const html = await response.text();
    this.csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] ?? this.csrf;
    return html;
  }

  async post(path: string, form: Record<string, string>) {
    const body = new URLSearchParams({ ...form, csrf: this.csrf ?? "" });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC_URL };
    if (this.cookie !== undefined) headers.cookie = this.cookie;
    return this.absorb(await this.harness.fetch(new URL(path, PUBLIC_URL), { method: "POST", headers, body }));
  }

  async signIn() {
    await this.page("/admin/login");
    const response = await this.post("/admin/login", { password: PASSWORD });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin");
    return this.page("/admin");
  }

  /** POSTs an account form, follows the redirect back, and returns the page's message. */
  async act(path: string, form: Record<string, string>) {
    const response = await this.post(path, form);
    expect(response.status, await response.clone().text()).toBe(303);
    const html = await this.page(response.headers.get("location") ?? "/admin");
    return /<p class="(?:ok|error)" role="(?:status|alert)">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
  }

  /** The id of the account named `name`, from the accounts page. */
  async idOf(name: string) {
    const row = (await this.page("/admin")).split("<tr>").find((candidate) => candidate.includes(`<strong>${name}</strong>`));
    const id = /name="id" value="([^"]+)"/.exec(row ?? "")?.[1];
    if (id === undefined) throw new Error(`no row for ${name}`);
    return id;
  }
}

const text = (result: CallToolResult) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

/** An MCP session over HTTP with the access token of an OAuth grant. */
async function mcpSession(app: App, access: string) {
  const client = new Client({ name: "admin-integration", version: "1.0.0" });
  sessions.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", app.base), { requestInit: { headers: { authorization: `Bearer ${access}` } } }),
  );
  return {
    /** The `account` enum of get_transactions, or undefined when the session does not see the tool. */
    accounts: async () => {
      const tools = (await client.listTools()).tools;
      const tool = tools.find((candidate) => candidate.name === "get_transactions");
      // No other tool may name an account the session does not see in get_transactions.
      const all = tools.flatMap((candidate) => (candidate.inputSchema.properties?.account as { enum?: Array<string> } | undefined)?.enum ?? []);
      const names = (tool?.inputSchema.properties?.account as { enum?: Array<string> } | undefined)?.enum;
      expect(new Set(all)).toEqual(new Set(names ?? []));
      return names;
    },
    /** get_transactions from the cache only (no FIO request); `ok` false for an error result or a rejected call. */
    cached: async (account: string) => {
      try {
        const result = (await client.callTool({
          name: "get_transactions",
          arguments: { account, ...RANGE, source: "cache" },
        })) as CallToolResult;
        return { ok: result.isError !== true, text: text(result) };
      } catch (error) {
        return { ok: false, text: String(error) };
      }
    },
  };
}

/** Polls `check` until it passes (background sync is asynchronous), failing with its last error after `ms`. */
async function eventually<A>(check: () => Promise<A>, ms = 15_000): Promise<A> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** The cache's bank-account key behind `accountId`, and how many movements it holds. */
const cachedAccount = (app: App, accountId: string) =>
  app.sql(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [account] = yield* sql<{ account_key: string }>`SELECT account_key FROM accounts WHERE account_id = ${accountId}`;
      return account?.account_key;
    }),
  );

/** What the cache holds for a bank account and for tokens: every table purgeTokens deletes from. */
const cacheRows = (app: App, accountKey: string, tokens: ReadonlyArray<string>) =>
  app.sql(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const count = (rows: ReadonlyArray<{ n: number }>) => Number(rows[0]?.n ?? 0);
      const fingerprints = tokens.map((token) => tokenFingerprint(Redacted.make(token)));
      return {
        movements: count(yield* sql<{ n: number }>`SELECT count(*) AS n FROM transactions WHERE account_key = ${accountKey}`),
        coverageDays: count(yield* sql<{ n: number }>`SELECT count(*) AS n FROM coverage_days WHERE account_key = ${accountKey}`),
        bindings: count(yield* sql<{ n: number }>`SELECT count(*) AS n FROM bindings WHERE ${sql.in("token_fingerprint", fingerprints)}`),
        syncStates: count(yield* sql<{ n: number }>`SELECT count(*) AS n FROM sync_state WHERE ${sql.in("token_fingerprint", fingerprints)}`),
      };
    }),
  );

let app: App;
/** Closes the test's MCP sessions (open streams would hold the server's shutdown). */
let sessions: Array<() => Promise<void>> = [];

beforeEach(async () => {
  app = await startApp();
});

afterEach(async ({ task }) => {
  if (task.result?.state === "fail") console.error(`app log:\n${app.logs.join("\n")}`);
  await Promise.allSettled(sessions.map((close) => close()));
  sessions = [];
  await app.close();
});

describe("account changes at /admin reach the MCP tools", () => {
  it("add, rename, rotate and remove with purge, through the HTTP endpoints", async () => {
    const admin = new Admin(app.harness);
    await admin.signIn();
    // The seeded accounts' startup sync, for the control reads below.
    const mainKey = await eventually(async () => {
      const key = await cachedAccount(app, BANK[FIO_TOKEN]!.accountId);
      expect(key).toBeDefined();
      return key!;
    });

    // Add: a grant made afterwards can select it, and its startup sync fills the cache.
    expect(await admin.act("/admin/accounts/add", { name: "travel", token: TRAVEL_TOKEN })).toMatch(/^Added “travel”/);
    const first = await tokensFor(app.harness, { accounts: ["main", "travel"] });
    const before = await mcpSession(app, first.access);
    await eventually(async () => expect(await before.accounts()).toEqual(["main", "travel"]));
    await eventually(async () => expect(await before.cached("travel")).toMatchObject({ ok: true, text: expect.stringContaining("Travel Agency") }));
    expect(app.fio.tokens).toContain(TRAVEL_TOKEN);
    const travelKey = await cachedAccount(app, BANK[TRAVEL_TOKEN]!.accountId);
    expect(travelKey).toBeDefined();

    // Rename: the same session lists and calls it by the new name only; the token (and grant) are unchanged.
    expect(await admin.act("/admin/accounts/rename", { id: await admin.idOf("travel"), name: "holiday" })).toBe("Renamed to “holiday”.");
    await eventually(async () => expect(await before.accounts()).toEqual(["main", "holiday"]));
    const renamed = await before.cached("holiday");
    expect(renamed).toMatchObject({ ok: true, text: expect.stringContaining("Travel Agency") });
    expect(renamed.text).not.toContain("Main Grocer");
    expect((await before.cached("travel")).ok).toBe(false);

    // Rotate: grants name tokens, so the old grant no longer covers it (src/admin/accounts.ts, rotate).
    expect(await admin.act("/admin/accounts/rotate", { id: await admin.idOf("holiday"), token: ROTATED_TOKEN })).toMatch(
      /^Replaced the token of “holiday”/,
    );
    await eventually(async () => expect(await before.accounts()).toEqual(["main"]));
    expect(await before.cached("holiday")).toMatchObject({
      ok: false,
      text: expect.stringContaining(`does not cover the account "holiday"`),
    });
    expect(await before.cached("main")).toMatchObject({ ok: true, text: expect.stringContaining("Main Grocer") });
    // A new grant selects it again; the replacement token is synced and answers for it.
    const second = await tokensFor(app.harness, { accounts: ["holiday"] });
    const after = await mcpSession(app, second.access);
    expect(await after.accounts()).toEqual(["holiday"]);
    await eventually(async () => expect(await after.cached("holiday")).toMatchObject({ ok: true, text: expect.stringContaining("After Rotation") }));
    expect(app.fio.tokens).toContain(ROTATED_TOKEN);

    // Every table the purge must empty has something to empty.
    const travelTokens = [TRAVEL_TOKEN, ROTATED_TOKEN];
    const held = await cacheRows(app, travelKey!, travelTokens);
    expect(held.movements).toBe(2);
    for (const rows of [held.coverageDays, held.bindings, held.syncStates]) expect(rows).toBeGreaterThan(0);

    // Remove with purge: no session lists it any more, and its cached data is gone.
    expect(await admin.act("/admin/accounts/remove", { id: await admin.idOf("holiday"), cache: "purge", confirm: "yes" })).toMatch(
      /^Removed “holiday”/,
    );
    await eventually(async () => expect(await after.accounts()).toBeUndefined());
    expect((await after.cached("holiday")).ok).toBe(false);
    expect(await before.accounts()).toEqual(["main"]);
    expect(await cachedAccount(app, BANK[TRAVEL_TOKEN]!.accountId)).toBeUndefined();
    expect(await cacheRows(app, travelKey!, travelTokens)).toEqual({ movements: 0, coverageDays: 0, bindings: 0, syncStates: 0 });
    // The other accounts' data stays.
    expect((await cacheRows(app, mainKey, [FIO_TOKEN])).movements).toBeGreaterThan(0);
  });
});
