import { Clock, Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { BoxNotFound, type DomainStoreError, InvalidIdentifier, storeFailure } from "./errors.js";
import { isDataBoxId } from "./ids.js";

/**
 * Per sending box, how freely a grant may send to a recipient (design §0):
 * `none` (default, unlisted) → an admin approves each filing; `approve` →
 * the caller confirms with a nonce; `full` → sent autonomously.
 */
export type RecipientTier = "none" | "approve" | "full";

export interface RecipientTierEntry {
  readonly boxId: string;
  readonly recipientDbId: string;
  readonly tier: Exclude<RecipientTier, "none">;
  readonly note: string | undefined;
  readonly updatedAt: number;
}

export interface RecipientTiersShape {
  /** The tier for sending from `boxId` to `recipientDbId`; unlisted → "none". */
  readonly tier: (
    boxId: string,
    recipientDbId: string,
  ) => Effect.Effect<RecipientTier, InvalidIdentifier | DomainStoreError>;
  /** The box's listed recipients, ordered by recipient dbID. */
  readonly list: (boxId: string) => Effect.Effect<ReadonlyArray<RecipientTierEntry>, DomainStoreError>;
  /**
   * Sets the tier; "none" removes the entry. The box must be stored. The
   * note replaces the stored one (omitted or blank clears it) and is
   * trimmed and cut to NOTE_MAX_LENGTH code points.
   */
  readonly set: (
    boxId: string,
    recipientDbId: string,
    tier: RecipientTier,
    note?: string,
  ) => Effect.Effect<void, BoxNotFound | InvalidIdentifier | DomainStoreError>;
  /** Removes the entry (back to "none"); a no-op when unlisted. */
  readonly remove: (boxId: string, recipientDbId: string) => Effect.Effect<void, DomainStoreError>;
}

/** The longest note kept, in code points; longer notes are cut to it. */
export const NOTE_MAX_LENGTH = 200;

/** Trimmed, blank → undefined, at most NOTE_MAX_LENGTH code points (never splits a surrogate pair). */
const normaliseNote = (note: string | undefined): string | undefined => {
  const trimmed = note?.trim() ?? "";
  if (trimmed === "") {
    return undefined;
  }
  const codePoints = Array.from(trimmed);
  return codePoints.length > NOTE_MAX_LENGTH ? codePoints.slice(0, NOTE_MAX_LENGTH).join("").trimEnd() : trimmed;
};

/** A stored tier; anything else (the CHECK constraint rules it out) reads as unlisted, the strictest tier. */
const listedTier = (value: string): RecipientTierEntry["tier"] | undefined =>
  value === "approve" || value === "full" ? value : undefined;

const checkRecipient = (recipientDbId: string) =>
  isDataBoxId(recipientDbId)
    ? Effect.void
    : Effect.fail(new InvalidIdentifier({ kind: "dataBoxId", rule: "7 lowercase letters and digits" }));

interface TierRow {
  readonly box_id: string;
  readonly recipient_db_id: string;
  readonly tier: string;
  readonly note: string | null;
  readonly updated_at: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tier = Effect.fn("RecipientTiers.tier")(function* (boxId: string, recipientDbId: string) {
    yield* checkRecipient(recipientDbId);
    const [row] = yield* sql<{ tier: string }>`
      SELECT tier FROM recipient_tiers WHERE box_id = ${boxId} AND recipient_db_id = ${recipientDbId}
    `.pipe(storeFailure("read a recipient tier"));
    const stored = row === undefined ? undefined : listedTier(row.tier);
    return stored ?? ("none" as const);
  });

  const list = Effect.fn("RecipientTiers.list")(function* (boxId: string) {
    const rows = yield* sql<TierRow>`
      SELECT box_id, recipient_db_id, tier, note, updated_at FROM recipient_tiers
      WHERE box_id = ${boxId} ORDER BY recipient_db_id
    `.pipe(storeFailure("list recipient tiers"));
    return rows.flatMap((row): ReadonlyArray<RecipientTierEntry> => {
      const stored = listedTier(row.tier);
      return stored === undefined
        ? []
        : [
            {
              boxId: row.box_id,
              recipientDbId: row.recipient_db_id,
              tier: stored,
              note: row.note ?? undefined,
              updatedAt: row.updated_at,
            },
          ];
    });
  });

  const set = Effect.fn("RecipientTiers.set")(function* (
    boxId: string,
    recipientDbId: string,
    tier: RecipientTier,
    note?: string,
  ) {
    yield* checkRecipient(recipientDbId);
    const now = yield* Clock.currentTimeMillis;
    const write = Effect.gen(function* () {
      const [box] = yield* sql<{ id: string }>`SELECT id FROM boxes WHERE id = ${boxId}`;
      if (box === undefined) {
        return false;
      }
      if (tier === "none") {
        yield* sql`DELETE FROM recipient_tiers WHERE box_id = ${boxId} AND recipient_db_id = ${recipientDbId}`;
      } else {
        yield* sql`
          INSERT INTO recipient_tiers ${sql.insert({
            box_id: boxId,
            recipient_db_id: recipientDbId,
            tier,
            note: normaliseNote(note) ?? null,
            updated_at: now,
          })}
          ON CONFLICT (box_id, recipient_db_id) DO UPDATE
          SET tier = excluded.tier, note = excluded.note, updated_at = excluded.updated_at
        `;
      }
      return true;
    });
    const stored = yield* sql.withTransaction(write).pipe(storeFailure("store a recipient tier"));
    if (!stored) {
      return yield* new BoxNotFound({ boxId });
    }
  });

  const remove = Effect.fn("RecipientTiers.remove")(function* (boxId: string, recipientDbId: string) {
    yield* sql`DELETE FROM recipient_tiers WHERE box_id = ${boxId} AND recipient_db_id = ${recipientDbId}`.pipe(
      storeFailure("remove a recipient tier"),
    );
  });

  return { tier, list, set, remove } satisfies RecipientTiersShape;
});

export class RecipientTiers extends Context.Service<RecipientTiers, RecipientTiersShape>()(
  "datova-schranka/RecipientTiers",
) {
  /** The tier table in the domain database (migration 0102_recipient_tiers). */
  static readonly Default: Layer.Layer<RecipientTiers, never, SqlClient.SqlClient> = Layer.effect(
    RecipientTiers,
    Effect.map(make, (shape) => RecipientTiers.of(shape)),
  );
}
