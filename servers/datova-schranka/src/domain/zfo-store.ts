import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { DomainConfig } from "./config.js";
import { InvalidIdentifier } from "./errors.js";
import { isDataBoxId, isMessageId } from "./ids.js";

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

export class ZfoStore extends Context.Service<ZfoStore, ZfoStoreShape>()("datova-schranka/ZfoStore") {
  /** Writes under `DomainConfig.dataDir` through the provided FileSystem. */
  static readonly Default: Layer.Layer<ZfoStore, never, DomainConfig | FileSystem.FileSystem> = Layer.effect(
    ZfoStore,
    Effect.suspend(() => makeZfoStore),
  );
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const makeZfoStore = Effect.gen(function* () {
  const config = yield* DomainConfig;
  const fs = yield* FileSystem.FileSystem;

  const write: ZfoStoreShape["write"] = Effect.fn("ZfoStore.write")(function* (
    dbId: string,
    dmId: string,
    bytes: Uint8Array,
  ) {
    // Both ids become path segments: check them before any path is built.
    if (!isDataBoxId(dbId)) {
      return yield* new InvalidIdentifier({ kind: "dataBoxId", rule: "7 lowercase letters or digits" });
    }
    if (!isMessageId(dmId)) {
      return yield* new InvalidIdentifier({ kind: "messageId", rule: "1-20 digits" });
    }
    const ref = `${dbId}/${dmId}.zfo`;
    const directory = join(config.dataDir, dbId);
    const target = join(directory, `${dmId}.zfo`);
    // In the target directory so the rename stays on one filesystem; the dot keeps it out of `*.zfo`.
    const temp = join(directory, `.${dmId}.zfo.${randomBytes(8).toString("hex")}.tmp`);
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true, mode: DIRECTORY_MODE });
      // makeDirectory leaves an existing directory's mode alone, and the umask narrows a new one.
      yield* fs.chmod(directory, DIRECTORY_MODE);
      yield* fs.writeFile(temp, bytes, { flag: "wx", mode: FILE_MODE });
      yield* fs.chmod(temp, FILE_MODE);
      yield* fs.rename(temp, target);
    }).pipe(
      Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore)),
      Effect.catch((cause) =>
        Effect.logError("datova-schranka: failed to store a signed message", cause).pipe(
          Effect.annotateLogs({ ref }),
          Effect.andThen(Effect.fail(new ZfoWriteFailed({ ref }))),
        ),
      ),
    );
    return { ref, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
  });

  return ZfoStore.of({ write });
});
