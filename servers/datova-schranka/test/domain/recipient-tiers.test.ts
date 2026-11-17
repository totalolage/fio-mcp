import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { BoxNotFound, InvalidIdentifier } from "../../src/domain/errors.js";
import { NOTE_MAX_LENGTH, RecipientTiers } from "../../src/domain/recipient-tiers.js";
import { memoryDatabase } from "./support/database.js";

const BOX = "box_AAAAAAAAAAAAAAAAAAAAAA";
const OTHER_BOX = "box_BBBBBBBBBBBBBBBBBBBBBB";
const UNKNOWN_BOX = "box_CCCCCCCCCCCCCCCCCCCCCC";

/** A minimal stored box; only its id matters to the tier table. */
const insertBox = (id: string, dbId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO boxes (id, db_id, label, label_key, environment, auth_kind, owner_json, credentials_sealed,
        created_at, updated_at)
      VALUES (${id}, ${dbId}, ${id}, ${id}, 'test', 'password', '{}', 'sealed', 0, 0)
    `;
  });

const layer = RecipientTiers.Default.pipe(Layer.provideMerge(memoryDatabase()));

const withBoxes = <A, E>(body: (tiers: RecipientTiers["Service"]) => Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    yield* insertBox(BOX, "aaaaaaa");
    yield* insertBox(OTHER_BOX, "bbbbbbb");
    return yield* body(yield* RecipientTiers);
  }).pipe(Effect.provide(layer));

describe("RecipientTiers", () => {
  it.effect("reports an unlisted recipient as none", () =>
    withBoxes((tiers) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* tiers.tier(BOX, "abc1234"), "none");
        assert.deepStrictEqual(yield* tiers.list(BOX), []);
      }),
    ),
  );

  it.effect("sets, lists and removes an entry", () =>
    withBoxes((tiers) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_700_000_000_000);
        yield* tiers.set(BOX, "abc1234", "approve", "Finanční úřad");
        assert.strictEqual(yield* tiers.tier(BOX, "abc1234"), "approve");
        assert.deepStrictEqual(yield* tiers.list(BOX), [
          { boxId: BOX, recipientDbId: "abc1234", tier: "approve", note: "Finanční úřad", updatedAt: 1_700_000_000_000 },
        ]);
        yield* tiers.remove(BOX, "abc1234");
        assert.strictEqual(yield* tiers.tier(BOX, "abc1234"), "none");
        assert.deepStrictEqual(yield* tiers.list(BOX), []);
      }),
    ),
  );

  it.effect("deletes the entry when set to none", () =>
    withBoxes((tiers) =>
      Effect.gen(function* () {
        yield* tiers.set(BOX, "abc1234", "full");
        yield* tiers.set(BOX, "abc1234", "none");
        assert.strictEqual(yield* tiers.tier(BOX, "abc1234"), "none");
        assert.deepStrictEqual(yield* tiers.list(BOX), []);
        // Setting an unlisted recipient to none is a no-op, not an error.
        yield* tiers.set(BOX, "zzz9999", "none");
        assert.deepStrictEqual(yield* tiers.list(BOX), []);
      }),
    ),
  );

  it.effect("upserts: a second set replaces the tier, note and timestamp", () =>
    withBoxes((tiers) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        yield* tiers.set(BOX, "abc1234", "approve", "first");
        yield* TestClock.setTime(2_000);
        yield* tiers.set(BOX, "abc1234", "full");
        assert.strictEqual(yield* tiers.tier(BOX, "abc1234"), "full");
        assert.deepStrictEqual(yield* tiers.list(BOX), [
          { boxId: BOX, recipientDbId: "abc1234", tier: "full", note: undefined, updatedAt: 2_000 },
        ]);
      }),
    ),
  );

  it.effect("normalises the note: trimmed, blank → none, bounded", () =>
    withBoxes((tiers) =>
      Effect.gen(function* () {
        yield* tiers.set(BOX, "aaa0001", "approve", "  padded  ");
        yield* tiers.set(BOX, "aaa0002", "approve", "   ");
        yield* tiers.set(BOX, "aaa0003", "approve", "ř".repeat(NOTE_MAX_LENGTH + 10));
        const notes = (yield* tiers.list(BOX)).map((entry) => entry.note);
        assert.deepStrictEqual(notes, ["padded", undefined, "ř".repeat(NOTE_MAX_LENGTH)]);
      }),
    ),
  );

  it.effect("bounds the note by code points, never splitting a surrogate pair", () =>
    withBoxes((tiers) =>
      Effect.gen(function* () {
        yield* tiers.set(BOX, "aaa0001", "approve", "😀".repeat(NOTE_MAX_LENGTH + 1));
        const [entry] = yield* tiers.list(BOX);
        assert.strictEqual(entry?.note, "😀".repeat(NOTE_MAX_LENGTH));
      }),
    ),
  );

  it.effect("lists by recipient dbID, only the box's own entries", () =>
    withBoxes((tiers) =>
      Effect.gen(function* () {
        yield* tiers.set(BOX, "ccc3333", "full");
        yield* tiers.set(BOX, "aaa1111", "approve");
        yield* tiers.set(OTHER_BOX, "bbb2222", "full");
        yield* tiers.set(BOX, "bbb2222", "approve");
        const listed = (yield* tiers.list(BOX)).map((entry) => [entry.recipientDbId, entry.tier]);
        assert.deepStrictEqual(listed, [
          ["aaa1111", "approve"],
          ["bbb2222", "approve"],
          ["ccc3333", "full"],
        ]);
        assert.deepStrictEqual(
          (yield* tiers.list(OTHER_BOX)).map((entry) => entry.recipientDbId),
          ["bbb2222"],
        );
        // The same recipient has an independent tier per sending box.
        assert.strictEqual(yield* tiers.tier(OTHER_BOX, "bbb2222"), "full");
        assert.strictEqual(yield* tiers.tier(OTHER_BOX, "aaa1111"), "none");
      }),
    ),
  );

  it.effect("removing an unlisted recipient is a no-op", () =>
    withBoxes((tiers) =>
      Effect.gen(function* () {
        yield* tiers.set(BOX, "abc1234", "full");
        yield* tiers.remove(BOX, "zzz9999");
        yield* tiers.remove(UNKNOWN_BOX, "abc1234");
        assert.strictEqual(yield* tiers.tier(BOX, "abc1234"), "full");
      }),
    ),
  );

  it.effect("refuses a malformed recipient dbID", () =>
    withBoxes((tiers) =>
      Effect.gen(function* () {
        for (const bad of ["", "ABC1234", "abc123", "abc12345", "abc-123", "abc1234 ", "' OR 1=1"]) {
          for (const error of [yield* Effect.flip(tiers.tier(BOX, bad)), yield* Effect.flip(tiers.set(BOX, bad, "full"))]) {
            assert.instanceOf(error, InvalidIdentifier);
            assert.strictEqual(error.kind, "dataBoxId");
          }
        }
        assert.deepStrictEqual(yield* tiers.list(BOX), []);
      }),
    ),
  );

  it.effect("refuses an unknown box, for every tier", () =>
    withBoxes((tiers) =>
      Effect.gen(function* () {
        for (const tier of ["approve", "full", "none"] as const) {
          const error = yield* Effect.flip(tiers.set(UNKNOWN_BOX, "abc1234", tier));
          assert.instanceOf(error, BoxNotFound);
          assert.strictEqual(error.boxId, UNKNOWN_BOX);
        }
        assert.deepStrictEqual(yield* tiers.list(UNKNOWN_BOX), []);
      }),
    ),
  );

  it.effect("checks the recipient before the box", () =>
    withBoxes((tiers) =>
      Effect.gen(function* () {
        assert.instanceOf(yield* Effect.flip(tiers.set(UNKNOWN_BOX, "BAD", "full")), InvalidIdentifier);
      }),
    ),
  );
});
