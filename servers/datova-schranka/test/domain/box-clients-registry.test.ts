import { assert, describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Duration, Effect, Fiber, Layer, Scheduler } from "effect";
import { BoxClients } from "../../src/domain/box-clients.js";
import { DomainConfig } from "../../src/domain/config.js";
import { memoryDatabase } from "./support/database.js";
import { loginKey, loginResponder, passwordCredentials } from "./support/fake-isds.js";
import { startRegistry } from "./support/registry-harness.js";

/** BoxClients over the real registry: the credentials-reference agreement holds across the seam. */
describe("BoxClients over BoxRegistry", () => {
  it.effect("reuses one client, switches to replaced credentials and refuses a removed box", () =>
    Effect.gen(function* () {
      const { registry, context, isds } = yield* startRegistry({ logins: { alice: "aaa1111", "alice-again": "aaa1111" } });
      const clients = Context.get(
        yield* Layer.build(
          BoxClients.Default.pipe(
            Layer.provide(Layer.succeedContext(context)),
            Layer.provide(isds.layer),
            Layer.provide(DomainConfig.layer({ dataDir: "/nonexistent", requestTimeout: Duration.seconds(7) })),
          ),
        ),
        BoxClients,
      );
      const box = yield* registry.add({ label: "Office", environment: "production", credentials: passwordCredentials("alice") });
      const pingers = () => isds.requests.filter(({ request }) => request.operation === "DummyOperation");
      const madeBefore = isds.made.length;

      yield* clients.use(box.id, (client) => client.ping());
      yield* clients.use(box.id, (client) => client.ping());
      expect(isds.made.length - madeBefore).toBe(1);
      expect(isds.made.slice(madeBefore).map((config) => [config.environment, Duration.toMillis(config.requestTimeout)])).toEqual([
        ["production", 7_000],
      ]);

      yield* registry.replaceCredentials(box.id, passwordCredentials("alice-again"));
      yield* clients.use(box.id, (client) => client.ping());
      expect(pingers().map(({ config }) => loginKey(config.credentials))).toEqual(["alice", "alice", "alice-again"]);

      yield* registry.remove(box.id);
      const error = yield* clients.use(box.id, (client) => client.ping()).pipe(Effect.flip);
      expect(error._tag).toBe("BoxNotFound");
      expect(yield* registry.list).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(memoryDatabase())),
  );

  it.effect("runs the registry's login and connection test under the box's permit, not another box's", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const logins = { alice: "aaa1111", "alice-again": "aaa1111", bob: "bbb2222", "bob-again": "bbb2222" };
      const respond = loginResponder(logins);
      const { registry, context, isds } = yield* startRegistry({
        respond: (config, request) => {
          events.push(`${request.operation}:${loginKey(config.credentials)}`);
          return respond(config, request);
        },
      });
      const clients = Context.get(
        yield* Layer.build(
          BoxClients.Default.pipe(
            Layer.provide(Layer.succeedContext(context)),
            Layer.provide(isds.layer),
            Layer.provide(DomainConfig.layer({ dataDir: "/nonexistent" })),
          ),
        ),
        BoxClients,
      );
      const alice = yield* registry.add({ label: "Alice", environment: "production", credentials: passwordCredentials("alice") });
      const bob = yield* registry.add({ label: "Bob", environment: "production", credentials: passwordCredentials("bob") });
      events.length = 0;

      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const held = yield* clients
        .use(alice.id, () =>
          Effect.sync(() => events.push("held:start")).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => events.push("held:end"))),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);

      // With yields prevented, each contender gives control back only at an async point: the
      // box's permit, or, were it not taken, nowhere before the fake transport (SQLite in memory
      // and the fake transport run synchronously, without a timer).
      const contend = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.provideService(Scheduler.PreventSchedulerYield, true),
          Effect.forkChild({ startImmediately: true }),
        );
      const replacing = yield* contend(registry.replaceCredentials(alice.id, passwordCredentials("alice-again")));
      const testing = yield* contend(registry.testConnection(alice.id));

      // Bob's box is not held up by Alice's call in flight.
      yield* registry.replaceCredentials(bob.id, passwordCredentials("bob-again"));
      yield* registry.testConnection(bob.id);
      assert.deepStrictEqual(events, ["held:start", "GetOwnerInfoFromLogin:bob-again", "DummyOperation:bob-again"]);
      assert.isUndefined(replacing.pollUnsafe());
      assert.isUndefined(testing.pollUnsafe());

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(held);
      yield* Fiber.join(replacing);
      yield* Fiber.join(testing);
      assert.deepStrictEqual(events.slice(0, 4), [
        "held:start",
        "GetOwnerInfoFromLogin:bob-again",
        "DummyOperation:bob-again",
        "held:end",
      ]);
      // Each contender ran alone after the held use; the ping uses whichever credentials were current.
      const rest = events.slice(4);
      expect(rest).toHaveLength(2);
      expect(rest).toContain("GetOwnerInfoFromLogin:alice-again");
      expect(rest.filter((event) => event.startsWith("DummyOperation:alice"))).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(memoryDatabase())),
  );
});
