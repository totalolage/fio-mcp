import { Data, type Duration, type Redacted } from "effect";

/** Which ISDS environment a client talks to. */
export type IsdsEnvironment = "production" | "test";

/**
 * How the client authenticates. One client instance serves exactly one data box.
 * - `SystemCertificate`: the direct system-certificate route (`ws1c…/cert`). The TLS client
 *   certificate registered on the box identifies it; no username or password is sent.
 * - `Password`: the username/password route (`ws1…`), HTTP Basic over TLS.
 */
export type IsdsCredentials = Data.TaggedEnum<{
  /** The system certificate registered on the box, as a PKCS#12 (.p12/.pfx) archive. */
  SystemCertificate: {
    readonly pkcs12: Uint8Array;
    readonly passphrase: Redacted.Redacted<string>;
  };
  Password: {
    readonly username: string;
    readonly password: Redacted.Redacted<string>;
  };
}>;

export const IsdsCredentials = Data.taggedEnum<IsdsCredentials>();

/**
 * Base URLs per route (WS_manipulace_s_datovymi_zpravami.pdf §1.2.1). Service paths below are
 * appended, e.g. `https://ws1c.datovka.gov.cz/cert/DS/dx`.
 */
export const isdsBaseUrl: Record<IsdsCredentials["_tag"], Record<IsdsEnvironment, string>> = {
  SystemCertificate: {
    production: "https://ws1c.datovka.gov.cz/cert",
    test: "https://ws1c.datovka-test.gov.cz/cert",
  },
  Password: {
    production: "https://ws1.datovka.gov.cz",
    test: "https://ws1.datovka-test.gov.cz",
  },
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

export interface IsdsClientConfig {
  /** Selects the base URL together with the credentials' route; ignored when `baseUrl` is set. */
  readonly environment: IsdsEnvironment;
  /**
   * Overrides the base URL (scheme, host, port and route prefix, e.g. `https://127.0.0.1:8443/cert`).
   * Meant for tests and for the legacy hosts; must be `https:`.
   */
  readonly baseUrl?: string | undefined;
  readonly credentials: IsdsCredentials;
  /**
   * Extra PEM CA certificates to trust for the server certificate, in addition to Node's
   * bundled roots. Server certificate verification can't be turned off.
   */
  readonly additionalTrustedCa?: ReadonlyArray<string> | undefined;
  /**
   * How long one SOAP request may take, from connecting until the whole response has been read.
   * A request that runs out of time fails with `IsdsTimeoutError`.
   */
  readonly requestTimeout: Duration.Duration;
  /** Responses larger than this fail with `IsdsTransportError` (reason `ResponseTooLarge`). */
  readonly maxResponseBytes?: number | undefined;
}

/** Default response cap: a 20 MB message base64-encoded inside a signed ZFO, with headroom. */
export const defaultMaxResponseBytes = 64 * 1024 * 1024;

export const resolveBaseUrl = (config: IsdsClientConfig): string =>
  (config.baseUrl ?? isdsBaseUrl[config.credentials._tag][config.environment]).replace(/\/+$/, "");
