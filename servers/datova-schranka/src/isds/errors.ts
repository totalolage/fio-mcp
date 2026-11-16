import { Schema } from "effect";

const Service = Schema.Literals(["operations", "info", "search", "access"]);

/** The credentials are unusable: the PKCS#12 archive or passphrase was rejected while building the TLS context, or the username is invalid for HTTP Basic. */
export class IsdsCredentialsError extends Schema.TaggedError<IsdsCredentialsError>()("IsdsCredentialsError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `The ISDS credentials could not be used: ${this.detail}`;
  }
}

/**
 * The request never produced an HTTP response: TLS handshake failure (including an untrusted
 * server certificate), connection failure, or a response over the size cap.
 */
export class IsdsTransportError extends Schema.TaggedError<IsdsTransportError>()("IsdsTransportError", {
  service: Service,
  operation: Schema.String,
  reason: Schema.Literals(["Tls", "Connection", "ResponseTooLarge"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return `ISDS ${this.operation} failed (${this.reason}): ${this.detail}`;
  }
}

/**
 * The request ran out of time. When `requestSent` is true the server may have processed it,
 * so for CreateMessage the outcome is unknown: reconcile with `reconcileSentMessage` before
 * retrying. Never treat this as success or as failure.
 */
export class IsdsTimeoutError extends Schema.TaggedError<IsdsTimeoutError>()("IsdsTimeoutError", {
  service: Service,
  operation: Schema.String,
  timeoutMillis: Schema.Finite,
  requestSent: Schema.Boolean,
}) {
  override get message(): string {
    return this.requestSent
      ? `ISDS ${this.operation} timed out after ${this.timeoutMillis} ms; the outcome is unknown.`
      : `ISDS ${this.operation} timed out after ${this.timeoutMillis} ms before the request was sent.`;
  }
}

/** ISDS rejected the client certificate (HTTP 401/403, usually with an HTML body). */
export class IsdsAuthError extends Schema.TaggedError<IsdsAuthError>()("IsdsAuthError", {
  service: Service,
  operation: Schema.String,
  httpStatus: Schema.Finite,
}) {
  override get message(): string {
    return `ISDS refused the credentials (HTTP ${this.httpStatus}).`;
  }
}

/** ISDS is down for maintenance (HTTP 503). Retry later. */
export class IsdsMaintenanceError extends Schema.TaggedError<IsdsMaintenanceError>()("IsdsMaintenanceError", {
  service: Service,
  operation: Schema.String,
  retryAfter: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return "ISDS is unavailable (HTTP 503, maintenance).";
  }
}

/** Any other unexpected HTTP status. */
export class IsdsHttpError extends Schema.TaggedError<IsdsHttpError>()("IsdsHttpError", {
  service: Service,
  operation: Schema.String,
  httpStatus: Schema.Finite,
  contentType: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `ISDS ${this.operation} returned HTTP ${this.httpStatus}.`;
  }
}

/** The server answered with a SOAP fault. */
export class IsdsSoapFault extends Schema.TaggedError<IsdsSoapFault>()("IsdsSoapFault", {
  service: Service,
  operation: Schema.String,
  faultCode: Schema.String,
  faultString: Schema.String,
  httpStatus: Schema.Finite,
}) {
  override get message(): string {
    return `ISDS ${this.operation} SOAP fault ${this.faultCode}: ${this.faultString}`;
  }
}

/** The response was not well-formed XML or did not match the operation's schema. */
export class IsdsInvalidResponse extends Schema.TaggedError<IsdsInvalidResponse>()("IsdsInvalidResponse", {
  service: Service,
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `ISDS ${this.operation} returned an unexpected response: ${this.detail}`;
  }
}

/** The caller's input failed validation before anything was sent. */
export class IsdsInvalidRequest extends Schema.TaggedError<IsdsInvalidRequest>()("IsdsInvalidRequest", {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Invalid ISDS ${this.operation} request: ${this.detail}`;
  }
}

/**
 * The message's attachments exceed the 20 MB limit of CreateMessage. Larger messages need the
 * VoDZ service (UploadAttachment + CreateBigMessage, SOAP 1.2 on ws2c), which is not implemented.
 */
export class IsdsMessageTooLarge extends Schema.TaggedError<IsdsMessageTooLarge>()("IsdsMessageTooLarge", {
  totalBytes: Schema.Finite,
  limitBytes: Schema.Finite,
}) {
  override get message(): string {
    return `The attachments total ${this.totalBytes} bytes, over the ${this.limitBytes}-byte limit; large messages (VoDZ) are not supported.`;
  }
}

/**
 * How an ISDS status code should be handled.
 * - `Transient`: 3006 (delivery still processing), 3008 (parallel request), 3009 (rate limited),
 *   3013 (too many VoDZ downloads). Retry with backoff.
 * - `NotDelivered`: 1222, the message is not legally delivered yet (state 4/5); list received
 *   messages first.
 * - `Blocked`: 3022, an administrator blocked a suspicious message. Never retry.
 * - `AttachmentRejected`: 1214, an attachment's type or content failed validation.
 * - `WrongService`: 1281, the message needs the other (small vs. VoDZ) service.
 * - `BoxNotFound`: dbStatusCode 5001, no data box with that ID.
 * - `Other`: anything else; the catalog is open.
 */
export const IsdsStatusClassification = Schema.Literals([
  "Transient",
  "NotDelivered",
  "Blocked",
  "AttachmentRejected",
  "WrongService",
  "BoxNotFound",
  "Other",
]);
export type IsdsStatusClassification = typeof IsdsStatusClassification.Type;

export const classifyStatus = (kind: "dm" | "db", code: string): IsdsStatusClassification => {
  if (kind === "db") {
    return code === "5001" ? "BoxNotFound" : "Other";
  }
  switch (code) {
    case "3006":
    case "3008":
    case "3009":
    case "3013":
      return "Transient";
    case "1222":
      return "NotDelivered";
    case "3022":
      return "Blocked";
    case "1214":
      return "AttachmentRejected";
    case "1281":
      return "WrongService";
    default:
      return "Other";
  }
};

/** ISDS answered, but its `dmStatus`/`dbStatus` reports a non-success code. */
export class IsdsStatusError extends Schema.TaggedError<IsdsStatusError>()("IsdsStatusError", {
  service: Service,
  operation: Schema.String,
  statusKind: Schema.Literals(["dm", "db"]),
  code: Schema.String,
  statusMessage: Schema.String,
  classification: IsdsStatusClassification,
}) {
  get retryable(): boolean {
    return this.classification === "Transient";
  }

  override get message(): string {
    return `ISDS ${this.operation} returned ${this.statusKind}StatusCode ${this.code}: ${this.statusMessage}`;
  }
}

/** Failures of the HTTP exchange, before the SOAP body is interpreted. */
export type IsdsTransportFailure =
  | IsdsTransportError
  | IsdsTimeoutError
  | IsdsAuthError
  | IsdsMaintenanceError
  | IsdsHttpError;

/** Every failure an ISDS operation call can produce once its input is valid. */
export type IsdsCallError = IsdsTransportFailure | IsdsSoapFault | IsdsInvalidResponse | IsdsStatusError;
