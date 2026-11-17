import { Context, type Effect } from "effect";
import type { BoxNotFound, DomainStoreError, InvalidIdentifier } from "./errors.js";

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
  /** Sets the tier; "none" removes the entry. The box must be stored. */
  readonly set: (
    boxId: string,
    recipientDbId: string,
    tier: RecipientTier,
    note?: string,
  ) => Effect.Effect<void, BoxNotFound | InvalidIdentifier | DomainStoreError>;
  /** Removes the entry (back to "none"); a no-op when unlisted. */
  readonly remove: (boxId: string, recipientDbId: string) => Effect.Effect<void, DomainStoreError>;
}

export class RecipientTiers extends Context.Service<RecipientTiers, RecipientTiersShape>()(
  "datova-schranka/RecipientTiers",
) {}
