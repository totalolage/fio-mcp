import { Context, type Effect } from "effect";
import type { DomainStoreError } from "../errors.js";

/**
 * Whether a caller's OAuth grant may send from a box right now (D-a): "ok", or why not.
 * The send service turns any other verdict into a refusal that names it.
 */
export type AuthorityVerdict = "ok" | "grant_inactive" | "scope_missing" | "box_not_granted";

export interface SendAuthorityShape {
  /** The verdict for grant `grantId` sending from box `boxId`, read fresh on every call (no caching). */
  readonly check: (grantId: string, boxId: string) => Effect.Effect<AuthorityVerdict, DomainStoreError>;
}

/**
 * The send-authority port. Its live implementation reads core's OAuth grant store and is
 * provided by the server composition; tests use test/domain/send/support/authority.ts.
 */
export class SendAuthority extends Context.Service<SendAuthority, SendAuthorityShape>()(
  "datova-schranka/SendAuthority",
) {}
