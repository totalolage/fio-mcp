import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import { ADMIN_PASSWORD_HASH_KEY } from "@mcps/core/admin/password.js";
import { ConfigError } from "@mcps/core/config/env.js";
import { PasswordHashError, parsePasswordHash, verifyPassword } from "@mcps/core/oauth/crypto.js";
import { makeOAuthStore } from "@mcps/core/oauth/store.js";
import { type Cause, Clock, ConfigProvider, Effect, Layer, Option, Queue, Redacted, Sink, Stdio, Stream, Terminal } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { DatabaseLive } from "../../src/app/database.js";
import { CommandFailed } from "../../src/cli/io.js";
import { CLI_USAGE, runCli } from "../../src/cli/run.js";
import { APP_IDENTITY } from "../../src/oauth/identity.js";
import { appConfigFrom, requiredEnv, tempDir } from "../config/support.js";

/** Captured standard streams over `stdin` (a pipe unless `isTerminal`). */
const fakeStdio = (stdin = "", isTerminal = false) => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const decoder = new TextDecoder();
  const collect = (into: Array<string>) => {
    const append = (chunk: string | Uint8Array) =>
      Effect.sync(() => {
        into.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
      });
    return Sink.forEach(append);
  };
  const layer = Stdio.layerTest({
    stdin: Stream.make(new TextEncoder().encode(stdin)),
    stdinIsTerminal: Effect.succeed(isTerminal),
    stdout: () => collect(out),
    stderr: () => collect(err),
  });
  return { layer, out, err };
};

/** A terminal that "types" the given lines (no echo). */
const fakeTerminal = (lines: ReadonlyArray<string>) => {
  let next = 0;
  return Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readLine: Effect.die("not used"),
      display: () => Effect.void,
      readInput: Effect.gen(function* () {
        const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
        const key = (name: string) => ({ name, ctrl: false, meta: false, shift: false });
        for (const char of lines[next++] ?? "") yield* Queue.offer(queue, { input: Option.some(char), key: key(char) });
        yield* Queue.offer(queue, { input: Option.none(), key: key("return") });
        return queue;
      }),
    }),
  );
};

/**
 * Runs `datova-schranka <args>` against `env`, with `stdin` piped in, or on
 * a terminal typing `typed` when given.
 */
const cli = (args: ReadonlyArray<string>, env: Record<string, string> = {}, stdin = "", typed?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const stdio = fakeStdio(stdin, typed !== undefined);
    const exit = yield* runCli(args).pipe(
      Effect.provide(
        Layer.mergeAll(
          stdio.layer,
          fakeTerminal(typed ?? []),
          NodeFileSystem.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        ),
      ),
      Effect.exit,
    );
    return { exit, out: stdio.out.join(""), err: stdio.err.join("") };
  });

const failure = (
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
  stdin = "",
  typed?: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const result = yield* cli(args, env, stdin, typed);
    assert.isTrue(result.exit._tag === "Failure", `${args.join(" ")} should fail`);
    const error = yield* Effect.flip(result.exit);
    return { error, out: result.out, err: result.err };
  });

const success = (
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
  stdin = "",
  typed?: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const result = yield* cli(args, env, stdin, typed);
    if (result.exit._tag === "Failure") assert.fail(`${args.join(" ")} failed: ${String(result.exit.cause)}`);
    return result;
  });

/** The variables a configured command needs, with a database file of its own. */
const serverEnv = Effect.gen(function* () {
  const env = yield* requiredEnv;
  return { ...env, DATOVA_SCHRANKA_DB_PATH: join(tempDir(), "datova-schranka.sqlite") };
});

/** Runs `effect` on the database `env` names (as the server would see it). */
const onDatabase = <A, E>(env: Record<string, string>, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.provide(effect, DatabaseLive.pipe(Layer.provide(appConfigFrom(env)), Layer.provide(NodeFileSystem.layer)));

describe("runCli arguments", () => {
  it.effect("prints the usage for anything that is not exactly a command, before reading any configuration", () =>
    Effect.gen(function* () {
      for (const args of [
        [],
        ["serve"],
        ["unknown"],
        ["hash-password", "extra"],
        ["totp-init", "extra"],
        ["backup"],
        ["backup", ""],
        ["backup", "a", "b"],
        ["clients"],
        ["clients", "list", "extra"],
        ["clients", "revoke"],
        ["clients", "revoke", ""],
        ["clients", "revoke", "a", "b"],
        ["tokens"],
        ["tokens", "revoke-all", "extra"],
        ["reset-admin-password", "--bogus"],
        ["reset-admin-password", "--set", "extra"],
        ["audit"],
        ["audit", "list"],
        ["audit", "purge"],
        ["audit", "purge", "--before"],
        ["audit", "purge", "--after", "2020-01-01"],
        ["audit", "purge", "--before", "2020-1-1"],
        ["audit", "purge", "--before", "2020-02-30"],
        ["audit", "purge", "--before", "yesterday"],
        ["audit", "purge", "--before", "2020-01-01", "extra"],
      ]) {
        const { error } = yield* failure(args);
        assert.instanceOf(error, CommandFailed, args.join(" "));
        assert.strictEqual(error.message, CLI_USAGE, args.join(" "));
      }
    }),
  );

  it.effect("names every command in the usage", () =>
    Effect.sync(() => {
      for (const command of [
        "serve",
        "backup <dest>",
        "hash-password",
        "totp-init",
        "clients list",
        "clients revoke <id>",
        "tokens revoke-all",
        "reset-admin-password [--set]",
        "audit purge --before YYYY-MM-DD",
      ]) {
        assert.include(CLI_USAGE, command);
      }
    }),
  );

  it.effect("configured commands fail with the configuration error, naming the variable", () =>
    Effect.gen(function* () {
      const { error } = yield* failure(["clients", "list"], { HOME: "/home/test" });
      assert.instanceOf(error, ConfigError);
      assert.include(error.message, "DATOVA_SCHRANKA_PUBLIC_URL");
    }),
  );
});

/** Whether `line` is the hash of `password`, checked with core's verifier. */
const hashes = (line: string, password: string) =>
  Effect.gen(function* () {
    const parsed = parsePasswordHash(line.trim(), APP_IDENTITY);
    if (parsed instanceof PasswordHashError) return false;
    return yield* verifyPassword(Redacted.make(password), parsed);
  });

describe("hash-password", () => {
  it.effect("hashes a piped password (trailing newline dropped) to stdout, needing no configuration", () =>
    Effect.gen(function* () {
      const { out, err } = yield* success(["hash-password"], {}, "a long admin password\n");
      assert.match(out, /^\$scrypt\$[^\n]+\n$/);
      assert.isTrue(yield* hashes(out, "a long admin password"));
      assert.strictEqual(err, "");
    }),
  );

  it.effect("asks twice on a terminal without echoing", () =>
    Effect.gen(function* () {
      const { out, err } = yield* success(["hash-password"], {}, "", ["typed admin password", "typed admin password"]);
      assert.isTrue(yield* hashes(out, "typed admin password"));
      assert.strictEqual(err, "Admin password: \nRepeat the password: \n");
    }),
  );

  it.effect("refuses short passwords and mismatched repeats", () =>
    Effect.gen(function* () {
      const short = yield* failure(["hash-password"], {}, "short\n");
      assert.strictEqual(short.error.message, "the password must be 12 to 1024 characters");
      const mismatch = yield* failure(["hash-password"], {}, "", ["first admin password", "other admin password"]);
      assert.strictEqual(mismatch.error.message, "the passwords do not match");
      assert.strictEqual(short.out + mismatch.out, "");
    }),
  );
});

describe("totp-init", () => {
  it.effect("prints a new base32 secret and its otpauth URI on stdout, and stores nothing", () =>
    Effect.gen(function* () {
      const { out, err } = yield* success(["totp-init"]);
      const [secret, uri, ...rest] = out.split("\n");
      assert.match(secret ?? "", /^[A-Z2-7]{32}$/);
      assert.include(uri ?? "", "otpauth://totp/datova-schranka:admin?");
      assert.include(uri ?? "", `secret=${secret}`);
      assert.include(uri ?? "", "issuer=datova-schranka");
      assert.deepStrictEqual(rest, [""]);
      assert.include(err, "DATOVA_SCHRANKA_ADMIN_TOTP_SECRET_FILE");
      assert.include(err, "datova-schranka totp-init | head -n 1");
    }),
  );
});

describe("clients and tokens", () => {
  it.effect("lists clients, revokes one, and revokes every token", () =>
    Effect.gen(function* () {
      const env = yield* serverEnv;
      const empty = yield* success(["clients", "list"], env);
      assert.strictEqual(empty.out, "No registered clients.\n");

      const now = yield* Clock.currentTimeMillis;
      yield* onDatabase(
        env,
        Effect.gen(function* () {
          const store = yield* makeOAuthStore();
          for (const clientId of ["ds_client_a", "ds_client_b"]) {
            yield* store.insertClient(
              { clientId, clientName: `App ${clientId}`, redirectUris: ["https://a.example/cb"], createdAt: now, lastUsedAt: null },
              10,
            );
            const grantId = `grant_${clientId}`;
            yield* store.createGrant(
              { grantId, clientId, scopes: ["isds:read"], resources: ["box_a"], resource: "https://ds.example.test/mcp" },
              { codeHash: `code_${clientId}`, clientId, redirectUri: "https://a.example/cb", codeChallenge: "x", expiresAt: now + 60_000 },
              now,
            );
            yield* store.insertTokens(grantId, {
              accessHash: `access_${clientId}`,
              accessExpiresAt: now + 3_600_000,
              refreshHash: `refresh_${clientId}`,
              refreshExpiresAt: now + 3_600_000,
            });
          }
        }),
      );

      const listed = (yield* success(["clients", "list"], env)).out;
      assert.include(listed, 'ds_client_a  name="App ds_client_a"  registered=1970-01-01T00:00:00.000Z  last_authorized=1970-01-01T00:00:00.000Z  active_grants=1');
      assert.include(listed, "ds_client_b");
      assert.include(listed, "active_grants=1");
      assert.include(listed, 'redirect_uris=["https://a.example/cb"]');

      const revoked = yield* success(["clients", "revoke", "ds_client_a"], env);
      assert.strictEqual(revoked.out, "Revoked client ds_client_a and all its tokens.\n");
      const missing = yield* failure(["clients", "revoke", "ds_client_a"], env);
      assert.strictEqual(missing.error.message, "no registered client ds_client_a (see datova-schranka clients list)");

      const all = yield* success(["tokens", "revoke-all"], env);
      assert.strictEqual(all.out, "Revoked 1 active grants; every client must authorize again.\n");
      const live = yield* onDatabase(
        env,
        Effect.gen(function* () {
          const store = yield* makeOAuthStore();
          return yield* store.accessGrant("access_ds_client_b", now);
        }),
      );
      assert.isTrue(Option.isNone(live));
    }),
  );
});

describe("reset-admin-password", () => {
  const storedHash = (env: Record<string, string>) =>
    onDatabase(
      env,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly value: string }>`SELECT value FROM server_settings WHERE key = ${ADMIN_PASSWORD_HASH_KEY}`;
        return rows[0]?.value;
      }),
    );

  it.effect("stores a new password with --set and drops it again without", () =>
    Effect.gen(function* () {
      const env = yield* serverEnv;
      const none = yield* success(["reset-admin-password"], env);
      assert.strictEqual(
        none.err,
        "No admin password was set at /admin; DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE already applies.\n",
      );

      const set = yield* success(["reset-admin-password", "--set"], env, "a new admin password\n");
      assert.strictEqual(set.out, "");
      assert.strictEqual(set.err, "Stored the new admin password; it replaces DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE.\n");
      assert.match((yield* storedHash(env)) ?? "", /^\$scrypt\$/);

      const removed = yield* success(["reset-admin-password"], env);
      assert.strictEqual(
        removed.err,
        "Removed the admin password set at /admin; DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE applies again.\n",
      );
      assert.isUndefined(yield* storedHash(env));
    }),
  );

  it.effect("refuses a short password and stores nothing", () =>
    Effect.gen(function* () {
      const env = yield* serverEnv;
      const { error } = yield* failure(["reset-admin-password", "--set"], env, "short\n");
      assert.include(error.message, "the password must be 12 to 1024 characters");
      assert.isUndefined(yield* storedHash(env));
    }),
  );
});

describe("audit purge", () => {
  const NOW = Date.parse("2026-11-17T12:00:00Z");

  const seed = (env: Record<string, string>) =>
    onDatabase(
      env,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [id, at] of [
          ["old", Date.parse("2025-01-01T10:00:00Z")],
          ["edge", Date.parse("2025-06-01T00:00:00Z")],
          ["recent", Date.parse("2026-11-01T00:00:00Z")],
        ] as const) {
          yield* sql`INSERT INTO audit_log ${sql.insert({
            id,
            at,
            updated_at: at,
            actor_kind: "admin",
            grant_id: null,
            client_id: null,
            subject: null,
            action: "box.add",
            box_id: null,
            outcome: "ok",
            detail_json: "{}",
          })}`;
        }
      }),
    );

  const remaining = (env: Record<string, string>) =>
    onDatabase(
      env,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{ readonly id: string }>`SELECT id FROM audit_log ORDER BY at`).map((row) => row.id);
      }),
    );

  it.effect("deletes only rows recorded before the date (00:00 UTC) and prints the count", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const env = yield* serverEnv;
      yield* seed(env);
      const { out } = yield* success(["audit", "purge", "--before", "2025-06-01"], env);
      assert.strictEqual(out, "Deleted 1 audit row from before 2025-06-01 (UTC). Rows are kept at least 365 days.\n");
      assert.deepStrictEqual(yield* remaining(env), ["edge", "recent"]);
    }),
  );

  it.effect("refuses a cut-off within the retention period, naming the latest allowed date, and deletes nothing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const env = yield* serverEnv;
      yield* seed(env);
      const { error, out } = yield* failure(["audit", "purge", "--before", "2026-01-01"], env);
      assert.instanceOf(error, CommandFailed);
      assert.strictEqual(
        error.message,
        "Audit entries must be kept 365 days; the cutoff can be 2025-11-17 at the latest.",
      );
      assert.strictEqual(out, "");
      assert.deepStrictEqual(yield* remaining(env), ["old", "edge", "recent"]);
    }),
  );
  it.effect("allows the latest date the retention floor permits and refuses the day after", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const env = yield* serverEnv;
      yield* seed(env);
      const late = yield* failure(["audit", "purge", "--before", "2025-11-18"], env);
      assert.include(late.error.message, "the cutoff can be 2025-11-17 at the latest");
      const { out } = yield* success(["audit", "purge", "--before", "2025-11-17"], env);
      assert.strictEqual(out, "Deleted 2 audit rows from before 2025-11-17 (UTC). Rows are kept at least 365 days.\n");
      assert.deepStrictEqual(yield* remaining(env), ["recent"]);
    }),
  );
});

describe("backup", () => {
  it.effect("writes a private copy of the database and refuses an existing destination", () =>
    Effect.gen(function* () {
      const env = yield* serverEnv;
      const destination = join(tempDir(), "backup.sqlite");
      yield* success(["backup", destination], env);
      assert.isTrue(existsSync(destination));
      assert.strictEqual(statSync(destination).mode & 0o777, 0o600);
      assert.isAbove(statSync(destination).size, 0);

      const taken = join(tempDir(), "taken.sqlite");
      writeFileSync(taken, "keep");
      const { error } = yield* failure(["backup", taken], env);
      assert.strictEqual(error.message, `backup destination ${taken} already exists`);
    }),
  );
});
