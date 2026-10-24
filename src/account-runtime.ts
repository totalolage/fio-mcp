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
 *   its cache sync job stops and its idle rate-limiter state is dropped;
 * - a new token (account added, token replaced): it gets the sync startup
 *   would have given it (FIO_SYNC_ON_STARTUP), and a rate limiter on first
 *   use.
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
          yield* cache.cancelSync(fingerprint);
          yield* limiter.forget(fingerprint);
        }
        const added = list.filter((account) => !before.has(account.tokenFingerprint));
        if (config.cache.enabled && added.length > 0) yield* syncAll(cache, added, startupRequest(config));
      });
      yield* Effect.forkScoped(Stream.runForEach(accounts.changes, apply));
    }),
  );
