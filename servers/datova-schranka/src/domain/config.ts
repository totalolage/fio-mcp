import { Context, Duration, Layer, type Redacted } from "effect";
import type { IsdsEnvironment } from "../isds/config.js";

/**
 * The settings the domain services read. The app fills them from
 * DATOVA_SCHRANKA_* (Effect Config) later; tests build them with
 * `DomainConfig.layer`, which applies the defaults below.
 */
export interface DomainConfigShape {
  /** The ISDS environment this process talks to; boxes added under the other one are not loaded. */
  readonly environment: IsdsEnvironment;
  /** How long one SOAP request may take. */
  readonly requestTimeout: Duration.Duration;
  /** Root of the ZFO store: `<dataDir>/<dbID>/<dmID>.zfo`. */
  readonly dataDir: string;
  /** Largest attachment returned inline by a download; larger ones are skipped with a note. */
  readonly attachmentInlineMaxBytes: number;
  /** Most attachment bytes returned inline by one download, all attachments together. */
  readonly responseInlineMaxBytes: number;
  /** Lifetime of an approval nonce (send tier `approve`). */
  readonly approvalNonceTtl: Duration.Duration;
  /** Lifetime of a filing waiting for an admin decision (send tier `none`). */
  readonly pendingTtl: Duration.Duration;
}

const MIB = 1024 * 1024;

/** Defaults per the design (§2); `dataDir` has none, the app derives it from the database path. */
export const domainConfigDefaults: Omit<DomainConfigShape, "dataDir"> = {
  environment: "production",
  requestTimeout: Duration.millis(60_000),
  attachmentInlineMaxBytes: 10 * MIB,
  responseInlineMaxBytes: 25 * MIB,
  approvalNonceTtl: Duration.minutes(15),
  pendingTtl: Duration.hours(168),
};

export class DomainConfig extends Context.Service<DomainConfig, DomainConfigShape>()("datova-schranka/DomainConfig") {
  /** The defaults with `overrides` applied. */
  static readonly layer = (
    overrides: Partial<DomainConfigShape> & Pick<DomainConfigShape, "dataDir">,
  ): Layer.Layer<DomainConfig> => Layer.succeed(DomainConfig, DomainConfig.of({ ...domainConfigDefaults, ...overrides }));
}

/**
 * The 32-byte data key that seals box credentials, approval nonces and
 * pending payloads at rest. The app reads it from DATOVA_SCHRANKA_DATA_KEY_FILE
 * and verifies it against the database later.
 */
export interface DataKeyShape {
  readonly key: Redacted.Redacted<Uint8Array>;
}

export class DataKey extends Context.Service<DataKey, DataKeyShape>()("datova-schranka/DataKey") {
  static readonly layer = (key: Redacted.Redacted<Uint8Array>): Layer.Layer<DataKey> =>
    Layer.succeed(DataKey, DataKey.of({ key }));
}
