import { Config, Effect, FileSystem, Option, Redacted, Schema } from "effect";

/**
 * Environment variables read through Effect's current ConfigProvider, for an
 * app's configuration loader. Callers pass full variable names, so an app
 * keeps its own prefix. Diagnostics name the variable, never its value or a
 * path: a misplaced secret must not reach stderr.
 */

/** Invalid configuration. Names the variable, never its value or a path. */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Fails with a ConfigError carrying `detail`. */
export const failConfig = (detail: string) => Effect.fail(new ConfigError({ detail }));

/** A trimmed, non-empty variable, or None. Never echoes the value on failure. */
export const optionalVar = Effect.fn("config.optionalVar")(function* (key: string) {
  const value = yield* Config.option(Config.String(key)).pipe(
    Effect.mapError(() => new ConfigError({ detail: `Could not read ${key}` })),
  );
  return Option.filter(
    Option.map(value, (s) => s.trim()),
    (s) => s !== "",
  );
});

/**
 * A secret from `key` or from the file named by `${key}_FILE`. Exactly one
 * may be set. A trailing newline in the file is dropped.
 */
export const secretVar = Effect.fn("config.secretVar")(function* (key: string) {
  const direct = yield* optionalVar(key);
  const file = yield* optionalVar(`${key}_FILE`);
  if (Option.isSome(direct) && Option.isSome(file)) {
    return yield* failConfig(`Set either ${key} or ${key}_FILE, not both`);
  }
  if (Option.isSome(file)) {
    const content = yield* readVarFile(`${key}_FILE`, file.value);
    const trimmed = content.replace(/\r?\n$/, "").trim();
    if (trimmed === "") return yield* failConfig(`${key}_FILE: file is empty`);
    return Option.some(Redacted.make(trimmed));
  }
  return Option.map(direct, (value) => Redacted.make(value));
});

/** The file `key` names, as text; failures name `key` only. */
export const readVarFile = Effect.fn("config.readVarFile")(function* (key: string, path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(path)
    .pipe(Effect.mapError(() => new ConfigError({ detail: `${key}: file not readable` })));
});

/** An integer >= `min`, or `fallback` when unset. `why` is appended to the failure. */
export const intVar = Effect.fn("config.intVar")(function* (key: string, fallback: number, min: number, why = "") {
  const raw = yield* optionalVar(key);
  if (Option.isNone(raw)) return fallback;
  const value = Number(raw.value);
  if (!Number.isInteger(value) || value < min) {
    return yield* failConfig(`${key} must be an integer >= ${min}${why}`);
  }
  return value;
});

/** true/false, 1/0, yes/no or on/off (any case), or `fallback` when unset. */
export const boolVar = Effect.fn("config.boolVar")(function* (key: string, fallback: boolean) {
  const raw = yield* optionalVar(key);
  if (Option.isNone(raw)) return fallback;
  const value = raw.value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return yield* failConfig(`${key} must be true or false`);
});

/** A comma-separated list, entries trimmed, empty entries dropped; empty when unset. */
export const listVar = (key: string) =>
  optionalVar(key).pipe(
    Effect.map((raw) =>
      Option.match(raw, {
        onNone: (): Array<string> => [],
        onSome: (value) =>
          value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== ""),
      }),
    ),
  );
