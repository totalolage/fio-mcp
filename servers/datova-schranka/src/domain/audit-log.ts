import { createHash } from "node:crypto";
import { Redactor, type RedactorShape } from "@mcps/core/redaction.js";
import { Cause, Clock, Context, Data, DateTime, Effect, Exit, Layer, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { type DomainStoreError, storeFailure } from "./errors.js";
import { newRowId } from "./ids.js";

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

export class AuditLog extends Context.Service<AuditLog, AuditLogShape>()("datova-schranka/AuditLog") {
  /** Needs the database (SqlClient) with the domain migrations applied, and the process Redactor. */
  static readonly Default: Layer.Layer<AuditLog, never, SqlClient.SqlClient | Redactor> = Layer.effect(
    AuditLog,
    Effect.suspend(() => makeAuditLog),
  );
}

/** `<at>.<id>` for URLs; `parseAuditCursor` returns undefined for anything malformed. */
export const formatAuditCursor = (cursor: AuditCursor): string => `${cursor.at}.${cursor.id}`;
export const parseAuditCursor = (text: string): AuditCursor | undefined => {
  const dot = text.indexOf(".");
  if (dot <= 0) return undefined;
  const at = Number(text.slice(0, dot));
  const id = text.slice(dot + 1);
  return Number.isSafeInteger(at) && at >= 0 && id !== "" ? { at, id } : undefined;
};

const DAY_MILLIS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** 1-500, default 100; fractions are truncated, anything not a number is the default. */
const clampLimit = (limit: number | undefined): number =>
  limit === undefined || Number.isNaN(limit) ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));

/**
 * Replaces every byte array (any ArrayBuffer view, Buffer included) with
 * {bytes, sha256}, walking arrays and plain objects. A value that refers
 * back to one of its ancestors becomes "[circular]".
 */
const summarizeBytes = (value: unknown, ancestors: ReadonlySet<object> = new Set()): unknown => {
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { bytes: view.byteLength, sha256: createHash("sha256").update(view).digest("hex") };
  }
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[circular]";
  const inner = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map((item) => summarizeBytes(item, inner));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, summarizeBytes(item, inner)]));
};

/** A detail that JSON cannot encode (a BigInt, say) or a stored detail that does not parse; storeFailure logs and drops it. */
class AuditJsonError extends Data.TaggedError("AuditJsonError")<{ readonly cause: unknown }> {}

/** The stored form of `detail`: byte arrays summarized, then redacted, as JSON; undefined is {}. */
const encodeDetail = (redactor: RedactorShape, detail: unknown): Effect.Effect<string, AuditJsonError> =>
  Effect.try({
    try: () => JSON.stringify(redactor.redactDeep(summarizeBytes(detail ?? {}))) ?? "{}",
    catch: (cause) => new AuditJsonError({ cause }),
  });

interface AuditDbRow {
  readonly id: string;
  readonly at: number;
  readonly updated_at: number;
  readonly actor_kind: AuditActorKind;
  readonly grant_id: string | null;
  readonly client_id: string | null;
  readonly subject: string | null;
  readonly action: string;
  readonly box_id: string | null;
  readonly outcome: AuditOutcome;
  readonly detail_json: string;
}

const toEntry = (row: AuditDbRow): Effect.Effect<AuditEntry, AuditJsonError> =>
  Effect.try({
    try: () => ({
      id: row.id,
      at: row.at,
      updatedAt: row.updated_at,
      actorKind: row.actor_kind,
      grantId: row.grant_id ?? undefined,
      clientId: row.client_id ?? undefined,
      subject: row.subject ?? undefined,
      action: row.action,
      boxId: row.box_id ?? undefined,
      outcome: row.outcome,
      detail: JSON.parse(row.detail_json) as unknown,
    }),
    catch: (cause) => new AuditJsonError({ cause }),
  });

/** The latest cutoff purgeBefore accepts at `now`: everything younger than AUDIT_RETENTION_DAYS stays. */
const retentionFloor = (now: number): number => now - AUDIT_RETENTION_DAYS * DAY_MILLIS;

const makeAuditLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const redactor = yield* Redactor;

  const insert = Effect.fnUntraced(function* (input: AuditEventInput, outcome: AuditOutcome) {
    const id = newRowId("aud");
    const now = yield* Clock.currentTimeMillis;
    const detail = yield* encodeDetail(redactor, input.detail);
    yield* sql`
      INSERT INTO audit_log ${sql.insert({
        id,
        at: now,
        updated_at: now,
        actor_kind: input.actor.kind,
        grant_id: input.actor.grantId ?? null,
        client_id: input.actor.clientId ?? null,
        subject: input.actor.subject ?? null,
        action: input.action,
        box_id: input.boxId ?? null,
        outcome,
        detail_json: detail,
      })}
    `;
    return id;
  });

  const start: AuditLogShape["start"] = (input) => insert(input, "started").pipe(storeFailure("write an audit entry"));

  const record: AuditLogShape["record"] = (input) =>
    insert(input, input.outcome).pipe(storeFailure("write an audit entry"));

  /**
   * Only a row still "started" changes: a finished entry keeps its first
   * outcome. An id that matches no started row (unknown, purged or already
   * finished) is logged as a warning and otherwise ignored, so the caller's
   * own result is never replaced by an audit bookkeeping error.
   */
  const finish: AuditLogShape["finish"] = Effect.fn("AuditLog.finish")(function* (
    id: string,
    outcome: AuditFinalOutcome,
    detail?: unknown,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* (
      detail === undefined
        ? sql<{ id: string }>`
            UPDATE audit_log SET outcome = ${outcome}, updated_at = ${now}
            WHERE id = ${id} AND outcome = 'started' RETURNING id
          `
        : Effect.flatMap(
            encodeDetail(redactor, detail),
            (json) => sql<{ id: string }>`
              UPDATE audit_log SET outcome = ${outcome}, updated_at = ${now}, detail_json = ${json}
              WHERE id = ${id} AND outcome = 'started' RETURNING id
            `,
          )
    ).pipe(storeFailure("finish an audit entry"));
    if (rows.length === 0) {
      yield* Effect.logWarning("datova-schranka: no started audit entry to finish").pipe(
        Effect.annotateLogs({ auditId: id, outcome }),
      );
    }
  });

  const list: AuditLogShape["list"] = (query = {}) => {
    const limit = clampLimit(query.limit);
    const before = query.before;
    return sql<AuditDbRow>`
      SELECT * FROM audit_log
      WHERE ${query.grantId === undefined ? sql`1 = 1` : sql`grant_id = ${query.grantId}`}
        AND ${query.boxId === undefined ? sql`1 = 1` : sql`box_id = ${query.boxId}`}
        AND ${query.action === undefined ? sql`1 = 1` : sql`action = ${query.action}`}
        AND ${before === undefined ? sql`1 = 1` : sql`(at < ${before.at} OR (at = ${before.at} AND id < ${before.id}))`}
      ORDER BY at DESC, id DESC
      LIMIT ${limit + 1}
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows.slice(0, limit), toEntry)),
      Effect.map((entries): AuditPage => {
        const last = entries.at(-1);
        return {
          entries,
          next: entries.length === limit && last !== undefined ? { at: last.at, id: last.id } : undefined,
        };
      }),
      storeFailure("list the audit log"),
    );
  };

  /** Allowed cutoffs are at most now − AUDIT_RETENTION_DAYS days; an invalid Date is refused too. */
  const purgeBefore: AuditLogShape["purgeBefore"] = Effect.fn("AuditLog.purgeBefore")(function* (cutoff: Date) {
    const floor = retentionFloor(yield* Clock.currentTimeMillis);
    const at = cutoff.getTime();
    if (!(at <= floor)) {
      return yield* new AuditRetentionFloor({ earliestAllowed: DateTime.formatIsoDateUtc(DateTime.makeUnsafe(floor)) });
    }
    const rows = yield* sql<{ id: string }>`DELETE FROM audit_log WHERE at < ${at} RETURNING id`.pipe(
      storeFailure("purge the audit log"),
    );
    return rows.length;
  });

  return AuditLog.of({ start, finish, record, list, purgeBefore });
});

const isSentTimeout = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "IsdsTimeoutError" &&
  "requestSent" in error &&
  error.requestSent === true;

export interface AuditedOptions<A, E> {
  /** The detail stored on success; it replaces the start detail. Omitted or undefined keeps it. */
  readonly okDetail?: ((value: A) => unknown) | undefined;
  /** The detail stored on failure; it replaces the start detail. Omitted or undefined keeps it. */
  readonly errorDetail?: ((error: E) => unknown) | undefined;
  /** The outcome of a failure. Default: "uncertain" for an IsdsTimeoutError sent before it timed out, else "error". */
  readonly classify?: ((error: E) => AuditFinalOutcome) | undefined;
}

const finalOf = <A, E>(
  exit: Exit.Exit<A, E>,
  options: AuditedOptions<A, E>,
): { readonly outcome: AuditFinalOutcome; readonly detail: unknown } => {
  if (Exit.isSuccess(exit)) return { outcome: "ok", detail: options.okDetail?.(exit.value) };
  const failure = Cause.findError(exit.cause);
  if (Result.isSuccess(failure)) {
    const error = failure.success;
    const outcome = options.classify?.(error) ?? (isSentTimeout(error) ? "uncertain" : "error");
    return { outcome, detail: options.errorDetail?.(error) };
  }
  // Interrupted mid-call: the request may or may not have reached ISDS.
  if (Cause.hasInterruptsOnly(exit.cause)) return { outcome: "uncertain", detail: undefined };
  return { outcome: "error", detail: undefined };
};

/**
 * Runs `effect` between an audit intent and its outcome (design §9 R6).
 * The intent (outcome "started") is written first; if that write fails,
 * `effect` does not run and the DomainStoreError is returned. Once the
 * intent is written the outcome is recorded on every exit, uninterruptibly:
 * success "ok", failure per `classify`, a defect "error", an interruption
 * "uncertain". A failure to record the outcome (the write, or a detail
 * mapper that throws) is logged and leaves the row "started" (read as
 * "outcome unknown"); the caller still gets the result of `effect`.
 */
export const audited = Effect.fn("AuditLog.audited")(function* <A, E, R>(
  input: AuditEventInput,
  effect: Effect.Effect<A, E, R>,
  options: AuditedOptions<A, E> = {},
) {
  const audit = yield* AuditLog;
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(audit.start(input), (id) =>
      restore(effect).pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            const final = finalOf(exit, options);
            return audit.finish(id, final.outcome, final.detail);
          }).pipe(
            // A failing finish or a throwing detail mapper must not replace the call's own result.
            Effect.catchCause((cause) =>
              Effect.logWarning("datova-schranka: audit entry left started", cause).pipe(
                Effect.annotateLogs({ auditId: id }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
