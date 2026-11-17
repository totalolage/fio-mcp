import { Context, type Effect, Schema } from "effect";
import type { InvalidIdentifier } from "./errors.js";

/**
 * Signed messages (ZFO) on the data volume: `<dataDir>/<dbID>/<dmID>.zfo`,
 * directories 0700, files 0600, written atomically (temp file + rename).
 * Both ids are validated (dbID /^[a-z0-9]{7}$/, dmID /^[0-9]{1,20}$/)
 * before any path is built. A repeated download replaces the file. Files
 * stay until removed by hand.
 */
export interface StoredZfo {
  /** `<dbID>/<dmID>.zfo`, relative to the data directory. */
  readonly ref: string;
  /** Hex SHA-256 of the bytes written. */
  readonly sha256: string;
  readonly bytes: number;
}

export class ZfoWriteFailed extends Schema.TaggedError<ZfoWriteFailed>()("ZfoWriteFailed", {
  ref: Schema.String,
}) {
  override get message(): string {
    return `The signed message ${this.ref} could not be stored.`;
  }
}

export interface ZfoStoreShape {
  readonly write: (dbId: string, dmId: string, bytes: Uint8Array) => Effect.Effect<StoredZfo, InvalidIdentifier | ZfoWriteFailed>;
}

export class ZfoStore extends Context.Service<ZfoStore, ZfoStoreShape>()("datova-schranka/ZfoStore") {}
