import { Effect, Layer } from "effect";
import {
  type AuditEventInput,
  type AuditFinalOutcome,
  AuditLog,
} from "../../../src/domain/audit-log.js";
import { DomainStoreError } from "../../../src/domain/errors.js";

export type ReadAuditEvent =
  | { readonly kind: "start"; readonly id: string; readonly input: AuditEventInput }
  | { readonly kind: "finish"; readonly id: string; readonly outcome: AuditFinalOutcome; readonly detail: unknown };

/**
 * An AuditLog that records start/finish in order, into its own `events` and as
 * `audit.start <action>` / `audit.finish <outcome>` lines in the shared `log`.
 * `failStart` makes start fail with DomainStoreError (nothing recorded); `failFinish` makes
 * finish fail with DomainStoreError or die, after logging `audit.finish <outcome> (failed)`.
 */
export const readAuditLog = (
  log: Array<string>,
  options: { readonly failStart?: boolean; readonly failFinish?: "fail" | "die" } = {},
) => {
  const events: Array<ReadAuditEvent> = [];
  const unused = Effect.die("read-audit-log: not used by ReadService");
  const layer = Layer.succeed(
    AuditLog,
    AuditLog.of({
      start: (input) =>
        Effect.suspend(() => {
          if (options.failStart === true) return Effect.fail(new DomainStoreError({ operation: "write audit entry" }));
          const id = `audit_${events.length + 1}`;
          events.push({ kind: "start", id, input });
          log.push(`audit.start ${input.action}`);
          return Effect.succeed(id);
        }),
      finish: (id, outcome, detail) =>
        Effect.suspend(() => {
          if (options.failFinish === "fail") {
            log.push(`audit.finish ${outcome} (failed)`);
            return Effect.fail(new DomainStoreError({ operation: "update audit entry" }));
          }
          if (options.failFinish === "die") {
            log.push(`audit.finish ${outcome} (died)`);
            return Effect.die("read-audit-log: finish died");
          }
          events.push({ kind: "finish", id, outcome, detail });
          log.push(`audit.finish ${outcome}`);
          return Effect.void;
        }),
      record: () => unused,
      list: () => unused,
      purgeBefore: () => unused,
    }),
  );
  return { layer, events };
};
