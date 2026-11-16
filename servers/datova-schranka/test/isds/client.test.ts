import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { IsdsClient } from "../../src/isds/client.js";
import { IsdsTimeoutError } from "../../src/isds/errors.js";
import { dmStatus, fakeTransport, ok, soapResponse } from "./fake-transport.js";

describe("IsdsClient", () => {
  it.effect("runs operations over the provided transport", () =>
    Effect.gen(function* () {
      const transport = fakeTransport((request) =>
        Effect.succeed(ok(soapResponse(request.operation, dmStatus("0000")))),
      );
      const records = yield* Effect.gen(function* () {
        const client = yield* IsdsClient;
        yield* client.ping();
        return yield* client.listSentMessages({ states: [5, 6] });
      }).pipe(Effect.provide(IsdsClient.Default.pipe(Layer.provide(transport.layer))));
      assert.deepStrictEqual(records, []);
      assert.deepStrictEqual(
        transport.requests.map((request) => [request.service, request.operation]),
        [
          ["operations", "DummyOperation"],
          ["info", "GetListOfSentMessages"],
        ],
      );
    }),
  );

  it.effect("passes a CreateMessage timeout through unchanged", () =>
    Effect.gen(function* () {
      const timeout = new IsdsTimeoutError({ service: "operations", operation: "CreateMessage", timeoutMillis: 5, requestSent: true });
      const transport = fakeTransport(() => Effect.fail(timeout));
      const error = yield* Effect.gen(function* () {
        const client = yield* IsdsClient;
        return yield* client.createMessage({
          dbIDRecipient: "abc1234",
          dmAnnotation: "Test",
          dmFiles: [{ content: new Uint8Array([1]), dmMimeType: "application/pdf", dmFileMetaType: "main", dmFileDescr: "a.pdf" }],
        });
      }).pipe(Effect.provide(IsdsClient.Default.pipe(Layer.provide(transport.layer))), Effect.flip);
      assert.strictEqual(error, timeout);
    }),
  );
});
