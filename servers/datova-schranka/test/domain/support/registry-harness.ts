import { makeRedactor, Redactor } from "@mcps/core/redaction.js";
import { Context, Effect, Layer, Logger, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { BoxRegistry } from "../../../src/domain/boxes.js";
import { DataKey, DomainConfig } from "../../../src/domain/config.js";
import type { IsdsEnvironment } from "../../../src/isds/config.js";
import { type FakeIsdsOptions, type FakeRespond, fakeIsdsTransports, loginResponder } from "./fake-isds.js";

export const DATA_KEY = Redacted.make(new Uint8Array(32).fill(7));

export interface StartOptions {
  /** Login key (username or passphrase) to the dbID GetOwnerInfoFromLogin answers with. */
  readonly logins?: Readonly<Record<string, string>>;
  /** Replaces the login responder. */
  readonly respond?: FakeRespond;
  readonly onMake?: FakeIsdsOptions["onMake"];
  readonly environment?: IsdsEnvironment;
}

/**
 * One server start over the ambient database: the registry, the fake ISDS
 * record, every secret registered with the Redactor and what was logged
 * while loading.
 */
export const startRegistry = Effect.fn("startRegistry")(function* (options: StartOptions = {}) {
  const isds = fakeIsdsTransports(options.respond ?? loginResponder(options.logins ?? {}), { onMake: options.onMake });
  const registered: Array<string> = [];
  const base = makeRedactor([]);
  const redactor = Redactor.of({
    ...base,
    register: (secrets) => {
      registered.push(...secrets);
      base.register(secrets);
    },
  });
  const logs: Array<string> = [];
  const capture = Logger.make<unknown, void>((entry) => void logs.push(Logger.formatLogFmt.log(entry)));
  const layer = BoxRegistry.Default.pipe(
    Layer.provide(isds.layer),
    Layer.provide(Layer.succeed(Redactor, redactor)),
    Layer.provide(DataKey.layer(DATA_KEY)),
    Layer.provide(DomainConfig.layer({ dataDir: "/nonexistent", environment: options.environment ?? "production" })),
  );
  const context = yield* Layer.build(layer).pipe(Effect.provide(Logger.layer([capture])));
  return { registry: Context.get(context, BoxRegistry), context, isds, registered, logs, redactor: base };
});

export interface BoxRowRaw {
  readonly id: string;
  readonly db_id: string;
  readonly label: string;
  readonly label_key: string;
  readonly environment: string;
  readonly auth_kind: string;
  readonly owner_json: string;
  readonly credentials_sealed: string;
}

export const boxRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<BoxRowRaw>`SELECT * FROM boxes ORDER BY rowid`;
});
