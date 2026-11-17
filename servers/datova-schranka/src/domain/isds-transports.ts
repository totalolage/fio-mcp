import { Context, Effect, Layer, type Scope } from "effect";
import { IsdsClient, type IsdsClientShape } from "../isds/client.js";
import type { IsdsClientConfig, IsdsCredentials } from "../isds/config.js";
import type { IsdsConfigError, IsdsCredentialsError } from "../isds/errors.js";
import { makeNodeTransport } from "../isds/node-transport.js";
import { IsdsTransport, type IsdsTransportShape } from "../isds/transport.js";
import type { DomainConfigShape } from "./config.js";

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
) {
  /** Real HTTPS transports, one keep-alive agent per `make` scope. */
  static readonly Live: Layer.Layer<IsdsTransports> = Layer.succeed(
    IsdsTransports,
    IsdsTransports.of({ make: (config) => makeNodeTransport(config) }),
  );
}

/** The client config for one box: its credentials over the configured environment and request timeout. */
export const boxClientConfig = (
  config: Pick<DomainConfigShape, "environment" | "requestTimeout">,
  credentials: IsdsCredentials,
): IsdsClientConfig => ({
  environment: config.environment,
  credentials,
  requestTimeout: config.requestTimeout,
});

/** An IsdsClient over a transport from `IsdsTransports`; the transport lives as long as the scope. */
export const makeIsdsClient = Effect.fn("IsdsTransports.client")(function* (config: IsdsClientConfig) {
  const transports = yield* IsdsTransports;
  const transport = yield* transports.make(config);
  const services = yield* Layer.build(IsdsClient.Default.pipe(Layer.provide(Layer.succeed(IsdsTransport, transport))));
  const client: IsdsClientShape = Context.get(services, IsdsClient);
  return client;
});
