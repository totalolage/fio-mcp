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

const summary = (view: Uint8Array) => ({
  bytes: view.byteLength,
  sha256: createHash("sha256").update(view).digest("hex"),
});

/**
 * Turns `detail` into inert JSON data before it is redacted, so nothing
 * JSON.stringify runs afterwards (a toJSON hook, a getter) can emit
 * unredacted text. Byte arrays (any ArrayBuffer view, Buffer included, and
 * ArrayBuffer) become {bytes, sha256}; a toJSON hook (Date, Redacted, Effect
 * data types) runs first and its result is walked; any other object, a
 * class instance too, contributes its own enumerable fields; bigints become
 * strings; undefined, functions and symbols are dropped from objects and
 * become null in arrays, as JSON does; non-finite numbers become null; a
 * value that refers back to one of its ancestors becomes "[circular]".
 */
const toJsonData = (value: unknown, ancestors: ReadonlySet<object> = new Set()): unknown => {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (value === null || typeof value !== "object") return null;
  if (ArrayBuffer.isView(value)) return summary(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ArrayBuffer) return summary(new Uint8Array(value));
  if (ancestors.has(value)) return "[circular]";
  const inner = new Set(ancestors).add(value);
  if ("toJSON" in value && typeof value.toJSON === "function") return toJsonData(value.toJSON(), inner);
  if (Array.isArray(value)) return value.map((item) => toJsonData(item, inner) ?? null);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const data = toJsonData(item, inner);
      return data === undefined ? [] : [[key, data] as const];
    }),
  );
};

/**
 * A detail that cannot be encoded (a getter or toJSON hook threw), a stored
 * detail that does not parse, or a detail mapper of `audited` that threw.
 */
class AuditDetailError extends Data.TaggedError("AuditDetailError")<{ readonly cause: unknown }> {}

/** Stored instead of a start or record detail that cannot be encoded. */
const UNENCODABLE_DETAIL = JSON.stringify({ detailError: "unencodable" });

/**
 * The stored form of `detail`: inert JSON data, redacted, as JSON; undefined
 * is {}. A detail that cannot be encoded is logged and gives undefined, so
 * the entry is still written.
 */
const encodeDetail = (redactor: RedactorShape, detail: unknown): Effect.Effect<string | undefined> =>
  Effect.try({
    try: () => {
      const data = detail === undefined ? {} : toJsonData(detail);
      return JSON.stringify(redactor.redactDeep(data === undefined ? {} : data));
    },
    catch: (cause) => new AuditDetailError({ cause }),
  }).pipe(
    Effect.catch((error) =>
      Effect.as(Effect.logWarning("datova-schranka: an audit detail could not be encoded", error), undefined),
    ),
  );

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

const toEntry = (row: AuditDbRow): Effect.Effect<AuditEntry, AuditDetailError> =>
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
    catch: (cause) => new AuditDetailError({ cause }),
  });

/** The latest cutoff purgeBefore accepts at `now`: everything younger than AUDIT_RETENTION_DAYS stays. */
const retentionFloor = (now: number): number => now - AUDIT_RETENTION_DAYS * DAY_MILLIS;

const makeAuditLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const redactor = yield* Redactor;

  const insert = Effect.fnUntraced(function* (input: AuditEventInput, outcome: AuditOutcome) {
    const id = newRowId("aud");
    const now = yield* Clock.currentTimeMillis;
    const detail = (yield* encodeDetail(redactor, input.detail)) ?? UNENCODABLE_DETAIL;
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
    // A detail that cannot be encoded keeps the stored one; the outcome is still recorded.
    const json = detail === undefined ? undefined : yield* encodeDetail(redactor, detail);
    const rows = yield* (
      json === undefined
        ? sql<{ id: string }>`
            UPDATE audit_log SET outcome = ${outcome}, updated_at = ${now}
            WHERE id = ${id} AND outcome = 'started' RETURNING id
          `
        : sql<{ id: string }>`
            UPDATE audit_log SET outcome = ${outcome}, updated_at = ${now}, detail_json = ${json}
            WHERE id = ${id} AND outcome = 'started' RETURNING id
          `
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
      Effect.flatMap((rows) =>
        Effect.map(Effect.forEach(rows.slice(0, limit), toEntry), (entries): AuditPage => {
          // The extra row fetched past `limit` is what shows an older entry exists.
          const last = entries.at(-1);
          return {
            entries,
            next: rows.length > limit && last !== undefined ? { at: last.at, id: last.id } : undefined,
          };
        }),
      ),
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

/** `audited`'s default failure outcome: "uncertain" for an IsdsTimeoutError sent before it timed out, else "error". */
export const defaultFailureOutcome = (error: unknown): AuditFinalOutcome => (isSentTimeout(error) ? "uncertain" : "error");

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

/** Runs a caller's mapper; one that throws is logged and gives `fallback`. */
const mapped = <T>(mapper: () => T, fallback: T): Effect.Effect<T> =>
  Effect.try({ try: mapper, catch: (cause) => new AuditDetailError({ cause }) }).pipe(
    Effect.catch((error) => Effect.as(Effect.logWarning("datova-schranka: an audit mapper failed", error), fallback)),
  );

const finalOf = <A, E>(
  exit: Exit.Exit<A, E>,
  options: AuditedOptions<A, E>,
): Effect.Effect<{ readonly outcome: AuditFinalOutcome; readonly detail: unknown }> => {
  if (Exit.isSuccess(exit)) {
    return Effect.map(mapped(() => options.okDetail?.(exit.value), undefined), (detail) => ({ outcome: "ok", detail }));
  }
  const failure = Cause.findError(exit.cause);
  if (Result.isSuccess(failure)) {
    const error = failure.success;
    const classify = options.classify ?? defaultFailureOutcome;
    return Effect.all({
      // A classify that throws says nothing about the call, so its outcome is unknown.
      outcome: mapped((): AuditFinalOutcome => classify(error), "uncertain"),
      detail: mapped(() => options.errorDetail?.(error), undefined),
    });
  }
  // Interrupted mid-call: the request may or may not have reached ISDS.
  if (Cause.hasInterruptsOnly(exit.cause)) return Effect.succeed({ outcome: "uncertain", detail: undefined });
  return Effect.succeed({ outcome: "error", detail: undefined });
};

/**
 * Runs `effect` between an audit intent and its outcome (design §9 R6).
 * The intent (outcome "started") is written first; if that write fails,
 * `effect` does not run and the DomainStoreError is returned. Once the
 * intent is written the outcome is recorded on every exit, uninterruptibly:
 * success "ok", failure per `classify`, a defect "error", an interruption
 * "uncertain". A mapper that throws is logged and treated as absent (a
 * throwing `classify` gives "uncertain"). A failure to record the outcome is
 * logged and leaves the row "started" (read as "outcome unknown"); the
 * caller still gets the result of `effect`.
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
          Effect.flatMap(finalOf(exit, options), (final) => audit.finish(id, final.outcome, final.detail)).pipe(
            // A failing finish must not replace the call's own result.
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
