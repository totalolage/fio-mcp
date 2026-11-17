import { Effect, Layer, Stream } from "effect";
import { type Box, BoxRegistry } from "../../../src/domain/boxes.js";
import { BoxNotFound } from "../../../src/domain/errors.js";

/** A BoxRegistry holding only `box`; `get` of any other id fails BoxNotFound, the rest is unused. */
export const readBoxRegistry = (box: Box) => {
  const unused = Effect.die("read-box-registry: not used by ReadService");
  return Layer.succeed(
    BoxRegistry,
    BoxRegistry.of({
      list: unused,
      changes: Stream.empty,
      skipped: unused,
      get: (boxId) => (boxId === box.id ? Effect.succeed(box) : Effect.fail(new BoxNotFound({ boxId }))),
      add: () => unused,
      relabel: () => unused,
      replaceCredentials: () => unused,
      testConnection: () => unused,
      remove: () => unused,
      credentials: () => unused,
    }),
  );
};

/** A loaded test box with this id and dbID. */
export const readTestBox = (id: string, dbId: string): Box => ({
  id,
  dbId,
  label: "Test box",
  environment: "test",
  boxType: "OVM",
  authKind: "password",
  owner: { dbID: dbId },
  createdAt: 0,
  updatedAt: 0,
});
