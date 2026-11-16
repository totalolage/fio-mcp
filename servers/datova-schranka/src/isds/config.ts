import type { Duration, Redacted } from "effect";

/**
 * Which ISDS environment a client talks to. Both use the direct system-certificate
 * route (`/cert`): the TLS client certificate alone identifies the data box.
 */
export type IsdsEnvironment = "production" | "test";

/** Base URLs of the `cert` route (WS_manipulace_s_datovymi_zpravami.pdf §1.2.1). */
export const certRouteBaseUrl: Record<IsdsEnvironment, string> = {
  production: "https://ws1c.datovka.gov.cz/cert",
  test: "https://ws1c.datovka-test.gov.cz/cert",
};

/**
 * SOAP 1.1 service endpoints, appended to the base URL. One per WSDL:
 * dm_operations → `/DS/dz`, dm_info → `/DS/dx`, db_search → `/DS/df`,
 * db_access → `/DS/DsManage`.
 */
export const isdsServicePath = {
  operations: "/DS/dz",
  info: "/DS/dx",
  search: "/DS/df",
  access: "/DS/DsManage",
} as const;

export type IsdsService = keyof typeof isdsServicePath;

/** The system certificate registered on one data box, as a PKCS#12 (.p12/.pfx) archive. */
export interface IsdsClientCertificate {
  readonly pkcs12: Uint8Array;
  readonly passphrase: Redacted.Redacted<string>;
}

/** Configuration of one ISDS client. One client instance serves exactly one data box. */
export interface IsdsClientConfig {
  /** Selects the base URL; ignored when `baseUrl` is set. */
  readonly environment: IsdsEnvironment;
  /**
   * Overrides the base URL (scheme, host, port and route prefix, e.g. `https://127.0.0.1:8443/cert`).
   * Meant for tests and for the legacy hosts; must be `https:`.
   */
  readonly baseUrl?: string | undefined;
  readonly certificate: IsdsClientCertificate;
  /**
   * Extra PEM CA certificates to trust for the server certificate, in addition to Node's
   * bundled roots. Server certificate verification can't be turned off.
   */
  readonly additionalTrustedCa?: ReadonlyArray<string> | undefined;
  /**
   * How long one SOAP request may take, from connecting until the whole response has been read.
   * A request that runs out of time fails with `IsdsTimeoutError` (outcome unknown).
   */
  readonly requestTimeout: Duration.Duration;
  /** Responses larger than this fail with `IsdsTransportError` (reason `ResponseTooLarge`). */
  readonly maxResponseBytes?: number | undefined;
}

/** Default response cap: a 20 MB message base64-encoded inside a signed ZFO, with headroom. */
export const defaultMaxResponseBytes = 64 * 1024 * 1024;

export const resolveBaseUrl = (config: IsdsClientConfig): string =>
  (config.baseUrl ?? certRouteBaseUrl[config.environment]).replace(/\/+$/, "");
