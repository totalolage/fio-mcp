/**
 * The datova-schranka admin tabs served in-process through core's admin
 * server: an in-memory database with core's OAuth and the domain
 * migrations, the real BoxRegistry over a fake ISDS transport, the real
 * AuditLog, an in-memory admin password, and a cookie-keeping browser that
 * posts url-encoded and multipart forms with the CSRF token. Everything
 * logged while the app runs is captured, to check no secret is logged.
 */

import type { Flash } from "@mcps/core/admin/pages.js";
import { AdminPassword, type AdminPasswordShape, type PasswordStore } from "@mcps/core/admin/password.js";
import { AdminLive, type SecondFactorCheck } from "@mcps/core/admin/server.js";
import type { AdminApp, AdminTab } from "@mcps/core/admin/tab.js";
import { hashPassword, PasswordHashError, parsePasswordHash } from "@mcps/core/oauth/crypto.js";
import { OAUTH_MIGRATIONS } from "@mcps/core/oauth/store.js";
import { makeRedactor, Redactor } from "@mcps/core/redaction.js";
import { type Context, Effect, Exit, Layer, Logger, Option, Redacted, Ref, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import type { SqlClient } from "effect/sql";
import { AuditLog } from "../../../src/domain/audit-log.js";
import { BoxLocks } from "../../../src/domain/box-locks.js";
import { BoxRegistry } from "../../../src/domain/boxes.js";
import { DataKey, DomainConfig } from "../../../src/domain/config.js";
import type { IsdsTransports } from "../../../src/domain/isds-transports.js";
import { DOMAIN_MIGRATIONS } from "../../../src/domain/migrations.js";
import type { IsdsEnvironment } from "../../../src/isds/config.js";
import { memoryDatabase } from "../../domain/support/database.js";
import { type FakeIsdsOptions, type FakeRespond, fakeIsdsTransports, loginResponder } from "../../domain/support/fake-isds.js";
import { DATA_KEY } from "../../domain/support/registry-harness.js";

export const IDENTITY = { name: "datova-schranka", idPrefix: "ds" };
export const PUBLIC_URL = "https://ds.example.test";
export const PASSWORD = "correct horse battery staple";
const FAST_SCRYPT = { ln: 14, r: 8, p: 1 } as const;

/** What the tabs under test may require. */
export type HarnessServices =
  | SqlClient.SqlClient
  | Redactor
  | DomainConfig
  | DataKey
  | IsdsTransports
  | BoxLocks
  | BoxRegistry
  | AuditLog;

export interface AdminHarnessOptions {
  /** Login key (username or certificate passphrase) to the dbID GetOwnerInfoFromLogin answers with. */
  readonly logins?: Readonly<Record<string, string>> | undefined;
  /** Replaces the fake ISDS responder. */
  readonly respond?: FakeRespond | undefined;
  readonly onMake?: FakeIsdsOptions["onMake"];
  /** The configured ISDS environment; production when absent. */
  readonly environment?: IsdsEnvironment | undefined;
  /** Replaces core's second-factor check of tab actions. */
  readonly secondFactor?: SecondFactorCheck | undefined;
  /** Changes the admin password service (e.g. `totpEnabled`). */
  readonly password?: ((real: AdminPasswordShape) => AdminPasswordShape) | undefined;
  /** Runs against the migrated database before the registry loads (e.g. rows of another environment). */
  readonly seed?: Effect.Effect<void, never, SqlClient.SqlClient> | undefined;
}

export interface AdminHarness {
  readonly fetch: (request: Request) => Promise<Response>;
  /** Runs an effect with the app's services (the same registry, audit log and database). */
  readonly run: <A, E>(effect: Effect.Effect<A, E, HarnessServices>) => Promise<A>;
  /** The fake ISDS record (configs made, requests sent). */
  readonly isds: ReturnType<typeof fakeIsdsTransports>;
  /** Every line logged while the app ran (logfmt). */
  readonly logs: ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

const memoryPasswordStore = Effect.map(
  Ref.make(Option.none<string>()),
  (stored): PasswordStore => ({ get: Ref.get(stored), put: (line) => Ref.set(stored, Option.some(line)) }),
);

/** Starts core's admin server with `tabs` over fresh app services. */
export async function startAdmin(
  tabs: Effect.Effect<ReadonlyArray<AdminTab>, never, HarnessServices>,
  options: AdminHarnessOptions = {},
): Promise<AdminHarness> {
  const line = await Effect.runPromise(hashPassword(Redacted.make(PASSWORD), FAST_SCRYPT));
  const bootstrap = parsePasswordHash(line, IDENTITY);
  if (bootstrap instanceof PasswordHashError) throw new Error(bootstrap.message);
  const logs: Array<string> = [];
  const capture = Logger.layer([Logger.make<unknown, void>((entry) => void logs.push(Logger.formatLogFmt.log(entry)))]);
  const isds = fakeIsdsTransports(options.respond ?? loginResponder(options.logins ?? {}), { onMake: options.onMake });
  const scope = await Effect.runPromise(Scope.make());
  const database = memoryDatabase({ ...OAUTH_MIGRATIONS, ...DOMAIN_MIGRATIONS });
  const seeded = Layer.effectDiscard(options.seed ?? Effect.void).pipe(
    Layer.provideMerge(database),
  );
  const services = Layer.mergeAll(BoxRegistry.Default.pipe(Layer.orDie), AuditLog.Default).pipe(
    Layer.provideMerge(isds.layer),
    Layer.provideMerge(Layer.succeed(Redactor, makeRedactor([]))),
    Layer.provideMerge(DataKey.layer(DATA_KEY)),
    Layer.provideMerge(DomainConfig.layer({ dataDir: "/nonexistent", environment: options.environment ?? "production" })),
    Layer.provideMerge(BoxLocks.Default),
    Layer.provideMerge(seeded),
    Layer.provide(capture),
  );
  const built = await Effect.runPromise(Layer.buildWithScope(services, scope));
  const context = built as Context.Context<HarnessServices>;
  const app: AdminApp = { identity: IDENTITY, resourcesHeading: "Data boxes", passwordHashSource: "DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE" };
  const realPassword = AdminPassword.layer(memoryPasswordStore, { app: IDENTITY, bootstrap: Redacted.make(bootstrap), scrypt: FAST_SCRYPT });
  const override = options.password;
  const password =
    override === undefined
      ? realPassword
      : Layer.effect(
          AdminPassword,
          Effect.gen(function* () {
            return AdminPassword.of(override(yield* AdminPassword));
          }),
        ).pipe(Layer.provide(realPassword));
  const admin = AdminLive({ publicUrl: PUBLIC_URL, secondFactor: options.secondFactor }, app, tabs).pipe(
    Layer.provide(password),
    Layer.provide(BoxRegistry.resources),
    Layer.provide(Layer.succeedContext(context)),
  );
  const web = HttpRouter.toWebHandler(Layer.mergeAll(admin, capture).pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });
  return {
    fetch: (request) => web.handler(request),
    run: (effect) => Effect.runPromise(effect.pipe(Effect.provide(context), Effect.provide(capture))),
    isds,
    logs,
    close: async () => {
      await web.dispose();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

/** The one-shot message a page shows, unescaped as far as core's flash escaping goes. */
export const flashOf = (html: string): Flash | undefined => {
  const match = /<p class="(ok|error)" role="(?:status|alert)">([^<]*)<\/p>/.exec(html);
  return match === null ? undefined : { kind: match[1] as Flash["kind"], text: unescapeHtml(match[2] ?? "") };
};

const unescapeHtml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

export interface Page {
  readonly status: number;
  readonly location: string | null;
  readonly html: string;
}

/** A browser keeping the admin cookie; `csrf` is the last page's form token. Every page it saw is kept in `pages`. */
export class AdminBrowser {
  cookie: string | undefined;
  csrf: string | undefined;
  readonly pages: Array<string> = [];
  constructor(private readonly app: AdminHarness) {}

  private async absorb(response: Response): Promise<Page> {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      if (at > 0 && pair.slice(0, at).endsWith("-admin")) this.cookie = pair.slice(at + 1) === "" ? undefined : pair;
    }
    const html = await response.text();
    this.pages.push(html);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    if (csrf !== undefined) this.csrf = csrf;
    return { status: response.status, location: response.headers.get("location"), html };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { origin: PUBLIC_URL, ...extra };
    if (this.cookie !== undefined) headers.cookie = this.cookie;
    return headers;
  }

  async get(path: string): Promise<Page> {
    const headers = this.headers();
    delete headers.origin;
    return this.absorb(await this.app.fetch(new Request(new URL(path, PUBLIC_URL), { headers })));
  }

  async post(path: string, form: Record<string, string>): Promise<Page> {
    const body = new URLSearchParams(form);
    if (this.csrf !== undefined) body.set("csrf", this.csrf);
    const headers = this.headers({ "content-type": "application/x-www-form-urlencoded" });
    return this.absorb(await this.app.fetch(new Request(new URL(path, PUBLIC_URL), { method: "POST", headers, body })));
  }

  /** Posts a multipart form (the CSRF token added), sent as bytes. */
  async postMultipart(path: string, form: FormData): Promise<Page> {
    if (this.csrf !== undefined && !form.has("csrf")) form.set("csrf", this.csrf);
    const encoded = new Response(form);
    const headers = this.headers({ "content-type": encoded.headers.get("content-type") ?? "" });
    const body = new Uint8Array(await encoded.arrayBuffer());
    return this.absorb(await this.app.fetch(new Request(new URL(path, PUBLIC_URL), { method: "POST", headers, body })));
  }

  async signIn(extra: Record<string, string> = {}): Promise<Page> {
    await this.get("/admin/login");
    return this.post("/admin/login", { password: PASSWORD, ...extra });
  }

  /** Follows an action's redirect and returns the message the next page shows. */
  private async follow(posted: Page) {
    if (posted.status !== 303 || posted.location === null) return { status: posted.status, flash: undefined, html: posted.html };
    const page = await this.get(posted.location);
    return { status: page.status, location: posted.location, flash: flashOf(page.html), html: page.html };
  }

  /** Posts a url-encoded form and returns the one-shot message the redirected page shows. */
  async act(path: string, form: Record<string, string>) {
    return this.follow(await this.post(path, form));
  }

  /** Posts a multipart form and returns the one-shot message the redirected page shows. */
  async actMultipart(path: string, form: FormData) {
    return this.follow(await this.postMultipart(path, form));
  }
}

/** Builds a FormData from text fields and, optionally, files. */
export const multipart = (
  fields: Record<string, string>,
  files: Record<string, { readonly name: string; readonly bytes: Uint8Array }> = {},
): FormData => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  for (const [name, { name: fileName, bytes }] of Object.entries(files)) {
    form.set(name, new Blob([new Uint8Array(bytes)], { type: "application/x-pkcs12" }), fileName);
  }
  return form;
};
