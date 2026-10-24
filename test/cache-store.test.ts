import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, } from "effect";
import { SqlClient } from "effect/sql";
import { backupDatabase, CACHE_MIGRATIONS, migrate, SERVER_MIGRATIONS } from "../src/cache/db.js";
import { makeCacheStore } from "../src/cache/store.js";
import { CacheError, InvalidInput } from "../src/errors.js";
import {
  account,
  cacheLayer,
  config,
  seedRange,
  serveFrom,
  setNow,
  statement,
  TODAY,
  tx,
} from "./support/cache.js";
import { memoryDatabase, testDatabase } from "./support/database.js";
import { fakeFio } from "./support/fio-api.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "fio-cache-"));
const mode = (path: string) => statSync(path).mode & 0o777;

const withDb = (filename: string) => Effect.provide(testDatabase(filename));

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
      const oldDatabase = () => memoryDatabase(beforeMigration);

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
        const covered = { from: "2026-10-01", to: TODAY };
        yield* seedRange(yield* account(), statement(covered.from, covered.to, [tx(1, "2026-10-02", -5), tx(2, TODAY, 9)]), covered);
        const result = yield* backupDatabase(destination);
        assert.strictEqual(result.destination, destination);
        assert.isAbove(result.bytes, 0);
        const again = yield* Effect.flip(backupDatabase(destination));
        assert.instanceOf(again, InvalidInput);
      }).pipe(Effect.provide(Layer.merge(cacheLayer(config({ cache: { dbPath: path } }), fio.layer), NodeFileSystem.layer)));
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
