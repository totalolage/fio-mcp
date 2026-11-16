import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import {
  CacheError,
  FioBadRequest,
  FioResponseError,
  FioServerError,
  FioTransportError,
  HistoryAuthorizationRequired,
  InvalidInput,
  PermissionDenied,
  RateLimited,
  TokenRejected,
  TooManyItems,
  UploadOutcomeUnknown,
  XmlParseError,
} from "../errors.js";
import { type GuardSpec, guardMarked, guardResult, hasMarks } from "./untrusted.js";

/** Tool results are JSON objects; their shape is described in each tool's description. */
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Every expected failure a tool can report. Declared failures become
 * `isError` results whose text is the error's message.
 */
export const ToolFailure = Schema.Union([
  RateLimited,
  TokenRejected,
  PermissionDenied,
  FioBadRequest,
  TooManyItems,
  HistoryAuthorizationRequired,
  FioServerError,
  FioTransportError,
  FioResponseError,
  XmlParseError,
  InvalidInput,
  UploadOutcomeUnknown,
  CacheError,
]);

/**
 * Guards the bank text an error message carries (marked excerpts, SEC-05).
 * The copy keeps the error's class and fields; only its message differs.
 */
export const guardFailure = <E>(error: E): Effect.Effect<E> => {
  if (!(error instanceof Error) || !hasMarks(error.message)) return Effect.succeed(error);
  return Effect.map(guardMarked(error.message), (message) => {
    const copy: E = Object.assign(Object.create(Object.getPrototypeOf(error)), error);
    Object.defineProperty(copy, "message", { value: message, enumerable: false, configurable: true });
    return copy;
  });
};

/**
 * The output path of every tool: redact, guard bank text (SEC-05), redact
 * again. Guarding runs inside redaction, so a token in bank text is still
 * `***` inside its guard; redaction never touches guard tags.
 */
export const guardedOutput =
  (redactDeep: <T>(value: T) => T) =>
  <A extends Record<string, unknown>, E, R>(effect: Effect.Effect<A, E, R>, spec: GuardSpec = MARKED_ONLY) =>
    effect.pipe(
      Effect.flatMap((result) => guardResult(redactDeep(result), spec)),
      Effect.map(redactDeep),
      Effect.catch((error) => Effect.flatMap(guardFailure(error), Effect.fail)),
    );

const MARKED_ONLY: GuardSpec = { _tag: "Marked" };

export const DateParam = (what: string) =>
  Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { message: "must be YYYY-MM-DD" })).annotate({
    description: what,
  });

type AccountFields = { readonly account: Schema.optionalKey<Schema.String> };

/**
 * Adds the `account` parameter when several accounts are configured. With one
 * account the parameter does not exist, and strict decoding rejects it.
 */
export function withAccount<F extends Schema.Struct.Fields>(
  fields: F,
  accountNames: ReadonlyArray<string>,
): Schema.Struct<F & AccountFields> {
  const all: Schema.Struct.Fields =
    accountNames.length > 1
      ? {
          ...fields,
          // Generic: HTTP narrows the enum to the session's granted accounts.
          account: Schema.Literals(accountNames).annotate({ description: "Name of the account to use." }),
        }
      : fields;
  // MCP needs an object-rooted JSON Schema; an empty Struct encodes to
  // `{ not: { type: "null" } }`, so a tool without parameters uses EmptyParams.
  const schema = Object.keys(all).length === 0 ? Tool.EmptyParams : Schema.Struct(all);
  // The runtime schema is narrower than the declared type (account is
  // required with several accounts and absent with one); handlers only read
  // `account` as an optional name.
  return schema as unknown as Schema.Struct<F & AccountFields>;
}

export interface ToolHints {
  readonly title: string;
  readonly readOnly: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly openWorld: boolean;
}

export function annotateTool<T extends Tool.Any>(tool: T, hints: ToolHints): T {
  return tool
    .annotate(Tool.Title, hints.title)
    .annotate(Tool.Readonly, hints.readOnly)
    .annotate(Tool.Destructive, hints.destructive ?? false)
    .annotate(Tool.Idempotent, hints.idempotent ?? false)
    .annotate(Tool.OpenWorld, hints.openWorld)
    .annotate(Tool.Strict, true) as T;
}
