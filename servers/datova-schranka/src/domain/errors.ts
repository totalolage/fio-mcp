import { Effect, Schema } from "effect";

/**
 * Domain errors. Messages name ids and rules only: never credentials,
 * message content or ISDS free text beyond the status code.
 */

/** A database operation failed; the cause was logged (the logger redacts) and dropped. */
export class DomainStoreError extends Schema.TaggedError<DomainStoreError>()("DomainStoreError", {
  operation: Schema.String,
}) {
  override get message(): string {
    return `datova-schranka: failed to ${this.operation}`;
  }
}

/** Logs the cause and replaces it with a value-free DomainStoreError. */
export const storeFailure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, DomainStoreError, R> =>
    Effect.catch(effect, (cause) =>
      Effect.logError(`datova-schranka: failed to ${operation}`, cause).pipe(
        Effect.andThen(Effect.fail(new DomainStoreError({ operation }))),
      ),
    );

/** No loaded box has this id (never added, removed, or stored under the other ISDS environment). */
export class BoxNotFound extends Schema.TaggedError<BoxNotFound>()("BoxNotFound", {
  boxId: Schema.String,
}) {
  override get message(): string {
    return `No data box ${this.boxId} is configured.`;
  }
}

/** An identifier failed its format rule before it reached SQL, a path or ISDS. */
export class InvalidIdentifier extends Schema.TaggedError<InvalidIdentifier>()("InvalidIdentifier", {
  kind: Schema.Literals(["dataBoxId", "messageId", "boxId", "label"]),
  rule: Schema.String,
}) {
  override get message(): string {
    return `Invalid ${this.kind}: ${this.rule}`;
  }
}
