import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted, Result } from "effect";
import { SqlClient } from "effect/sql";
import { backupDatabase, CACHE_MIGRATIONS, migrate, SERVER_MIGRATIONS } from "../src/cache/db.js";
import {
  CacheKeyMismatch,
  CacheKeyMissing,
  type CacheSealing,
  CacheValueUnreadable,
  cacheAad,
  convertRows,
  openValue,
  PLAINTEXT,
  reconcileCacheEncryption,
  SEALED_TRANSACTION_COLUMNS,
  type SealedTransactionColumn,
  sealValue,
} from "../src/cache/encryption.js";
import { Transactions } from "../src/cache/service.js";
import { type GroupBy, makeCacheStore, type TransactionFilters } from "../src/cache/store.js";
import { CacheError, InvalidInput } from "../src/errors.js";
import type { Transaction } from "../src/statement.js";
import {
  account,
  cacheLayer,
  config,
  NOW,
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
          [5, "create_accounts"],
          [6, "grant_last_used"],
          [7, "account_token_history"],
          [11, "cache_sealed_rows"],
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

describe("a retired token", () => {
  it.effect("drops a write and a sync-state save built before the retirement and run after a purge, until reinstated", () =>
    Effect.gen(function* () {
      const store = yield* makeCacheStore();
      const sql = yield* SqlClient.SqlClient;
      const fp = "f".repeat(32);
      const late = { accountName: "main", tokenFingerprint: fp, statement: statement(TODAY, TODAY, [tx(1, TODAY, 5)]), fetchedAt: NOW };
      // Built before the retirement, run after it and the purge.
      const lateState = store.putSyncState(fp, yield* store.syncState(fp));
      yield* store.retire(fp);
      yield* store.purgeTokens([fp], new Set());
      assert.strictEqual((yield* store.commit(late)).rowsWritten, 0);
      yield* lateState;
      assert.isTrue(Option.isNone(yield* store.binding(fp)));
      const [rows] = yield* sql<{ n: number }>`SELECT (SELECT COUNT(*) FROM transactions) + (SELECT COUNT(*) FROM sync_state) AS n`;
      assert.strictEqual(rows?.n, 0);
      // Added again: accepted again.
      yield* store.reinstate(fp);
      assert.strictEqual((yield* store.commit(late)).rowsWritten, 1);
    }).pipe(withDb(":memory:")),
  );
});

const KEY = Redacted.make(new Uint8Array(32).fill(7));
const OTHER_KEY = Redacted.make(new Uint8Array(32).fill(9));
const ON: CacheSealing = { encrypt: true, dataKey: KEY };
const OFF_WITH_KEY: CacheSealing = { encrypt: false, dataKey: KEY };
const FP = "e".repeat(32);
const ACCOUNT_KEY = "2000000001/2010";
const RANGE = { from: "2026-10-01", to: "2026-10-20" };

/** Movements covering what the text filters and counterparty grouping look at: case, NULLs, LIKE metacharacters, non-ASCII, currencies. */
const MOVEMENTS = [
  tx(1, "2026-10-01", -1200, {
    counterpartyName: "Jan Novák",
    counterpartyAccount: "1234",
    counterpartyBankCode: "0100",
    counterpartyBankName: "Komerční banka",
    counterpartyBic: "KOMBCZPP",
    messageForRecipient: "Rent October",
    userIdentification: "Novák rent",
    comment: "flat",
    payerReference: "ref-1",
    executedBy: "Jan Novák",
    details: "rent for the flat",
  }),
  tx(2, "2026-10-02", 35000.5, { counterpartyName: "ACME s.r.o.", counterpartyAccount: "9999", counterpartyBankCode: "2010", comment: "salary 100%" }),
  tx(3, "2026-10-03", -99.99, { counterpartyAccount: "5555", counterpartyBankCode: "0300", userIdentification: "card_payment RENT" }),
  tx(4, "2026-10-04", -15.5, { counterpartyAccount: "7777", messageForRecipient: "coffee", currency: "EUR" }),
  tx(5, "2026-10-05", -1200, { counterpartyName: "jan novák", messageForRecipient: "rent november", payerReference: "ref-5" }),
  tx(6, "2026-10-06", 10, { messageForRecipient: "ŽLUŤOUČKÝ kůň", comment: "a_b" }),
  tx(7, "2026-10-07", -0.01, { counterpartyName: "ACME s.r.o.", counterpartyBic: "GIBACZPX", counterpartyBankName: "Česká spořitelna" }),
  tx(8, "2026-10-08", 0, { messageForRecipient: "" }),
];

type Store = Effect.Success<ReturnType<typeof makeCacheStore>>;

const commitMovements = (store: Store, movements: ReadonlyArray<Transaction> = MOVEMENTS, iban?: null) => {
  const stated = statement(RANGE.from, RANGE.to, movements);
  return store.commit({
    accountName: "main",
    tokenFingerprint: FP,
    statement: iban === null ? { ...stated, info: { ...stated.info, iban: null } } : stated,
    coverage: RANGE,
    fetchedAt: NOW,
  });
};

const SEARCHES: ReadonlyArray<TransactionFilters> = [
  {},
  { text: "rent" },
  { text: "RENT", direction: "out" },
  { text: "%" },
  { text: "_" },
  { text: "" },
  { text: "žluťoučký" },
  { text: "ŽLUŤOUČKÝ" },
  { counterparty: "novák" },
  { counterparty: "acme", dateFrom: "2026-10-03" },
  { counterparty: "1234/0100" },
  { counterparty: "55" },
  { counterparty: "acme", text: "salary" },
  { text: "rent", minAmount: 1000 },
];
const GROUPINGS: ReadonlyArray<[GroupBy, TransactionFilters]> = [
  ["counterparty", {}],
  ["counterparty", { direction: "out" }],
  ["counterparty", { text: "rent" }],
  ["month", { counterparty: "acme" }],
  ["type", { text: "o" }],
];

/** Every search (two pages each way) and summary (two pages) the comparison covers. */
const queryAll = Effect.fn(function* (store: Store) {
  const searches = [];
  for (const filters of SEARCHES) {
    for (const order of ["asc", "desc"] as const) {
      searches.push(yield* store.search(ACCOUNT_KEY, filters, { limit: 2, offset: 0, order }));
      searches.push(yield* store.search(ACCOUNT_KEY, filters, { limit: 2, offset: 2, order }));
    }
  }
  const summaries = [];
  for (const [groupBy, filters] of GROUPINGS) {
    summaries.push(yield* store.summarize(ACCOUNT_KEY, filters, groupBy, { limit: 2, offset: 0 }));
    summaries.push(yield* store.summarize(ACCOUNT_KEY, filters, groupBy, { limit: 2, offset: 2 }));
  }
  const range = yield* store.transactionsIn(ACCOUNT_KEY, RANGE);
  const account = yield* store.account(ACCOUNT_KEY);
  return { searches, summaries, range, account };
});

const unencrypted = (movements: ReadonlyArray<Transaction> = MOVEMENTS) =>
  Effect.gen(function* () {
    const store = yield* makeCacheStore();
    yield* commitMovements(store, movements);
    return yield* queryAll(store);
  }).pipe(withDb(":memory:"));

type RawRow = { readonly movement_id: number; readonly sealed: number } & Readonly<Record<SealedTransactionColumn, string | null>>;

const rawRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<RawRow>`
    SELECT movement_id, sealed, ${sql.literal(SEALED_TRANSACTION_COLUMNS.join(", "))} FROM transactions ORDER BY movement_id
  `;
});

const rawAccount = Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ iban: string | null; sealed: number }>`SELECT iban, sealed FROM accounts`);

/** Every protected value of the sealed rows is a sealed value; no plaintext of any movement shows in any of them. */
const assertSealed = (rows: ReadonlyArray<RawRow>) => {
  const plaintexts = MOVEMENTS.flatMap((movement) =>
    [movement.counterpartyName, movement.messageForRecipient, movement.userIdentification, movement.executedBy, movement.details].filter(
      (value): value is string => value !== null && value.length > 3,
    ),
  );
  for (const row of rows) {
    assert.strictEqual(row.sealed, 1);
    for (const column of SEALED_TRANSACTION_COLUMNS) {
      const value = row[column];
      if (value === null) continue;
      assert.match(value, /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]*\.[A-Za-z0-9+/=]+$/, `${column} of ${row.movement_id}`);
      for (const plaintext of plaintexts) assert.notInclude(value, plaintext);
    }
  }
};

const fromStartup = (sealing: CacheSealing) => Effect.andThen(reconcileCacheEncryption(sealing), makeCacheStore(sealing));

describe("cache encryption (FIO_CACHE_ENCRYPT)", () => {
  it.effect("stores ciphertext in every protected column, and search and summaries return what they return unencrypted", () =>
    Effect.gen(function* () {
      const expected = yield* unencrypted();
      assert.strictEqual(expected.searches[4]?.total, 3, "the text filter (searches[4]) matches something");
      const actual = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* makeCacheStore(ON);
        yield* commitMovements(store);
        const messages = yield* sql<{ message: string | null }>`SELECT message FROM transactions ORDER BY movement_id`;
        assert.deepStrictEqual(
          messages.map(({ message }) => message === null),
          MOVEMENTS.map((movement) => movement.messageForRecipient === null),
        );
        const rows = yield* rawRows;
        assert.lengthOf(rows, MOVEMENTS.length);
        assertSealed(rows);
        const [first] = rows;
        for (const column of SEALED_TRANSACTION_COLUMNS) assert.isNotNull(first?.[column] ?? null, column);
        const [account] = yield* rawAccount;
        assert.strictEqual(account?.sealed, 1);
        assert.notInclude(account?.iban ?? "", "2000000001");
        return yield* queryAll(store);
      }).pipe(withDb(":memory:"));
      assert.deepStrictEqual(actual, expected);
    }),
  );

  it.effect("the cache service reconciles at startup and seals what it writes when the configuration turns encryption on", () =>
    Effect.gen(function* () {
      yield* setNow();
      const fio = yield* fakeFio(serveFrom([]));
      const dbPath = join(tempDir(), "fio.sqlite");
      const throughService = (encrypt: boolean) =>
        Effect.gen(function* () {
          const cache = yield* Transactions;
          const main = yield* account();
          const rows = yield* rawRows;
          if (encrypt) assertSealed(rows);
          else assert.isTrue(rows.every((row) => row.sealed === 0));
          // Written through the service: movement 9 is new.
          yield* cache.record(main, statement(RANGE.from, RANGE.to, [...MOVEMENTS, tx(9, "2026-10-09", -5, { messageForRecipient: "rent fee" })]));
          const [nine] = (yield* rawRows).filter((row) => row.movement_id === 9);
          assert.strictEqual(nine?.sealed, encrypt ? 1 : 0);
          const query = { dateFrom: RANGE.from, dateTo: RANGE.to, limit: 2, offset: 1, order: "asc" } as const;
          return {
            search: yield* cache.search(main, { ...query, text: "rent" }),
            counterparty: (yield* cache.search(main, { ...query, counterparty: "acme" })).transactions,
            summary: (yield* cache.summarize(main, { ...query, groupBy: "counterparty" })).groups,
          };
        }).pipe(Effect.provide(cacheLayer(config({ cache: encrypt ? { dbPath, encrypt, dataKey: KEY } : { dbPath } }), fio.layer)));
      // The first run writes plaintext; the second starts with encryption on and seals it first.
      yield* Effect.gen(function* () {
        yield* (yield* Transactions).record(yield* account(), statement(RANGE.from, RANGE.to, MOVEMENTS));
      }).pipe(Effect.provide(cacheLayer(config({ cache: { dbPath } }), fio.layer)));
      const plain = yield* throughService(false);
      assert.strictEqual(plain.search.total, 4);
      assert.deepStrictEqual(yield* throughService(true), plain);
    }),
  );

  it.effect("a sealed value copied to another row, or read with another key, does not decrypt", () =>
    Effect.gen(function* () {
      const sealed = yield* sealValue(KEY, "transactions", "message", ACCOUNT_KEY, 1, "Rent October");
      const opened = (key: typeof KEY, table: "transactions" | "accounts", column: string, accountKey: string, id: number | undefined) =>
        openValue(key, table, column, accountKey, id, sealed);
      assert.deepStrictEqual(opened(KEY, "transactions", "message", ACCOUNT_KEY, 1), Result.succeed("Rent October"));
      for (const result of [
        opened(KEY, "transactions", "message", ACCOUNT_KEY, 2),
        opened(KEY, "transactions", "message", "2000000002/2010", 1),
        opened(KEY, "transactions", "comment", ACCOUNT_KEY, 1),
        opened(KEY, "accounts", "message", ACCOUNT_KEY, undefined),
        opened(OTHER_KEY, "transactions", "message", ACCOUNT_KEY, 1),
      ]) {
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.instanceOf(result.failure, CacheValueUnreadable);
      }
      assert.strictEqual(cacheAad("accounts", "iban", ACCOUNT_KEY, undefined), `fio-mcp:cache:v1:accounts:iban:${ACCOUNT_KEY}:-`);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* makeCacheStore(ON);
        yield* commitMovements(store);
        // With another key nothing sealed reads, and startup refuses it.
        const other = yield* makeCacheStore({ encrypt: true, dataKey: OTHER_KEY });
        assert.instanceOf(yield* Effect.flip(other.transactionsIn(ACCOUNT_KEY, RANGE)), CacheError);
        assert.instanceOf(yield* Effect.flip(other.account(ACCOUNT_KEY)), CacheError);
        assert.instanceOf(yield* Effect.flip(reconcileCacheEncryption({ encrypt: true, dataKey: OTHER_KEY })), CacheKeyMismatch);
        // Movement 1's message copied onto movement 5: the row no longer reads, and the text search and summary fail rather than skip it.
        yield* sql`UPDATE transactions SET message = (SELECT message FROM transactions WHERE movement_id = 1) WHERE movement_id = 5`;
        assert.instanceOf(yield* Effect.flip(store.transactionsIn(ACCOUNT_KEY, RANGE)), CacheError);
        assert.instanceOf(yield* Effect.flip(store.search(ACCOUNT_KEY, { text: "rent" }, { limit: 10, offset: 0, order: "asc" })), CacheError);
        assert.instanceOf(yield* Effect.flip(store.summarize(ACCOUNT_KEY, {}, "counterparty", { limit: 10, offset: 0 })), CacheError);
        const unreadable = yield* Effect.flip(reconcileCacheEncryption(OFF_WITH_KEY));
        assert.instanceOf(unreadable, CacheValueUnreadable);
        assert.include(unreadable.message, "movement 5");
        // Movement 1 alone still reads.
        const first = yield* store.transactionsIn(ACCOUNT_KEY, { from: RANGE.from, to: RANGE.from });
        assert.strictEqual(first[0]?.messageForRecipient, "Rent October");
      }).pipe(withDb(":memory:"));
    }),
  );

  it.effect("a table with plaintext and sealed rows reads like an unencrypted one, with encryption on or off", () =>
    Effect.gen(function* () {
      const expected = yield* unencrypted();
      const mixed = <A, E>(read: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        Effect.gen(function* () {
          // Movements 1-4 written before encryption was turned on, 5-8 after.
          yield* commitMovements(yield* makeCacheStore(), MOVEMENTS.slice(0, 4));
          yield* commitMovements(yield* makeCacheStore(ON), MOVEMENTS.slice(4));
          assert.deepStrictEqual(
            (yield* rawRows).map((row) => row.sealed),
            [0, 0, 0, 0, 1, 1, 1, 1],
          );
          return yield* read;
        }).pipe(withDb(":memory:"));
      assert.deepStrictEqual(yield* mixed(Effect.flatMap(makeCacheStore(ON), queryAll)), expected);
      // Off (another process sealed rows, or before the startup reconcile): with the key the sealed rows read too...
      assert.deepStrictEqual(yield* mixed(Effect.flatMap(makeCacheStore(OFF_WITH_KEY), queryAll)), expected);
      // ...and without it the reads that reach them fail instead of matching or grouping ciphertext.
      yield* mixed(
        Effect.gen(function* () {
          const store = yield* makeCacheStore();
          const fails = <A, E>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => assert.instanceOf(error, CacheError));
          yield* fails(store.search(ACCOUNT_KEY, { text: "rent" }, { limit: 10, offset: 0, order: "asc" }));
          yield* fails(store.summarize(ACCOUNT_KEY, {}, "counterparty", { limit: 10, offset: 0 }));
          yield* fails(store.transactionsIn(ACCOUNT_KEY, RANGE));
          // Movements 1-4 alone still read.
          assert.lengthOf(yield* store.transactionsIn(ACCOUNT_KEY, { from: RANGE.from, to: "2026-10-04" }), 4);
        }),
      );
    }),
  );

  it.effect("an account header keeps its sealed IBAN, or its plaintext one, when a later response has none", () =>
    Effect.gen(function* () {
      const iban = "CZ002000000001";
      // Plaintext IBAN, then a sealing store's response without one: the plaintext stays and is marked plaintext.
      yield* Effect.gen(function* () {
        yield* commitMovements(yield* makeCacheStore());
        const store = yield* makeCacheStore(ON);
        yield* commitMovements(store, MOVEMENTS, null);
        assert.deepStrictEqual(yield* rawAccount, [{ iban, sealed: 0 }]);
        assert.strictEqual(Option.getOrUndefined(yield* store.account(ACCOUNT_KEY))?.iban, iban);
        // With an IBAN it is sealed; a plaintext store's response without one keeps it sealed.
        yield* commitMovements(store);
        yield* commitMovements(yield* makeCacheStore(OFF_WITH_KEY), MOVEMENTS, null);
        const [stored] = yield* rawAccount;
        assert.strictEqual(stored?.sealed, 1);
        assert.notStrictEqual(stored?.iban, iban);
        assert.strictEqual(Option.getOrUndefined(yield* (yield* makeCacheStore(OFF_WITH_KEY)).account(ACCOUNT_KEY))?.iban, iban);
      }).pipe(withDb(":memory:"));
    }),
  );

  it.effect("turning encryption on seals existing rows at startup once; turning it off opens them, and needs the key", () =>
    Effect.gen(function* () {
      const expected = yield* unencrypted();
      const path = join(tempDir(), "fio.sqlite");
      const onDisk = Effect.provide(testDatabase(path, CACHE_MIGRATIONS));
      yield* Effect.flatMap(makeCacheStore(), commitMovements).pipe(onDisk);

      const sealedOnce = yield* Effect.gen(function* () {
        const store = yield* fromStartup(ON);
        const rows = yield* rawRows;
        assertSealed(rows);
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM cache_plaintext_remnants`, [{ n: 0 }]);
        assert.deepStrictEqual(yield* queryAll(store), expected);
        return rows;
      }).pipe(onDisk);
      // VACUUM and the truncated log leave no plaintext in the file.
      const file = readFileSync(path);
      for (const plaintext of ["Rent October", "card_payment", "ACME s.r.o.", "rent for the flat"]) {
        assert.strictEqual(file.indexOf(Buffer.from(plaintext, "utf8")), -1, plaintext);
      }
      // A second startup has nothing left to seal: every value stays as it was (sealing again would change each nonce).
      assert.deepStrictEqual(yield* Effect.andThen(fromStartup(ON), rawRows).pipe(onDisk), sealedOnce);

      // Off without the key, or with another key: startup fails and nothing changes.
      yield* Effect.gen(function* () {
        assert.instanceOf(yield* Effect.flip(reconcileCacheEncryption(PLAINTEXT)), CacheKeyMissing);
        assert.instanceOf(yield* Effect.flip(reconcileCacheEncryption({ encrypt: false, dataKey: OTHER_KEY })), CacheKeyMismatch);
        assert.deepStrictEqual(yield* rawRows, sealedOnce);
      }).pipe(onDisk);

      // Off with the key: every row is opened again.
      const reopened = yield* Effect.gen(function* () {
        const store = yield* fromStartup(OFF_WITH_KEY);
        const rows = yield* rawRows;
        assert.isTrue(rows.every((row) => row.sealed === 0));
        assert.strictEqual(rows[0]?.executed_by, "Jan Novák");
        assert.deepStrictEqual(yield* rawAccount, [{ iban: "CZ002000000001", sealed: 0 }]);
        return yield* queryAll(store);
      }).pipe(onDisk);
      assert.deepStrictEqual(reopened, expected);
    }),
  );

  it.effect("a cleanup after sealing that does not complete is repeated by the next startup", () =>
    Effect.gen(function* () {
      const path = join(tempDir(), "fio.sqlite");
      const onDisk = Effect.provide(testDatabase(path, CACHE_MIGRATIONS));
      const holdsPlaintext = () =>
        [path, `${path}-wal`].some((file) => existsSync(file) && readFileSync(file).indexOf(Buffer.from("Rent October", "utf8")) !== -1);
      const pendingCleanup = Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ n: number }>`SELECT COUNT(*) AS n FROM cache_plaintext_remnants`);
      yield* Effect.flatMap(makeCacheStore(), commitMovements).pipe(onDisk);
      assert.isTrue(holdsPlaintext());
      // Sealing commits, then the process stops before the cleanup.
      yield* convertRows(KEY, true).pipe(onDisk);
      yield* Effect.gen(function* () {
        assertSealed(yield* rawRows);
        assert.deepStrictEqual(yield* pendingCleanup, [{ n: 1 }]);
      }).pipe(onDisk);
      assert.isTrue(holdsPlaintext(), "the interrupted cleanup left plaintext behind");
      // Nothing left to seal, but the next startup finishes the cleanup.
      yield* Effect.gen(function* () {
        yield* reconcileCacheEncryption(ON);
        assert.deepStrictEqual(yield* pendingCleanup, [{ n: 0 }]);
      }).pipe(onDisk);
      assert.isFalse(holdsPlaintext());
    }),
  );

  it.effect("the startup conversion crosses batch boundaries, and is all or nothing", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 1234 }, (_, index) =>
        tx(index + 1, "2026-10-10", -index, { messageForRecipient: `payment ${index + 1}`, counterpartyName: `shop ${index % 7}` }),
      );
      yield* Effect.gen(function* () {
        yield* commitMovements(yield* makeCacheStore(), many);
        yield* reconcileCacheEncryption(ON);
        const sealed = yield* rawRows;
        assert.lengthOf(sealed, many.length);
        assert.isTrue(sealed.every((row) => row.sealed === 1 && row.message?.startsWith("v1.") === true));
        const store = yield* makeCacheStore(ON);
        const found = yield* store.search(ACCOUNT_KEY, { text: "payment 1234" }, { limit: 5, offset: 0, order: "asc" });
        assert.deepStrictEqual(
          found.transactions.map((movement) => movement.id),
          [1234],
        );
        // One row that does not decrypt (the last batch's) stops opening them all, and no row changes.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE transactions SET message = (SELECT message FROM transactions WHERE movement_id = 1) WHERE movement_id = 1234`;
        assert.instanceOf(yield* Effect.flip(reconcileCacheEncryption(OFF_WITH_KEY)), CacheValueUnreadable);
        assert.deepStrictEqual(yield* rawRows, sealed.map((row) => (row.movement_id === 1234 ? { ...row, message: sealed[0]?.message ?? null } : row)));
        yield* sql`DELETE FROM transactions WHERE movement_id = 1234`;
        yield* reconcileCacheEncryption(OFF_WITH_KEY);
        const opened = yield* rawRows;
        assert.lengthOf(opened, many.length - 1);
        assert.isTrue(opened.every((row) => row.sealed === 0 && row.message === `payment ${row.movement_id}`));
      }).pipe(withDb(":memory:"));
    }),
  );
});
