import { Context, type Effect, Layer } from "effect";
import type { IsdsClientConfig, IsdsService } from "./config.ts";
import type { IsdsConfigError, IsdsCredentialsError, IsdsTransportFailure } from "./errors.ts";
import { makeNodeTransport } from "./node-transport.js";

/** One SOAP 1.1 POST to an ISDS service endpoint. */
export interface IsdsSoapRequest {
  readonly service: IsdsService;
  /** The WSDL operation name, used for the SOAPAction header and in errors. */
  readonly operation: string;
  /** The complete SOAP envelope, UTF-8 XML. */
  readonly envelope: string;
}

/**
 * The HTTP response to a SOAP request whose body the SOAP layer must interpret: HTTP 200
 * (a normal response) or HTTP 500 (a SOAP fault). Other statuses fail in the transport.
 */
export interface IsdsSoapResponse {
  readonly httpStatus: 200 | 500;
  readonly contentType: string | undefined;
  /** The response body decoded as UTF-8. */
  readonly body: string;
}

export interface IsdsTransportShape {
  readonly send: (request: IsdsSoapRequest) => Effect.Effect<IsdsSoapResponse, IsdsTransportFailure>;
}

/**
 * Sends SOAP envelopes to ISDS. The live implementation authenticates with the box's TLS client
 * certificate; tests replace it with canned responses.
 */
export class IsdsTransport extends Context.Service<IsdsTransport, IsdsTransportShape>()(
  "datova-schranka/IsdsTransport",
) {
  /**
   * The live transport over Node `https`: TLS client certificate (PKCS#12) or HTTP Basic,
   * always verifying the server certificate. Building it fails on an unusable PKCS#12 archive,
   * passphrase or username (`IsdsCredentialsError`) or a non-`https:` base URL or out-of-range
   * limit (`IsdsConfigError`). Its connections close when the layer's scope closes.
   */
  static readonly layer = (config: IsdsClientConfig): Layer.Layer<IsdsTransport, IsdsCredentialsError | IsdsConfigError> =>
    Layer.effect(IsdsTransport, makeNodeTransport(config));
}
