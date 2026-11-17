import { DateTime, Schema } from "effect";
import { Tool } from "effect/ai";
import { DATA_BOX_ID, MESSAGE_ID } from "./read-guards.js";

/** Tool results are JSON objects; their shape is described in each tool's description. */
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

export const MessageIdParam = Schema.String.check(Schema.isPattern(MESSAGE_ID, { message: "must be 1-20 digits" })).annotate({
  description: "ISDS message ID (dmID): 1-20 digits.",
});

export const DataBoxIdParam = Schema.String.check(
  Schema.isPattern(DATA_BOX_ID, { message: "must be 7 lowercase letters or digits" }),
).annotate({ description: "ISDS data box ID (dbID): 7 lowercase letters or digits." });

const TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A date (YYYY-MM-DD, a UTC day) or an ISO 8601 date-time with offset. */
export const TimeParam = (what: string) =>
  Schema.String.check(
    Schema.isPattern(TIME, { message: "must be YYYY-MM-DD or an ISO 8601 date-time with offset" }),
    Schema.makeFilter((text: string) => (Number.isNaN(Date.parse(text)) ? "must be a real date" : undefined)),
  ).annotate({
    description: `${what}: YYYY-MM-DD (a UTC day) or an ISO 8601 date-time with offset, e.g. 2026-11-17T08:00:00+01:00.`,
  });

/**
 * A validated TimeParam as a UTC time. A date alone means the start of that
 * UTC day as a lower bound and its last millisecond as an upper bound.
 */
export const timeBound = (text: string | undefined, bound: "from" | "to"): DateTime.Utc | undefined => {
  if (text === undefined) return undefined;
  const millis = Date.parse(text);
  return DateTime.makeUnsafe(bound === "to" && DATE_ONLY.test(text) ? millis + DAY_MS - 1 : millis);
};

/** States a list can filter on (ISDS dmMessageStatus; 9 cannot be filtered). */
export const StatesParam = Schema.Array(Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8, 10]))
  .check(Schema.isMinLength(1))
  .annotate({
    description:
      "Only messages in these states (dmMessageStatus): 1 submitted, 2 stamped, 3 failed virus check, 4 dispatched, 5 delivered by fiction, 6 delivered by login, 7 read, 8 undeliverable, 10 moved to the data vault. All states when absent.",
  });

export const LimitParam = (max: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max })).annotate({
    description: `How many records to return at most (1-${max}).`,
  });

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
