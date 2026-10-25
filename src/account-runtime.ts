import { Effect, Layer, Stream } from "effect";
import { type Account, Accounts } from "./accounts.js";
import { startupRequest, syncAll, Transactions } from "./cache/service.js";
import { AppConfig } from "./config.js";
import { RateLimiter } from "./rate-limiter.js";

/**
 * Follows account changes made at runtime (/admin) in the per-token
 * machinery, which is keyed by token fingerprint:
 *
 * - a token no account uses any more (account removed, token replaced):
 *   its idle rate-limiter state is dropped. Its cache sync job is not
 *   stopped here: /admin retires the token in the cache before publishing
 *   the change (`Accounts.replace`), which stops the job;
 * - a new token (account added, token replaced): it gets the sync startup
 *   would have given it (FIO_SYNC_ON_STARTUP), and a rate limiter on first
 *   use.
 *
 * Changes are handled one after another, possibly late: by the time a
 * removal is handled, the token may be in use again (removed and added
 * again, or replaced and put back). A removed token that is configured
 * again by then is left alone.
 *
 * Renames change no fingerprint, so nothing here. Tool schemas and
 * `tools/list` follow the accounts on their own (src/mcp/registration.ts,
 * src/transport/grant-tools.ts).
 */

const fingerprints = (list: ReadonlyArray<Account>) => new Set(list.map((account) => account.tokenFingerprint));

export const AccountChangesLive: Layer.Layer<never, never, Accounts | Transactions | RateLimiter | AppConfig> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const accounts = yield* Accounts;
      const cache = yield* Transactions;
      const limiter = yield* RateLimiter;
      const config = yield* AppConfig;
      let previous = yield* accounts.list;
      const apply = Effect.fnUntraced(function* (list: ReadonlyArray<Account>) {
        const before = fingerprints(previous);
        const now = fingerprints(list);
        previous = list;
        for (const fingerprint of before) {
          if (now.has(fingerprint)) continue;
          if (fingerprints(yield* accounts.list).has(fingerprint)) continue;
          yield* limiter.forget(fingerprint);
        }
        const added = list.filter((account) => !before.has(account.tokenFingerprint));
        if (config.cache.enabled && added.length > 0) yield* syncAll(cache, added, startupRequest(config));
      });
      yield* Effect.forkScoped(Stream.runForEach(accounts.changes, apply));
    }),
  );
