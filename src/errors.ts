/** Errors surfaced to the model. Messages must already be token-free. */

export class RateLimitedError extends Error {
  override name = "RateLimitedError";
  constructor(
    readonly retryAfterSeconds: number,
    reason: string,
  ) {
    super(`Rate limited: ${reason} Retry after ${retryAfterSeconds} s.`);
  }
}

export type FioErrorKind =
  | "bad_request" // 404: bad URL parameters or import data
  | "rate_limited" // 409: token used within the last 30 s
  | "too_many_items" // 413: more than 50,000 movements
  | "history_locked" // 422: data older than 90 days needs strong authorization
  | "token_rejected" // 500: token does not exist or is inactive
  | "unauthorized" // 401/403: not documented by FIO, but unambiguous
  | "http_error" // anything else
  | "network"
  | "timeout"
  | "bad_response";

export class FioApiError extends Error {
  override name = "FioApiError";
  constructor(
    readonly kind: FioErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const PERMISSION_DENIED = "You don't have permissions to do that.";

/** FIO refused the call because the token may not do it. The message leads with PERMISSION_DENIED. */
export class PermissionDeniedError extends Error {
  override name = "PermissionDeniedError";
  constructor(detail: string) {
    super(`${PERMISSION_DENIED}\n${detail}`);
  }
}

/** Maps a non-2xx HTTP status to the meaning documented in PDF §8. */
export function errorForStatus(status: number, bodyExcerpt: string): FioApiError {
  const detail = bodyExcerpt ? ` Response: ${bodyExcerpt}` : "";
  switch (status) {
    case 404:
      return new FioApiError("bad_request", `FIO rejected the request parameters (HTTP 404).${detail}`, status);
    case 409:
      return new FioApiError(
        "rate_limited",
        "FIO refused the request because this token was used less than 30 s ago (HTTP 409).",
        status,
      );
    case 413:
      return new FioApiError(
        "too_many_items",
        "The download would return more than 50,000 movements (HTTP 413). Narrow the date range or move the download marker forward.",
        status,
      );
    case 422:
      return new FioApiError(
        "history_locked",
        "The request covers data older than 90 days, which FIO only serves for 10 minutes after the account owner unlocks full history for this token in Internetbanking (HTTP 422).",
        status,
      );
    case 500:
      return new FioApiError(
        "token_rejected",
        `FIO returned HTTP 500, which the API documentation defines as "token does not exist or is inactive" (expired, revoked, or not yet active).${detail}`,
        status,
      );
    case 401:
    case 403:
      return new FioApiError("unauthorized", `FIO denied access with HTTP ${status}.${detail}`, status);
    default:
      return new FioApiError("http_error", `FIO returned HTTP ${status}.${detail}`, status);
  }
}

/** Arguments that pass the schema but make no sense together. */
export class ToolInputError extends Error {
  override name = "ToolInputError";
}
