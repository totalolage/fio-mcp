/**
 * The production server (src/app/app.ts httpApp with FEATURES) in-process on
 * a loopback port, driven end to end as its users drive it: boxes are added
 * through the admin boxes tab, clients are authorized in the browser consent
 * flow, and tools are called over MCP with the access token.
 *
 * ISDS is either a fake transport layer (offline tests) or the app's real
 * transports against the ISDS `test` environment (the opt-in live smoke).
 * Everything the server writes goes to a fresh temporary directory: the
 * database, the ZFO store, a throwaway data key and the admin password hash.
 *
 * Credentials passed to the admin helpers are never logged or rendered by
 * the harness: the server's log lines go through its Redactor into `logs`
 * (nothing reaches stderr), and every text the harness returns (logs, admin
 * messages, audit cells) has those values replaced with SCRUBBED.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { hashPassword } from "@mcps/core/oauth/crypto.js";
import { makeOAuthStore } from "@mcps/core/oauth/store.js";
import { Redactor } from "@mcps/core/redaction.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Context, Effect, Exit, Layer, Logger, Redacted, Scope } from "effect";
import { HttpServer } from "effect/http";
import { AUDIT_PATH } from "../../../src/admin/audit-tab.js";
import { ADD_PATH } from "../../../src/admin/boxes-pages.js";
import { FEATURES, type Features, httpApp, RedactorLive } from "../../../src/app/app.js";
import { AppConfig } from "../../../src/config.js";
import { IsdsTransports } from "../../../src/domain/isds-transports.js";
import { grantSettings } from "../../../src/oauth/grant-settings.js";
import { flashOf, multipart } from "../../admin/support/admin-harness.js";
import { loadConfigFrom } from "../../config/support.js";
import { socketFetch } from "../../support/app.js";
import {
  FAST_SCRYPT,
  type HarnessServices,
  type OAuthHarness,
  PASSWORD,
  PUBLIC_URL,
  SkewedClock,
  tokensFor,
} from "../../support/oauth.js";

/** What replaces a credential value in every text the harness returns. */
export const SCRUBBED = "‹redacted›";

export interface E2eOptions {
  /** ISDS: a fake IsdsTransports layer, or "live" for the app's own transports (IsdsTransports.Live). */
  readonly isds: Layer.Layer<IsdsTransports> | "live";
  /** More environment, e.g. DATOVA_SCHRANKA_ISDS_REQUEST_TIMEOUT_MS. The ISDS environment is always `test`. */
  readonly env?: Readonly<Record<string, string>>;
  /** The features to serve (default FEATURES, the production set). */
  readonly features?: Features;
}

/** What an admin action did, as the next page showed it; a refused or failed action is an outcome, not an error. */
export interface AdminOutcome {
  /** The status of the page after the action's redirect (the action's own status when it did not redirect). */
  readonly status: number;
  /** The one-shot message's kind, if the page showed one. */
  readonly kind: "ok" | "error" | undefined;
  /** The message text (or the start of the answer's text when there was no redirect), credentials replaced with SCRUBBED. */
  readonly text: string | undefined;
  /** Whether the box was added (an "ok" message). */
  readonly added: boolean;
}

export interface PasswordBox {
  readonly label: string;
  readonly username: string;
  readonly password: string;
}

export interface CertificateBox {
  readonly label: string;
  /** The PKCS#12 file's bytes, posted as the multipart field "certificate". */
  readonly pkcs12: Uint8Array;
  readonly passphrase: string;
  /** The uploaded file's name (default "box.p12"). */
  readonly filename?: string;
}

/** One row of the admin audit tab, cell texts with markup stripped. */
export interface AuditRow {
  readonly time: string;
  readonly actor: string;
  readonly action: string;
  readonly box: string;
  readonly outcome: string;
  readonly detail: string;
}

/** A signed-in admin browser session. */
export interface AdminSession {
  /** Adds a box with a username and password (the tab's password route). */
  readonly addPasswordBox: (box: PasswordBox) => Promise<AdminOutcome>;
  /** Adds a box with a PKCS#12 upload and its passphrase (the tab's certificate route). */
  readonly addCertificateBox: (box: CertificateBox) => Promise<AdminOutcome>;
  /** Every row of the audit tab, newest first (all pages). */
  readonly auditRows: () => Promise<ReadonlyArray<AuditRow>>;
  /** GETs an admin page; the HTML has credentials replaced with SCRUBBED. */
  readonly page: (path: string) => Promise<{ readonly status: number; readonly html: string }>;
}

export interface ConsentRequest {
  /** The box labels to tick. */
  readonly boxes: ReadonlyArray<string>;
  /** The scopes to request and tick. */
  readonly scopes: ReadonlyArray<string>;
  /** Whether to tick isds_delivery_consent. */
  readonly deliveryConsent: boolean;
}

export interface Grant {
  readonly clientId: string;
  readonly access: string;
  readonly refresh: string;
}

export interface McpOptions {
  /** Per-request timeout of the MCP client (default: the SDK's 60 s); live ISDS calls can take long. */
  readonly requestTimeoutMs?: number;
}

/** An MCP session on /mcp; tool errors come back as results (isError), never as rejections. */
export interface McpSession {
  readonly client: Client;
  readonly listTools: () => Promise<ReadonlyArray<Tool>>;
  readonly call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface E2eApp {
  /** The app's origin on loopback (PUBLIC_URL is only its configured public name). */
  readonly base: string;
  /** The data directory (database, ZFO store, key and hash files); removed by close. */
  readonly dir: string;
  /** The OAuth view of the app for test/support/oauth.ts's helpers (requests go to the socket). */
  readonly oauth: OAuthHarness;
  /** Runs an effect with the app's own services. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, HarnessServices>) => Promise<A>;
  /** The server's log lines so far (redacted by its Redactor, credentials replaced with SCRUBBED). */
  readonly logs: () => ReadonlyArray<string>;
  /** Signs in to /admin with the harness's admin password. */
  readonly admin: () => Promise<AdminSession>;
  /** Registers a client, consents in the browser, and exchanges the code for tokens; throws when consent is refused. */
  readonly consent: (request: ConsentRequest) => Promise<Grant>;
  /** Opens an MCP session with the access token; closed by close. */
  readonly mcp: (access: string, options?: McpOptions) => Promise<McpSession>;
  readonly close: () => Promise<void>;
}

/** The environment `datova-schranka serve` would get, with a throwaway key and hash written to `dir`. */
async function e2eEnv(dir: string, extra: Readonly<Record<string, string>>) {
  const hash = await Effect.runPromise(hashPassword(Redacted.make(PASSWORD), FAST_SCRYPT));
  writeFileSync(join(dir, "password.hash"), `${hash}\n`, { mode: 0o400 });
  writeFileSync(join(dir, "data.key"), `${randomBytes(32).toString("hex")}\n`, { mode: 0o400 });
  return {
    HOME: "/home/test",
    ...extra,
    DATOVA_SCHRANKA_HOST: "127.0.0.1",
    DATOVA_SCHRANKA_PUBLIC_URL: PUBLIC_URL,
    DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE: join(dir, "password.hash"),
    DATOVA_SCHRANKA_DATA_KEY_FILE: join(dir, "data.key"),
    DATOVA_SCHRANKA_DB_PATH: join(dir, "datova-schranka.sqlite"),
    DATOVA_SCHRANKA_DATA_DIR: join(dir, "zfo"),
    DATOVA_SCHRANKA_ISDS_ENVIRONMENT: "test",
  };
}

/** Replaces every known credential value in `text`. */
const scrubber = (secrets: Set<string>) => (text: string) => {
  let out = text;
  for (const secret of secrets) if (secret !== "") out = out.replaceAll(secret, SCRUBBED);
  return out;
};

const unescapeHtml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

const cellText = (html: string) => unescapeHtml(html.replace(/<br\s*\/?>/g, " ").replace(/<[^>]*>/g, "")).trim();

/** The audit tab's rows and its "Older" link, if any. */
const auditPage = (html: string, scrub: (text: string) => string) => {
  const table = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? "";
  const rows = Array.from(table.matchAll(/<tr>([\s\S]*?)<\/tr>/g), (match) => {
    const cells = Array.from((match[1] ?? "").matchAll(/<td>([\s\S]*?)<\/td>/g), (cell) => scrub(cellText(cell[1] ?? "")));
    const [time = "", actor = "", action = "", box = "", outcome = "", detail = ""] = cells;
    return { time, actor, action, box, outcome, detail };
  });
  const older = /<a href="([^"]+)">Older<\/a>/.exec(html)?.[1];
  return { rows, older: older === undefined ? undefined : unescapeHtml(older) };
};

/** A cookie-keeping admin browser over the app's socket. */
async function adminSession(
  fetch: OAuthHarness["fetch"],
  secrets: Set<string>,
  scrub: (text: string) => string,
): Promise<AdminSession> {
  let cookie: string | undefined;
  let csrf: string | undefined;
  const absorb = async (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      if (at > 0 && pair.slice(0, at).endsWith("-admin")) cookie = pair.slice(at + 1) === "" ? undefined : pair;
    }
    const html = await response.text();
    csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? csrf;
    return { status: response.status, location: response.headers.get("location"), html };
  };
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...(cookie === undefined ? {} : { cookie }) });
  const get = async (path: string) => absorb(await fetch(new Request(new URL(path, PUBLIC_URL), { headers: headers() })));
  const post = async (path: string, body: URLSearchParams | FormData) => {
    if (csrf !== undefined) body.set("csrf", csrf);
    const encoded = new Response(body);
    const request = new Request(new URL(path, PUBLIC_URL), {
      method: "POST",
      headers: headers({ origin: PUBLIC_URL, "content-type": encoded.headers.get("content-type") ?? "" }),
      body: new Uint8Array(await encoded.arrayBuffer()),
    });
    return absorb(await fetch(request));
  };

  await get("/admin/login");
  const signedIn = await post("/admin/login", new URLSearchParams({ password: PASSWORD }));
  if (signedIn.status !== 303 || cookie === undefined) throw new Error(`admin sign-in answered ${signedIn.status}`);
  // The session's form token comes with its first page.
  await get(signedIn.location ?? "/admin");

  const act = async (form: FormData): Promise<AdminOutcome> => {
    const posted = await post(ADD_PATH, form);
    if (posted.status !== 303 || posted.location === null) {
      return { status: posted.status, kind: undefined, text: scrub(cellText(posted.html)).slice(0, 300), added: false };
    }
    const page = await get(posted.location);
    const flash = flashOf(page.html);
    return {
      status: page.status,
      kind: flash?.kind,
      text: flash === undefined ? undefined : scrub(flash.text),
      added: flash?.kind === "ok",
    };
  };

  return {
    addPasswordBox: ({ label, username, password }) => {
      secrets.add(username);
      secrets.add(password);
      return act(multipart({ auth: "password", label, username, password }));
    },
    addCertificateBox: ({ label, pkcs12, passphrase, filename = "box.p12" }) => {
      secrets.add(passphrase);
      return act(multipart({ auth: "certificate", label, passphrase }, { certificate: { name: filename, bytes: pkcs12 } }));
    },
    auditRows: async () => {
      const rows: Array<AuditRow> = [];
      let path: string | undefined = AUDIT_PATH;
      while (path !== undefined) {
        const page = await get(path);
        if (page.status !== 200) throw new Error(`audit tab answered ${page.status}`);
        const parsed = auditPage(page.html, scrub);
        rows.push(...parsed.rows);
        path = parsed.older;
      }
      return rows;
    },
    page: async (path) => {
      const page = await get(path);
      return { status: page.status, html: scrub(page.html) };
    },
  };
}

/** Starts httpApp(features) on a loopback port over a fresh data directory. */
export async function startE2eApp(options: E2eOptions): Promise<E2eApp> {
  const dir = mkdtempSync(join(tmpdir(), "datova-schranka-e2e-"));
  const scope = await Effect.runPromise(Scope.make());
  const sessions: Array<() => Promise<void>> = [];
  const close = async () => {
    for (const session of sessions.splice(0)) await session().catch(() => undefined);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const secrets = new Set<string>();
    const scrub = scrubber(secrets);
    const lines: Array<string> = [];
    // The app's log lines through the app's own Redactor (the instance its services register box secrets with).
    const capture = Layer.unwrap(
      Effect.map(Effect.service(Redactor), (redactor) =>
        Logger.layer([
          Logger.make<unknown, void>((entry) => {
            lines.push(redactor.redact(Logger.formatLogFmt.log(entry)));
          }),
        ]),
      ),
    ).pipe(Layer.provide(RedactorLive));
    const config = await Effect.runPromise(loadConfigFrom(await e2eEnv(dir, options.env ?? {})));
    const platform = Layer.mergeAll(
      Layer.succeed(AppConfig, { ...config, http: { ...config.http, port: 0 } }),
      NodeFileSystem.layer,
      options.isds === "live" ? IsdsTransports.Live : options.isds,
    );
    const app = httpApp(options.features ?? FEATURES).pipe(Layer.provide(platform), Layer.provide(capture));
    const services = await Effect.runPromise(Layer.buildWithScope(app, scope));
    const address = Context.get(services, HttpServer.HttpServer).address;
    const base = `http://127.0.0.1:${"port" in address ? address.port : 0}`;
    const run = <A, E>(effect: Effect.Effect<A, E, HarnessServices>) =>
      Effect.runPromise(effect.pipe(Effect.provideContext(services)));
    const fetch = socketFetch(base);
    const refuse = () => Promise.reject(new Error("add boxes through the admin tab"));
    const oauth: OAuthHarness = {
      fetch,
      // Not wired: the app runs on real time.
      clock: new SkewedClock(),
      logs: lines,
      store: (f) => run(Effect.flatMap(makeOAuthStore(undefined, grantSettings), f)),
      sql: run,
      run,
      boxes: { add: refuse, remove: refuse },
      close,
    };
    return {
      base,
      dir,
      oauth,
      run,
      logs: () => lines.map(scrub),
      admin: () => adminSession(fetch, secrets, scrub),
      consent: async (request) => {
        const tokens = await tokensFor(oauth, {
          boxes: request.boxes,
          scopes: request.scopes,
          deliveryConsent: request.deliveryConsent,
        });
        return { clientId: tokens.clientId, access: tokens.access, refresh: tokens.refresh };
      },
      mcp: async (access, mcpOptions = {}) => {
        const client = new Client({ name: "datova-schranka-e2e", version: "1.0.0" });
        sessions.push(() => client.close());
        await client.connect(
          new StreamableHTTPClientTransport(new URL("/mcp", base), {
            requestInit: { headers: { authorization: `Bearer ${access}` } },
          }),
        );
        const requestOptions =
          mcpOptions.requestTimeoutMs === undefined ? undefined : { timeout: mcpOptions.requestTimeoutMs };
        return {
          client,
          listTools: async () => (await client.listTools(undefined, requestOptions)).tools,
          call: async (name, args = {}) =>
            (await client.callTool({ name, arguments: args }, undefined, requestOptions)) as CallToolResult,
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
