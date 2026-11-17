import { Effect, Layer } from "effect";
import { DomainStoreError } from "../../../../src/domain/errors.js";
import { type AuthorityVerdict, SendAuthority } from "../../../../src/domain/send/authority.js";

/** The map key of one grant's verdict for one box. */
export const authorityKey = (grantId: string, boxId: string): string => `${grantId}|${boxId}`;

export interface TestSendAuthorityOptions {
  /** Verdicts keyed by `authorityKey(grantId, boxId)`; any other pair is "ok". */
  readonly verdicts?: Readonly<Record<string, AuthorityVerdict>> | undefined;
  /** Shared ordering log: each check appends `authority.check <grantId>|<boxId> <verdict>` (or `failed`). */
  readonly log?: Array<string> | undefined;
}

/**
 * A SendAuthority whose verdicts can change mid-test, including from inside a fake ISDS
 * transport reply: `set` (an Effect) and `setNow` (synchronous) take effect on the next check.
 * `failChecks` makes every later check fail with DomainStoreError until called with false.
 */
export const makeTestSendAuthority = (options: TestSendAuthorityOptions = {}) => {
  const verdicts = new Map<string, AuthorityVerdict>(Object.entries(options.verdicts ?? {}));
  const checks: Array<{ readonly grantId: string; readonly boxId: string }> = [];
  let failing = false;

  const setNow = (grantId: string, boxId: string, verdict: AuthorityVerdict): void => {
    verdicts.set(authorityKey(grantId, boxId), verdict);
  };

  const layer = Layer.succeed(
    SendAuthority,
    SendAuthority.of({
      check: (grantId, boxId) =>
        Effect.suspend(() => {
          checks.push({ grantId, boxId });
          const key = authorityKey(grantId, boxId);
          if (failing) {
            options.log?.push(`authority.check ${key} failed`);
            return Effect.fail(new DomainStoreError({ operation: "check send authority" }));
          }
          const verdict = verdicts.get(key) ?? "ok";
          options.log?.push(`authority.check ${key} ${verdict}`);
          return Effect.succeed(verdict);
        }),
    }),
  );

  return {
    layer,
    /** Every check in call order. */
    checks,
    setNow,
    set: (grantId: string, boxId: string, verdict: AuthorityVerdict): Effect.Effect<void> =>
      Effect.sync(() => setNow(grantId, boxId, verdict)),
    failChecks: (fail = true): Effect.Effect<void> =>
      Effect.sync(() => {
        failing = fail;
      }),
  };
};
