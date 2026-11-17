/**
 * SendBackground: the send domain's background runs, in the layer's scope (D-i, D-j).
 * - Once at start: reconcile the filings startup recovery turned outcome_unknown.
 * - Every minute: the expiry sweep over open filings past their expiry.
 * A failure or defect in either is logged with its cause and never ends the loop or fails the layer.
 */
import { Effect, Layer, Schedule } from "effect";
import { SendService } from "./api.js";

/** How often the expiry sweep runs. */
export const EXPIRY_SWEEP_INTERVAL = "60 seconds";

const logged = <A, E>(failureLog: string, effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logError(failureLog, cause)),
  );

/** Forks both runs into the layer's scope; closing the scope stops them. Needs SendService. */
export const SendBackground = Layer.effectDiscard(
  Effect.gen(function* () {
    const send = yield* SendService;
    yield* Effect.forkScoped(
      logged(
        "datova-schranka: reconciling the recovered filings failed",
        send.reconcileRecovered.pipe(
          Effect.tap((sent) => Effect.logInfo("datova-schranka: recovered filings reconciled", { sent })),
        ),
      ),
    );
    yield* Effect.forkScoped(
      logged("datova-schranka: the filing expiry sweep failed", send.expireDue).pipe(
        Effect.repeat(Schedule.spaced(EXPIRY_SWEEP_INTERVAL)),
      ),
    );
  }),
);
