import { Effect, Schema, type SchemaIssue } from "effect";
import { McpSchema, McpServer, type Tool, type Toolkit } from "effect/ai";
import { type AuditActor, AuditLog } from "../domain/audit-log.js";
import { toolActor } from "./call.js";
import { currentCaller } from "./caller.js";

/**
 * Audits tool calls whose input fails schema decoding. McpServer decodes a
 * toolkit tool's parameters before its handler runs and answers a failure
 * with InvalidParams, so no handler (and no service) sees the call; these
 * helpers write its one audit row instead: actor tool (grant and client
 * when the call has an OAuth caller), action = tool name, outcome refused,
 * detail {reason: "invalid_input", issues: [{path, kind}]} with no input
 * values. The client still gets the toolkit's InvalidParams answer.
 *
 * A group opts in by registering its toolkit with registerAuditedToolkit
 * instead of McpServer.registerToolkit (read-tools.ts, send-tools.ts); a raw
 * tool calls recordInvalidInput when its own decode fails (download-tool.ts).
 * A tools/call naming a tool that is not registered is answered by
 * McpServer itself and is not audited.
 */

/** At most this many issues go into the audit detail. */
const MAX_ISSUES = 20;
/** A key from the input is audited only when it looks like a parameter name. */
const PARAMETER_NAME = /^[A-Za-z0-9_]{1,64}$/;

export interface InputIssue {
  readonly path: ReadonlyArray<string | number>;
  /** The schema issue kind: MissingKey, UnexpectedKey, InvalidType, InvalidValue, Forbidden, OneOf, AnyOf. */
  readonly kind: string;
}

const segment = (key: PropertyKey): string | number => {
  if (typeof key === "number") return key;
  return typeof key === "string" && PARAMETER_NAME.test(key) ? key : "<key>";
};

/** The leaf issues of a decode failure as paths and kinds; values never appear. */
export const inputIssues = (issue: SchemaIssue.Issue): ReadonlyArray<InputIssue> => {
  const out: Array<InputIssue> = [];
  const visit = (node: SchemaIssue.Issue, path: ReadonlyArray<string | number>): void => {
    if (out.length >= MAX_ISSUES) return;
    switch (node._tag) {
      case "Pointer":
        visit(node.issue, [...path, ...node.path.map(segment)]);
        return;
      case "Filter":
      case "Encoding":
        visit(node.issue, path);
        return;
      case "Composite":
        for (const child of node.issues) visit(child, path);
        return;
      case "AnyOf":
        if (node.issues.length === 0) out.push({ path, kind: node._tag });
        for (const child of node.issues) visit(child, path);
        return;
      default:
        out.push({ path, kind: node._tag });
    }
  };
  visit(issue, []);
  return out;
};

const DECODE_OPTIONS = { onExcessProperty: "error", errors: "all" } as const;

/** The issues of `payload` against `schema`, or none when it decodes (the failure had another cause). */
export const payloadIssues = (schema: Schema.Top, payload: unknown): ReadonlyArray<InputIssue> => {
  const result = Schema.decodeExit(schema as Schema.Codec<unknown, unknown>)(payload ?? {}, DECODE_OPTIONS);
  if (result._tag === "Success") return [];
  const failure = result.cause.reasons.find((reason) => reason._tag === "Fail");
  const error: unknown = failure?._tag === "Fail" ? failure.error : undefined;
  return Schema.isSchemaError(error) ? inputIssues(error.issue) : [];
};

/**
 * Writes the one refused row of a call to `tool` whose input failed
 * decoding. Never fails: when the audit store cannot take the row, the
 * failure is logged at error level and the call is still rejected (nothing
 * runs for it), the same outage policy as a refusal (call.ts) and as a
 * service whose intent row cannot be written.
 */
export const recordInvalidInput = (
  tool: string,
  issues: ReadonlyArray<InputIssue>,
): Effect.Effect<void, never, AuditLog> =>
  Effect.gen(function* () {
    const caller = yield* Effect.option(currentCaller);
    const actor: AuditActor = caller._tag === "Some" ? toolActor(caller.value) : { kind: "tool" };
    const audit = yield* AuditLog;
    yield* audit.record({ actor, action: tool, outcome: "refused", detail: { reason: "invalid_input", issues } });
  }).pipe(
    Effect.catch((error) => Effect.logError(`mcp: could not audit the invalid input of a ${tool} call`, error)),
  );

type Registration = Parameters<McpServer.McpServer["Service"]["addTool"]>[0];

/**
 * McpServer.registerToolkit with invalid-input auditing: the toolkit's own
 * registrations (same tools/list entries, decoding and handlers) are added
 * with a handler that records a refused row when the call fails with
 * InvalidParams, then answers as before. Provide the handlers layer as with
 * McpServer.registerToolkit.
 */
export const registerAuditedToolkit = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<Tools>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const audit = yield* AuditLog;
    const captured: Array<Registration> = [];
    const capturing = McpServer.McpServer.of({
      ...server,
      addTool: (registration) => Effect.sync(() => void captured.push(registration)),
    });
    yield* McpServer.registerToolkit(toolkit).pipe(Effect.provideService(McpServer.McpServer, capturing));
    const tools: Readonly<Record<string, Tool.Any>> = toolkit.tools;
    // Every tool must come back through addTool, or one would be registered without the audit.
    const names = captured.map((registration) => registration.tool.name).sort();
    const expected = Object.keys(tools).sort();
    if (names.join("\n") !== expected.join("\n")) {
      return yield* Effect.die(`registerAuditedToolkit: captured [${names.join(", ")}] for [${expected.join(", ")}]`);
    }
    for (const registration of captured) {
      const name = registration.tool.name;
      const parameters = tools[name]?.parametersSchema;
      yield* server.addTool({
        ...registration,
        handle: (payload: unknown) =>
          registration.handle(payload).pipe(
            Effect.tapError((error) =>
              error instanceof McpSchema.InvalidParams
                ? recordInvalidInput(name, parameters === undefined ? [] : payloadIssues(parameters, payload)).pipe(
                    Effect.provideService(AuditLog, audit),
                  )
                : Effect.void,
            ),
          ),
      });
    }
  });
