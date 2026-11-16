import { Effect, Result, Schema } from "effect";
import type { IsdsService } from "./config.js";
import {
  classifyStatus,
  type IsdsCallError,
  IsdsInvalidRequest,
  IsdsInvalidResponse,
  IsdsSoapFault,
  IsdsStatusError,
} from "./errors.js";
import { type IsdsSoapResponse, IsdsTransport } from "./transport.js";
import { parseXml, renderXml, type XmlElement, xmlElement, xmlTextKey } from "./xml.js";

/** The ISDS v20 target namespace of dmBaseTypes.xsd and dbTypes.xsd (elementFormDefault qualified). */
export const isdsNamespace = "http://isds.czechpoint.cz/v20";
export const soapEnvelopeNamespace = "http://schemas.xmlsoap.org/soap/envelope/";

/**
 * A complete SOAP 1.1 envelope around one document/literal body element. The body element
 * declares the ISDS namespace as its default, which its qualified descendants inherit;
 * attributes are unqualified in the ISDS schemas, so they stay outside it.
 */
export const soapEnvelope = (body: XmlElement): Result.Result<string, string> =>
  Result.map(
    renderXml(
      xmlElement("soap:Envelope", [xmlElement("soap:Body", [{ ...body, attributes: [["xmlns", isdsNamespace], ...body.attributes] }])], {
        "xmlns:soap": soapEnvelopeNamespace,
      }),
    ),
    (xml) => `<?xml version="1.0" encoding="UTF-8"?>${xml}`,
  );

type Json = { readonly [key: string]: unknown };

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** `xsi:nil="true"` on an element with no content, after the parser dropped the prefix. */
const isNil = (value: unknown): boolean =>
  isRecord(value) && (value.nil === "true" || value.nil === "1") && Object.keys(value).every((key) => key === "nil" || key === "type");

/** Drops nil elements, so a nillable optional element decodes as absent rather than as an object. */
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.filter((item) => !isNil(item)).map(normalize);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isNil(child)) out[key] = normalize(child);
  }
  return out;
};

const ResponseStatus = Schema.Struct({
  dmStatus: Schema.optional(Schema.Struct({ dmStatusCode: Schema.String, dmStatusMessage: Schema.optional(Schema.String) })),
  dbStatus: Schema.optional(
    Schema.Struct({
      dbStatusCode: Schema.String,
      dbStatusMessage: Schema.optional(Schema.String),
      dbStatusRefNumber: Schema.optional(Schema.String),
    }),
  ),
});
const decodeResponseStatus = Schema.decodeUnknownEffect(ResponseStatus);

const Fault = Schema.Struct({
  faultcode: Schema.optional(Schema.Unknown),
  faultstring: Schema.optional(Schema.Unknown),
});
const decodeFault = Schema.decodeUnknownEffect(Fault);

/** The text of a parsed element, whether or not it carried attributes. */
const textOf = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value[xmlTextKey] === "string") return value[xmlTextKey];
  return undefined;
};

/** The status an ISDS response reported, after it was accepted as a success. */
export interface IsdsResponseStatus {
  readonly code: string;
  readonly message: string;
}

export interface IsdsOperation<A> {
  readonly service: IsdsService;
  /** The WSDL operation name; also the request body element's local name. */
  readonly operation: string;
  /** The request body element (the operation element), unqualified; `soapEnvelope` adds the namespace. */
  readonly request: XmlElement;
  /** Decodes the content of `<{operation}Response>`, after nil elements were dropped. */
  readonly response: Schema.Decoder<A>;
  /** Local names of elements that may repeat, so one occurrence still decodes as an array. */
  readonly repeating?: ReadonlySet<string>;
  /** Which status element the response carries. */
  readonly status: "dm" | "db";
  /**
   * Status codes that mean success for this operation, besides "0000". Codes not listed fail
   * with `IsdsStatusError` before the response payload is decoded.
   */
  readonly successCodes?: ReadonlySet<string>;
}

export interface IsdsOperationResult<A> {
  readonly response: A;
  readonly status: IsdsResponseStatus;
}

/**
 * Interprets one SOAP response: a SOAP fault fails with `IsdsSoapFault`, a non-success
 * dmStatus/dbStatus with `IsdsStatusError`, and anything that isn't the expected well-formed
 * response with `IsdsInvalidResponse`. Never dies on server input.
 */
export const interpretResponse = Effect.fn("IsdsSoap.interpretResponse")(function* <A>(
  operation: IsdsOperation<A>,
  reply: IsdsSoapResponse,
) {
  const invalid = (detail: string) =>
    new IsdsInvalidResponse({ service: operation.service, operation: operation.operation, detail });

  const parsed = parseXml(reply.body, operation.repeating);
  if (Result.isFailure(parsed)) return yield* invalid(parsed.failure);
  const document = normalize(parsed.success);
  const envelope = isRecord(document) ? document.Envelope : undefined;
  const body = isRecord(envelope) ? envelope.Body : undefined;
  if (!isRecord(body)) return yield* invalid("the response is not a SOAP envelope with a body");

  if (body.Fault !== undefined) {
    const fault = yield* decodeFault(body.Fault).pipe(Effect.mapError(() => invalid("malformed SOAP fault")));
    return yield* new IsdsSoapFault({
      service: operation.service,
      operation: operation.operation,
      faultCode: textOf(fault.faultcode) ?? "",
      faultString: textOf(fault.faultstring) ?? "",
      httpStatus: reply.httpStatus,
    });
  }
  if (reply.httpStatus !== 200) return yield* invalid(`HTTP ${reply.httpStatus} without a SOAP fault`);

  const responseName = `${operation.operation}Response`;
  const content = body[responseName];
  if (!isRecord(content)) return yield* invalid(`the SOAP body has no ${responseName} element`);

  const statuses = yield* decodeResponseStatus(content).pipe(
    Effect.mapError((error) => invalid(`malformed status: ${error.message}`)),
  );
  const status =
    operation.status === "dm"
      ? statuses.dmStatus && { code: statuses.dmStatus.dmStatusCode, message: statuses.dmStatus.dmStatusMessage ?? "" }
      : statuses.dbStatus && { code: statuses.dbStatus.dbStatusCode, message: statuses.dbStatus.dbStatusMessage ?? "" };
  if (status === undefined) return yield* invalid(`${responseName} has no ${operation.status}Status`);
  if (status.code !== "0000" && !operation.successCodes?.has(status.code)) {
    return yield* new IsdsStatusError({
      service: operation.service,
      operation: operation.operation,
      statusKind: operation.status,
      code: status.code,
      statusMessage: status.message,
      classification: classifyStatus(operation.status, status.code),
    });
  }

  const response = yield* Schema.decodeEffect(operation.response)(content).pipe(
    Effect.mapError((error) => invalid(error.message)),
  );
  return { response, status } satisfies IsdsOperationResult<A>;
});

/**
 * Sends one ISDS operation through `IsdsTransport` and interprets the reply. Fails with
 * `IsdsInvalidRequest` before sending when the request holds text XML cannot carry. Transport
 * failures, including `IsdsTimeoutError`, pass through unchanged.
 */
export const callIsds = Effect.fn("IsdsSoap.call")(function* <A>(operation: IsdsOperation<A>) {
  const envelope = soapEnvelope(operation.request);
  if (Result.isFailure(envelope)) {
    return yield* new IsdsInvalidRequest({ operation: operation.operation, detail: envelope.failure });
  }
  const transport = yield* IsdsTransport;
  const reply = yield* transport.send({
    service: operation.service,
    operation: operation.operation,
    envelope: envelope.success,
  });
  return yield* interpretResponse(operation, reply);
});

/** Every failure `callIsds` can produce. */
export type IsdsOperationError = IsdsCallError | IsdsInvalidRequest;
