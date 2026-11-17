import { Context, Effect, Layer, Ref, Semaphore } from "effect";

/**
 * One permit per stored box, shared by every ISDS call made for it: the
 * calls BoxClients runs and the registry's credential replacement and
 * connection test (design §9 R6; ISDS rejects parallel list/download,
 * status 3008). Different boxes run concurrently.
 *
 * The permit is not reentrant: an effect run under `withBox` must not
 * call `withBox` for the same box again (directly or through
 * BoxClients.use, BoxRegistry.replaceCredentials or
 * BoxRegistry.testConnection), or it waits for itself.
 */
export interface BoxLocksShape {
  /** Runs `effect` holding the box's permit, waiting while another call for the box holds it. */
  readonly withBox: <A, E, R>(boxId: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** A box's permit and how many callers hold it or wait for it; the entry goes when that reaches 0. */
interface Lock {
  readonly permit: Semaphore.Semaphore;
  readonly users: number;
}

const make = Effect.gen(function* () {
  const locks = yield* Ref.make<ReadonlyMap<string, Lock>>(new Map());

  /** Joins the box's lock, creating it if no one holds or waits for it. */
  const join = (boxId: string) =>
    Ref.modify(locks, (current): readonly [Semaphore.Semaphore, ReadonlyMap<string, Lock>] => {
      const existing = current.get(boxId);
      const permit = existing?.permit ?? Semaphore.makeUnsafe(1);
      return [permit, new Map(current).set(boxId, { permit, users: (existing?.users ?? 0) + 1 })];
    });

  /** Leaves the box's lock, dropping it once its last user leaves. */
  const leave = (boxId: string) =>
    Ref.update(locks, (current) => {
      const existing = current.get(boxId);
      if (existing === undefined) return current;
      const next = new Map(current);
      if (existing.users <= 1) next.delete(boxId);
      else next.set(boxId, { permit: existing.permit, users: existing.users - 1 });
      return next;
    });

  const withBox = <A, E, R>(boxId: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      join(boxId),
      (permit) => permit.withPermit(effect),
      () => leave(boxId),
    );

  const service: BoxLocksShape = { withBox };
  return service;
});

export class BoxLocks extends Context.Service<BoxLocks, BoxLocksShape>()("datova-schranka/BoxLocks") {
  /**
   * The per-box permits. BoxRegistry.Default and BoxClients.Default both
   * need it and must get the same instance, so build it once and provide
   * it to both.
   */
  static readonly Default: Layer.Layer<BoxLocks> = Layer.effect(BoxLocks, make);
}
