import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { CommandFailed } from "./io.js";

const failed = (step: string) => () => new CommandFailed({ message: `backup failed: could not ${step}` });

/**
 * `datova-schranka backup <dest>`: writes a consistent copy of the live
 * database to `destination` with `VACUUM INTO` (safe while the server writes
 * through WAL), like Fio's. The destination must not exist; it is created
 * 0600. The copy holds sealed credentials (open only with the data key) and
 * not the ZFO files in DATOVA_SCHRANKA_DATA_DIR.
 */
export const backupDatabase = Effect.fn("cli.backup")(function* (destination: string) {
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const exists = yield* fs.exists(destination).pipe(Effect.mapError(failed("check the backup destination")));
  if (exists) return yield* new CommandFailed({ message: `backup destination ${destination} already exists` });
  yield* fs
    .writeFileString(destination, "", { flag: "wx", mode: 0o600 })
    .pipe(Effect.mapError(failed("create the backup file")));
  yield* sql`VACUUM INTO ${destination}`.pipe(Effect.mapError(failed("write the backup")));
  yield* fs.chmod(destination, 0o600).pipe(Effect.mapError(failed("restrict the backup file")));
  const info = yield* fs.stat(destination).pipe(Effect.mapError(failed("read the backup file")));
  return { destination, bytes: Number(info.size) };
});
