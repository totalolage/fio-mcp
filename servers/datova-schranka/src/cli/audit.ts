import { DateTime, Effect, Option } from "effect";
import { AUDIT_RETENTION_DAYS, AuditLog } from "../domain/audit-log.js";
import { CommandFailed, write } from "./io.js";

/** `datova-schranka audit purge --before YYYY-MM-DD`. */
export const PURGE_USAGE = "datova-schranka audit purge --before YYYY-MM-DD";

/**
 * The cut-off date of `purge --before <date>` (the arguments after `audit`),
 * or undefined when the arguments are not exactly that with a real calendar
 * date.
 */
export const parsePurgeArgs = (args: ReadonlyArray<string>): string | undefined => {
  const [command, flag, date, ...rest] = args;
  if (command !== "purge" || flag !== "--before" || date === undefined || rest.length > 0) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  // A real day: 2026-02-30 does not survive the round trip.
  const parsed = DateTime.make(`${date}T00:00:00Z`);
  return Option.isSome(parsed) && DateTime.formatIsoDate(parsed.value) === date ? date : undefined;
};

/**
 * Deletes audit rows recorded before `before` (00:00 UTC) and prints how
 * many. Refuses a cut-off within the retention period, deleting nothing.
 * Only audit rows: ZFO files and filings stay.
 */
export const purgeAuditCommand = Effect.fn("cli.purgeAudit")(function* (before: string) {
  const audit = yield* AuditLog;
  const deleted = yield* audit
    .purgeBefore(DateTime.toDateUtc(DateTime.makeUnsafe(`${before}T00:00:00Z`)))
    .pipe(Effect.mapError((error) => new CommandFailed({ message: error.message })));
  yield* write(
    "stdout",
    `Deleted ${deleted} audit ${deleted === 1 ? "row" : "rows"} from before ${before} (UTC). Rows are kept at least ${AUDIT_RETENTION_DAYS} days.\n`,
  );
});
