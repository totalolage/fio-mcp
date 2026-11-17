import { Context, type Effect, Schema } from "effect";
import type { DomainStoreError } from "./errors.js";

/**
 * The audit log (design §3, §9 R6): every tool call, admin action, consent
 * and system event. Calls with legal effect write their intent first
 * (outcome "started") and the outcome after, so a crash between the two
 * leaves a "started" row. `detail` is stored as redacted JSON: the
 * Redactor runs over it, and byte arrays become {bytes, sha256}, so no
 * credentials or attachment content reach the table. Rows have no FK to
 * grants or boxes and outlive both.
 */

export type AuditActorKind = "tool" | "admin" | "consent" | "system";

/**
 * "uncertain": the call may have taken effect but no answer arrived
 * (timeout after the request was sent).
 */
export type AuditOutcome = "started" | "ok" | "error" | "refused" | "uncertain";
export type AuditFinalOutcome = Exclude<AuditOutcome, "started">;

export interface AuditActor {
  readonly kind: AuditActorKind;
  readonly grantId?: string | undefined;
  readonly clientId?: string | undefined;
  /** The signed-in subject or admin, when known. */
  readonly subject?: string | undefined;
}

export interface AuditEventInput {
  readonly actor: AuditActor;
  /** The tool name or admin/system action, e.g. "list_received_messages", "box.add". */
  readonly action: string;
  readonly boxId?: string | undefined;
  readonly detail?: unknown;
}

export interface AuditEntry {
  readonly id: string;
  /** Epoch milliseconds the entry was first written. */
  readonly at: number;
  readonly updatedAt: number;
  readonly actorKind: AuditActorKind;
  readonly grantId: string | undefined;
  readonly clientId: string | undefined;
  readonly subject: string | undefined;
  readonly action: string;
  readonly boxId: string | undefined;
  readonly outcome: AuditOutcome;
  /** The parsed, already-redacted detail JSON. */
  readonly detail: unknown;
}

/** Position after the last entry of a page: entries strictly older than (at, id). */
export interface AuditCursor {
  readonly at: number;
  readonly id: string;
}

export interface AuditListQuery {
  readonly before?: AuditCursor | undefined;
  /** 1-500; default 100. */
  readonly limit?: number | undefined;
  readonly grantId?: string | undefined;
  readonly boxId?: string | undefined;
  readonly action?: string | undefined;
}

export interface AuditPage {
  /** Newest first. */
  readonly entries: ReadonlyArray<AuditEntry>;
  /** Present when older entries may exist. */
  readonly next: AuditCursor | undefined;
}

/** Audit rows must be kept at least 365 days. */
export const AUDIT_RETENTION_DAYS = 365;

export class AuditRetentionFloor extends Schema.TaggedError<AuditRetentionFloor>()("AuditRetentionFloor", {
  earliestAllowed: Schema.String,
}) {
  override get message(): string {
    return `Audit entries must be kept ${AUDIT_RETENTION_DAYS} days; the cutoff can be ${this.earliestAllowed} at the latest.`;
  }
}

export interface AuditLogShape {
  /** Writes the intent (outcome "started") and returns the entry id. */
  readonly start: (input: AuditEventInput) => Effect.Effect<string, DomainStoreError>;
  /** Sets the outcome of a started entry; `detail`, when given, replaces the stored one. */
  readonly finish: (id: string, outcome: AuditFinalOutcome, detail?: unknown) => Effect.Effect<void, DomainStoreError>;
  /** One-shot event: inserts an entry with its final outcome. */
  readonly record: (input: AuditEventInput & { readonly outcome: AuditFinalOutcome }) => Effect.Effect<string, DomainStoreError>;
  readonly list: (query?: AuditListQuery) => Effect.Effect<AuditPage, DomainStoreError>;
  /** Deletes entries written before `cutoff`; refuses a cutoff inside the retention floor. Returns the count. */
  readonly purgeBefore: (cutoff: Date) => Effect.Effect<number, AuditRetentionFloor | DomainStoreError>;
}

export class AuditLog extends Context.Service<AuditLog, AuditLogShape>()("datova-schranka/AuditLog") {}

/** `<at>.<id>` for URLs; `parseAuditCursor` returns undefined for anything malformed. */
export const formatAuditCursor = (cursor: AuditCursor): string => `${cursor.at}.${cursor.id}`;
export const parseAuditCursor = (text: string): AuditCursor | undefined => {
  const dot = text.indexOf(".");
  if (dot <= 0) return undefined;
  const at = Number(text.slice(0, dot));
  const id = text.slice(dot + 1);
  return Number.isSafeInteger(at) && at >= 0 && id !== "" ? { at, id } : undefined;
};
