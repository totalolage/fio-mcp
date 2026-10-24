import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { backupDatabase, CACHE_MIGRATIONS, databaseLayer, migrate, SERVER_MIGRATIONS } from "../src/cache/db.js";
import { NOT_VERIFIED } from "../src/cache/service.js";
import { makeCacheStore } from "../src/cache/store.js";
import { CacheError, InvalidInput } from "../src/errors.js";
import {
  account,
  cacheLayer,
  config,
  enabledCache,
  fakeFio,
  NOW,
  serveFrom,
  setNow,
  statement,
  TODAY,
  TOKEN_B,
  tx,
} from "./support/cache.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "fio-cache-"));
const mode = (path: string) => statSync(path).mode & 0o777;

const withDb = (filename: string) => Effect.provide(databaseLayer(filename).pipe(Layer.provide(NodeFileSystem.layer)));

const tables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
  return rows.map((r) => r.name);
});

describe("cache database", () => {
  it.effect("migrates a fresh database and re-running is a no-op", () =>
    Effect.gen(function* () {
      const names = yield* tables;
      for (const table of ["accounts", "bindings", "coverage_days", "sync_state", "transactions"]) {
        assert.include(names, table);
      }
      assert.deepStrictEqual(yield* migrate(), []);
      const sql = yield* SqlClient.SqlClient;
      const [applied] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM fio_mcp_migrations`;
      assert.strictEqual(applied?.n, Object.keys(CACHE_MIGRATIONS).length);
      const [tempStore] = yield* sql<{ temp_store: number }>`PRAGMA temp_store`;
      assert.strictEqual(tempStore?.temp_store, 2);
    }).pipe(withDb(":memory:")),
  );

  it.effect("migrating legacy pending ranges makes every range upsert-only", () =>
    Effect.gen(function* () {
      const beforeMigration = Object.fromEntries(Object.entries(SERVER_MIGRATIONS).filter(([id]) => id < "0003"));
      const oldDatabase = () => databaseLayer(":memory:", beforeMigration).pipe(Layer.provide(NodeFileSystem.layer));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const october = { from: "2026-10-16", to: "2026-10-20" };
        const earlier = { from: "2026-10-01", to: "2026-10-15" };
        const states = [
          ["refresh-fp", "refresh", [october, earlier]],
          ["backfill-fp", "backfill", [october, earlier]],
          ["incremental-fp", "incremental", [october]],
          ["idle-fp", null, []],
        ] as const;
        for (const [fp, mode, pending] of states) {
          yield* sql`INSERT INTO sync_state ${sql.insert({ token_fingerprint: fp, mode, pending_json: JSON.stringify(pending) })}`;
        }
        assert.deepStrictEqual(yield* migrate(SERVER_MIGRATIONS), [
          [3, "pending_range_replace"],
          [4, "grant_account_fingerprints"],
        ]);
        const store = yield* makeCacheStore();
        const pending = (fp: string) => Effect.map(store.syncState(fp), (state) => state.pending);
        assert.deepStrictEqual(yield* pending("refresh-fp"), [
          { ...october, replace: false },
          { ...earlier, replace: false },
        ]);
        assert.deepStrictEqual(yield* pending("backfill-fp"), [
          { ...october, replace: false },
          { ...earlier, replace: false },
        ]);
        assert.deepStrictEqual(yield* pending("incremental-fp"), [{ ...october, replace: false }]);
        assert.deepStrictEqual(yield* pending("idle-fp"), []);
      }).pipe(Effect.provide(oldDatabase()));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO sync_state (token_fingerprint, mode, pending_json) VALUES ('malformed-fp', 'refresh', '{')`;
        assert.instanceOf(yield* Effect.flip(migrate(SERVER_MIGRATIONS)), CacheError);
      }).pipe(Effect.provide(oldDatabase()));
    }),
  );

  it.effect("creates the directory 0700 and the file 0600, in WAL mode, and reopens it", () =>
    Effect.gen(function* () {
      const path = join(tempDir(), "nested", "fio.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [journal] = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`;
        assert.strictEqual(journal?.journal_mode, "wal");
        yield* sql`INSERT INTO accounts (account_key, account_id, bank_id, updated_at) VALUES ('k', '1', '2010', 0)`;
        assert.strictEqual(mode(path), 0o600);
        assert.strictEqual(mode(join(path, "..")), 0o700);
        assert.strictEqual(mode(`${path}-wal`), 0o600);
      }).pipe(withDb(path));
      // Reopening keeps the data and does not re-run migrations.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ account_key: string }>`SELECT account_key FROM accounts`;
        assert.deepStrictEqual(
          rows.map((r) => r.account_key),
          ["k"],
        );
      }).pipe(withDb(path));
    }),
  );

  it.effect("backup writes a readable 0600 copy and refuses an existing destination", () =>
    Effect.gen(function* () {
      yield* setNow();
      const dir = tempDir();
      const path = join(dir, "fio.sqlite");
      const destination = join(dir, "backup.sqlite");
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        yield* cache.writeThrough(acc, statement("2026-10-01", TODAY, [tx(1, "2026-10-02", -5), tx(2, TODAY, 9)]), {
          from: "2026-10-01",
          to: TODAY,
        });
        const result = yield* backupDatabase(destination);
        assert.strictEqual(result.destination, destination);
        assert.isAbove(result.bytes, 0);
        const again = yield* Effect.flip(backupDatabase(destination));
        assert.instanceOf(again, InvalidInput);
      }).pipe(Effect.provide(Layer.merge(cacheLayer(config({ cache: { dbPath: path } }), fio.api), NodeFileSystem.layer)));
      assert.strictEqual(mode(destination), 0o600);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ movement_id: number }>`SELECT movement_id FROM transactions ORDER BY movement_id`;
        assert.deepStrictEqual(
          rows.map((r) => r.movement_id),
          [1, 2],
        );
      }).pipe(withDb(destination));
    }),
  );

  it.effect("backup refuses a destination that exists even when empty", () =>
    Effect.gen(function* () {
      const destination = join(tempDir(), "taken.sqlite");
      writeFileSync(destination, "");
      const error = yield* Effect.flip(backupDatabase(destination));
      assert.instanceOf(error, InvalidInput);
    }).pipe(withDb(":memory:"), Effect.provide(NodeFileSystem.layer)),
  );
});

describe("cache store", () => {
  it.effect("upserts by movement id: a refetch overwrites and never duplicates", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        const range = { from: "2026-10-20", to: TODAY };
        yield* cache.writeThrough(acc, statement(range.from, range.to, [tx(1, "2026-10-20", -10), tx(2, "2026-10-21", 20)]), range);
        yield* cache.writeThrough(
          acc,
          statement(range.from, range.to, [
            tx(1, "2026-10-20", -10, { comment: "edited" }),
            tx(2, "2026-10-21", 20),
            tx(3, TODAY, 30),
          ]),
          range,
        );
        const key = yield* cache.boundAccount(acc);
        const rows = yield* cache.store.transactionsIn(key, range);
        assert.deepStrictEqual(
          rows.map((r) => [r.id, r.comment]),
          [
            [1, "edited"],
            [2, null],
            [3, null],
          ],
        );
        assert.strictEqual((yield* cache.store.stats(key)).rowCount, 3);
        // Movements from a statement or /last are stored without coverage.
        yield* cache.record(acc, statement("2025-01-01", "2025-01-31", [tx(9, "2025-01-15", 1)]));
        assert.strictEqual((yield* cache.store.stats(key)).rowCount, 4);
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [range]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("records coverage only for the period FIO's header reports", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        yield* cache.writeThrough(acc, statement("2026-10-15", "2026-10-20", []), { from: "2026-10-10", to: TODAY });
        const key = yield* cache.boundAccount(acc);
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [{ from: "2026-10-15", to: "2026-10-20" }]);
        // Days after today are never recorded.
        yield* cache.writeThrough(acc, statement("2026-10-21", "2026-12-31", []), { from: "2026-10-21", to: "2026-12-31" });
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [{ from: "2026-10-15", to: TODAY }]);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("binds data to the token: a new token, or a name re-pointed to another account, sees no stale rows", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      const path = join(tempDir(), "fio.sqlite");
      const range = { from: "2026-10-20", to: TODAY };
      // Token A fetches account 2000000001.
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        yield* cache.writeThrough(acc, statement(range.from, range.to, [tx(1, "2026-10-21", -10)]), range);
        assert.strictEqual(yield* cache.boundAccount(acc), "2000000001/2010");
      }).pipe(Effect.provide(cacheLayer(config({ cache: { dbPath: path } }), fio.api)));

      // "main" now uses token B, which belongs to account 3000000002.
      const repointed = config({
        cache: { dbPath: path },
        accounts: [{ name: "main", token: Redacted.make(TOKEN_B), accountNumber: undefined, currency: undefined }],
      });
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        const unverified = yield* Effect.flip(cache.read(acc, range));
        assert.instanceOf(unverified, InvalidInput);
        assert.strictEqual(unverified.message, NOT_VERIFIED);
        yield* cache.writeThrough(acc, statement(range.from, range.to, [tx(7, TODAY, 70)], "3000000002"), range);
        const read = yield* cache.read(acc, range);
        assert.deepStrictEqual(
          read.transactions.map((t) => t.id),
          [7],
        );
        assert.strictEqual(read.info.accountId, "3000000002");
      }).pipe(Effect.provide(cacheLayer(repointed, fio.api)));
    }),
  );

  it.effect("rejects a statement without account identity and stores nothing", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        const anonymous = statement("2026-10-20", TODAY, [tx(1, TODAY, 1)]);
        const result = yield* Effect.flip(
          cache.store.commit({
            accountName: acc.name,
            tokenFingerprint: acc.tokenFingerprint,
            statement: { ...anonymous, info: { ...anonymous.info, accountId: null } },
            coverage: { from: "2026-10-20", to: TODAY },
            fetchedAt: 0,
          }),
        );
        assert.strictEqual(result._tag, "FioResponseError");
        assert.instanceOf(yield* Effect.flip(cache.boundAccount(acc)), InvalidInput);
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );

  it.effect("a response with a movement lacking an ID or date stores nothing and covers no day", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      yield* Effect.gen(function* () {
        const cache = yield* enabledCache;
        const acc = yield* account();
        const earlier = { from: "2026-10-20", to: "2026-10-20" };
        yield* cache.writeThrough(acc, statement(earlier.from, earlier.to, [tx(1, "2026-10-20", -10)]), earlier);
        const key = yield* cache.boundAccount(acc);
        const range = { from: "2026-10-20", to: TODAY };
        for (const broken of [tx(3, TODAY, 5, { id: null }), tx(4, TODAY, 5, { date: null })]) {
          const result = yield* Effect.flip(
            cache.store.commit({
              accountName: acc.name,
              tokenFingerprint: acc.tokenFingerprint,
              statement: statement(range.from, range.to, [tx(1, "2026-10-20", -999), tx(2, "2026-10-21", 20), broken]),
              coverage: range,
              fetchedAt: NOW,
            }),
          );
          assert.strictEqual(result._tag, "FioResponseError");
        }
        assert.deepStrictEqual(yield* cache.store.coveredRanges(key), [earlier]);
        const read = yield* cache.read(acc, range);
        assert.deepStrictEqual(
          read.transactions.map((t) => [t.id, t.amount]),
          [[1, -10]],
        );
        assert.isFalse(read.freshness.complete);
        assert.isFalse(yield* cache.servable(key, range));
      }).pipe(Effect.provide(cacheLayer(config(), fio.api)));
    }),
  );
});
