import { Schema } from "effect";

/**
 * OAuth protocol errors (RFC 6749 §5.2, RFC 7591 §3.2.2, RFC 8707 §2,
 * RFC 6750 §3.1). Each tag maps to one RFC `error` code and HTTP status;
 * `description` becomes `error_description` and must never contain a token,
 * code, password, or cookie.
 */

const fields = { description: Schema.String };

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", fields) {}
export class InvalidClient extends Schema.TaggedError<InvalidClient>()("InvalidClient", fields) {}
export class InvalidGrant extends Schema.TaggedError<InvalidGrant>()("InvalidGrant", fields) {}
export class UnauthorizedClient extends Schema.TaggedError<UnauthorizedClient>()("UnauthorizedClient", fields) {}
export class UnsupportedGrantType extends Schema.TaggedError<UnsupportedGrantType>()("UnsupportedGrantType", fields) {}
export class UnsupportedResponseType extends Schema.TaggedError<UnsupportedResponseType>()(
  "UnsupportedResponseType",
  fields,
) {}
export class InvalidScope extends Schema.TaggedError<InvalidScope>()("InvalidScope", fields) {}
export class InvalidTarget extends Schema.TaggedError<InvalidTarget>()("InvalidTarget", fields) {}
export class AccessDenied extends Schema.TaggedError<AccessDenied>()("AccessDenied", fields) {}
export class InvalidRedirectUri extends Schema.TaggedError<InvalidRedirectUri>()("InvalidRedirectUri", fields) {}
export class InvalidClientMetadata extends Schema.TaggedError<InvalidClientMetadata>()(
  "InvalidClientMetadata",
  fields,
) {}
/** Capacity exhausted (503), e.g. the client registry is full. */
export class TemporarilyUnavailable extends Schema.TaggedError<TemporarilyUnavailable>()("TemporarilyUnavailable", {
  description: Schema.String,
  retryAfterSeconds: Schema.Int,
}) {}
/** Rate limited (429), e.g. too many registrations. RFC 6749 has no code of its own for it. */
export class TooManyRequests extends Schema.TaggedError<TooManyRequests>()("TooManyRequests", {
  description: Schema.String,
  retryAfterSeconds: Schema.Int,
}) {}
/** Storage failed; the cause is logged (redacted), never returned. */
export class ServerError extends Schema.TaggedError<ServerError>()("ServerError", fields) {}

export type OAuthError =
  | InvalidRequest
  | InvalidClient
  | InvalidGrant
  | UnauthorizedClient
  | UnsupportedGrantType
  | UnsupportedResponseType
  | InvalidScope
  | InvalidTarget
  | AccessDenied
  | InvalidRedirectUri
  | InvalidClientMetadata
  | TemporarilyUnavailable
  | TooManyRequests
  | ServerError;

/** RFC error code and HTTP status for JSON endpoints (/token, /register, /revoke). */
export const OAUTH_ERRORS: Record<OAuthError["_tag"], { readonly code: string; readonly status: number }> = {
  InvalidRequest: { code: "invalid_request", status: 400 },
  // RFC 6749 §5.2: 401 for failed client authentication.
  InvalidClient: { code: "invalid_client", status: 401 },
  InvalidGrant: { code: "invalid_grant", status: 400 },
  UnauthorizedClient: { code: "unauthorized_client", status: 400 },
  UnsupportedGrantType: { code: "unsupported_grant_type", status: 400 },
  UnsupportedResponseType: { code: "unsupported_response_type", status: 400 },
  InvalidScope: { code: "invalid_scope", status: 400 },
  InvalidTarget: { code: "invalid_target", status: 400 },
  AccessDenied: { code: "access_denied", status: 403 },
  InvalidRedirectUri: { code: "invalid_redirect_uri", status: 400 },
  InvalidClientMetadata: { code: "invalid_client_metadata", status: 400 },
  TemporarilyUnavailable: { code: "temporarily_unavailable", status: 503 },
  TooManyRequests: { code: "temporarily_unavailable", status: 429 },
  ServerError: { code: "server_error", status: 500 },
};

/**
 * Failures of the browser-facing login and consent pages. They render as
 * HTML (the redirect URI is either untrusted or not involved yet).
 */
export class PageError extends Schema.TaggedError<PageError>()("PageError", {
  status: Schema.Int,
  title: Schema.String,
  detail: Schema.String,
}) {}

