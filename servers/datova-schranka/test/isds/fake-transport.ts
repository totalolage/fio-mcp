import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { IsdsTransportFailure } from "../../src/isds/errors.js";
import { type IsdsSoapRequest, type IsdsSoapResponse, IsdsTransport } from "../../src/isds/transport.js";

/** Reads `test/fixtures/<name>` as UTF-8. */
export const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "..", "fixtures", name), "utf8");

/** An HTTP 200 SOAP response whose body is `xml`. */
export const ok = (xml: string): IsdsSoapResponse => ({ httpStatus: 200, contentType: "text/xml; charset=utf-8", body: xml });

/** An HTTP 500 response whose body is `xml`. */
export const serverError = (xml: string): IsdsSoapResponse => ({
  httpStatus: 500,
  contentType: "text/xml; charset=utf-8",
  body: xml,
});

/**
 * A SOAP 1.1 response envelope the way ISDS writes it: prefixed envelope, the operation
 * response in the v20 namespace under a prefix, `inner` as its content (unprefixed children
 * in the default namespace).
 */
export const soapResponse = (operation: string, inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">` +
  `<SOAP-ENV:Body><p:${operation}Response xmlns:p="http://isds.czechpoint.cz/v20" xmlns="http://isds.czechpoint.cz/v20">` +
  `${inner}</p:${operation}Response></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

export const dmStatus = (code: string, message = code === "0000" ? "Provedeno úspěšně." : "Chyba") =>
  `<dmStatus><dmStatusCode>${code}</dmStatusCode><dmStatusMessage>${message}</dmStatusMessage></dmStatus>`;

export const dbStatus = (code: string, message = code === "0000" ? "Provedeno úspěšně." : "Chyba") =>
  `<dbStatus><dbStatusCode>${code}</dbStatusCode><dbStatusMessage>${message}</dbStatusMessage></dbStatus>`;

export const soapFault = (code: string, text: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body>` +
  `<SOAP-ENV:Fault><faultcode>${code}</faultcode><faultstring>${text}</faultstring></SOAP-ENV:Fault>` +
  `</SOAP-ENV:Body></SOAP-ENV:Envelope>`;

type Respond = (request: IsdsSoapRequest) => Effect.Effect<IsdsSoapResponse, IsdsTransportFailure>;

/**
 * A transport that answers every request with `respond` and records what was sent.
 * Pass a plain response to answer every call the same way, or an array to answer calls in order.
 */
export const fakeTransport = (respond: Respond | IsdsSoapResponse | ReadonlyArray<IsdsSoapResponse>) => {
  const requests: Array<IsdsSoapRequest> = [];
  const handler: Respond = (request) => {
    if (typeof respond === "function") return respond(request);
    if (!Array.isArray(respond)) return Effect.succeed(respond as IsdsSoapResponse);
    const replies: ReadonlyArray<IsdsSoapResponse> = respond;
    return Effect.succeed(replies[Math.min(requests.length - 1, replies.length - 1)] ?? ok(""));
  };
  const layer = Layer.succeed(
    IsdsTransport,
    IsdsTransport.of({
      send: (request) =>
        Effect.suspend(() => {
          requests.push(request);
          return handler(request);
        }),
    }),
  );
  return { layer, requests };
};
