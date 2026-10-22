import { Effect, Layer } from "effect";
import type { Accounts } from "./accounts.js";
import type { AppConfig } from "./config.js";
import { FioApi } from "./fio-api.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { Redactor } from "./redaction.js";

/** Placeholder until the generated OpenAPI client lands. */
export const FioApiLive: Layer.Layer<FioApi, never, AppConfig | Accounts | RateLimiter | Redactor> = Layer.effect(
  FioApi,
  Effect.die("FioApi is not implemented yet"),
);
