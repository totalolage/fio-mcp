import { Context, type Effect, type Scope } from "effect";
import type { IsdsClientConfig } from "../isds/config.js";
import type { IsdsConfigError, IsdsCredentialsError } from "../isds/errors.js";
import type { IsdsTransportShape } from "../isds/transport.js";

/**
 * Builds the transport for one box's credentials. Live: `makeNodeTransport`
 * (its agent closes with the scope). Tests: the fake transport from
 * test/isds/fake-transport.ts, keyed by whatever the test needs.
 */
export interface IsdsTransportsShape {
  readonly make: (
    config: IsdsClientConfig,
  ) => Effect.Effect<IsdsTransportShape, IsdsCredentialsError | IsdsConfigError, Scope.Scope>;
}

export class IsdsTransports extends Context.Service<IsdsTransports, IsdsTransportsShape>()(
  "datova-schranka/IsdsTransports",
) {}
