import { Context, type Effect } from "effect";
import type { IsdsClientShape } from "../isds/client.js";
import type { IsdsConfigError, IsdsCredentialsError } from "../isds/errors.js";
import type { BoxCredentialsUnreadable } from "./boxes.js";
import type { BoxNotFound } from "./errors.js";

/**
 * One IsdsClient per loaded box, over its decrypted credentials and the
 * configured environment and request timeout. `use` holds the box's
 * semaphore for the whole of `f`, so ISDS calls for one box never overlap
 * (ISDS rejects parallel list/download, status 3008) while different
 * boxes run concurrently. Replaced credentials apply from the next `use`;
 * a removed box fails with BoxNotFound.
 */
export type BoxClientError = BoxNotFound | BoxCredentialsUnreadable | IsdsCredentialsError | IsdsConfigError;

export interface BoxClientsShape {
  readonly use: <A, E>(
    boxId: string,
    f: (client: IsdsClientShape) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | BoxClientError>;
}

export class BoxClients extends Context.Service<BoxClients, BoxClientsShape>()("datova-schranka/BoxClients") {}
