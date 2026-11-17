import { ConfigError } from "@mcps/core/config/env.js";
import { sqliteDatabase } from "@mcps/core/sqlite.js";
import { Clock, Effect, Layer, Redacted, Result } from "effect";
import { SqlClient } from "effect/sql";
import { AppConfig } from "../config.js";
import { BoxRegistry } from "../domain/boxes.js";
import { DataKey } from "../domain/config.js";
import { storeFailure } from "../domain/errors.js";
import { openText, sealText } from "../domain/sealed.js";
import { APP_MIGRATIONS, MIGRATIONS_TABLE } from "./migrations.js";

/** The database at DATOVA_SCHRANKA_DB_PATH, created private (dir 0700, file 0600) and migrated to APP_MIGRATIONS. */
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return sqliteDatabase({
      filename: config.dbPath,
      table: MIGRATIONS_TABLE,
      migrations: APP_MIGRATIONS,
      onFailure: storeFailure,
    });
  }),
);

/** server_settings key: the ISDS environment the database (and its ZFO store) belongs to (D1). */
export const ISDS_ENVIRONMENT_SETTING = "isds_environment";
/** server_settings key: a fixed value sealed with the data key at first start (D3). */
export const DATA_KEY_CHECK_SETTING = "data_key_check";

const DATA_KEY_CHECK_AAD = "datova-schranka:data-key-check:v1";
const DATA_KEY_CHECK_VALUE = "datova-schranka data key check v1";

const ENVIRONMENT_VARIABLE = "DATOVA_SCHRANKA_ISDS_ENVIRONMENT";
const DATA_KEY_VARIABLE = "DATOVA_SCHRANKA_DATA_KEY_FILE";

/** Environments are not secrets, but the stored one is only named when it is one we write. */
const describeStored = (value: string): string =>
  value === "production" || value === "test" ? value : "an unknown environment";

/**
 * Binds the database to this configuration, or refuses to start (D1, D3).
 * First start stores the ISDS environment and a check value sealed with the
 * data key, together in one transaction. Every start then requires the stored
 * environment to equal DATOVA_SCHRANKA_ISDS_ENVIRONMENT and the data key to
 * open the check value. Writes only what is absent (INSERT … DO NOTHING) and
 * verifies what is stored, so two first starts racing cannot bind the
 * database to two keys. Run it before anything opens sealed data (BoxRegistry
 * fails on credentials it cannot open, with a less helpful message).
 */
export const checkDatabaseBinding = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* AppConfig;
  const { key } = yield* DataKey;
  const environment = config.domain.environment;
  const sealed = yield* sealText(key, DATA_KEY_CHECK_VALUE, DATA_KEY_CHECK_AAD);
  /** The refusal for what is stored, if any; runs inside the transaction so a refusal writes nothing. */
  const refusal = (stored: ReadonlyArray<{ readonly key: string; readonly value: string }>) => {
    const value = (name: string) => stored.find((row) => row.key === name)?.value ?? "";
    const storedEnvironment = value(ISDS_ENVIRONMENT_SETTING);
    if (storedEnvironment !== environment) {
      return new ConfigError({
        detail: `${ENVIRONMENT_VARIABLE} is ${environment} but this database belongs to ${describeStored(storedEnvironment)}; a database and its ZFO store serve one ISDS environment, so use the database made for ${environment} or set ${ENVIRONMENT_VARIABLE} back`,
      });
    }
    const opened = openText(key, value(DATA_KEY_CHECK_SETTING), DATA_KEY_CHECK_AAD);
    if (!(Result.isSuccess(opened) && Redacted.value(opened.success) === DATA_KEY_CHECK_VALUE)) {
      return new ConfigError({
        detail: `${DATA_KEY_VARIABLE}: the data key does not match this database; use the key the database was created with`,
      });
    }
    return undefined;
  };
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO server_settings (key, value, updated_at)
          VALUES (${ISDS_ENVIRONMENT_SETTING}, ${environment}, ${now}), (${DATA_KEY_CHECK_SETTING}, ${sealed}, ${now})
          ON CONFLICT (key) DO NOTHING`;
        const stored = yield* sql<{ readonly key: string; readonly value: string }>`SELECT key, value FROM server_settings
          WHERE key = ${ISDS_ENVIRONMENT_SETTING} OR key = ${DATA_KEY_CHECK_SETTING}`;
        const refused = refusal(stored);
        if (refused !== undefined) return yield* refused;
      }),
    )
    .pipe(
      Effect.catchTag("SqlError", (cause) => storeFailure("check the database settings")(Effect.fail(cause))),
    );
});

/** The database checked against this configuration: anything built on it starts only after checkDatabaseBinding passed. */
export const CheckedDatabaseLive = Layer.effectDiscard(checkDatabaseBinding).pipe(Layer.provideMerge(DatabaseLive));

/**
 * One warning when boxes stored under another ISDS environment were not
 * loaded (R6), naming their labels and environments only.
 */
export const warnSkippedBoxes = Effect.gen(function* () {
  const registry = yield* BoxRegistry;
  const skipped = yield* registry.skipped;
  if (skipped.length === 0) return;
  const config = yield* AppConfig;
  const boxes = skipped.map((box) => `${JSON.stringify(box.label)} (${box.environment})`).join(", ");
  yield* Effect.logWarning(
    `${skipped.length === 1 ? "1 box was" : `${skipped.length} boxes were`} not loaded because ${ENVIRONMENT_VARIABLE} is ${config.domain.environment}: ${boxes}`,
  );
});

/** warnSkippedBoxes as a layer, built once the BoxRegistry is. */
export const SkippedBoxesWarningLive = Layer.effectDiscard(warnSkippedBoxes);
