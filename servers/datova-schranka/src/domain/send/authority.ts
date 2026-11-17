import { makeOAuthStore } from "@mcps/core/oauth/store.js";
import { Clock, Context, Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { DomainStoreError } from "../errors.js";

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

/** The scope a grant needs to send (the MCP layer's SEND_SCOPE). */
const SEND_SCOPE = "isds:send";

/**
 * SendAuthority over core's OAuth grant store: a grant counts while it is live (not revoked,
 * with a usable token or code), read fresh on every check. No grant settings are decoded, so a
 * settings column can never make the check fail.
 */
export const sendAuthorityLayer: Layer.Layer<SendAuthority, never, SqlClient.SqlClient> = Layer.effect(
  SendAuthority,
  Effect.gen(function* () {
    const store = yield* makeOAuthStore();
    return SendAuthority.of({
      check: Effect.fn("SendAuthority.check")(function* (grantId: string, boxId: string) {
        const now = yield* Clock.currentTimeMillis;
        const grants = yield* store
          .listGrants(now)
          .pipe(Effect.mapError(() => new DomainStoreError({ operation: "check the OAuth grant" })));
        const grant = grants.find((candidate) => candidate.grantId === grantId);
        if (grant === undefined) return "grant_inactive" as const;
        if (!grant.scopes.includes(SEND_SCOPE)) return "scope_missing" as const;
        if (!grant.resources.includes(boxId)) return "box_not_granted" as const;
        return "ok" as const;
      }),
    });
  }),
);
