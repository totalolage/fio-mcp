import { assert, describe, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Latch, Layer, Queue, Schema, Scope } from "effect";
import { BoxClients } from "../../src/domain/box-clients.js";
import { BoxLocks } from "../../src/domain/box-locks.js";
import { BoxCredentialsUnreadable } from "../../src/domain/boxes.js";
import { DomainConfig } from "../../src/domain/config.js";
import { BoxNotFound } from "../../src/domain/errors.js";
import { IsdsTransports } from "../../src/domain/isds-transports.js";
import type { IsdsClientConfig } from "../../src/isds/config.js";
import { IsdsCredentialsError } from "../../src/isds/errors.js";
import { type FakeBoxEntry, fakeBox, makeFakeBoxRegistry } from "./support/fake-box-registry.js";
import { type FakeIsdsOptions, fakeIsdsTransports, loginResponder, passwordCredentials } from "./support/fake-isds.js";

class CallbackFailed extends Schema.TaggedError<CallbackFailed>()("CallbackFailed", { reason: Schema.String }) {}

const entry = (id: string, username = `user-${id}`): FakeBoxEntry => ({
  box: fakeBox(id),
  credentials: passwordCredentials(username),
});

interface SetupOptions extends FakeIsdsOptions {
  /** Runs once a transport is made and its close is tracked, while the client is still being built. */
  readonly afterMake?: (config: IsdsClientConfig) => Effect.Effect<void>;
}

/**
 * BoxClients.Default over a fake registry and fake transports, built in a scope the test closes
 * (`closeLayer`). Every transport's scope close is recorded in `closed` and offered to `closes`.
 */
const setup = Effect.fn("setup")(function* (entries: ReadonlyArray<FakeBoxEntry>, options: SetupOptions = {}) {
  const registry = yield* makeFakeBoxRegistry(entries);
  const isds = fakeIsdsTransports(loginResponder({}), options);
  const closed: Array<IsdsClientConfig> = [];
  const closes = yield* Queue.unbounded<IsdsClientConfig>();
  const tracked = Layer.effect(
    IsdsTransports,
    Effect.gen(function* () {
      const inner = yield* IsdsTransports;
      return IsdsTransports.of({
        make: (config) =>
          inner.make(config).pipe(
            Effect.tap(() =>
              Effect.addFinalizer(() =>
                Effect.sync(() => closed.push(config)).pipe(Effect.andThen(Queue.offer(closes, config))),
              ),
            ),
            Effect.tap(() => options.afterMake?.(config) ?? Effect.void),
          ),
      });
    }),
  ).pipe(Layer.provide(isds.layer));
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const context = yield* Layer.buildWithScope(
    BoxClients.Default.pipe(
      Layer.provide(Layer.mergeAll(registry.layer, tracked, DomainConfig.layer({ dataDir: "/unused" }), BoxLocks.Default)),
    ),
    scope,
  );
  return {
    clients: Context.get(context, BoxClients),
    registry,
    made: isds.made,
    requests: isds.requests,
    closed,
    nextClose: Queue.take(closes),
    closeLayer: Scope.close(scope, Exit.void),
  };
});

/** A `use` callback that signals `entered`, then holds the box until `release` opens. */
const holding = Effect.fn("holding")(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Latch.make();
  return {
    entered,
    release,
    body: (events: Array<string>, name: string) =>
      Effect.gen(function* () {
        events.push(`${name}:start`);
        yield* Deferred.succeed(entered, undefined);
        yield* release.await;
        events.push(`${name}:end`);
      }),
  };
});

describe("BoxClients", () => {
  it.effect("builds one client per box and reuses it across uses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b1 = entry("b1");
        const { clients, made, requests } = yield* setup([b1, entry("b2")]);

        for (let i = 0; i < 3; i++) yield* clients.use("b1", (client) => client.ping());
        yield* clients.use("b2", (client) => client.ping());

        assert.strictEqual(made.length, 2);
        assert.strictEqual(made[0]?.credentials, b1.credentials);
        assert.strictEqual(made[0]?.environment, "production");
        assert.deepStrictEqual(
          requests.map(({ config }) => config.credentials === b1.credentials),
          [true, true, true, false],
        );
      }),
    ),
  );

  it.effect("runs uses of one box one at a time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { clients } = yield* setup([entry("b1")]);
        const events: Array<string> = [];
        const first = yield* holding();

        const a = yield* clients.use("b1", () => first.body(events, "a")).pipe(Effect.forkChild);
        yield* Deferred.await(first.entered);
        const b = yield* clients
          .use("b1", () => Effect.sync(() => events.push("b")))
          .pipe(Effect.forkChild({ startImmediately: true }));

        assert.deepStrictEqual(events, ["a:start"]);
        assert.isUndefined(b.pollUnsafe());

        yield* first.release.open;
        yield* Fiber.join(a);
        yield* Fiber.join(b);
        assert.deepStrictEqual(events, ["a:start", "a:end", "b"]);
      }),
    ),
  );

  it.effect("runs uses of different boxes concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { clients } = yield* setup([entry("b1"), entry("b2")]);
        const events: Array<string> = [];
        const first = yield* holding();

        const a = yield* clients.use("b1", () => first.body(events, "a")).pipe(Effect.forkChild);
        yield* Deferred.await(first.entered);
        yield* clients.use("b2", () => Effect.sync(() => events.push("b")));

        assert.deepStrictEqual(events, ["a:start", "b"]);
        yield* first.release.open;
        yield* Fiber.join(a);
      }),
    ),
  );

  it.effect("holds the box while its client is built, so concurrent first uses build one client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const building = yield* Deferred.make<void>();
        const finish = yield* Latch.make();
        const { clients, made } = yield* setup([entry("b1")], {
          onMake: () => Deferred.succeed(building, undefined).pipe(Effect.andThen(finish.await)),
        });

        const a = yield* clients.use("b1", (client) => client.ping()).pipe(Effect.forkChild);
        yield* Deferred.await(building);
        const b = yield* clients
          .use("b1", (client) => client.ping())
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.isUndefined(b.pollUnsafe());

        yield* finish.open;
        yield* Fiber.join(a);
        yield* Fiber.join(b);
        assert.strictEqual(made.length, 1);
      }),
    ),
  );

  it.effect("applies replaced credentials from the next use and closes the old transport once it is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b1 = entry("b1");
        const replacement = passwordCredentials("user-b1", "new-secret");
        const { clients, registry, made, requests, closed } = yield* setup([b1]);
        const events: Array<string> = [];
        const first = yield* holding();

        const a = yield* clients
          .use("b1", (client) => client.ping().pipe(Effect.andThen(first.body(events, "a"))))
          .pipe(Effect.forkChild);
        yield* Deferred.await(first.entered);
        yield* registry.replaceCredentials("b1", replacement);
        const b = yield* clients
          .use("b1", (client) => client.ping())
          .pipe(Effect.forkChild({ startImmediately: true }));

        assert.strictEqual(closed.length, 0);
        yield* first.release.open;
        yield* Fiber.join(a);
        yield* Fiber.join(b);

        assert.deepStrictEqual(
          made.map(({ credentials }) => credentials),
          [b1.credentials, replacement],
        );
        assert.deepStrictEqual(
          closed.map(({ credentials }) => credentials),
          [b1.credentials],
        );
        assert.strictEqual(requests.at(-1)?.config.credentials, replacement);
      }),
    ),
  );

  it.effect("fails a use of a removed box with BoxNotFound and closes its transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b1 = entry("b1");
        const { clients, registry, closed } = yield* setup([b1, entry("b2")]);
        yield* clients.use("b1", (client) => client.ping());
        yield* clients.use("b2", (client) => client.ping());

        yield* registry.remove("b1");
        const error = yield* clients.use("b1", (client) => client.ping()).pipe(Effect.flip);

        assert.instanceOf(error, BoxNotFound);
        assert.deepStrictEqual(
          closed.map(({ credentials }) => credentials),
          [b1.credentials],
        );
      }),
    ),
  );

  it.effect("closes a box removed during a use only after that use finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b1 = entry("b1");
        const { clients, registry, closed, nextClose } = yield* setup([b1]);
        const closedWhileHeld: Array<number> = [];
        const first = yield* holding();

        const a = yield* clients
          .use("b1", () =>
            first.body([], "a").pipe(Effect.andThen(Effect.sync(() => closedWhileHeld.push(closed.length)))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(first.entered);
        yield* registry.remove("b1");
        // Let the registry's change reach BoxClients, which must wait for the running use.
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });

        yield* first.release.open;
        yield* Fiber.join(a);
        const config = yield* nextClose;

        assert.deepStrictEqual(closedWhileHeld, [0]);
        assert.strictEqual(config.credentials, b1.credentials);
      }),
    ),
  );

  it.effect("closes a removed box's transport without waiting for its next use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b1 = entry("b1");
        const { clients, registry, nextClose } = yield* setup([b1]);
        yield* clients.use("b1", (client) => client.ping());

        yield* registry.remove("b1");
        const config = yield* nextClose;

        assert.strictEqual(config.credentials, b1.credentials);
      }),
    ),
  );

  it.effect("fails a use whose client cannot be built, caches nothing, and retries on the next use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        const { clients, made } = yield* setup([entry("b1")], {
          onMake: () =>
            Effect.suspend(() => {
              attempts++;
              return attempts === 1 ? Effect.fail(new IsdsCredentialsError({ detail: "bad PKCS#12" })) : Effect.void;
            }),
        });
        let called = false;

        const error = yield* clients
          .use("b1", (client) => Effect.sync(() => (called = true)).pipe(Effect.andThen(client.ping())))
          .pipe(Effect.flip);
        assert.instanceOf(error, IsdsCredentialsError);
        assert.isFalse(called);

        yield* clients.use("b1", (client) => client.ping());
        yield* clients.use("b1", (client) => client.ping());
        assert.strictEqual(attempts, 2);
        assert.strictEqual(made.length, 1);
      }),
    ),
  );

  it.effect("fails a use whose stored credentials are unreadable, and uses them once they are readable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { clients, registry, made } = yield* setup([{ box: fakeBox("b1"), credentials: "unreadable" }]);

        const error = yield* clients.use("b1", (client) => client.ping()).pipe(Effect.flip);
        assert.instanceOf(error, BoxCredentialsUnreadable);
        assert.strictEqual(made.length, 0);

        const readable = passwordCredentials("user-b1");
        yield* registry.replaceCredentials("b1", readable);
        yield* clients.use("b1", (client) => client.ping());
        assert.strictEqual(made[0]?.credentials, readable);
      }),
    ),
  );

  for (const rebuild of [false, true]) {
    it.effect(`closes a box removed while its client is ${rebuild ? "rebuilt" : "first built"}, without another use`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const b1 = entry("b1");
          const replacement = passwordCredentials("user-b1", "new-secret");
          const building = yield* Deferred.make<void>();
          const proceed = yield* Deferred.make<void>();
          const gated = rebuild ? replacement : b1.credentials;
          const { clients, registry, nextClose } = yield* setup([b1], {
            afterMake: (config) =>
              config.credentials === gated
                ? Deferred.succeed(building, undefined).pipe(Effect.andThen(Deferred.await(proceed)))
                : Effect.void,
          });
          if (rebuild) {
            yield* clients.use("b1", (client) => client.ping());
            yield* registry.replaceCredentials("b1", replacement);
          }

          const a = yield* clients.use("b1", (client) => client.ping()).pipe(Effect.forkChild);
          yield* Deferred.await(building);
          if (rebuild) assert.strictEqual((yield* nextClose).credentials, b1.credentials);
          yield* registry.remove("b1");
          // Let the registry's change reach BoxClients while the client is still being built.
          yield* Effect.repeat(Effect.yieldNow, { times: 20 });

          yield* Deferred.succeed(proceed, undefined);
          yield* Fiber.join(a);
          assert.strictEqual((yield* nextClose).credentials, gated);
        }),
      ),
    );
  }

  it.effect("closes the transport of an interrupted build and builds again on the next use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const building = yield* Deferred.make<void>();
        let attempts = 0;
        const { clients, made, closed } = yield* setup([entry("b1")], {
          afterMake: () =>
            Effect.suspend(() => {
              attempts++;
              return attempts === 1 ? Deferred.succeed(building, undefined).pipe(Effect.andThen(Effect.never)) : Effect.void;
            }),
        });

        const a = yield* clients.use("b1", (client) => client.ping()).pipe(Effect.forkChild);
        yield* Deferred.await(building);
        yield* Fiber.interrupt(a);
        assert.strictEqual(closed.length, 1);

        yield* clients.use("b1", (client) => client.ping());
        yield* clients.use("b1", (client) => client.ping());
        assert.strictEqual(made.length, 2);
        assert.strictEqual(closed.length, 1);
      }),
    ),
  );

  it.effect("releases the box when a use is interrupted and keeps its client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { clients, made, closed } = yield* setup([entry("b1")]);
        const first = yield* holding();

        const a = yield* clients.use("b1", () => first.body([], "a")).pipe(Effect.forkChild);
        yield* Deferred.await(first.entered);
        yield* Fiber.interrupt(a);
        yield* clients.use("b1", (client) => client.ping());

        assert.strictEqual(made.length, 1);
        assert.strictEqual(closed.length, 0);
      }),
    ),
  );

  it.effect("closes every transport when the layer closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { clients, closed, closeLayer } = yield* setup([entry("b1"), entry("b2")]);
        yield* clients.use("b1", (client) => client.ping());
        yield* clients.use("b2", (client) => client.ping());
        assert.strictEqual(closed.length, 0);

        yield* closeLayer;

        assert.strictEqual(closed.length, 2);
      }),
    ),
  );

  it.effect("passes the callback's own error through and keeps the client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { clients, made, closed } = yield* setup([entry("b1")]);

        const error = yield* clients
          .use("b1", () => Effect.fail(new CallbackFailed({ reason: "nope" })))
          .pipe(Effect.flip);
        yield* clients.use("b1", (client) => client.ping());

        assert.instanceOf(error, CallbackFailed);
        assert.strictEqual(error.reason, "nope");
        assert.strictEqual(made.length, 1);
        assert.strictEqual(closed.length, 0);
      }),
    ),
  );
});
