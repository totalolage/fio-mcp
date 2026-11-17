import { Context, Effect, Exit, Layer, Option, Ref, Scope, Semaphore, Stream } from "effect";
import type { IsdsClientShape } from "../isds/client.js";
import type { IsdsCredentials } from "../isds/config.js";
import type { IsdsConfigError, IsdsCredentialsError } from "../isds/errors.js";
import { type BoxCredentialsUnreadable, BoxRegistry } from "./boxes.js";
import { DomainConfig } from "./config.js";
import type { BoxNotFound } from "./errors.js";
import { boxClientConfig, IsdsTransports, makeIsdsClient } from "./isds-transports.js";

/**
 * One IsdsClient per loaded box, over its decrypted credentials and the
 * configured environment and request timeout. `use` holds the box's
 * semaphore for the whole of `f`, so ISDS calls for one box never overlap
 * (ISDS rejects parallel list/download, status 3008) while different
 * boxes run concurrently. Replaced credentials apply from the next `use`;
 * a removed box fails with BoxNotFound.
 */
export type BoxClientError = BoxNotFound | BoxCredentialsUnreadable | IsdsCredentialsError | IsdsConfigError;

export interface BoxClientsShape {
  readonly use: <A, E>(
    boxId: string,
    f: (client: IsdsClientShape) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | BoxClientError>;
}

/** A built client, the credentials object it was built from, and the scope its transport lives in. */
interface BuiltClient {
  readonly credentials: IsdsCredentials;
  readonly client: IsdsClientShape;
  readonly scope: Scope.Closeable;
}

/** Per box: the permit every `use` holds, and the client last built. `built` changes only under the permit. */
interface BoxSlot {
  readonly permit: Semaphore.Semaphore;
  readonly built: Ref.Ref<Option.Option<BuiltClient>>;
}

const make = Effect.gen(function* () {
  const registry = yield* BoxRegistry;
  const transports = yield* IsdsTransports;
  const config = yield* DomainConfig;
  const layerScope = yield* Scope.Scope;
  const slots = yield* Ref.make<ReadonlyMap<string, BoxSlot>>(new Map());

  const slotFor = Effect.fn("BoxClients.slotFor")(function* (boxId: string) {
    const fresh: BoxSlot = { permit: yield* Semaphore.make(1), built: yield* Ref.make(Option.none<BuiltClient>()) };
    return yield* Ref.modify(slots, (current): readonly [BoxSlot, ReadonlyMap<string, BoxSlot>] => {
      const existing = current.get(boxId);
      return existing === undefined ? [fresh, new Map(current).set(boxId, fresh)] : [existing, current];
    });
  });

  /** Closes the slot's client, if any. Under the slot's permit. */
  const discard = (slot: BoxSlot) =>
    Ref.getAndSet(slot.built, Option.none()).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.void, onSome: ({ scope }) => Scope.close(scope, Exit.void) }),
      ),
    );

  /** Drops a removed box's slot and closes its client. Under the slot's permit. */
  const forget = (boxId: string, slot: BoxSlot) =>
    discard(slot).pipe(
      Effect.andThen(
        Ref.update(slots, (current) => {
          if (current.get(boxId) !== slot) return current;
          const next = new Map(current);
          next.delete(boxId);
          return next;
        }),
      ),
    );

  /**
   * The slot's client when it was built from this very credentials object (the registry keeps
   * the reference until the credentials are replaced), else a new one; the old one is closed
   * first. A failed build closes its scope and leaves the slot empty. Under the slot's permit.
   */
  const clientFor = Effect.fn("BoxClients.clientFor")(function* (slot: BoxSlot, credentials: IsdsCredentials) {
    const built = yield* Ref.get(slot.built);
    if (Option.isSome(built) && built.value.credentials === credentials) return built.value.client;
    yield* discard(slot);
    const scope = yield* Scope.fork(layerScope);
    return yield* makeIsdsClient(boxClientConfig(config, credentials)).pipe(
      Scope.provide(scope),
      Effect.provideService(IsdsTransports, transports),
      Effect.tap((client) => Ref.set(slot.built, Option.some({ credentials, client, scope }))),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit))),
    );
  });

  const use = Effect.fn("BoxClients.use")(function* <A, E>(
    boxId: string,
    f: (client: IsdsClientShape) => Effect.Effect<A, E>,
  ) {
    const slot = yield* slotFor(boxId);
    return yield* slot.permit.withPermit(
      Effect.gen(function* () {
        const credentials = yield* registry
          .credentials(boxId)
          .pipe(Effect.tapError((error) => (error._tag === "BoxNotFound" ? forget(boxId, slot) : Effect.void)));
        const client = yield* clientFor(slot, credentials);
        return yield* f(client);
      }),
    );
  });

  /** Closes a box's client once the registry no longer has it, waiting for a running `use`. */
  const dropIfRemoved = (boxId: string, slot: BoxSlot) =>
    slot.permit.withPermit(
      registry.get(boxId).pipe(Effect.matchEffect({ onFailure: () => forget(boxId, slot), onSuccess: () => Effect.void })),
    );

  yield* registry.changes.pipe(
    Stream.runForEach((boxes) =>
      Ref.get(slots).pipe(
        Effect.flatMap((current) => {
          const present = new Set(boxes.map((box) => box.id));
          const removed = [...current].filter(([boxId]) => !present.has(boxId));
          return Effect.forEach(removed, ([boxId, slot]) => Effect.forkIn(dropIfRemoved(boxId, slot), layerScope), {
            discard: true,
          });
        }),
      ),
    ),
    Effect.forkIn(layerScope),
  );

  const service: BoxClientsShape = { use };
  return service;
});

export class BoxClients extends Context.Service<BoxClients, BoxClientsShape>()("datova-schranka/BoxClients") {
  /** Clients built lazily per box, each transport in a scope the layer owns. */
  static readonly layer: Layer.Layer<BoxClients, never, BoxRegistry | IsdsTransports | DomainConfig> = Layer.effect(
    BoxClients,
    make,
  );
}
