import { Redactor } from "@mcps/core/redaction.js";
import { type Resource, Resources } from "@mcps/core/resources.js";
import { Clock, Context, Effect, Layer, Redacted, Result, Schema, Semaphore, Stream, SubscriptionRef } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { IsdsCredentials, type IsdsEnvironment } from "../isds/config.js";
import { DataBoxOwnerInfo } from "../isds/databox.js";
import {
  type IsdsCallError,
  type IsdsConfigError,
  type IsdsCredentialsError,
  IsdsInvalidRequest,
  IsdsInvalidResponse,
} from "../isds/errors.js";
import { BoxLocks } from "./box-locks.js";
import { DataKey, DomainConfig } from "./config.js";
import { BoxNotFound, type DomainStoreError, InvalidIdentifier, storeFailure } from "./errors.js";
import { isDataBoxId, newBoxId } from "./ids.js";
import { boxClientConfig, IsdsTransports, makeIsdsClient } from "./isds-transports.js";
import { boxCredentialsAad, openText, sealText } from "./sealed.js";

/**
 * The registry of stored data boxes. Each add gets a fresh opaque id (the
 * grant key); the ISDS dbID is stored beside it and is unique among stored
 * boxes. Credentials are sealed at rest with AAD
 * datova-schranka:box-credentials:v1:<id>.
 */

export type BoxAuthKind = "certificate" | "password";

export interface Box {
  /** Opaque, random per add; what grants store. Never the dbID. */
  readonly id: string;
  /** The ISDS data box id (7 characters). */
  readonly dbId: string;
  /** Unique among stored boxes ignoring case after trimming. */
  readonly label: string;
  readonly environment: IsdsEnvironment;
  readonly boxType: string | undefined;
  readonly authKind: BoxAuthKind;
  /** GetOwnerInfoFromLogin's answer when the box was added or its credentials replaced. */
  readonly owner: DataBoxOwnerInfo;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A stored box this process does not load: it was added under the other ISDS environment. */
export interface SkippedBox {
  readonly id: string;
  readonly dbId: string;
  readonly label: string;
  readonly environment: IsdsEnvironment;
}

export interface AddBoxInput {
  readonly label: string;
  /** Must equal the configured environment; a box is only usable there. */
  readonly environment: IsdsEnvironment;
  readonly credentials: IsdsCredentials;
}

/** Another stored box already has this label (case-insensitive, trimmed). */
export class BoxLabelTaken extends Schema.TaggedError<BoxLabelTaken>()("BoxLabelTaken", {
  label: Schema.String,
}) {
  override get message(): string {
    return `A data box labelled "${this.label}" already exists.`;
  }
}

/** The credentials resolve to a dbID that is already stored (under `existingBoxId`). */
export class BoxAlreadyAdded extends Schema.TaggedError<BoxAlreadyAdded>()("BoxAlreadyAdded", {
  dbId: Schema.String,
  existingBoxId: Schema.String,
}) {
  override get message(): string {
    return `Data box ${this.dbId} is already added.`;
  }
}

/** Replacement credentials belong to a different data box than the stored one. */
export class BoxIdentityMismatch extends Schema.TaggedError<BoxIdentityMismatch>()("BoxIdentityMismatch", {
  boxId: Schema.String,
  expectedDbId: Schema.String,
  actualDbId: Schema.String,
}) {
  override get message(): string {
    return `The new credentials log in to data box ${this.actualDbId}, not ${this.expectedDbId}; add it as a new box instead.`;
  }
}

/** The requested environment is not the one this server is configured for. */
export class BoxEnvironmentMismatch extends Schema.TaggedError<BoxEnvironmentMismatch>()("BoxEnvironmentMismatch", {
  requested: Schema.String,
  configured: Schema.String,
}) {
  override get message(): string {
    return `This server talks to the ISDS ${this.configured} environment; a ${this.requested} box cannot be added.`;
  }
}

/** A stored box's credentials did not decrypt (wrong data key, or an altered or moved row). */
export class BoxCredentialsUnreadable extends Schema.TaggedError<BoxCredentialsUnreadable>()(
  "BoxCredentialsUnreadable",
  { boxId: Schema.String },
) {
  override get message(): string {
    return `The stored credentials of data box ${this.boxId} could not be decrypted: the data key changed or the row was altered.`;
  }
}

/** What logging in with the given credentials can fail with (GetOwnerInfoFromLogin or DummyOperation). */
export type BoxLoginError = IsdsCredentialsError | IsdsConfigError | IsdsCallError;

export interface RemovedBox {
  readonly box: Box;
  /** Open filings (awaiting_approval / pending_admin) moved to expired. */
  readonly expiredFilings: number;
}

export interface BoxRegistryShape {
  /** Loaded boxes in creation order; the same array value until a change. */
  readonly list: Effect.Effect<ReadonlyArray<Box>>;
  /** The current list, then every new one. */
  readonly changes: Stream.Stream<ReadonlyArray<Box>>;
  /**
   * Stored boxes not loaded because their environment differs from the configured one.
   * This process cannot relabel, re-credential, test or remove them; restart the server
   * under the box's original environment to administer one.
   */
  readonly skipped: Effect.Effect<ReadonlyArray<SkippedBox>>;
  readonly get: (boxId: string) => Effect.Effect<Box, BoxNotFound>;
  /** Logs in (GetOwnerInfoFromLogin), then stores the box under a new id. */
  readonly add: (
    input: AddBoxInput,
  ) => Effect.Effect<
    Box,
    InvalidIdentifier | BoxLabelTaken | BoxAlreadyAdded | BoxEnvironmentMismatch | BoxLoginError | DomainStoreError
  >;
  readonly relabel: (
    boxId: string,
    label: string,
  ) => Effect.Effect<Box, BoxNotFound | InvalidIdentifier | BoxLabelTaken | DomainStoreError>;
  /**
   * Logs in with the new credentials, under the box's BoxLocks permit; they must resolve to
   * the same dbID. Keeps the id (grants keep the box).
   */
  readonly replaceCredentials: (
    boxId: string,
    credentials: IsdsCredentials,
  ) => Effect.Effect<Box, BoxNotFound | BoxIdentityMismatch | BoxLoginError | DomainStoreError>;
  /** DummyOperation with the stored credentials, under the box's BoxLocks permit. */
  readonly testConnection: (boxId: string) => Effect.Effect<void, BoxNotFound | BoxCredentialsUnreadable | BoxLoginError>;
  /** Deletes the box, its credentials and recipient tiers; expires its open filings; keeps audit rows. */
  readonly remove: (boxId: string) => Effect.Effect<RemovedBox, BoxNotFound | DomainStoreError>;
  /**
   * The box's decrypted credentials, for BoxClients. Returns the same object
   * on every call until the box's credentials are replaced (decrypted once at
   * load, add or replace), so callers may key caches on the reference.
   */
  readonly credentials: (boxId: string) => Effect.Effect<IsdsCredentials, BoxNotFound | BoxCredentialsUnreadable>;
}

/** The label rule (before trimming): 1-64 code points after trimming, nothing invisible. Same as Fio's account names. */
const LABEL_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const LABEL_RULE = "1-64 characters after trimming, no control or invisible characters";

/** Labels are unique ignoring case after trimming. */
const labelKey = (label: string): string => label.trim().toLowerCase();

/** The trimmed label, or InvalidIdentifier. */
const checkLabel = (label: string): Effect.Effect<string, InvalidIdentifier> => {
  const trimmed = label.trim();
  const length = Array.from(trimmed).length;
  return LABEL_INVISIBLE.test(label) || length < 1 || length > 64
    ? Effect.fail(new InvalidIdentifier({ kind: "label", rule: LABEL_RULE }))
    : Effect.succeed(trimmed);
};

const authKindOf = (credentials: IsdsCredentials): BoxAuthKind =>
  credentials._tag === "SystemCertificate" ? "certificate" : "password";

/** The values the Redactor must hide: the password or the PKCS#12 passphrase. */
const secretsOf = (credentials: IsdsCredentials): ReadonlyArray<string> =>
  IsdsCredentials.$match(credentials, {
    SystemCertificate: ({ passphrase }) => [Redacted.value(passphrase)],
    Password: ({ password }) => [Redacted.value(password)],
  });

/** The plaintext inside `credentials_sealed`: JSON, the PKCS#12 archive as base64. */
const StoredCredentials = Schema.Union([
  Schema.TaggedStruct("certificate", { pkcs12: Schema.String, passphrase: Schema.String }),
  Schema.TaggedStruct("password", { username: Schema.String, password: Schema.String }),
]);
const decodeStoredCredentials = Schema.decodeUnknownResult(Schema.fromJsonString(StoredCredentials));

const credentialsJson = (credentials: IsdsCredentials): string =>
  JSON.stringify(
    IsdsCredentials.$match(credentials, {
      SystemCertificate: ({ pkcs12, passphrase }) => ({
        _tag: "certificate",
        pkcs12: Buffer.from(pkcs12).toString("base64"),
        passphrase: Redacted.value(passphrase),
      }),
      Password: ({ username, password }) => ({ _tag: "password", username, password: Redacted.value(password) }),
    }),
  );

const credentialsOfStored = (stored: typeof StoredCredentials.Type): IsdsCredentials =>
  stored._tag === "certificate"
    ? IsdsCredentials.SystemCertificate({
        pkcs12: new Uint8Array(Buffer.from(stored.pkcs12, "base64")),
        passphrase: Redacted.make(stored.passphrase),
      })
    : IsdsCredentials.Password({ username: stored.username, password: Redacted.make(stored.password) });

const OwnerJson = Schema.fromJsonString(DataBoxOwnerInfo);
const encodeOwner = Schema.encodeEffect(OwnerJson);
const decodeOwner = Schema.decodeUnknownEffect(OwnerJson);

const BoxRow = Schema.Struct({
  id: Schema.String,
  db_id: Schema.String,
  label: Schema.String,
  environment: Schema.Literals(["production", "test"]),
  box_type: Schema.NullOr(Schema.String),
  auth_kind: Schema.Literals(["certificate", "password"]),
  owner_json: Schema.String,
  credentials_sealed: Schema.String,
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
});
type BoxRow = typeof BoxRow.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(BoxRow));

const OPEN_FILING_STATES = ["awaiting_approval", "pending_admin"] as const;

const isSqlError = (error: unknown): error is SqlError.SqlError => error instanceof SqlError.SqlError;
const isUniqueViolation = (error: unknown): error is SqlError.SqlError =>
  isSqlError(error) && error.reason._tag === "UniqueViolation";

/**
 * GetOwnerInfoFromLogin and DummyOperation take no input, so an
 * IsdsInvalidRequest from them is a bug, not a login failure.
 */
const noInvalidRequest = <A, E, R>(effect: Effect.Effect<A, E | IsdsInvalidRequest, R>) =>
  Effect.catchIf(effect, (error): error is IsdsInvalidRequest => error instanceof IsdsInvalidRequest, Effect.die);

interface Entry {
  readonly box: Box;
  /** Built once per load, add or replace: `credentials()` hands out this reference. */
  readonly credentials: IsdsCredentials;
}

const makeBoxRegistry = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { key } = yield* DataKey;
  const config = yield* DomainConfig;
  const transports = yield* IsdsTransports;
  const redactor = yield* Redactor;
  const locks = yield* BoxLocks;

  const rows = yield* sql`SELECT * FROM boxes ORDER BY created_at, rowid`.pipe(
    Effect.flatMap(decodeRows),
    storeFailure("load the data boxes"),
  );

  const loadEntry = Effect.fn("BoxRegistry.loadEntry")(function* (row: BoxRow) {
    const opened = openText(key, row.credentials_sealed, boxCredentialsAad(row.id));
    const stored = Result.flatMap(opened, (plaintext) =>
      Result.mapError(decodeStoredCredentials(Redacted.value(plaintext)), () => "invalid" as const),
    );
    if (Result.isFailure(stored)) return yield* new BoxCredentialsUnreadable({ boxId: row.id });
    const owner = yield* decodeOwner(row.owner_json).pipe(storeFailure(`read the owner of data box ${row.id}`));
    const box: Box = {
      id: row.id,
      dbId: row.db_id,
      label: row.label,
      environment: row.environment,
      boxType: row.box_type ?? undefined,
      authKind: row.auth_kind,
      owner,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return { box, credentials: credentialsOfStored(stored.success) } satisfies Entry;
  });

  // Skipped boxes stay in the database untouched; they are administered by
  // restarting the server under their original environment.
  const skipped: ReadonlyArray<SkippedBox> = rows
    .filter((row) => row.environment !== config.environment)
    .map((row) => ({ id: row.id, dbId: row.db_id, label: row.label, environment: row.environment }));
  if (skipped.length > 0) {
    yield* Effect.logWarning(
      `datova-schranka: ${skipped.length} stored data boxes belong to another ISDS environment than ${config.environment} and are not loaded`,
      skipped.map((box) => `${box.id} (${box.dbId}, ${box.environment})`),
    );
  }

  const initial = yield* Effect.forEach(
    rows.filter((row) => row.environment === config.environment),
    loadEntry,
  );
  const entries = new Map<string, Entry>(initial.map((entry) => [entry.box.id, entry]));
  redactor.register(initial.flatMap((entry) => secretsOf(entry.credentials)));
  yield* Effect.logInfo(`datova-schranka: ${initial.length} data boxes loaded`);

  const current = yield* SubscriptionRef.make<ReadonlyArray<Box>>(initial.map((entry) => entry.box));
  const lock = yield* Semaphore.make(1);
  /**
   * Runs one change alone and uninterruptibly, so a committed write is
   * always published to `entries` and `current`. Only database work goes
   * here; logins happen before.
   */
  const exclusive = <A, E, R>(change: Effect.Effect<A, E, R>) =>
    Semaphore.withPermit(lock)(Effect.uninterruptible(change));

  const find = (boxId: string): Effect.Effect<Entry, BoxNotFound> =>
    Effect.suspend(() => {
      const entry = entries.get(boxId);
      return entry === undefined ? Effect.fail(new BoxNotFound({ boxId })) : Effect.succeed(entry);
    });

  /** Records a stored change in memory and publishes the new list. */
  const commit = (boxId: string, entry: Entry | undefined) =>
    Effect.suspend(() => {
      const known = entries.has(boxId);
      if (entry === undefined) entries.delete(boxId);
      else entries.set(boxId, entry);
      return SubscriptionRef.update(current, (list) => {
        if (entry === undefined) return list.filter((box) => box.id !== boxId);
        if (known) return list.map((box) => (box.id === boxId ? entry.box : box));
        return [...list, entry.box];
      });
    });

  /** GetOwnerInfoFromLogin with `credentials`: the owner and its validated dbID. */
  const login = Effect.fn("BoxRegistry.login")(
    function* (credentials: IsdsCredentials) {
      const client = yield* makeIsdsClient(boxClientConfig(config, credentials));
      const owner = yield* noInvalidRequest(client.getOwnerInfo());
      const dbId = owner.dbID;
      if (dbId === undefined || !isDataBoxId(dbId)) {
        return yield* new IsdsInvalidResponse({
          service: "access",
          operation: "GetOwnerInfoFromLogin",
          detail: "the answer has no valid data box id",
        });
      }
      return { owner, dbId };
    },
    Effect.scoped,
    Effect.provideService(IsdsTransports, transports),
  );

  const dbIdTaken = (dbId: string) =>
    sql<{ readonly id: string }>`SELECT id FROM boxes WHERE db_id = ${dbId}`.pipe(
      Effect.map((found) => {
        const existing = found[0];
        return existing === undefined ? undefined : new BoxAlreadyAdded({ dbId, existingBoxId: existing.id });
      }),
    );

  const labelTaken = (label: string, except: string | undefined) =>
    sql<{ readonly id: string }>`SELECT id FROM boxes WHERE label_key = ${labelKey(label)}`.pipe(
      Effect.map((found) => (found.some((row) => row.id !== except) ? new BoxLabelTaken({ label }) : undefined)),
    );

  /**
   * Runs `write` in a transaction after `conflict` finds nothing. A UNIQUE
   * violation the check missed is mapped through `conflict` again.
   */
  const guardedWrite = <A, C>(
    operation: string,
    conflict: Effect.Effect<C | undefined, SqlError.SqlError>,
    write: Effect.Effect<A, SqlError.SqlError>,
  ): Effect.Effect<A, C | DomainStoreError> =>
    sql
      .withTransaction(
        Effect.flatMap(
          conflict,
          (found): Effect.Effect<A, C | SqlError.SqlError> => (found === undefined ? write : Effect.fail(found)),
        ),
      )
      .pipe(
        Effect.catchIf(isUniqueViolation, (error) =>
          Effect.flatMap(conflict, (found): Effect.Effect<never, C | SqlError.SqlError> => Effect.fail(found ?? error)),
        ),
        Effect.catchIf(isSqlError, (error) => storeFailure(operation)(Effect.fail(error))),
      );

  /** The dbID is stored under another id, else the label is taken. */
  const addConflict = Effect.fn("BoxRegistry.addConflict")(function* (dbId: string, label: string) {
    const added = yield* dbIdTaken(dbId);
    return added ?? (yield* labelTaken(label, undefined));
  });

  const sealCredentials = (boxId: string, credentials: IsdsCredentials) =>
    sealText(key, credentialsJson(credentials), boxCredentialsAad(boxId));

  const add = Effect.fn("BoxRegistry.add")(function* (input: AddBoxInput) {
    const label = yield* checkLabel(input.label);
    if (input.environment !== config.environment) {
      return yield* new BoxEnvironmentMismatch({ requested: input.environment, configured: config.environment });
    }
    const taken = yield* labelTaken(label, undefined).pipe(storeFailure("check the data box label"));
    if (taken !== undefined) return yield* taken;
    redactor.register(secretsOf(input.credentials));
    const { owner, dbId } = yield* login(input.credentials);
    return yield* exclusive(
      Effect.gen(function* () {
        const id = newBoxId();
        const now = yield* Clock.currentTimeMillis;
        const credentialsSealed = yield* sealCredentials(id, input.credentials);
        const ownerJson = yield* encodeOwner(owner).pipe(storeFailure("encode the data box owner"));
        const box: Box = {
          id,
          dbId,
          label,
          environment: config.environment,
          boxType: owner.dbType,
          authKind: authKindOf(input.credentials),
          owner,
          createdAt: now,
          updatedAt: now,
        };
        yield* guardedWrite(
          "add the data box",
          addConflict(dbId, label),
          sql`INSERT INTO boxes ${sql.insert({
            id,
            db_id: dbId,
            label,
            label_key: labelKey(label),
            environment: config.environment,
            box_type: box.boxType ?? null,
            auth_kind: box.authKind,
            owner_json: ownerJson,
            credentials_sealed: credentialsSealed,
            created_at: now,
            updated_at: now,
          })}`,
        );
        yield* commit(id, { box, credentials: input.credentials });
        return box;
      }),
    );
  });

  const relabel = Effect.fn("BoxRegistry.relabel")(function* (boxId: string, newLabel: string) {
    const label = yield* checkLabel(newLabel);
    return yield* exclusive(
      Effect.gen(function* () {
        const entry = yield* find(boxId);
        const now = yield* Clock.currentTimeMillis;
        yield* guardedWrite(
          "relabel the data box",
          labelTaken(label, boxId),
          sql`UPDATE boxes SET label = ${label}, label_key = ${labelKey(label)}, updated_at = ${now} WHERE id = ${boxId}`,
        );
        const box: Box = { ...entry.box, label, updatedAt: now };
        yield* commit(boxId, { box, credentials: entry.credentials });
        return box;
      }),
    );
  });

  const replaceCredentials = Effect.fn("BoxRegistry.replaceCredentials")(function* (
    boxId: string,
    credentials: IsdsCredentials,
  ) {
    yield* find(boxId);
    redactor.register(secretsOf(credentials));
    // Under the box's permit, so this login never overlaps another ISDS call for the box.
    const { owner, dbId } = yield* locks.withBox(boxId, login(credentials));
    return yield* exclusive(
      Effect.gen(function* () {
        const entry = yield* find(boxId);
        if (dbId !== entry.box.dbId) {
          return yield* new BoxIdentityMismatch({ boxId, expectedDbId: entry.box.dbId, actualDbId: dbId });
        }
        const now = yield* Clock.currentTimeMillis;
        const credentialsSealed = yield* sealCredentials(boxId, credentials);
        const ownerJson = yield* encodeOwner(owner).pipe(storeFailure("encode the data box owner"));
        const box: Box = { ...entry.box, owner, boxType: owner.dbType, authKind: authKindOf(credentials), updatedAt: now };
        yield* sql`UPDATE boxes SET owner_json = ${ownerJson}, box_type = ${box.boxType ?? null},
          auth_kind = ${box.authKind}, credentials_sealed = ${credentialsSealed}, updated_at = ${now}
          WHERE id = ${boxId}`.pipe(storeFailure("replace the data box credentials"));
        yield* commit(boxId, { box, credentials });
        return box;
      }),
    );
  });

  const credentials = (boxId: string): Effect.Effect<IsdsCredentials, BoxNotFound> =>
    Effect.map(find(boxId), (entry) => entry.credentials);

  /** Pings with the box's current credentials, under the box's permit like every other ISDS call for it. */
  const testConnection = Effect.fn("BoxRegistry.testConnection")(function* (boxId: string) {
    yield* locks.withBox(
      boxId,
      Effect.gen(function* () {
        const entry = yield* find(boxId);
        const client = yield* makeIsdsClient(boxClientConfig(config, entry.credentials));
        yield* noInvalidRequest(client.ping());
      }).pipe(Effect.scoped, Effect.provideService(IsdsTransports, transports)),
    );
  });

  const remove = Effect.fn("BoxRegistry.remove")(function* (boxId: string) {
    return yield* exclusive(
      Effect.gen(function* () {
        const entry = yield* find(boxId);
        const now = yield* Clock.currentTimeMillis;
        const expired = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE approval_nonces SET used_at = ${now}
                WHERE used_at IS NULL AND filing_id IN (
                  SELECT id FROM filings WHERE box_id = ${boxId} AND state IN ${sql.in(OPEN_FILING_STATES)})`;
              const filings = yield* sql<{ readonly id: string }>`UPDATE filings
                SET state = 'expired', payload_sealed = NULL, updated_at = ${now}
                WHERE box_id = ${boxId} AND state IN ${sql.in(OPEN_FILING_STATES)} RETURNING id`;
              yield* sql`DELETE FROM recipient_tiers WHERE box_id = ${boxId}`;
              yield* sql`DELETE FROM boxes WHERE id = ${boxId}`;
              return filings.length;
            }),
          )
          .pipe(storeFailure("remove the data box"));
        yield* commit(boxId, undefined);
        return { box: entry.box, expiredFilings: expired } satisfies RemovedBox;
      }),
    );
  });

  return {
    list: SubscriptionRef.get(current),
    changes: SubscriptionRef.changes(current),
    skipped: Effect.succeed(skipped),
    get: (boxId: string) => Effect.map(find(boxId), (entry) => entry.box),
    add,
    relabel,
    replaceCredentials,
    testConnection,
    remove,
    credentials,
  } satisfies BoxRegistryShape;
});

export class BoxRegistry extends Context.Service<BoxRegistry, BoxRegistryShape>()("datova-schranka/BoxRegistry") {
  /**
   * The boxes stored in the database. Boxes of the other ISDS environment are
   * not loaded (see `skipped`) and are administered by restarting the server
   * under their original environment; a box whose credentials do not decrypt
   * fails startup. Replacing credentials and testing the connection take the
   * box's BoxLocks permit, the one BoxClients holds, so they never overlap
   * another ISDS call for the box; call neither inside BoxClients.use. Passwords and passphrases are registered with the Redactor.
   * Each change runs its own transaction and publishes once it commits, so
   * do not call one inside an outer `withTransaction`.
   */
  static readonly Default: Layer.Layer<
    BoxRegistry,
    BoxCredentialsUnreadable | DomainStoreError,
    SqlClient.SqlClient | DataKey | DomainConfig | IsdsTransports | Redactor | BoxLocks
  > = Layer.effect(BoxRegistry, makeBoxRegistry);

  /** The loaded boxes as core Resources (id = box id); the same array value until the boxes change. */
  static readonly resources: Layer.Layer<Resources, never, BoxRegistry> = Layer.effect(
    Resources,
    Effect.gen(function* () {
      const registry = yield* BoxRegistry;
      const mapped = new WeakMap<ReadonlyArray<Box>, ReadonlyArray<Resource>>();
      const resourcesOf = (boxes: ReadonlyArray<Box>): ReadonlyArray<Resource> => {
        const known = mapped.get(boxes);
        if (known !== undefined) return known;
        const resources = boxes.map((box) => ({ id: box.id, label: box.label }));
        mapped.set(boxes, resources);
        return resources;
      };
      return Resources.of({
        list: Effect.map(registry.list, resourcesOf),
        changes: Stream.map(registry.changes, resourcesOf),
      });
    }),
  );
}
