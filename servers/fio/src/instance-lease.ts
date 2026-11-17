import { InstanceLease, runLeased } from "@mcps/core/instance-lease.js";
import { Effect, Layer } from "effect";
import { cacheFailure, Database } from "./cache/db.js";
import { AppConfig, type AppConfigShape } from "./config.js";
import { FIO_APP } from "./identity.js";

/**
 * Fio's single-instance lease (core `InstanceLease`). The per-token rate
 * limiter lives in process memory, so two servers on one FIO token each send
 * their own requests and FIO answers 409: a server that opens the database
 * takes the lease, a second one refuses to start. CLI subcommands never take
 * it. `server_settings`, which the lease needs, comes from `SERVER_MIGRATIONS`.
 */

/** True when the served app opens the database (FIO_DB_PATH): the cache is enabled, or HTTP with OAuth. */
export const opensDatabase = (config: AppConfigShape): boolean =>
  config.cache.enabled || (config.transport.kind === "http" && config.transport.auth.kind === "oauth");

/**
 * The server's lease from configuration, on the server's database
 * (`Database.Live`, the same connection the app uses) with the production
 * timings, when the served app opens the database; otherwise `None`.
 */
export const InstanceLeaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return opensDatabase(config)
      ? InstanceLease.layer({ appName: FIO_APP.name, onSqlFailure: cacheFailure }).pipe(Layer.provide(Database.Live))
      : InstanceLease.None;
  }),
).pipe(Layer.provide(AppConfig.Live));

/** The server entrypoint: `app` under the lease from configuration (`InstanceLeaseLive`). */
export const serveLeased = <A, E, R>(app: Layer.Layer<A, E, R>) => runLeased(app, InstanceLeaseLive);
