import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import type { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { DomainStoreError } from "../../../src/domain/errors.js";
import type { Filing, FilingPreview } from "../../../src/domain/send/api.js";
import {
  type FilingStore,
  type FilingWrite,
  makeFilingStore,
  type NewFiling,
  type NewFilingFields,
  type NewNonce,
} from "../../../src/domain/send/store.js";
import { patchRawFiling, rawFiling, rawFilings, rawNonces, sendDatabase } from "./support/database.js";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

const preview: FilingPreview = {
  senderBox: { id: "box_1", dbId: "sndr123", label: "Office" },
  recipient: "rcpt123",
  annotation: "Invoice 42",
  envelope: { senderRefNumber: "ref-1", personalDelivery: true, legalTitleLaw: 500 },
  attachments: [{ filename: "a.pdf", mimeType: "application/pdf", metaType: "main", size: 3, sha256: "ab12" }],
  totalBytes: 3,
  contentHash: "hash-1",
};

const fields = (id: string, overrides: Partial<NewFilingFields> = {}): NewFilingFields => ({
  id,
  grantKey: "grant_1",
  boxId: "box_1",
  idempotencyKey: `key-${id}`,
  contentHash: "hash-1",
  tier: "full",
  recipientDbId: "rcpt123",
  preview,
  ...overrides,
});

const nonce = (hash: string, expiresAt = T0 + 10 * MINUTE): NewNonce => ({
  nonceHash: hash,
  nonceSealed: `sealed-${hash}`,
  expiresAt,
});

const awaiting = (id: string, overrides: Partial<NewFilingFields> = {}, nonceHash = `n-${id}`): NewFiling => ({
  ...fields(id, { tier: "approve", ...overrides }),
  state: "awaiting_approval",
  payloadSealed: `payload-${id}`,
  expiresAt: T0 + 10 * MINUTE,
  nonce: nonce(nonceHash),
});

const pending = (id: string, overrides: Partial<NewFilingFields> = {}): NewFiling => ({
  ...fields(id, { tier: "none", ...overrides }),
  state: "pending_admin",
  payloadSealed: `payload-${id}`,
  expiresAt: T0 + 60 * MINUTE,
});

const dispatching = (id: string, submittedAt = T0, overrides: Partial<NewFilingFields> = {}): NewFiling => ({
  ...fields(id, overrides),
  state: "dispatching",
  submittedAt,
});

const refused = (id: string): NewFiling => ({ ...fields(id, { tier: "none" }), state: "refused", reason: "no" });

/** Runs a test body against a fresh store, with the clock at T0. */
const withStore = <A, E>(body: (store: FilingStore) => Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const store = yield* makeFilingStore;
    return yield* body(store);
  }).pipe(Effect.provide(sendDatabase()));

const expectTag = <T extends FilingWrite["_tag"]>(write: FilingWrite, tag: T): Extract<FilingWrite, { _tag: T }> => {
  assert.strictEqual(write._tag, tag);
  return write as Extract<FilingWrite, { _tag: T }>;
};

const inserted = (store: FilingStore, filing: NewFiling) =>
  Effect.map(store.insert(filing), (write) => expectTag(write, "Inserted").filing);

const rawRow = (id: string) => Effect.map(rawFiling(id), (row) => Option.getOrThrow(row));

describe("FilingStore rows", () => {
  it.effect("decode every column into a Filing, JSON parsed and NULLs as undefined", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const fresh = yield* inserted(store, dispatching("f1"));
        const expected: Filing = {
          id: "f1",
          grantKey: "grant_1",
          boxId: "box_1",
          idempotencyKey: "key-f1",
          contentHash: "hash-1",
          tier: "full",
          state: "dispatching",
          recipientDbId: "rcpt123",
          preview,
          dmId: undefined,
          isdsStatus: undefined,
          reason: undefined,
          reconcile: undefined,
          submittedAt: T0,
          reconciledAt: undefined,
          createdAt: T0,
          updatedAt: T0,
          expiresAt: undefined,
        };
        assert.deepStrictEqual(fresh, expected);
        assert.deepStrictEqual(yield* store.byId("f1"), Option.some(expected));

        yield* TestClock.adjust(MINUTE);
        const status = { code: "1216", message: "Recipient cannot receive", classification: "NotDelivered" } as const;
        const write = yield* store.transition("f1", ["dispatching"], "isds_rejected", {
          dmId: "123456",
          isdsStatus: status,
          reason: "rejected by ISDS",
          reconcile: { at: T0, result: "found", dmIDs: ["123456"] },
          reconciledAt: T0 + 1,
          expiresAt: T0 + 2,
        });
        const updated = expectTag(write, "Won").filing;
        assert.deepStrictEqual(updated, {
          ...expected,
          state: "isds_rejected",
          dmId: "123456",
          isdsStatus: status,
          reason: "rejected by ISDS",
          reconcile: { at: T0, result: "found", dmIDs: ["123456"] },
          reconciledAt: T0 + 1,
          expiresAt: T0 + 2,
          updatedAt: T0 + MINUTE,
        });
        assert.deepStrictEqual(yield* store.byId("f1"), Option.some(updated));

        const row = yield* rawRow("f1");
        assert.deepStrictEqual(JSON.parse(String(row.preview_json)), preview);
        assert.deepStrictEqual(JSON.parse(String(row.isds_status_json)), status);
      }),
    ),
  );

  it.effect("never put the payload or nonces on a Filing", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const filing = yield* inserted(store, awaiting("f1"));
        for (const key of ["payloadSealed", "payload_sealed", "payload", "nonce", "nonceSealed"]) {
          assert.notProperty(filing, key);
        }
      }),
    ),
  );

  it.effect("fail with DomainStoreError when a stored row does not decode", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, dispatching("f1"));
        yield* inserted(store, dispatching("f2"));
        yield* patchRawFiling("f1", { preview_json: "not json" });
        yield* patchRawFiling("f2", { isds_status_json: JSON.stringify({ code: "1", message: "m" }) });
        const reads: ReadonlyArray<Effect.Effect<unknown, DomainStoreError>> = [store.byId("f1"), store.byId("f2"), store.list()];
        for (const read of reads) {
          const exit = yield* Effect.exit(read);
          assert.isTrue(Exit.isFailure(exit));
          assert.instanceOf(Exit.findErrorOption(exit).pipe(Option.getOrUndefined), DomainStoreError);
        }
      }),
    ),
  );
});

describe("FilingStore reads", () => {
  it.effect("find a filing by id and by grant, box and idempotency key", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const filing = yield* inserted(store, refused("f1"));
        assert.deepStrictEqual(yield* store.byKey("grant_1", "box_1", "key-f1"), Option.some(filing));
        assert.isTrue(Option.isNone(yield* store.byKey("grant_2", "box_1", "key-f1")));
        assert.isTrue(Option.isNone(yield* store.byKey("grant_1", "box_2", "key-f1")));
        assert.isTrue(Option.isNone(yield* store.byId("nope")));
      }),
    ),
  );

  it.effect("list newest updated first, filtered by state and limited", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, refused("a"));
        yield* TestClock.adjust(1);
        yield* inserted(store, pending("b"));
        yield* TestClock.adjust(1);
        yield* inserted(store, dispatching("c"));
        yield* TestClock.adjust(1);
        yield* store.transition("a", ["refused"], "refused", { reason: "again" });

        const ids = (filings: ReadonlyArray<Filing>) => filings.map((filing) => filing.id);
        assert.deepStrictEqual(ids(yield* store.list()), ["a", "c", "b"]);
        assert.deepStrictEqual(ids(yield* store.list({ limit: 2 })), ["a", "c"]);
        assert.deepStrictEqual(ids(yield* store.list({ states: ["pending_admin", "dispatching"] })), ["c", "b"]);
        assert.deepStrictEqual(ids(yield* store.list({ states: [] })), []);
        assert.deepStrictEqual(ids(yield* store.list({ limit: 0 })), ["a"]);
        assert.deepStrictEqual(ids(yield* store.list({ limit: 10_000 })), ["a", "c", "b"]);
      }),
    ),
  );

  it.effect("list at most 100 filings by default and 500 at most", () =>
    withStore((store) =>
      Effect.gen(function* () {
        for (let index = 0; index < 501; index++) {
          yield* inserted(store, refused(`f${String(index).padStart(3, "0")}`));
        }
        assert.strictEqual((yield* store.list()).length, 100);
        assert.strictEqual((yield* store.list({ limit: 501 })).length, 500);
      }),
    ),
  );

  it.effect("read the sealed payload until it is cleared", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, pending("f1"));
        yield* inserted(store, refused("f2"));
        assert.deepStrictEqual(yield* store.payload("f1"), Option.some("payload-f1"));
        assert.isTrue(Option.isNone(yield* store.payload("f2")));
        assert.isTrue(Option.isNone(yield* store.payload("nope")));
        yield* store.transition("f1", ["pending_admin"], "admin_rejected", { clearPayload: true });
        assert.isTrue(Option.isNone(yield* store.payload("f1")));
      }),
    ),
  );
});

describe("FilingStore inserts", () => {
  it.effect("insert an awaiting_approval filing with its payload and a nonce bound to it", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const filing = yield* inserted(store, awaiting("f1"));
        assert.strictEqual(filing.state, "awaiting_approval");
        assert.strictEqual(filing.expiresAt, T0 + 10 * MINUTE);
        assert.strictEqual(filing.submittedAt, undefined);
        assert.strictEqual((yield* rawRow("f1")).payload_sealed, "payload-f1");
        assert.deepStrictEqual(yield* rawNonces, [
          {
            nonce_hash: "n-f1",
            nonce_sealed: "sealed-n-f1",
            filing_id: "f1",
            content_hash: "hash-1",
            box_id: "box_1",
            grant_key: "grant_1",
            created_at: T0,
            expires_at: T0 + 10 * MINUTE,
            used_at: null,
          },
        ]);
      }),
    ),
  );

  it.effect("insert pending_admin with a payload, refused with a reason, dispatching with submittedAt", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const queued = yield* inserted(store, pending("p"));
        assert.deepStrictEqual([queued.state, queued.expiresAt], ["pending_admin", T0 + 60 * MINUTE]);
        assert.strictEqual((yield* rawRow("p")).payload_sealed, "payload-p");

        const denied = yield* inserted(store, refused("r"));
        assert.deepStrictEqual([denied.state, denied.reason, denied.expiresAt], ["refused", "no", undefined]);
        assert.strictEqual((yield* rawRow("r")).payload_sealed, null);

        const claimed = yield* inserted(store, dispatching("d", T0 + 5));
        assert.deepStrictEqual([claimed.state, claimed.submittedAt], ["dispatching", T0 + 5]);
        assert.strictEqual((yield* rawRow("d")).payload_sealed, null);

        assert.deepStrictEqual(yield* rawNonces, []);
      }),
    ),
  );

  it.effect("report a taken grant, box and key as KeyTaken and leave nothing behind", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const first = yield* inserted(store, awaiting("f1", { idempotencyKey: "k" }));
        for (const retry of [awaiting("f2", { idempotencyKey: "k" }, "n-other"), dispatching("f3", T0, { idempotencyKey: "k" })]) {
          const write = yield* store.insert(retry);
          assert.deepStrictEqual(expectTag(write, "KeyTaken").existing, first);
        }
        assert.deepStrictEqual(
          (yield* rawFilings).map((row) => row.id),
          ["f1"],
        );
        assert.deepStrictEqual(
          (yield* rawNonces).map((row) => row.nonce_hash),
          ["n-f1"],
        );

        yield* inserted(store, awaiting("f4", { idempotencyKey: "k", grantKey: "grant_2" }));
        yield* inserted(store, awaiting("f5", { idempotencyKey: "k", boxId: "box_2" }));
      }),
    ),
  );

  it.effect("fail with DomainStoreError, not KeyTaken, when only the nonce hash collides", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, awaiting("f1", {}, "same"));
        const exit = yield* Effect.exit(store.insert(awaiting("f2", {}, "same")));
        assert.instanceOf(Exit.findErrorOption(exit).pipe(Option.getOrUndefined), DomainStoreError);
        assert.isTrue(Option.isNone(yield* rawFiling("f2")));
      }),
    ),
  );
});

describe("FilingStore transitions", () => {
  it.effect("win a compare-and-set from an expected state and lose from any other", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, pending("f1"));
        yield* TestClock.adjust(MINUTE);
        const won = expectTag(
          yield* store.transition("f1", ["awaiting_approval", "pending_admin"], "admin_rejected", {
            reason: "not ours",
            clearPayload: true,
          }),
          "Won",
        ).filing;
        assert.deepStrictEqual([won.state, won.reason, won.updatedAt], ["admin_rejected", "not ours", T0 + MINUTE]);
        assert.strictEqual((yield* rawRow("f1")).payload_sealed, null);

        const before = yield* rawRow("f1");
        yield* TestClock.adjust(MINUTE);
        const lost = expectTag(yield* store.transition("f1", ["pending_admin"], "dispatching", { submittedAt: 1 }), "Lost");
        assert.deepStrictEqual(lost.current, Option.some(won));
        assert.deepStrictEqual(yield* rawRow("f1"), before);

        assert.isTrue(Option.isNone(expectTag(yield* store.transition("nope", ["sent"], "not_sent"), "Lost").current));
        assert.isTrue(Option.isSome(expectTag(yield* store.transition("f1", [], "sent"), "Lost").current));
      }),
    ),
  );

  it.effect("keep unpatched columns and leave the payload unless told to clear it", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, pending("f1"));
        const won = expectTag(yield* store.transition("f1", ["pending_admin"], "pending_admin"), "Won").filing;
        assert.deepStrictEqual([won.expiresAt, won.reason], [T0 + 60 * MINUTE, undefined]);
        assert.strictEqual((yield* rawRow("f1")).payload_sealed, "payload-f1");
      }),
    ),
  );

  it.effect("report a dmID already on another filing as DmIdTaken and change nothing", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, dispatching("a"));
        yield* inserted(store, dispatching("b"));
        expectTag(yield* store.transition("a", ["dispatching"], "sent", { dmId: "100" }), "Won");
        const before = yield* rawRow("b");
        const taken = expectTag(yield* store.transition("b", ["dispatching"], "sent", { dmId: "100" }), "DmIdTaken");
        assert.deepStrictEqual([taken.dmId, taken.filingId], ["100", "a"]);
        assert.deepStrictEqual(yield* rawRow("b"), before);
        // Re-stating a filing's own dmID is no conflict.
        expectTag(yield* store.transition("a", ["sent"], "sent", { dmId: "100" }), "Won");
      }),
    ),
  );

  it.effect("report a lost CAS, not DmIdTaken, when the filing already left the expected state", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, dispatching("a"));
        yield* inserted(store, dispatching("b"));
        expectTag(yield* store.transition("a", ["dispatching"], "sent", { dmId: "100" }), "Won");
        yield* patchRawFiling("b", { state: "not_sent" });
        const before = yield* rawRow("b");
        const lostCas = expectTag(yield* store.transition("b", ["dispatching"], "sent", { dmId: "100" }), "Lost");
        assert.strictEqual(Option.getOrThrow(lostCas.current).state, "not_sent");
        assert.deepStrictEqual(yield* rawRow("b"), before);
        const missing = expectTag(yield* store.transition("nope", ["dispatching"], "sent", { dmId: "100" }), "Lost");
        assert.isTrue(Option.isNone(missing.current));
      }),
    ),
  );

  it.effect("burn the filing's unused nonces only when the transition wins", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, awaiting("f1"));
        yield* TestClock.adjust(MINUTE);
        expectTag(yield* store.transition("f1", ["pending_admin"], "refused", { burnNonces: true }), "Lost");
        assert.strictEqual((yield* rawNonces)[0]?.used_at, null);

        const queued = expectTag(
          yield* store.transition("f1", ["awaiting_approval"], "pending_admin", {
            burnNonces: true,
            expiresAt: T0 + 99 * MINUTE,
          }),
          "Won",
        ).filing;
        assert.deepStrictEqual([queued.state, queued.expiresAt], ["pending_admin", T0 + 99 * MINUTE]);
        assert.strictEqual((yield* rawNonces)[0]?.used_at, T0 + MINUTE);
        assert.strictEqual((yield* rawRow("f1")).payload_sealed, "payload-f1");
      }),
    ),
  );
});

describe("FilingStore claimWithNonce", () => {
  it.effect("claim an awaiting filing with its live nonce in one transaction", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, awaiting("f1"));
        yield* TestClock.adjust(MINUTE);
        const claimed = expectTag(yield* store.claimWithNonce("f1", "n-f1", T0 + MINUTE), "Won").filing;
        assert.deepStrictEqual(
          [claimed.state, claimed.submittedAt, claimed.updatedAt],
          ["dispatching", T0 + MINUTE, T0 + MINUTE],
        );
        assert.strictEqual((yield* rawRow("f1")).payload_sealed, null);
        assert.strictEqual((yield* rawNonces)[0]?.used_at, T0 + MINUTE);
        expectTag(yield* store.claimWithNonce("f1", "n-f1", T0 + MINUTE), "Lost");
      }),
    ),
  );

  it.effect("lose on a used, expired or foreign nonce and leave the filing unchanged", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, awaiting("used"));
        yield* inserted(store, awaiting("late"));
        yield* inserted(store, awaiting("other"));
        yield* store.burnNonce("n-used");
        const before = yield* rawFilings;
        const loses = (filingId: string, hash: string) =>
          Effect.gen(function* () {
            const lost = expectTag(yield* store.claimWithNonce(filingId, hash, T0), "Lost");
            assert.strictEqual(Option.getOrUndefined(lost.current)?.state, "awaiting_approval");
          });

        yield* loses("used", "n-used");
        yield* loses("other", "n-late"); // live, but bound to another filing
        yield* loses("other", "n-missing");
        yield* TestClock.setTime(T0 + 10 * MINUTE); // nonce expires_at == now: no longer live
        yield* loses("late", "n-late");
        assert.deepStrictEqual(yield* rawFilings, before);
        assert.deepStrictEqual(
          (yield* rawNonces).map((row) => [row.nonce_hash, row.used_at]),
          [
            ["n-late", null],
            ["n-other", null],
            ["n-used", T0],
          ],
        );
      }),
    ),
  );

  it.effect("roll the nonce back when the filing is no longer awaiting approval", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, awaiting("f1"));
        yield* patchRawFiling("f1", { state: "pending_admin" });
        const lost = expectTag(yield* store.claimWithNonce("f1", "n-f1", T0), "Lost");
        assert.strictEqual(Option.getOrUndefined(lost.current)?.state, "pending_admin");
        assert.strictEqual((yield* rawNonces)[0]?.used_at, null);
        assert.isTrue(Option.isNone(expectTag(yield* store.claimWithNonce("nope", "n-f1", T0), "Lost").current));
      }),
    ),
  );
});

describe("FilingStore nonces", () => {
  it.effect("insert, find, and report live nonces", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, awaiting("f1"));
        yield* inserted(store, pending("p1"));
        assert.isTrue(yield* store.insertNonce("f1", nonce("n-2", T0 + 20 * MINUTE)));
        assert.isFalse(yield* store.insertNonce("p1", nonce("n-p")));
        assert.isFalse(yield* store.insertNonce("nope", nonce("n-x")));

        assert.deepStrictEqual(
          yield* store.nonceByHash("n-2"),
          Option.some({
            nonceHash: "n-2",
            nonceSealed: "sealed-n-2",
            filingId: "f1",
            contentHash: "hash-1",
            boxId: "box_1",
            grantKey: "grant_1",
            createdAt: T0,
            expiresAt: T0 + 20 * MINUTE,
            usedAt: undefined,
          }),
        );
        assert.isTrue(Option.isNone(yield* store.nonceByHash("n-p")));

        // Two live nonces: the latest expiry wins.
        assert.strictEqual(Option.getOrUndefined(yield* store.liveNonce("f1"))?.nonceHash, "n-2");
        assert.isTrue(yield* store.burnNonce("n-2"));
        assert.isFalse(yield* store.burnNonce("n-2"));
        assert.strictEqual(Option.getOrUndefined(yield* store.nonceByHash("n-2"))?.usedAt, T0);
        assert.strictEqual(Option.getOrUndefined(yield* store.liveNonce("f1"))?.nonceHash, "n-f1");
        yield* TestClock.setTime(T0 + 10 * MINUTE);
        assert.isTrue(Option.isNone(yield* store.liveNonce("f1")));
        assert.isTrue(Option.isNone(yield* store.liveNonce("p1")));
      }),
    ),
  );

  it.effect("burn every unused nonce of a filing", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, awaiting("f1"));
        yield* inserted(store, awaiting("f2"));
        yield* store.insertNonce("f1", nonce("n-1b"));
        yield* store.burnNonce("n-f1");
        yield* TestClock.adjust(MINUTE);
        assert.strictEqual(yield* store.burnNonces("f1"), 1);
        assert.strictEqual(yield* store.burnNonces("f1"), 0);
        assert.deepStrictEqual(
          (yield* rawNonces).map((row) => [row.nonce_hash, row.used_at]),
          [
            ["n-1b", T0 + MINUTE],
            ["n-f1", T0],
            ["n-f2", null],
          ],
        );
      }),
    ),
  );

  it.effect("replace a filing's nonces atomically, and not at all once it left awaiting_approval", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, awaiting("f1"));
        yield* TestClock.adjust(MINUTE);
        assert.isTrue(yield* store.replaceNonce("f1", nonce("n-new", T0 + 30 * MINUTE)));
        assert.strictEqual(Option.getOrUndefined(yield* store.liveNonce("f1"))?.nonceHash, "n-new");
        assert.strictEqual(Option.getOrUndefined(yield* store.nonceByHash("n-f1"))?.usedAt, T0 + MINUTE);

        yield* patchRawFiling("f1", { state: "pending_admin" });
        assert.isFalse(yield* store.replaceNonce("f1", nonce("n-newer")));
        assert.isTrue(Option.isNone(yield* store.nonceByHash("n-newer")));
        assert.strictEqual(Option.getOrUndefined(yield* store.nonceByHash("n-new"))?.usedAt, undefined);
      }),
    ),
  );
});

describe("FilingStore nonce replacement failures", () => {
  it.effect("keep the old nonce live when the new one cannot be stored", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, awaiting("f1"));
        yield* inserted(store, awaiting("f2"));
        const exit = yield* Effect.exit(store.replaceNonce("f1", nonce("n-f2")));
        assert.instanceOf(Exit.findErrorOption(exit).pipe(Option.getOrUndefined), DomainStoreError);
        assert.strictEqual(Option.getOrUndefined(yield* store.liveNonce("f1"))?.nonceHash, "n-f1");
        assert.strictEqual(Option.getOrUndefined(yield* store.nonceByHash("n-f2"))?.filingId, "f2");
      }),
    ),
  );
});

describe("FilingStore dmID and competitor lookups", () => {
  it.effect("name the filing that holds a dmID", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, dispatching("f1"));
        yield* store.transition("f1", ["dispatching"], "sent", { dmId: "100" });
        assert.deepStrictEqual(yield* store.dmIdOwner("100"), Option.some("f1"));
        assert.isTrue(Option.isNone(yield* store.dmIdOwner("101")));
      }),
    ),
  );

  it.effect("find in-flight filings to the same recipient within the window, edges included", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const window = 15 * MINUTE;
        yield* inserted(store, dispatching("self", T0));
        yield* inserted(store, dispatching("lower-edge", T0 - window));
        yield* inserted(store, dispatching("upper-edge", T0 + window));
        yield* inserted(store, dispatching("too-early", T0 - window - 1));
        yield* inserted(store, dispatching("too-late", T0 + window + 1));
        yield* inserted(store, dispatching("unknown", T0 + 1));
        yield* inserted(store, dispatching("sent", T0 + 2));
        yield* inserted(store, dispatching("other-recipient", T0, { recipientDbId: "zzz9999" }));
        yield* inserted(store, dispatching("other-box", T0, { boxId: "box_2" }));
        yield* store.recover.pipe(Effect.andThen(store.transition("self", ["outcome_unknown"], "dispatching")));
        yield* store.transition("sent", ["outcome_unknown"], "sent", { dmId: "1" });

        assert.deepStrictEqual(yield* store.competitors("box_1", "rcpt123", T0, window, "self"), [
          "lower-edge",
          "unknown",
          "upper-edge",
        ]);
        assert.deepStrictEqual(yield* store.competitors("box_1", "rcpt123", T0, window, "unknown"), [
          "lower-edge",
          "self",
          "upper-edge",
        ]);
      }),
    ),
  );

  it.effect("count an in-flight filing without submitted_at as competing, whatever the window", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, dispatching("self", T0));
        yield* inserted(store, dispatching("untimed", T0 + 60 * MINUTE));
        yield* patchRawFiling("untimed", { submitted_at: null });
        assert.deepStrictEqual(yield* store.competitors("box_1", "rcpt123", T0, MINUTE, "self"), ["untimed"]);
      }),
    ),
  );
});

describe("FilingStore resolveReconciled", () => {
  const window = 15 * MINUTE;
  const record = { reconcile: { at: T0 + MINUTE, result: "found" }, reconciledAt: T0 + MINUTE };

  /** An outcome_unknown filing submitted at `submittedAt`. */
  const unknown = (store: FilingStore, id: string, submittedAt = T0, overrides: Partial<NewFilingFields> = {}) =>
    Effect.gen(function* () {
      yield* inserted(store, dispatching(id, submittedAt, overrides));
      expectTag(yield* store.transition(id, ["dispatching"], "outcome_unknown", { clearPayload: true }), "Won");
    });

  it.effect("move a lone outcome_unknown filing to sent with the dmID and the reconcile record", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* unknown(store, "f1");
        yield* unknown(store, "far", T0 + window + 1);
        yield* unknown(store, "elsewhere", T0, { recipientDbId: "zzz9999" });
        yield* TestClock.adjust(MINUTE);
        const sent = expectTag(yield* store.resolveReconciled("f1", "200", window, record), "Won").filing;
        assert.deepStrictEqual(
          [sent.state, sent.dmId, sent.reconcile, sent.reconciledAt, sent.updatedAt],
          ["sent", "200", record.reconcile, T0 + MINUTE, T0 + MINUTE],
        );
      }),
    ),
  );

  it.effect("name the filing that already holds the dmID and leave the state", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* unknown(store, "f1");
        yield* inserted(store, dispatching("holder", T0 - 2 * window));
        yield* store.transition("holder", ["dispatching"], "sent", { dmId: "200" });
        const before = yield* rawRow("f1");
        const taken = expectTag(yield* store.resolveReconciled("f1", "200", window, record), "DmIdTaken");
        assert.deepStrictEqual([taken.dmId, taken.filingId], ["200", "holder"]);
        assert.deepStrictEqual(yield* rawRow("f1"), before);
      }),
    ),
  );

  it.effect("name competing in-flight filings and leave the state", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* unknown(store, "f1");
        yield* unknown(store, "rival-unknown", T0 + window);
        yield* inserted(store, dispatching("rival-dispatching", T0 - 1));
        const before = yield* rawRow("f1");
        const competing = expectTag(yield* store.resolveReconciled("f1", "200", window, record), "Competing");
        assert.deepStrictEqual(competing.filingIds, ["rival-dispatching", "rival-unknown"]);
        assert.deepStrictEqual(yield* rawRow("f1"), before);
      }),
    ),
  );

  it.effect("treat every in-flight filing to the recipient as competing when submitted_at is missing", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* unknown(store, "f1");
        yield* patchRawFiling("f1", { submitted_at: null });
        yield* unknown(store, "far", T0 + 10 * window);
        const competing = expectTag(yield* store.resolveReconciled("f1", "200", window, record), "Competing");
        assert.deepStrictEqual(competing.filingIds, ["far"]);
      }),
    ),
  );

  it.effect("lose when the filing is no longer outcome_unknown or does not exist", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, dispatching("f1"));
        const lost = expectTag(yield* store.resolveReconciled("f1", "200", window, record), "Lost");
        assert.strictEqual(Option.getOrUndefined(lost.current)?.state, "dispatching");
        assert.isTrue(Option.isNone(expectTag(yield* store.resolveReconciled("nope", "200", window), "Lost").current));
        assert.isTrue(Option.isNone(yield* store.dmIdOwner("200")));
      }),
    ),
  );
});

describe("FilingStore sweeps", () => {
  it.effect("recover every dispatching filing to outcome_unknown and clear its payload", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, dispatching("d2"));
        yield* inserted(store, dispatching("d1"));
        yield* inserted(store, awaiting("a1"));
        yield* patchRawFiling("d1", { payload_sealed: "left over" });
        yield* TestClock.adjust(MINUTE);
        assert.deepStrictEqual(yield* store.recover, ["d1", "d2"]);
        for (const id of ["d1", "d2"]) {
          const row = yield* rawRow(id);
          assert.deepStrictEqual([row.state, row.payload_sealed, row.updated_at], ["outcome_unknown", null, T0 + MINUTE]);
        }
        assert.strictEqual((yield* rawRow("a1")).state, "awaiting_approval");
        assert.deepStrictEqual(yield* store.recover, []);
      }),
    ),
  );

  it.effect("expire only open filings past their expiry, burning nonces and clearing payloads", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* inserted(store, awaiting("due-awaiting")); // expires T0 + 10 min
        yield* inserted(store, pending("due-pending"));
        yield* patchRawFiling("due-pending", { expires_at: T0 + 5 * MINUTE });
        yield* inserted(store, pending("later")); // expires T0 + 60 min
        yield* inserted(store, awaiting("later-awaiting"));
        yield* patchRawFiling("later-awaiting", { expires_at: T0 + 10 * MINUTE + 1 });
        yield* inserted(store, dispatching("in-flight"));
        yield* patchRawFiling("in-flight", { expires_at: T0 });

        yield* TestClock.setTime(T0 + 10 * MINUTE);
        assert.deepStrictEqual(yield* store.expireDue, ["due-awaiting", "due-pending"]);
        for (const id of ["due-awaiting", "due-pending"]) {
          const row = yield* rawRow(id);
          assert.deepStrictEqual(
            [row.state, row.payload_sealed, row.updated_at],
            ["expired", null, T0 + 10 * MINUTE],
          );
        }
        assert.deepStrictEqual(
          (yield* rawFilings).map((row) => [row.id, row.state]),
          [
            ["due-awaiting", "expired"],
            ["due-pending", "expired"],
            ["in-flight", "dispatching"],
            ["later", "pending_admin"],
            ["later-awaiting", "awaiting_approval"],
          ],
        );
        assert.deepStrictEqual(
          (yield* rawNonces).map((row) => [row.nonce_hash, row.used_at]),
          [
            ["n-due-awaiting", T0 + 10 * MINUTE],
            ["n-later-awaiting", null],
          ],
        );
        assert.deepStrictEqual(yield* store.expireDue, []);
      }),
    ),
  );
});
