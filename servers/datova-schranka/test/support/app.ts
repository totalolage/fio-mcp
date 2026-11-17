/**
 * The composed server (src/app/app.ts httpApp) in-process on a loopback
 * port, as `datova-schranka serve` builds it from the environment: the
 * environment comes as a ConfigProvider (process.env stays untouched), ISDS
 * as a fake transport that logs every username in as its box. The returned
 * harness is an OAuthHarness over the socket, so test/support/oauth.ts's
 * browser, consent and token helpers drive the real app; `run` gets the
 * app's own services.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { hashPassword } from "@mcps/core/oauth/crypto.js";
import { makeOAuthStore } from "@mcps/core/oauth/store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Context, Effect, Exit, Layer, Logger, Redacted, Scope } from "effect";
import { HttpServer } from "effect/http";
import { FEATURES, type Features, httpApp } from "../../src/app/app.js";
import { AppConfig } from "../../src/config.js";
import { type Box, BoxRegistry } from "../../src/domain/boxes.js";
import { grantSettings } from "../../src/oauth/grant-settings.js";
import { loadConfigFrom } from "../config/support.js";
import { type FakeRespond, fakeIsdsTransports, loginResponder, passwordCredentials } from "../domain/support/fake-isds.js";
import { FAST_SCRYPT, type HarnessServices, type OAuthHarness, PASSWORD, PUBLIC_URL, SkewedClock } from "./oauth.js";

/** The data key the harness writes (hex). */
export const APP_DATA_KEY_HEX = "5a".repeat(32);

/** The boxes startApp adds (labels as test/support/oauth.ts's consent defaults tick them), username → dbID. */
export const APP_BOXES: ReadonlyArray<{ readonly label: string; readonly username: string; readonly dbId: string }> = [
  { label: "Main", username: "main-user", dbId: "abc2def" },
  { label: "Other", username: "other-user", dbId: "ghi3jkm" },
];

export interface AppStartOptions {
  /** The features to serve (default FEATURES, the production set). */
  readonly features?: Features;
  /** More environment, e.g. DATOVA_SCHRANKA_ADMIN_PORT. */
  readonly env?: Readonly<Record<string, string>>;
  /** Boxes to add once the server runs (default APP_BOXES; [] for none). */
  readonly boxes?: ReadonlyArray<{ readonly label: string; readonly username: string; readonly dbId: string }>;
  /** The fake ISDS's answer to every operation besides logins and DummyOperation (default: an empty 200). */
  readonly respond?: FakeRespond;
}

/** OAuthHarness over the socket; its `clock` is inert (the app runs on real time). */
export interface AppHarness extends OAuthHarness {
  /** The app's origin on loopback (PUBLIC_URL is only its configured public name). */
  readonly base: string;
  /** The boxes as the registry stored them, in APP_BOXES order. */
  readonly added: ReadonlyArray<Box>;
  /** The data directory (database, ZFO store); removed by close. */
  readonly dir: string;
  /** Opens an MCP client session on /mcp with the access token; closed by close. */
  readonly mcp: (access: string) => Promise<Client>;
}

/** PUBLIC_URL's requests to the socket at `base`; redirects come back to the caller, as in the in-process harness. */
export const socketFetch =
  (base: string): OAuthHarness["fetch"] =>
  async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== PUBLIC_URL) throw new Error(`not the app: ${url.origin}`);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    // The browser's side of the socket, outside Effect.
    // @effect-diagnostics-next-line globalFetch:off
    return fetch(`${base}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body,
      redirect: "manual",
    });
  };

/** A loopback port nothing listens on right now. */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** The environment `datova-schranka serve` would get, with its files in `dir`. */
export async function appEnv(dir: string, extra: Readonly<Record<string, string>> = {}) {
  // A second server on the same directory reuses the first one's files.
  if (!existsSync(join(dir, "password.hash"))) {
    const hash = await Effect.runPromise(hashPassword(Redacted.make(PASSWORD), FAST_SCRYPT));
    writeFileSync(join(dir, "password.hash"), `${hash}\n`, { mode: 0o400 });
    writeFileSync(join(dir, "data.key"), `${APP_DATA_KEY_HEX}\n`, { mode: 0o400 });
  }
  return {
    HOME: "/home/test",
    DATOVA_SCHRANKA_HOST: "127.0.0.1",
    DATOVA_SCHRANKA_PUBLIC_URL: PUBLIC_URL,
    DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE: join(dir, "password.hash"),
    DATOVA_SCHRANKA_DATA_KEY_FILE: join(dir, "data.key"),
    DATOVA_SCHRANKA_DB_PATH: join(dir, "datova-schranka.sqlite"),
    DATOVA_SCHRANKA_DATA_DIR: join(dir, "zfo"),
    DATOVA_SCHRANKA_ISDS_ENVIRONMENT: "test",
    ...extra,
  };
}

/**
 * The app's dependencies from `env`, as main.ts provides them but on port 0
 * and with the fake ISDS: AppConfig, the file system and IsdsTransports.
 */
export async function appPlatform(
  env: Readonly<Record<string, string>>,
  boxes: AppStartOptions["boxes"] = APP_BOXES,
  respond?: FakeRespond,
) {
  const config = await Effect.runPromise(loadConfigFrom({ ...env }));
  const logins = Object.fromEntries((boxes ?? []).map((box) => [box.username, box.dbId]));
  const isds = fakeIsdsTransports(loginResponder(logins, respond));
  return Layer.mergeAll(
    Layer.succeed(AppConfig, { ...config, http: { ...config.http, port: 0 } }),
    NodeFileSystem.layer,
    isds.layer,
  );
}

/** Starts httpApp(features) on a loopback port and adds the boxes through its BoxRegistry. */
export async function startApp(options: AppStartOptions = {}): Promise<AppHarness> {
  const dir = mkdtempSync(join(tmpdir(), "datova-schranka-app-"));
  const scope = await Effect.runPromise(Scope.make());
  const sessions: Array<() => Promise<void>> = [];
  const close = async () => {
    for (const session of sessions.splice(0)) await session().catch(() => undefined);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const env = await appEnv(dir, options.env);
    const boxes = options.boxes ?? APP_BOXES;
    const logs: Array<string> = [];
    const capture = Logger.make<unknown, void>((entry) => {
      logs.push(Logger.formatLogFmt.log(entry));
    });
    const app = httpApp(options.features ?? FEATURES).pipe(
      Layer.provide(await appPlatform(env, boxes, options.respond)),
      Layer.provide(Logger.layer([capture])),
    );
    const services = await Effect.runPromise(Layer.buildWithScope(app, scope));
    const address = Context.get(services, HttpServer.HttpServer).address;
    const base = `http://127.0.0.1:${"port" in address ? address.port : 0}`;
    const run = <A, E>(effect: Effect.Effect<A, E, HarnessServices>) =>
      Effect.runPromise(effect.pipe(Effect.provideContext(services)));
    const added = await run(
      Effect.forEach(boxes, (box) =>
        Effect.flatMap(Effect.service(BoxRegistry), (registry) =>
          registry.add({ label: box.label, environment: "test", credentials: passwordCredentials(box.username) }),
        ),
      ),
    );
    const refuse = () => Promise.reject(new Error("the app runs its real BoxRegistry: change boxes through run"));
    return {
      base,
      added,
      dir,
      fetch: socketFetch(base),
      // Not wired: the app and `run` use real time, so advancing it changes nothing.
      clock: new SkewedClock(),
      logs,
      store: (f) => run(Effect.flatMap(makeOAuthStore(undefined, grantSettings), f)),
      sql: run,
      run,
      boxes: { add: refuse, remove: refuse },
      mcp: async (access) => {
        const client = new Client({ name: "datova-schranka-app-test", version: "1.0.0" });
        sessions.push(() => client.close());
        await client.connect(
          new StreamableHTTPClientTransport(new URL("/mcp", base), {
            requestInit: { headers: { authorization: `Bearer ${access}` } },
          }),
        );
        return client;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
