import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import { type StoredZfo, ZfoStore } from "../../../src/domain/zfo-store.js";

export interface ReadZfoWrite {
  readonly dbId: string;
  readonly dmId: string;
  readonly bytes: Uint8Array;
}

/** A ZfoStore that records writes and answers `<dbId>/<dmId>.zfo` with the bytes' SHA-256. */
export const readZfoStore = (log: Array<string>) => {
  const writes: Array<ReadZfoWrite> = [];
  const layer = Layer.succeed(
    ZfoStore,
    ZfoStore.of({
      write: (dbId, dmId, bytes) =>
        Effect.sync((): StoredZfo => {
          writes.push({ dbId, dmId, bytes });
          log.push(`zfo.write ${dbId}/${dmId}`);
          return {
            ref: `${dbId}/${dmId}.zfo`,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.byteLength,
          };
        }),
    }),
  );
  return { layer, writes };
};
