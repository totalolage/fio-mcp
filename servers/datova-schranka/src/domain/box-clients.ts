import { Context, Effect, Exit, Layer, Option, Ref, Scope, Stream } from "effect";
import type { IsdsClientShape } from "../isds/client.js";
import type { IsdsCredentials } from "../isds/config.js";
import type { IsdsConfigError, IsdsCredentialsError } from "../isds/errors.js";
import { BoxLocks } from "./box-locks.js";
import { type BoxCredentialsUnreadable, BoxRegistry } from "./boxes.js";
import { DomainConfig } from "./config.js";
import type { BoxNotFound } from "./errors.js";
import { boxClientConfig, IsdsTransports, makeIsdsClient } from "./isds-transports.js";

/**
 * One IsdsClient per loaded box, over its decrypted credentials and the
 * configured environment and request timeout. `use` holds the box's
 * BoxLocks permit for the whole of `f`, so ISDS calls for one box never
 * overlap, here or in the registry's credential replacement and connection
 * test (ISDS rejects parallel list/download, status 3008), while different
 * boxes run concurrently. `f` must not take the same box's permit again. Replaced credentials apply from the next `use`;
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

const make = Effect.gen(function* () {
  const registry = yield* BoxRegistry;
  const locks = yield* BoxLocks;
  const transports = yield* IsdsTransports;
  const config = yield* DomainConfig;
  const layerScope = yield* Scope.Scope;
  /**
   * Every box a `use` has reached, with the client last built for it (none while one is being
   * built, or after a build failed). A `use` adds its box before asking the registry for the
   * credentials, so a removal published after that always finds the box here and is cleaned up
   * once the `use` ends. A box's entry is read and changed only under its BoxLocks permit.
   */
  const built = yield* Ref.make<ReadonlyMap<string, Option.Option<BuiltClient>>>(new Map());

  /** Takes the box's client out of `built` (dropping the box too when `forget`) and closes its scope. */
  const take = (boxId: string, forget: boolean) =>
    Ref.modify(
      built,
      (current): readonly [Option.Option<BuiltClient>, ReadonlyMap<string, Option.Option<BuiltClient>>] => {
        if (!current.has(boxId)) return [Option.none(), current];
        const next = new Map(current);
        if (forget) next.delete(boxId);
        else next.set(boxId, Option.none());
        return [current.get(boxId) ?? Option.none(), next];
      },
    ).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: ({ scope }) => Scope.close(scope, Exit.void) })),
      Effect.uninterruptible,
    );

  /** Closes the box's client, if any, keeping the box known. Under the box's permit. */
  const discard = (boxId: string) => take(boxId, false);

  /** Closes a removed box's client and forgets the box. Under the box's permit. */
  const forget = (boxId: string) => take(boxId, true);

  /**
   * Closes the box's old client and builds one over `credentials` in a new child of the layer
   * scope. Runs uninterruptibly except for the build itself (`restore`), so the box ends up
   * either with no client and the new scope closed, or holding the new client with its scope open.
   */
  const rebuild = Effect.fn("BoxClients.rebuild")(function* (
    boxId: string,
    credentials: IsdsCredentials,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) {
    yield* discard(boxId);
    const scope = yield* Scope.fork(layerScope);
    const exit = yield* Effect.exit(
      restore(
        makeIsdsClient(boxClientConfig(config, credentials)).pipe(
          Scope.provide(scope),
          Effect.provideService(IsdsTransports, transports),
        ),
      ),
    );
    if (Exit.isFailure(exit)) {
      yield* Scope.close(scope, exit);
      return yield* Effect.failCause(exit.cause);
    }
    yield* Ref.update(built, (current) => new Map(current).set(boxId, Option.some({ credentials, client: exit.value, scope })));
    return exit.value;
  });

  /**
   * The box's client when it was built from this very credentials object (the registry keeps
   * the reference until the credentials are replaced), else a new one. Under the box's permit.
   */
  const clientFor = Effect.fn("BoxClients.clientFor")(function* (boxId: string, credentials: IsdsCredentials) {
    const existing = (yield* Ref.get(built)).get(boxId) ?? Option.none();
    if (Option.isSome(existing) && existing.value.credentials === credentials) return existing.value.client;
    return yield* Effect.uninterruptibleMask((restore) => rebuild(boxId, credentials, restore));
  });

  const use = Effect.fn("BoxClients.use")(function* <A, E>(
    boxId: string,
    f: (client: IsdsClientShape) => Effect.Effect<A, E>,
  ) {
    return yield* locks.withBox(
      boxId,
      Effect.gen(function* () {
        yield* Ref.update(built, (current) => (current.has(boxId) ? current : new Map(current).set(boxId, Option.none())));
        const credentials = yield* registry
          .credentials(boxId)
          .pipe(Effect.tapError((error) => (error._tag === "BoxNotFound" ? forget(boxId) : Effect.void)));
        const client = yield* clientFor(boxId, credentials);
        return yield* f(client);
      }),
    );
  });

  /** Closes a box's client once the registry no longer has it, waiting for a running `use`. */
  const dropIfRemoved = (boxId: string) =>
    locks.withBox(
      boxId,
      registry.get(boxId).pipe(Effect.matchEffect({ onFailure: () => forget(boxId), onSuccess: () => Effect.void })),
    );

  yield* registry.changes.pipe(
    Stream.runForEach((boxes) =>
      Ref.get(built).pipe(
        Effect.flatMap((current) => {
          const present = new Set(boxes.map((box) => box.id));
          const removed = [...current.keys()].filter((boxId) => !present.has(boxId));
          return Effect.forEach(removed, (boxId) => Effect.forkIn(dropIfRemoved(boxId), layerScope), {
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
  /** Clients built lazily per box, each transport in a scope the layer owns. Needs the BoxLocks the registry uses. */
  static readonly Default: Layer.Layer<BoxClients, never, BoxRegistry | BoxLocks | IsdsTransports | DomainConfig> =
    Layer.effect(BoxClients, make);
}
