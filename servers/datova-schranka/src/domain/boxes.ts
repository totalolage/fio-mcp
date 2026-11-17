import { Context, type Effect, Schema, type Stream } from "effect";
import type { IsdsCredentials, IsdsEnvironment } from "../isds/config.js";
import type { DataBoxOwnerInfo } from "../isds/databox.js";
import type { IsdsCallError, IsdsConfigError, IsdsCredentialsError } from "../isds/errors.js";
import type { BoxNotFound, DomainStoreError, InvalidIdentifier } from "./errors.js";

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
  /** Stored boxes not loaded because their environment differs from the configured one. */
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
  /** Logs in with the new credentials; they must resolve to the same dbID. Keeps the id (grants keep the box). */
  readonly replaceCredentials: (
    boxId: string,
    credentials: IsdsCredentials,
  ) => Effect.Effect<Box, BoxNotFound | BoxIdentityMismatch | BoxLoginError | DomainStoreError>;
  /** DummyOperation with the stored credentials. */
  readonly testConnection: (boxId: string) => Effect.Effect<void, BoxNotFound | BoxCredentialsUnreadable | BoxLoginError>;
  /** Deletes the box, its credentials and recipient tiers; expires its open filings; keeps audit rows. */
  readonly remove: (boxId: string) => Effect.Effect<RemovedBox, BoxNotFound | DomainStoreError>;
  /** The box's decrypted credentials, for BoxClients. */
  readonly credentials: (boxId: string) => Effect.Effect<IsdsCredentials, BoxNotFound | BoxCredentialsUnreadable>;
}

export class BoxRegistry extends Context.Service<BoxRegistry, BoxRegistryShape>()("datova-schranka/BoxRegistry") {}
