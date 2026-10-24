import { Deferred, Effect, Layer, Redacted, Ref } from "effect";
import type { FioRequestError } from "../../src/errors.js";
import { FioApi, type FioApiShape } from "../../src/fio-api.js";
import { RateLimiter } from "../../src/rate-limiter.js";
import type { NormalizedStatement } from "../../src/statement.js";

/*
 * FioApi fakes for the modules that consume it. Each implements `periods`
 * (and what the test adds); any other call is an unimplemented defect
 * (`Layer.mock`).
 */

export interface PeriodCall {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly priority: string | undefined;
}

/** Answers /periods from `respond`; every other endpoint dies. Records each call. */
export type PeriodsScript = (
  call: PeriodCall,
  n: number,
) => Effect.Effect<NormalizedStatement, FioRequestError>;

/** A FioApi whose `periods` answers from a script that the test can replace; `extra` adds other methods. */
export const fakeFio = Effect.fnUntraced(function* (initial: PeriodsScript, extra: Partial<FioApiShape> = {}) {
  const calls = yield* Ref.make<ReadonlyArray<PeriodCall>>([]);
  const script = yield* Ref.make(initial);
  const layer = Layer.mock(FioApi, {
    ...extra,
    periods: (account, from, to, priority) =>
      Effect.gen(function* () {
        const call = { token: Redacted.value(account.token), from, to, priority };
        const n = (yield* Ref.getAndUpdate(calls, (c) => [...c, call])).length;
        return yield* (yield* Ref.get(script))(call, n);
      }),
  });
  return { layer, calls, setScript: (next: PeriodsScript) => Ref.set(script, next) };
});

export const STATEMENT: NormalizedStatement = {
  info: {
    accountId: "2900000000",
    bankId: "2010",
    currency: "CZK",
    iban: "CZ0000000000000000000000",
    bic: "FIOBCZPPXXX",
    openingBalance: 100,
    closingBalance: 100,
    dateStart: "2026-01-01",
    dateEnd: "2026-01-31",
    yearList: null,
    idList: null,
    idFrom: null,
    idTo: null,
    idLastDownload: null,
  },
  transactionCount: 0,
  transactions: [],
};

/**
 * A FioApi whose `periods` goes through the real RateLimiter and holds its
 * slot until `release` completes, then answers STATEMENT.
 */
export const slotHoldingFio = (release: Deferred.Deferred<void>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const limiter = yield* RateLimiter;
      return Layer.mock(FioApi, {
        periods: (account, _from, _to, priority) =>
          limiter.run(account.tokenFingerprint, priority ?? "interactive", Effect.as(Deferred.await(release), STATEMENT)),
      });
    }),
  );
