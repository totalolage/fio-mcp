import { Layer } from "effect";
import { AppConfig, type AppConfigShape } from "../../src/config.js";

/** AppConfig seeded with `config` instead of read from the environment. */
export const seededConfig = (config: AppConfigShape) => Layer.succeed(AppConfig, AppConfig.of(config));
