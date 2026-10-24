import { Schema } from "effect";

/** Failures of `Auth.authenticate` (src/transport/auth.ts), apart so its adapters can raise them without importing `Auth`. */

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  /** `WWW-Authenticate` value for the 401 response. */
  challenge: Schema.String,
}) {}

/** The credentials could not be checked (storage failure); answered with 503. */
export class AuthUnavailable extends Schema.TaggedError<AuthUnavailable>()("AuthUnavailable", {}) {}
