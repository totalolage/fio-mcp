import { Data, DateTime, Duration, Effect, Schema } from "effect";
import { IsdsInvalidRequest } from "./errors.js";
import { listSentMessages, type MessageRecord } from "./message-lists.js";
import { DataBoxId } from "./models.js";

/**
 * Reconciliation after a CreateMessage call timed out (IsdsTimeoutError): ISDS has no
 * idempotency key, so the only way to learn whether the submission went through is to look for
 * the message in the box's sent list.
 */

/** The outcome of {@link reconcileSentMessage}. */
export type SentMessageReconciliation = Data.TaggedEnum<{
  /** Exactly one sent message matches; `dmID` is its ID. */
  Found: { readonly dmID: string };
  /** No sent message matches (yet). Best effort only: see {@link reconcileSentMessage}. */
  NotFound: Record<never, never>;
  /** More than one sent message matches; the caller must decide. */
  Ambiguous: { readonly dmIDs: ReadonlyArray<string> };
}>;
export const SentMessageReconciliation = Data.taggedEnum<SentMessageReconciliation>();

const PositiveInt = Schema.Finite.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)));
const NonNegativeInt = Schema.Finite.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));

/**
 * What the timed-out CreateMessage sent. Text fields are compared exactly; an absent field
 * matches a record where it is absent or empty.
 */
export const ReconcileSentMessageInput = Schema.Struct({
  /** When the client sent the CreateMessage request (its own clock). */
  submittedAt: Schema.DateTimeUtc,
  /** The recipient box (dbIDRecipient). */
  dbIDRecipient: DataBoxId,
  dmAnnotation: Schema.optional(Schema.String),
  dmSenderRefNumber: Schema.optional(Schema.String),
  dmSenderIdent: Schema.optional(Schema.String),
  /**
   * The total binary size in BYTES of the attachments that were sent (before Base64). When
   * given, records whose dmAttachmentSize (kilobytes of Base64, rounded) can't correspond to it
   * are excluded; see {@link attachmentSizeMatches}.
   */
  expectedAttachmentBytes: Schema.optional(NonNegativeInt),
  /** How far around `submittedAt` to search, both ways; 2 minutes when absent. */
  slack: Schema.optional(Schema.Duration),
  /** Records per GetListOfSentMessages page; 1000 when absent. */
  pageSize: Schema.optional(PositiveInt),
});
export type ReconcileSentMessageInput = typeof ReconcileSentMessageInput.Type;

export const defaultReconcileSlack: Duration.Duration = Duration.minutes(2);
const defaultPageSize = 1000;

const sameText = (recorded: string | undefined, sent: string | undefined): boolean => (recorded ?? "") === (sent ?? "");

/**
 * Whether ISDS's dmAttachmentSize is consistent with attachments of `bytes` binary bytes in
 * total. ISDS reports rounded kilobytes of the Base64 form, about 4/3 of the binary size (PDF
 * §2.6.1 p. 60), without saying how it rounds, whether a kilobyte is 1000 or 1024 bytes, or how
 * much per-file padding counts. The band is deliberately wide, from the binary size in 1024-byte
 * kilobytes to the Base64 size in 1000-byte kilobytes plus 5% and 2 kB, minus/plus rounding:
 * wrongly excluding the real message would report `NotFound` and invite a duplicate send. An
 * absent (nil) size never excludes.
 */
export const attachmentSizeMatches = (reportedKilobytes: number | undefined, bytes: number): boolean => {
  if (reportedKilobytes === undefined) return true;
  const base64Bytes = Math.ceil(bytes / 3) * 4;
  const lowest = Math.floor(bytes / 1024) - 1;
  const highest = Math.ceil((base64Bytes * 1.05) / 1000) + 2;
  return reportedKilobytes >= lowest && reportedKilobytes <= highest;
};

const recordMatches = (input: ReconcileSentMessageInput) => (record: MessageRecord): boolean =>
  record.dbIDRecipient === input.dbIDRecipient &&
  sameText(record.dmAnnotation, input.dmAnnotation) &&
  sameText(record.dmSenderRefNumber, input.dmSenderRefNumber) &&
  sameText(record.dmSenderIdent, input.dmSenderIdent) &&
  (input.expectedAttachmentBytes === undefined ||
    attachmentSizeMatches(record.dmAttachmentSize, input.expectedAttachmentBytes));

/**
 * Looks for a message a timed-out CreateMessage may have created: lists the box's sent
 * messages (all states) in [submittedAt − slack, submittedAt + slack], paging while pages come
 * back full, and matches recipient, annotation, sender reference number and sender ident (and
 * the attachment size when `expectedAttachmentBytes` is given).
 *
 * The list's window filters on dmDeliveryTime, the moment ISDS delivers the message into the
 * recipient's box (PDF §2.9.2 p. 78), which normally follows acceptance within seconds. A
 * message still in state 1–2 (no delivery time yet) or rejected by the antivirus check (state
 * 3, never delivered) may therefore be missing from the window; the spec doesn't say.
 *
 * `NotFound` is best effort: the message may still appear later, and ISDS has no idempotency
 * key, so retrying the CreateMessage after `NotFound` can create a duplicate. Prefer to
 * reconcile again after a delay before resending. List failures propagate as errors; they never
 * turn into `NotFound`.
 */
export const reconcileSentMessage = Effect.fn("Isds.reconcileSentMessage")(function* (
  input: ReconcileSentMessageInput,
) {
  const valid = yield* Schema.decodeEffect(ReconcileSentMessageInput)(input).pipe(
    Effect.mapError((error) => new IsdsInvalidRequest({ operation: "GetListOfSentMessages", detail: error.message })),
  );
  const slack = valid.slack ?? defaultReconcileSlack;
  if (Duration.isNegative(slack)) {
    return yield* new IsdsInvalidRequest({ operation: "GetListOfSentMessages", detail: "`slack` is negative" });
  }
  const pageSize = valid.pageSize ?? defaultPageSize;
  const from = DateTime.subtractDuration(valid.submittedAt, slack);
  const to = DateTime.addDuration(valid.submittedAt, slack);
  const matches = recordMatches(valid);

  const found = new Set<string>();
  let offset = 1;
  let more = true;
  while (more) {
    const page = yield* listSentMessages({ from, to, states: "all", offset, limit: pageSize });
    for (const record of page) {
      if (matches(record)) found.add(record.dmID);
    }
    more = page.length >= pageSize;
    offset += pageSize;
  }

  const dmIDs = [...found];
  const [only] = dmIDs;
  if (only === undefined) return SentMessageReconciliation.NotFound();
  if (dmIDs.length === 1) return SentMessageReconciliation.Found({ dmID: only });
  return SentMessageReconciliation.Ambiguous({ dmIDs });
});
