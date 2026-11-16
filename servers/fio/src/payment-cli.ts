import * as NodeStdio from "@effect/platform-node/NodeStdio";
import { DateTime, Effect, Layer, Option, Stdio, Stream } from "effect";
import { CommandFailed } from "./oauth/cli.js";
import { AUDIT_RETENTION_DAYS, PaymentControls } from "./payment-controls.js";

/** `fio-mcp payments purge --before YYYY-MM-DD` (SEC-29). */
export const PURGE_USAGE = "fio-mcp payments purge --before YYYY-MM-DD";

/**
 * The cut-off date of `payments purge --before <date>` (the arguments after
 * `payments`), or undefined when the arguments are not exactly that with a
 * real calendar date.
 */
export const parsePurgeArgs = (args: ReadonlyArray<string>): string | undefined => {
  const [command, flag, date, ...rest] = args;
  if (command !== "purge" || flag !== "--before" || date === undefined || rest.length > 0) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  // A real day: 2026-02-30 does not survive the round trip.
  const parsed = DateTime.make(`${date}T00:00:00Z`);
  return Option.isSome(parsed) && DateTime.formatIsoDate(parsed.value) === date ? date : undefined;
};

const write = (text: string) =>
  Effect.flatMap(Stdio.Stdio, (stdio) => Stream.run(Stream.make(text), stdio.stdout())).pipe(
    Effect.mapError(() => new CommandFailed({ message: "could not write to stdout" })),
  );

/**
 * Deletes payment audit rows of Europe/Prague days before `before` and
 * prints how many. Refuses a cut-off within the retention period.
 */
export const purgePaymentsCommand = Effect.fn("cli.purgePayments")(function* (before: string) {
  const controls = yield* PaymentControls;
  const deleted = yield* controls.purgeBefore(before).pipe(Effect.mapError((error) => new CommandFailed({ message: error.message })));
  yield* write(
    `Deleted ${deleted} payment audit ${deleted === 1 ? "row" : "rows"} from before ${before} (Europe/Prague). Rows are kept at least ${AUDIT_RETENTION_DAYS} days.\n`,
  );
});

/** The command on the server's database and configuration. */
export const purgePayments = (before: string) =>
  purgePaymentsCommand(before).pipe(Effect.provide(Layer.mergeAll(PaymentControls.Live, NodeStdio.layer)));
