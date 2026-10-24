import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Logger, Option, Redacted } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { makeAccountStore, SETTING, StoredAccountsLive } from "../src/account-store.js";
import { Accounts, tokenFingerprint } from "../src/accounts.js";
import { databaseLayer, migrate, SERVER_MIGRATIONS } from "../src/cache/db.js";
import { type CacheStore, makeCacheStore } from "../src/cache/store.js";
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

describe("account token history", () => {
  const fp = (token: string) => tokenFingerprint(Redacted.make(token));
  const OTHER_TOKEN = "otherT0ken-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ";

  it.effect("records each account's tokens when imported, added and replaced, and forgets them with the account", () =>
    withSql(
      tempDb(),
      Effect.gen(function* () {
        const store = yield* makeAccountStore(KEY);
        assert.deepStrictEqual(yield* store.seed(accountSeedOf([MAIN])), Option.some(1));
        const savings = yield* store.insert({ name: "savings", token: Redacted.make(SAVINGS_TOKEN), accountNumber: undefined, currency: undefined });
        const [main] = (yield* store.load).map((record) => record.account);
        assert.strictEqual(main?.name, "main");
        const mainId = main?.id ?? "";
        yield* store.rotate(mainId, Redacted.make(OTHER_TOKEN));
        // Back to a token it had: still one entry for it.
        yield* store.rotate(mainId, Redacted.make(FIO_TOKEN));
        const history = yield* store.tokenHistory;
        assert.deepStrictEqual(history.get(mainId), [fp(FIO_TOKEN), fp(OTHER_TOKEN)]);
        assert.deepStrictEqual(history.get(savings), [fp(SAVINGS_TOKEN)]);
        assert.deepStrictEqual(yield* store.remove(mainId), [fp(FIO_TOKEN), fp(OTHER_TOKEN)]);
        assert.deepStrictEqual([...(yield* store.tokenHistory).keys()], [savings]);
      }),
    ),
  );

  it.effect("backfills every account's current token when migrating, and leaves the cache as it is", () =>
    Effect.gen(function* () {
      const path = tempDb();
      const before = Object.fromEntries(Object.entries(SERVER_MIGRATIONS).filter(([id]) => id < "0007"));
      const at0006 = databaseLayer(path, before).pipe(Layer.provide(NodeFileSystem.layer));
      yield* Effect.scoped(
        Effect.flatMap(Layer.build(at0006), (context) =>
          Effect.provideContext(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const row = (id: string, name: string, fingerprint: string, position: number) => ({
                account_id: id,
                name,
                name_key: name,
                token_sealed: "v1.sealed",
                token_fingerprint: fingerprint,
                account_number: null,
                currency: null,
                position,
                created_at: 1,
                updated_at: 2,
                token_updated_at: 3 + position,
              });
              yield* sql`INSERT INTO fio_accounts ${sql.insert([row("acct_a", "a", "fp-a", 1), row("acct_b", "b", "fp-b", 2)])}`;
              // fp-a-old: a's token before a rotation made before the history existed.
              yield* sql`INSERT INTO bindings ${sql.insert([
                { token_fingerprint: "fp-a", account_key: "k1", account_name: "a", verified_at: 1 },
                { token_fingerprint: "fp-a-old", account_key: "k1", account_name: "a", verified_at: 1 },
              ])}`;
            }),
            context,
          ),
        ),
      );
      yield* withSql(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* migrate(SERVER_MIGRATIONS), []);
          const [applied] = yield* sql<{ id: number }>`SELECT MAX(migration_id) AS id FROM fio_mcp_migrations`;
          assert.strictEqual(applied?.id, 7);
          assert.deepStrictEqual(
            yield* sql<{ account_id: string; token_fingerprint: string; created_at: number }>`
              SELECT account_id, token_fingerprint, created_at FROM fio_account_tokens ORDER BY account_id
            `,
            [
              { account_id: "acct_a", token_fingerprint: "fp-a", created_at: 4 },
              { account_id: "acct_b", token_fingerprint: "fp-b", created_at: 5 },
            ],
          );
          const [bindings] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM bindings`;
          assert.strictEqual(bindings?.n, 2);
        }),
      );
    }),
  );
});

describe("cache purge for a removed token", () => {
  const purgeFixture = <A, E>(body: (helpers: {
    readonly store: CacheStore;
    readonly bind: (fingerprint: string, accountKey: string) => Effect.Effect<unknown, SqlError.SqlError>;
    readonly count: (table: string) => Effect.Effect<number, SqlError.SqlError>;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>) =>
    withSql(
      tempDb(),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* makeCacheStore();
        const bind = (fingerprint: string, accountKey: string) =>
          Effect.andThen(
            sql`INSERT INTO bindings ${sql.insert({ token_fingerprint: fingerprint, account_key: accountKey, account_name: "x", verified_at: 1 })}`,
            sql`INSERT INTO sync_state ${sql.insert({ token_fingerprint: fingerprint, account_key: accountKey })}`,
          );
        const count = (table: string) =>
          Effect.map(sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`, ([row]) => row?.n ?? 0);
        yield* sql`INSERT INTO accounts ${sql.insert({ account_key: "k1", account_id: "1", bank_id: "2010", updated_at: 1 })}`;
        yield* sql`INSERT INTO transactions ${sql.insert({ account_key: "k1", movement_id: 1, date: "2026-01-01", raw_json: "{}", first_seen_at: 1, updated_at: 1 })}`;
        return yield* body({ store, bind, count });
      }),
    );

  it.effect("keeps the data while another configured token is bound to the same bank account", () =>
    purgeFixture(({ store, bind, count }) =>
      Effect.gen(function* () {
        yield* bind("fp-a", "k1");
        yield* bind("fp-b", "k1");
        assert.deepStrictEqual(yield* store.purgeTokens(["fp-a"], new Set(["fp-b"])), { deleted: 0, sharedWith: ["fp-b"], unattributed: 0 });
        // fp-b still reads k1: only fp-a's binding and sync state go.
        assert.strictEqual(yield* count("transactions"), 1);
        assert.strictEqual(yield* count("bindings"), 1);
        assert.strictEqual(yield* count("sync_state"), 1);
        assert.deepStrictEqual(yield* store.purgeTokens(["fp-b"], new Set()), { deleted: 1, sharedWith: [], unattributed: 0 });
        assert.strictEqual(yield* count("transactions"), 0);
        assert.strictEqual(yield* count("accounts"), 0);
        assert.strictEqual(yield* count("bindings"), 0);
        assert.strictEqual(yield* count("sync_state"), 0);
      }),
    ),
  );

  it.effect("keeps the data for a configured token and still drops the bindings of tokens no account uses", () =>
    purgeFixture(({ store, bind, count }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO coverage_days ${sql.insert({ account_key: "k1", day: "2026-01-01", fetched_at: 1 })}`;
        yield* bind("fp-old", "k1");
        yield* bind("fp-active", "k1");
        yield* bind("fp-removed", "k1");
        assert.deepStrictEqual(yield* store.purgeTokens(["fp-removed"], new Set(["fp-active"])), {
          deleted: 0,
          sharedWith: ["fp-active"],
          unattributed: 0,
        });
        assert.strictEqual(yield* count("transactions"), 1);
        assert.strictEqual(yield* count("coverage_days"), 1);
        assert.strictEqual(yield* count("accounts"), 1);
        assert.deepStrictEqual(
          yield* sql<{ fp: string }>`SELECT token_fingerprint AS fp FROM bindings UNION ALL SELECT token_fingerprint FROM sync_state`,
          [{ fp: "fp-active" }, { fp: "fp-active" }],
        );
        assert.strictEqual(Option.map(yield* store.binding("fp-active"), (binding) => binding.verifiedAt).pipe(Option.getOrUndefined), 1);
      }),
    ),
  );

  it.effect("deletes the data when only tokens no account uses are still bound, and their bindings", () =>
    purgeFixture(({ store, bind, count }) =>
      Effect.gen(function* () {
        // fp-old: the token before a rotation (or of an account removed earlier, keeping its data).
        yield* bind("fp-old", "k1");
        yield* bind("fp-new", "k1");
        yield* bind("fp-other", "k2");
        assert.deepStrictEqual(yield* store.purgeTokens(["fp-new"], new Set(["fp-other"])), { deleted: 1, sharedWith: [], unattributed: 0 });
        assert.strictEqual(yield* count("transactions"), 0);
        assert.strictEqual(yield* count("accounts"), 0);
        // Nothing left that could bind k1 again; fp-other's binding stays.
        assert.strictEqual(yield* count("bindings"), 1);
        assert.strictEqual(yield* count("sync_state"), 1);
        assert.isTrue(Option.isSome(yield* store.binding("fp-other")));
        // A token without a binding has nothing to delete.
        assert.deepStrictEqual(yield* store.purgeTokens(["fp-new"], new Set(["fp-other"])), { deleted: 0, sharedWith: [], unattributed: 0 });
      }),
    ),
  );

  it.effect("deletes what an earlier token cached when the current one cached nothing", () =>
    purgeFixture(({ store, bind, count }) =>
      Effect.gen(function* () {
        // fp-old: the account's token before a rotation; fp-new (current) never downloaded.
        yield* bind("fp-old", "k1");
        yield* bind("fp-other", "k2");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO sync_state ${sql.insert({ token_fingerprint: "fp-new" })}`;
        assert.deepStrictEqual(yield* store.purgeTokens(["fp-old", "fp-new"], new Set(["fp-other"])), {
          deleted: 1,
          sharedWith: [],
          unattributed: 0,
        });
        assert.strictEqual(yield* count("transactions"), 0);
        assert.strictEqual(yield* count("accounts"), 0);
        assert.deepStrictEqual(
          yield* sql<{ fp: string }>`SELECT token_fingerprint AS fp FROM bindings UNION ALL SELECT token_fingerprint FROM sync_state`,
          [{ fp: "fp-other" }, { fp: "fp-other" }],
        );
      }),
    ),
  );

  it.effect("keeps a bank account an earlier token of a configured account is bound to, and that token's binding", () =>
    purgeFixture(({ store, bind, count }) =>
      Effect.gen(function* () {
        // fp-mine: the removed account's; fp-theirs-old: a configured account's token before its rotation.
        yield* bind("fp-mine", "k1");
        yield* bind("fp-theirs-old", "k1");
        assert.deepStrictEqual(yield* store.purgeTokens(["fp-mine"], new Set(["fp-theirs", "fp-theirs-old"])), {
          deleted: 0,
          sharedWith: ["fp-theirs-old"],
          unattributed: 0,
        });
        assert.strictEqual(yield* count("transactions"), 1);
        assert.isTrue(Option.isNone(yield* store.binding("fp-mine")));
        assert.isTrue(Option.isSome(yield* store.binding("fp-theirs-old")));
      }),
    ),
  );

  it.effect("leaves and counts cached bank accounts no configured account's token is bound to", () =>
    purgeFixture(({ store, bind, count }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // k1: bound only to a token no account is known to have had (cached before token history, or kept at a removal).
        yield* bind("fp-unknown", "k1");
        yield* sql`INSERT INTO accounts ${sql.insert({ account_key: "k2", account_id: "2", bank_id: "2010", updated_at: 1 })}`;
        yield* bind("fp-mine", "k2");
        yield* sql`INSERT INTO accounts ${sql.insert({ account_key: "k3", account_id: "3", bank_id: "2010", updated_at: 1 })}`;
        yield* bind("fp-other", "k3");
        assert.deepStrictEqual(yield* store.purgeTokens(["fp-mine"], new Set(["fp-other"])), {
          deleted: 1,
          sharedWith: [],
          unattributed: 1,
        });
        assert.strictEqual(yield* count("transactions"), 1);
        assert.strictEqual(yield* count("accounts"), 2);
        assert.isTrue(Option.isSome(yield* store.binding("fp-unknown")));
      }),
    ),
  );

  it.effect("leaves a removed account's token that another account uses or used, with its binding, sync state and data", () =>
    purgeFixture(({ store, bind, count }) =>
      Effect.gen(function* () {
        // fp-both: the removed account's earlier token, which another account has now (or had).
        yield* bind("fp-both", "k1");
        yield* bind("fp-mine", "k1");
        assert.deepStrictEqual(yield* store.purgeTokens(["fp-both", "fp-mine"], new Set(["fp-both"])), {
          deleted: 0,
          sharedWith: ["fp-both"],
          unattributed: 0,
        });
        assert.strictEqual(yield* count("transactions"), 1);
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql<{ fp: string }>`SELECT token_fingerprint AS fp FROM bindings UNION ALL SELECT token_fingerprint FROM sync_state`,
          [{ fp: "fp-both" }, { fp: "fp-both" }],
        );
      }),
    ),
  );

  it.effect("deletes one bank account and keeps another a configured account's token is bound to", () =>
    purgeFixture(({ store, bind, count }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO accounts ${sql.insert({ account_key: "k2", account_id: "2", bank_id: "2010", updated_at: 1 })}`;
        yield* sql`INSERT INTO transactions ${sql.insert({ account_key: "k2", movement_id: 2, date: "2026-01-01", raw_json: "{}", first_seen_at: 1, updated_at: 1 })}`;
        // The removed account's tokens: fp-old for k1, fp-new (after its binding moved) for k2, which fp-other reads too.
        yield* bind("fp-old", "k1");
        yield* bind("fp-new", "k2");
        yield* bind("fp-other", "k2");
        assert.deepStrictEqual(yield* store.purgeTokens(["fp-old", "fp-new"], new Set(["fp-other"])), {
          deleted: 1,
          sharedWith: ["fp-other"],
          unattributed: 0,
        });
        assert.deepStrictEqual(yield* sql<{ key: string }>`SELECT DISTINCT account_key AS key FROM transactions`, [{ key: "k2" }]);
        assert.strictEqual(yield* count("bindings"), 1);
      }),
    ),
  );
});
