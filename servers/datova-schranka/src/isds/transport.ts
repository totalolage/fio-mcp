import { Context, type Effect } from "effect";
import type { IsdsService } from "./config.ts";
import type { IsdsTransportFailure } from "./errors.ts";

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
) {}
