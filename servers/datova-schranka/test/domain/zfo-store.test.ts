import { createHash } from "node:crypto";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { DomainConfig } from "../../src/domain/config.js";
import { InvalidIdentifier } from "../../src/domain/errors.js";
import { ZfoStore, ZfoWriteFailed } from "../../src/domain/zfo-store.js";

const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Runs `body` with a ZfoStore over `<fresh temp dir>/data`; the temp dir is removed afterwards. */
const withStore = <A, E>(
  body: (paths: { readonly root: string; readonly dataDir: string }) => Effect.Effect<A, E, ZfoStore | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "zfo-store-" });
    const dataDir = join(root, "data");
    return yield* body({ root, dataDir }).pipe(
      Effect.provide(ZfoStore.Default.pipe(Layer.provide(DomainConfig.layer({ dataDir })))),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

const permissions = (mode: number) => mode & 0o777;

describe("ZfoStore", () => {
  it.effect("writes <dataDir>/<dbID>/<dmID>.zfo with file 0600 and directory 0700", () =>
    withStore(({ dataDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ZfoStore;
        const bytes = bytesOf("signed message");
        const stored = yield* store.write("abc1234", "12345678901234567890", bytes);
        assert.deepStrictEqual(stored, { ref: "abc1234/12345678901234567890.zfo", sha256: sha256(bytes), bytes: bytes.byteLength });

        const file = join(dataDir, stored.ref);
        assert.deepStrictEqual(yield* fs.readFile(file), bytes);
        assert.strictEqual(permissions((yield* fs.stat(file)).mode), 0o600);
        assert.strictEqual(permissions((yield* fs.stat(join(dataDir, "abc1234"))).mode), 0o700);
        assert.deepStrictEqual(yield* fs.readDirectory(join(dataDir, "abc1234")), ["12345678901234567890.zfo"]);
      }),
    ),
  );

  it.effect("replaces an earlier download and tightens an existing directory", () =>
    withStore(({ dataDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ZfoStore;
        yield* fs.makeDirectory(join(dataDir, "abc1234"), { recursive: true });
        yield* fs.chmod(join(dataDir, "abc1234"), 0o755);
        yield* store.write("abc1234", "1", bytesOf("first, longer content"));
        const second = bytesOf("second");
        const stored = yield* store.write("abc1234", "1", second);
        assert.deepStrictEqual(stored, { ref: "abc1234/1.zfo", sha256: sha256(second), bytes: 6 });
        assert.deepStrictEqual(yield* fs.readFile(join(dataDir, "abc1234", "1.zfo")), second);
        assert.strictEqual(permissions((yield* fs.stat(join(dataDir, "abc1234"))).mode), 0o700);
        assert.deepStrictEqual(yield* fs.readDirectory(join(dataDir, "abc1234")), ["1.zfo"]);
      }),
    ),
  );

  it.effect("rejects malformed ids before touching the filesystem", () =>
    withStore(({ root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ZfoStore;
        const cases: ReadonlyArray<readonly [string, string, "dataBoxId" | "messageId"]> = [
          ["../x", "1", "dataBoxId"],
          ["ABC1234", "1", "dataBoxId"],
          ["abc12345", "1", "dataBoxId"],
          ["abc123", "1", "dataBoxId"],
          ["", "1", "dataBoxId"],
          ["abc/234", "1", "dataBoxId"],
          ["abc1234", "12a", "messageId"],
          ["abc1234", "", "messageId"],
          ["abc1234", "../1", "messageId"],
          ["abc1234", "123456789012345678901", "messageId"],
          ["abc1234", "1/../../x", "messageId"],
        ];
        for (const [dbId, dmId, kind] of cases) {
          const error = yield* Effect.flip(store.write(dbId, dmId, bytesOf("x")));
          assert.instanceOf(error, InvalidIdentifier, `${dbId} ${dmId}`);
          assert.strictEqual((error as InvalidIdentifier).kind, kind, `${dbId} ${dmId}`);
        }
        // Not even the data directory was created.
        assert.deepStrictEqual(yield* fs.readDirectory(root), []);
      }),
    ),
  );

  it.effect("fails with ZfoWriteFailed and leaves no temp file when the write fails", () =>
    withStore(({ dataDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ZfoStore;
        // A directory where the file should go makes the rename fail after the temp file is written.
        yield* fs.makeDirectory(join(dataDir, "abc1234", "7.zfo", "occupied"), { recursive: true });
        const error = yield* Effect.flip(store.write("abc1234", "7", bytesOf("x")));
        assert.instanceOf(error, ZfoWriteFailed);
        assert.strictEqual((error as ZfoWriteFailed).ref, "abc1234/7.zfo");
        assert.deepStrictEqual(yield* fs.readDirectory(join(dataDir, "abc1234")), ["7.zfo"]);
      }),
    ),
  );
});
