import { describe, expect, it } from "@effect/vitest";
import { Context, Duration, Effect, Layer } from "effect";
import { BoxClients } from "../../src/domain/box-clients.js";
import { DomainConfig } from "../../src/domain/config.js";
import { memoryDatabase } from "./support/database.js";
import { loginKey, passwordCredentials } from "./support/fake-isds.js";
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
});
