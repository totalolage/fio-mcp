import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Logger, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { SETTING, StoredAccountsLive } from "../src/account-store.js";
import { Accounts, tokenFingerprint } from "../src/accounts.js";
import { databaseLayer, SERVER_MIGRATIONS } from "../src/cache/db.js";
import { makeCacheStore } from "../src/cache/store.js";
import { type AccountConfig, type AccountSeed, accountSeedOf } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { hashPassword } from "../src/oauth/crypto.js";
import { Redactor } from "../src/redaction.js";
import { DataKeyMismatch, TokenDecryptionFailed } from "../src/token-crypto.js";
import { loadConfigFrom } from "./fixtures.js";
import { FIO_TOKEN, SAVINGS_TOKEN } from "./support/transport.js";

const KEY = Redacted.make(new Uint8Array(32).fill(3));
const WRONG_KEY = Redacted.make(new Uint8Array(32).fill(4));

const MAIN: AccountConfig = { name: "main", token: Redacted.make(FIO_TOKEN), accountNumber: "2900000000", currency: "CZK" };
const SAVINGS: AccountConfig = { name: "savings", token: Redacted.make(SAVINGS_TOKEN), accountNumber: undefined, currency: undefined };

const tempDb = () => join(mkdtempSync(join(tmpdir(), "fio-accounts-")), "fio.sqlite");

const database = (path: string) => databaseLayer(path, SERVER_MIGRATIONS).pipe(Layer.provide(NodeFileSystem.layer));

/** One server start: the accounts it loads (or why it failed) and what it logged. */
const start = (path: string, key: Redacted.Redacted<Uint8Array>, configured: ReadonlyArray<AccountConfig> | AccountSeed) =>
  Effect.gen(function* () {
    const logs: Array<string> = [];
    const capture = Logger.make<unknown, void>((entry) => void logs.push(Logger.formatLogFmt.log(entry)));
    const seed = "load" in configured ? configured : accountSeedOf(configured);
    const layer = StoredAccountsLive(key, seed).pipe(Layer.provide(database(path)), Layer.provide(Redactor.layerFrom([])));
    const exit = yield* Effect.exit(
      Effect.scoped(Effect.flatMap(Layer.build(layer), (context) => Context.get(context, Accounts).list)),
    ).pipe(Effect.provide(Logger.layer([capture])));
    return { exit, logs };
  });

const withSql = <A, E>(path: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.scoped(Effect.flatMap(Layer.build(database(path)), (context) => Effect.provideContext(effect, context)));

const tempFile = (content: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "fio-accounts-")), "file");
  writeFileSync(path, content, { mode: 0o440 });
  return path;
};

/** The seed `loadConfig` builds for HTTP mode with OAuth from `env`. */
const oauthSeed = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const hash = yield* hashPassword(Redacted.make("test-admin-password"), { ln: 14, r: 8, p: 1 });
    const config = yield* loadConfigFrom({
      FIO_MCP_TRANSPORT: "http",
      FIO_MCP_PUBLIC_URL: "https://fio.example.test",
      FIO_MCP_ADMIN_PASSWORD_HASH_FILE: tempFile(`${hash}\n`),
      FIO_MCP_DATA_KEY_FILE: tempFile(`${"03".repeat(32)}\n`),
      ...env,
    });
    if (config.transport.kind !== "http" || config.transport.auth.kind !== "oauth") return assert.fail("expected OAuth");
    assert.deepStrictEqual(config.accounts, []);
    return config.transport.auth.accountSeed;
  });

// Not JSON, and holds a token: it must never be echoed.
const MALFORMED_ACCOUNTS = `[{"name":"main","token":"${FIO_TOKEN}"`;

const names = (exit: Exit.Exit<ReadonlyArray<{ readonly name: string }>, unknown>) =>
  Exit.isSuccess(exit) ? exit.value.map((account) => account.name) : `failed: ${String(exit.cause)}`;

describe("encrypted account store", () => {
  it.effect("imports the configured accounts once, then ignores them with a warning", () =>
    Effect.gen(function* () {
      const path = tempDb();
      const first = yield* start(path, KEY, [MAIN, SAVINGS]);
      assert.deepStrictEqual(names(first.exit), ["main", "savings"]);
      assert.isTrue(first.logs.some((line) => line.includes("imported 2 accounts")));
      if (Exit.isSuccess(first.exit)) {
        const [main] = first.exit.value;
        assert.strictEqual(main?.tokenFingerprint, tokenFingerprint(MAIN.token));
        assert.strictEqual(main?.configuredAccountNumber, "2900000000");
        assert.match(main?.id ?? "", /^acct_/);
      }
      // Restarted with a different file: the database decides.
      const second = yield* start(path, KEY, [SAVINGS]);
      assert.deepStrictEqual(names(second.exit), ["main", "savings"]);
      assert.isTrue(second.logs.some((line) => line.includes("are set but ignored")));
      for (const line of [...first.logs, ...second.logs]) {
        assert.notInclude(line, FIO_TOKEN);
        assert.notInclude(line, SAVINGS_TOKEN);
      }
    }),
  );

  it.effect("never imports again once the accounts were edited, even down to none", () =>
    Effect.gen(function* () {
      const path = tempDb();
      yield* start(path, KEY, [MAIN]);
      yield* withSql(
        path,
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM fio_accounts`),
      );
      const restarted = yield* start(path, KEY, [MAIN]);
      assert.deepStrictEqual(names(restarted.exit), []);
      // A fresh database without configured accounts starts empty and stays importable.
      const fresh = tempDb();
      assert.deepStrictEqual(names((yield* start(fresh, KEY, [])).exit), []);
      assert.deepStrictEqual(names((yield* start(fresh, KEY, [SAVINGS])).exit), ["savings"]);
    }),
  );

  it.effect("starts from a seeded database whatever the ignored FIO_ACCOUNTS holds", () =>
    Effect.gen(function* () {
      const path = tempDb();
      yield* start(path, KEY, [MAIN]);
      const missing = join(mkdtempSync(join(tmpdir(), "fio-accounts-")), "gone.json");
      const ignored: ReadonlyArray<Record<string, string>> = [
        { FIO_ACCOUNTS: MALFORMED_ACCOUNTS },
        { FIO_ACCOUNTS_FILE: missing },
        { FIO_ACCOUNTS: "[]", FIO_TOKEN },
      ];
      for (const env of ignored) {
        const restarted = yield* start(path, KEY, yield* oauthSeed(env));
        assert.deepStrictEqual(names(restarted.exit), ["main"]);
        assert.isTrue(restarted.logs.some((line) => line.includes("are set but ignored")));
        for (const line of restarted.logs) {
          assert.notInclude(line, FIO_TOKEN);
          assert.notInclude(line, missing);
        }
      }
    }),
  );

  it.effect("validates the seed strictly when the database needs it, without echoing it", () =>
    Effect.gen(function* () {
      const path = tempDb();
      const failed = yield* start(path, KEY, yield* oauthSeed({ FIO_ACCOUNTS: MALFORMED_ACCOUNTS }));
      assert.isTrue(Exit.isFailure(failed.exit));
      if (Exit.isFailure(failed.exit)) {
        const error = Cause.squash(failed.exit.cause);
        assert.instanceOf(error, ConfigError);
        assert.strictEqual((error as ConfigError).message, "FIO_ACCOUNTS is not valid JSON");
        assert.notInclude(String(failed.exit.cause), FIO_TOKEN);
      }
      const missing = join(mkdtempSync(join(tmpdir(), "fio-accounts-")), "gone.json");
      const unreadable = yield* start(path, KEY, yield* oauthSeed({ FIO_ACCOUNTS_FILE: missing }));
      assert.isTrue(Exit.isFailure(unreadable.exit));
      if (Exit.isFailure(unreadable.exit)) {
        const error = Cause.squash(unreadable.exit.cause);
        assert.instanceOf(error, ConfigError);
        assert.strictEqual((error as ConfigError).message, "FIO_ACCOUNTS_FILE: file not readable");
        assert.notInclude(String(unreadable.exit.cause), missing);
      }
      for (const line of [...failed.logs, ...unreadable.logs]) assert.notInclude(line, FIO_TOKEN);
      // Nothing was imported or marked: a fixed seed still imports.
      const fixed = yield* start(path, KEY, yield* oauthSeed({ FIO_ACCOUNTS_FILE: tempFile(JSON.stringify([{ name: "main", token: FIO_TOKEN }])) }));
      assert.deepStrictEqual(names(fixed.exit), ["main"]);
    }),
  );

  it.effect("fails startup on a wrong key, without the key, a token, or a path in the message", () =>
    Effect.gen(function* () {
      const path = tempDb();
      yield* start(path, KEY, [MAIN]);
      const wrong = yield* start(path, WRONG_KEY, [MAIN]);
      assert.isTrue(Exit.isFailure(wrong.exit));
      if (Exit.isFailure(wrong.exit)) {
        const message = String(wrong.exit.cause);
        assert.include(message, "DataKeyMismatch");
        assert.include(new DataKeyMismatch().message, "FIO_MCP_DATA_KEY_FILE");
        assert.notInclude(message, FIO_TOKEN);
        assert.notInclude(message, path);
        assert.notInclude(message, Buffer.from(Redacted.value(WRONG_KEY)).toString("hex"));
      }
      // Even with no accounts at all, the key check catches it.
      const empty = tempDb();
      yield* start(empty, KEY, []);
      assert.isTrue(Exit.isFailure((yield* start(empty, WRONG_KEY, [])).exit));
    }),
  );

  it.effect("binds each ciphertext to its row: a token copied to another row fails startup instead of loading", () =>
    Effect.gen(function* () {
      const path = tempDb();
      yield* start(path, KEY, [MAIN, SAVINGS]);
      yield* withSql(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ account_id: string; token_sealed: string; token_fingerprint: string }>`
            SELECT account_id, token_sealed, token_fingerprint FROM fio_accounts ORDER BY position
          `;
          const [main, savings] = rows;
          if (main === undefined || savings === undefined) return assert.fail("expected two rows");
          // Swap both the ciphertexts and the fingerprints, as an attacker with write access could.
          yield* sql`UPDATE fio_accounts SET token_sealed = ${savings.token_sealed}, token_fingerprint = ${savings.token_fingerprint} WHERE account_id = ${main.account_id}`;
          yield* sql`UPDATE fio_accounts SET token_sealed = ${main.token_sealed}, token_fingerprint = ${main.token_fingerprint} WHERE account_id = ${savings.account_id}`;
        }),
      );
      const swapped = yield* start(path, KEY, []);
      assert.isTrue(Exit.isFailure(swapped.exit));
      if (Exit.isFailure(swapped.exit)) assert.include(String(swapped.exit.cause), "TokenDecryptionFailed");
      assert.include(new TokenDecryptionFailed({ accountId: "acct_x" }).message, "acct_x");
    }),
  );

  it.effect("fails closed when the key check is missing and the tokens do not decrypt", () =>
    Effect.gen(function* () {
      const path = tempDb();
      yield* start(path, KEY, [MAIN]);
      yield* withSql(
        path,
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM server_settings WHERE key = ${SETTING.dataKeyCheck}`),
      );
      assert.isTrue(Exit.isFailure((yield* start(path, WRONG_KEY, [])).exit));
      // The right key recreates the check.
      assert.deepStrictEqual(names((yield* start(path, KEY, [])).exit), ["main"]);
    }),
  );

  it.effect("keeps no token in plaintext anywhere in the database files", () =>
    Effect.gen(function* () {
      const path = tempDb();
      yield* start(path, KEY, [MAIN, SAVINGS]);
      const files = [path, `${path}-wal`, `${path}-journal`].filter((file) => existsSync(file));
      assert.isAbove(files.length, 0);
      for (const file of files) {
        const bytes = readFileSync(file);
        for (const token of [FIO_TOKEN, SAVINGS_TOKEN]) {
          assert.strictEqual(bytes.indexOf(Buffer.from(token, "utf8")), -1, `${token} in ${file}`);
          // Not even a long fragment (e.g. a prefix or the bytes without the last four).
          assert.strictEqual(bytes.indexOf(Buffer.from(token.slice(0, 24), "utf8")), -1, `prefix of a token in ${file}`);
          assert.strictEqual(bytes.indexOf(Buffer.from(token.slice(-24), "utf8")), -1, `suffix of a token in ${file}`);
        }
      }
    }),
  );
});

describe("cache purge for a removed token", () => {
  it.effect("deletes the token's data unless another token is bound to the same bank account", () =>
    Effect.gen(function* () {
      const path = tempDb();
      yield* withSql(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* makeCacheStore();
          const bind = (fingerprint: string, accountKey: string) =>
            sql`INSERT INTO bindings ${sql.insert({ token_fingerprint: fingerprint, account_key: accountKey, account_name: "x", verified_at: 1 })}`;
          yield* sql`INSERT INTO accounts ${sql.insert({ account_key: "k1", account_id: "1", bank_id: "2010", updated_at: 1 })}`;
          yield* sql`INSERT INTO transactions ${sql.insert({ account_key: "k1", movement_id: 1, date: "2026-01-01", raw_json: "{}", first_seen_at: 1, updated_at: 1 })}`;
          yield* sql`INSERT INTO sync_state ${sql.insert({ token_fingerprint: "fp-a" })}`;
          yield* bind("fp-a", "k1");
          yield* bind("fp-b", "k1");
          yield* store.purgeToken("fp-a");
          const count = (table: string) =>
            Effect.map(sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`, ([row]) => row?.n ?? 0);
          // fp-b still reads k1: only fp-a's binding and sync state go.
          assert.strictEqual(yield* count("transactions"), 1);
          assert.strictEqual(yield* count("bindings"), 1);
          assert.strictEqual(yield* count("sync_state"), 0);
          yield* store.purgeToken("fp-b");
          assert.strictEqual(yield* count("transactions"), 0);
          assert.strictEqual(yield* count("accounts"), 0);
          assert.strictEqual(yield* count("bindings"), 0);
        }),
      );
    }),
  );
});
