import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { hashPassword } from "@mcps/core/oauth/crypto.js";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { AppConfig, loadConfig } from "../../src/config.js";

/** A fresh private directory for one test. */
export const tempDir = () => mkdtempSync(join(tmpdir(), "datova-schranka-test-"));

/** Writes `content` to a new file and returns its path. */
export const secretFile = (content: string) => {
  const path = join(tempDir(), "secret");
  writeFileSync(path, content, { mode: 0o440 });
  return path;
};

export const DATA_KEY_HEX = "ab".repeat(32);
export const OTHER_DATA_KEY_HEX = "cd".repeat(32);

/** The variables every start needs: public URL, admin password hash file and data key file (HOME locates the database). */
export const requiredEnv = Effect.gen(function* () {
  const hash = yield* hashPassword(Redacted.make("test-admin-password"), { ln: 14, r: 8, p: 1 });
  return {
    HOME: "/home/test",
    DATOVA_SCHRANKA_PUBLIC_URL: "https://ds.example.test",
    DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE: secretFile(`${hash}\n`),
    DATOVA_SCHRANKA_DATA_KEY_FILE: secretFile(`${DATA_KEY_HEX}\n`),
  } as Record<string, string>;
});

const environment = (env: Record<string, string>) =>
  Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NodeFileSystem.layer);

/** loadConfig against exactly `env` (and the real file system for `_FILE` variables). */
export const loadConfigFrom = (env: Record<string, string>) => loadConfig.pipe(Effect.provide(environment(env)));

/** AppConfig loaded from exactly `env`. */
export const appConfigFrom = (env: Record<string, string>) => AppConfig.Default.pipe(Layer.provide(environment(env)));
