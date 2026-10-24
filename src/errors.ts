import { Schema } from "effect";

/**
 * Expected failures. Every error's `message` is shown to the model as the
 * tool result, so it must be token-free and say what to do next.
 */

export const PERMISSION_DENIED = "You don't have permissions to do that.";

export const UPLOAD_UNCERTAIN =
  "The upload may or may not have created a batch. Check the pending batches in FIO Internetbanking before submitting again, or the orders could be duplicated.";

/** The limiter could not give this call a slot within its wait budget, or FIO kept answering 409. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  retryAfterSeconds: Schema.Int,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Rate limited: ${this.reason} Retry after ${this.retryAfterSeconds} s.`;
  }
}

/**
 * HTTP 409: the token was used less than 30 s ago (possibly by another
 * program). The rate limiter consumes it: it blocks the token for an
 * interval and retries once, or fails with RateLimited.
 */
export class TokenBusy extends Schema.TaggedError<TokenBusy>()("TokenBusy", {}) {
  override get message(): string {
    return "FIO refused the request because this token was used less than 30 s ago (HTTP 409).";
  }
}

/** HTTP 500 on a read: FIO's documented meaning is "token does not exist or is inactive". */
export class TokenRejected extends Schema.TaggedError<TokenRejected>()("TokenRejected", {
  excerpt: Schema.String,
}) {
  override get message(): string {
    return `FIO returned HTTP 500, which the API documentation defines as "token does not exist or is inactive" (expired, revoked, or not yet active).${detail(this.excerpt)}`;
  }
}

/** FIO refused the call because the token may not do it. */
export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()("PermissionDenied", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `${PERMISSION_DENIED}\n${this.detail}`;
  }
}

/** HTTP 404: FIO's code for bad request parameters (URL, query, or import data). */
export class FioBadRequest extends Schema.TaggedError<FioBadRequest>()("FioBadRequest", {
  excerpt: Schema.String,
}) {
  override get message(): string {
    return `FIO rejected the request parameters (HTTP 404).${detail(this.excerpt)}`;
  }
}

/** HTTP 413: the download would return more than 50,000 movements. */
export class TooManyItems extends Schema.TaggedError<TooManyItems>()("TooManyItems", {}) {
  override get message(): string {
    return "The download would return more than 50,000 movements (HTTP 413). Narrow the date range or move the download marker forward.";
  }
}

/** HTTP 422: data older than 90 days needs the owner to unlock history in Internetbanking. */
export class HistoryAuthorizationRequired extends Schema.TaggedError<HistoryAuthorizationRequired>()(
  "HistoryAuthorizationRequired",
  {},
) {
  override get message(): string {
    return `The request covers data older than 90 days, which FIO only serves for 10 minutes after the account owner unlocks full history for this token in Internetbanking (HTTP 422). ${HISTORY_UNLOCK_STEPS}`;
  }
}

export const HISTORY_UNLOCK_STEPS =
  "To unlock it: sign in to FIO Internetbanking, open Nastavení → API, select this token, and authorize access to the full history (SMS or push). The unlock lasts 10 minutes.";

/** Any other non-2xx status. */
export class FioServerError extends Schema.TaggedError<FioServerError>()("FioServerError", {
  status: Schema.Int,
  excerpt: Schema.String,
}) {
  override get message(): string {
    return `FIO returned HTTP ${this.status}.${detail(this.excerpt)}`;
  }
}

/**
 * The request did not complete. `dispatched` is false when nothing reached
 * FIO (the request could not be built); a payment upload is then certainly
 * not created.
 */
export class FioTransportError extends Schema.TaggedError<FioTransportError>()("FioTransportError", {
  kind: Schema.Literals(["network", "timeout"]),
  detail: Schema.String,
  dispatched: Schema.Boolean,
}) {
  override get message(): string {
    return this.kind === "timeout" ? `FIO did not respond in time. ${this.detail}` : `Could not reach FIO: ${this.detail}`;
  }
}

/** A 2xx response that is not what the API documents (bad JSON, wrong shape, unreadable body). */
export class FioResponseError extends Schema.TaggedError<FioResponseError>()("FioResponseError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** The payment import response is not valid XML or lacks `<responseImport><result>`. */
export class XmlParseError extends Schema.TaggedError<XmlParseError>()("XmlParseError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Arguments that pass the schema but make no sense together, or a precondition the caller can fix. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * A payment upload failed after it may have reached FIO. Wraps the
 * underlying failure's message with the "check Internetbanking" warning.
 */
export class UploadOutcomeUnknown extends Schema.TaggedError<UploadOutcomeUnknown>()("UploadOutcomeUnknown", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `${this.detail}\n${UPLOAD_UNCERTAIN}`;
  }
}

/** The local SQLite cache failed. The SQL cause is logged (redacted), not shown. */
export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  operation: Schema.String,
}) {
  override get message(): string {
    return `The local transaction cache failed while trying to ${this.operation}. See the server log for details.`;
  }
}

/** Invalid configuration. Names the variable, never its value or a path. */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Errors any FIO request can fail with. */
export type FioRequestError =
  | RateLimited
  | TokenRejected
  | PermissionDenied
  | FioBadRequest
  | TooManyItems
  | HistoryAuthorizationRequired
  | FioServerError
  | FioTransportError
  | FioResponseError;

/** The FIO operation class, which decides how HTTP 500 is read. */
export type Operation = "read" | "import";

const PAYMENT_TOKEN_HINT =
  'Payment orders need a token created with the "Sledování účtu a zadávání platebních a inkasních příkazů" permission (Internetbanking → Nastavení → API).';

export { PAYMENT_TOKEN_HINT };

function detail(excerpt: string): string {
  return excerpt === "" ? "" : ` Response: ${excerpt}`;
}

/**
 * Maps a non-2xx status to the meaning documented in PDF §8. `excerpt` must
 * already be redacted and truncated.
 *
 * Permission refusals: FIO documents no permission error, so this covers
 * the signals that can only mean the token may not do this. HTTP 401/403 on
 * any call (undocumented but unambiguous), and HTTP 500 on a payment upload,
 * FIO's code for a missing or inactive token and the most likely answer to
 * a read-only token trying to upload. HTTP 500 on reads keeps FIO's
 * documented meaning.
 */
export function errorForStatus(
  status: number,
  excerpt: string,
  operation: Operation,
): Exclude<FioRequestError, RateLimited | FioTransportError | FioResponseError> | TokenBusy {
  switch (status) {
    case 401:
    case 403:
      return new PermissionDenied({
        detail:
          `FIO refused this token (HTTP ${status}). Check the token and its permission in Internetbanking (Nastavení → API).` +
          (operation === "import" ? ` ${PAYMENT_TOKEN_HINT}` : ""),
      });
    case 404:
      return new FioBadRequest({ excerpt });
    case 409:
      return new TokenBusy();
    case 413:
      return new TooManyItems();
    case 422:
      return new HistoryAuthorizationRequired();
    case 500:
      return operation === "import"
        ? new PermissionDenied({
            detail: `FIO rejected this token for payment orders (HTTP 500, which FIO documents as "token does not exist or is inactive"): it is read-only, or inactive or expired. ${PAYMENT_TOKEN_HINT}`,
          })
        : new TokenRejected({ excerpt });
    default:
      return new FioServerError({ status, excerpt });
  }
}
