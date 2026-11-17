import { type GuardSpec, guardedOutput, markUntrusted } from "@mcps/core/mcp/untrusted.js";
import { Redactor } from "@mcps/core/redaction.js";
import { Effect, Schema } from "effect";
import { type AuditActor, AuditLog } from "../domain/audit-log.js";
import { BoxRegistry } from "../domain/boxes.js";
import { type Caller, currentCaller } from "./caller.js";
import { ACCEPTED_DELIVERY_CONSENT_VERSIONS } from "./consent-versions.js";
import { READ_SCOPE, type ToolSpec } from "./tool-group.js";

/**
 * The one failure every datova-schranka tool declares: an `isError` result
 * whose text is `text`. ISDS text in it is marked (markUntrusted), so the
 * output guard wraps it.
 */
export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  text: Schema.String,
}) {
  override get message(): string {
    return this.text;
  }
}

/** The audit actor of a tool call by `caller`. */
export const toolActor = (caller: Caller): AuditActor => ({
  kind: "tool",
  grantId: caller.grantId,
  clientId: caller.clientId,
  subject: caller.subject,
});

/**
 * A service failure as the tool's error. ISDS errors can carry the ISDS
 * server's text (fault strings, status messages, response excerpts), so
 * their whole message is marked untrusted; the server's own errors keep
 * their wording.
 */
export const toolError = (error: Error & { readonly _tag: string }): ToolError =>
  new ToolError({ text: error._tag.startsWith("Isds") ? markUntrusted(error.message) : error.message });

/**
 * The output path of every tool (core guardedOutput over the Redactor):
 * redact, guard the untrusted text `spec` names, redact again; a failure's
 * marked text is guarded. Binary content never goes through it (see
 * download-tool.ts).
 */
export const toolOutput = <A extends Record<string, unknown>, E, R>(
  effect: Effect.Effect<A, E, R>,
  spec?: GuardSpec,
): Effect.Effect<A, E, R | Redactor> =>
  Effect.flatMap(Effect.service(Redactor), (redactor) => guardedOutput(redactor.redactDeep)(effect, spec));

// --- Authorization ---------------------------------------------------------------------------

const NO_CALLER = "This server serves OAuth grants only, and this call carries none.";
const NOT_COVERED = "Your grant does not cover a data box with that label.";
const NO_CONSENT =
  "Your grant has no accepted delivery consent. Authorize the client again and tick the delivery consent to use read tools.";
const missingScopeText = (missing: ReadonlyArray<string>) =>
  `Your grant lacks the ${missing.join(", ")} scope${missing.length > 1 ? "s" : ""}; authorize the client again with it.`;
const auditFailedText = "The refusal of this call could not be recorded; nothing was done.";

/** A box label from the input goes into the audit detail cut to this many characters. */
const MAX_AUDITED_LABEL_LENGTH = 64;

interface Refusal {
  readonly text: string;
  readonly reason: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly boxId?: string;
}

/** Records `refusal` as the call's one audit row (outcome refused), then fails with its text. */
const refuse = (tool: ToolSpec, actor: AuditActor, refusal: Refusal): Effect.Effect<never, ToolError, AuditLog> =>
  Effect.flatMap(Effect.service(AuditLog), (audit) =>
    audit.record({
      actor,
      action: tool.name,
      boxId: refusal.boxId,
      outcome: "refused",
      detail: { reason: refusal.reason, ...refusal.detail },
    }),
  ).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.fail(new ToolError({ text: auditFailedText })),
      onSuccess: () => Effect.fail(new ToolError({ text: refusal.text })),
    }),
  );

/**
 * Runs `run` for the current caller once the call is authorized for `tool`:
 * an OAuth caller, every scope of `tool`, then (unless `tool` is
 * resourceless) the `box` label of a loaded box the grant covers, and for
 * isds:read tools a delivery consent of an accepted wording version
 * (ACCEPTED_DELIVERY_CONSENT_VERSIONS; anything else is refused). A refused call writes exactly
 * one audit row (actor tool, action = tool name, outcome refused, detail
 * {reason, ...}) and fails with ToolError; `run` is not called. `run` gets
 * the box id (undefined only for a resourceless tool) and must audit the
 * call itself (the domain services do), so every call has one audit row.
 */
export const authorizedCall = <A, E, R>(
  tool: ToolSpec,
  input: { readonly box?: string | undefined },
  run: (caller: Caller, boxId: string | undefined) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ToolError, R | AuditLog | BoxRegistry> =>
  Effect.gen(function* () {
    const found = yield* Effect.option(currentCaller);
    if (found._tag === "None") {
      return yield* refuse(tool, { kind: "tool" }, { text: NO_CALLER, reason: "no_caller" });
    }
    const caller = found.value;
    const actor = toolActor(caller);
    const missing = tool.scopes.filter((scope) => !caller.scopes.has(scope));
    if (missing.length > 0) {
      return yield* refuse(tool, actor, { text: missingScopeText(missing), reason: "missing_scope", detail: { missing } });
    }
    let boxId: string | undefined;
    if (tool.resourceless !== true) {
      const label = input.box ?? "";
      const boxes = yield* (yield* BoxRegistry).list;
      // Only loaded boxes are listed, so a removed box or one of another environment is unknown here.
      const box = boxes.find((candidate) => candidate.label === label);
      if (box === undefined) {
        const box = label.slice(0, MAX_AUDITED_LABEL_LENGTH);
        return yield* refuse(tool, actor, { text: NOT_COVERED, reason: "unknown_box", detail: { box } });
      }
      if (!caller.boxIds.has(box.id)) {
        return yield* refuse(tool, actor, { text: NOT_COVERED, reason: "box_not_granted", boxId: box.id });
      }
      boxId = box.id;
    }
    const consent = caller.deliveryConsentVersion;
    if (tool.scopes.includes(READ_SCOPE) && (consent === null || !ACCEPTED_DELIVERY_CONSENT_VERSIONS.has(consent))) {
      return yield* refuse(tool, actor, {
        text: NO_CONSENT,
        reason: "no_delivery_consent",
        ...(boxId === undefined ? {} : { boxId }),
      });
    }
    return yield* run(caller, boxId);
  });

/**
 * authorizedCall for a box-bound tool: `run` gets the audit actor and the
 * box id. Calling it with a resourceless spec is a programming error.
 */
export const authorizedBoxCall = <A, E, R>(
  tool: ToolSpec,
  input: { readonly box: string },
  run: (actor: AuditActor, boxId: string, caller: Caller) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ToolError, R | AuditLog | BoxRegistry> =>
  authorizedCall(tool, input, (caller, boxId) =>
    boxId === undefined
      ? Effect.die(`authorizedBoxCall: ${tool.name} is resourceless`)
      : run(toolActor(caller), boxId, caller),
  );
