import { Data, DateTime, Duration, Effect, Option, Schema } from "effect";
import { IsdsInvalidRequest } from "./errors.js";
import { listSentMessages, type MessageRecord } from "./message-lists.js";
import { DataBoxId, type MessageState } from "./models.js";
import { formatXsDateTime } from "./xsd.js";

/**
 * Reconciliation after a CreateMessage call timed out (IsdsTimeoutError): ISDS has no
 * idempotency key, so the only way to learn whether the submission went through is to look for
 * the message in the box's sent list.
 */

/** A sent message that matches the submission, with its state as the sent list reported it. */
export interface SentMessageMatch {
  readonly dmID: string;
  /**
   * The message's state (dmMessageStatus) in the list record at reconciliation time. It may be
   * anything from 1 (submitted) on, including 3 (rejected by the antivirus check, never
   * delivered); it can change afterwards.
   */
  readonly dmMessageStatus: MessageState;
}

/**
 * The outcome of {@link reconcileSentMessage}. `Found` and `Ambiguous` say a sent message
 * matching the submission EXISTS, i.e. the CreateMessage went through; they say nothing about
 * delivery, which `dmMessageStatus` shows.
 */
export type SentMessageReconciliation = Data.TaggedEnum<{
  /** Exactly one sent message matches; it exists, whatever its state. */
  Found: SentMessageMatch;
  /** No sent message matches (yet). Best effort only: see {@link reconcileSentMessage}. */
  NotFound: Record<never, never>;
  /** More than one sent message matches, newest first as listed; the caller must decide. */
  Ambiguous: { readonly matches: ReadonlyArray<SentMessageMatch> };
}>;
export const SentMessageReconciliation = Data.taggedEnum<SentMessageReconciliation>();

const PositiveInt = Schema.Finite.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)));
const NonNegativeInt = Schema.Finite.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));

/**
 * What the timed-out CreateMessage sent. Text fields are compared after {@link normalizeText};
 * an absent field matches a record where it is absent or blank.
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
  /**
   * Margin added on both sides of the search window, [submittedAt − slack, max(submittedAt,
   * now) + slack]; 2 minutes when absent. It must cover the skew between the client's clock
   * (`submittedAt`) and ISDS's (dmDeliveryTime). A slack that pushes the window outside years
   * 0001–9999 (e.g. Duration.infinity) fails with IsdsInvalidRequest.
   */
  slack: Schema.optional(Schema.Duration),
  /** Records per GetListOfSentMessages page; 1000 when absent. */
  pageSize: Schema.optional(PositiveInt),
});
export type ReconcileSentMessageInput = typeof ReconcileSentMessageInput.Type;

export const defaultReconcileSlack: Duration.Duration = Duration.minutes(2);
const defaultPageSize = 1000;

/** What ISDS does with a character it substitutes: a space, or nothing (dropped). */
type Substitution = " " | "";

const inRange = (code: number, low: number, high: number): boolean => code >= low && code <= high;

/**
 * ISDS's documented character substitution in message data (WS_manipulace_s_datovymi_zpravami.pdf
 * §1.3.5 "Náhrada nestandardních znaků" p. 13, for all web services; §2.1.1 "Obálka zprávy" p. 45,
 * CreateMessage, for envelope data). Two points conflict in the spec, so they are parameters:
 * U+202F is listed both as whitespace replaced by a space and in the dropped U+202A–U+202F
 * formatting row (§1.3.5); U+007F–U+009F are dropped per §1.3.5 but §2.1.1 says control
 * characters become spaces.
 */
const isdsSubstitute =
  (narrowNoBreakSpace: Substitution, c1Controls: Substitution) =>
  (char: string): string => {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x202f) return narrowNoBreakSpace;
    if (inRange(code, 0x7f, 0x9f)) return c1Controls;
    // Whitespace (\t, \n, \r, U+2028, U+2029, U+00A0; §1.3.5) and other C0 controls (§2.1.1) → space.
    if (inRange(code, 0x00, 0x1f) || code === 0xa0 || code === 0x2028 || code === 0x2029) return " ";
    // Word-break, formatting and invisible characters are dropped (§1.3.5).
    if (
      code === 0x200b ||
      code === 0xad ||
      inRange(code, 0x200c, 0x200f) ||
      inRange(code, 0x202a, 0x202e) ||
      inRange(code, 0x2061, 0x206f)
    ) {
      return "";
    }
    return char;
  };

const normalizeWith = (substitute: (char: string) => string) => (text: string): string =>
  Array.from(text, substitute).join("").normalize("NFC").replace(/\s+/g, " ").trim();

/**
 * The form a sent text is compared in, in two layers:
 * 1. Documented: ISDS's substitution of control, whitespace and formatting characters (PDF
 *    §1.3.5 p. 13, §2.1.1 p. 45), which can make the listed text differ from what CreateMessage sent.
 *    Where the spec conflicts this function follows the §1.3.5 table rows (U+202F → space,
 *    U+007F–U+009F dropped); the match itself also tries the other readings.
 * 2. Defensive, not documented: Unicode NFC, collapsing whitespace runs (JS `\s`) to one space,
 *    trimming. The spec documents no trimming, collapsing or Unicode normalisation (searched
 *    §§1.3.5, 2.1, 2.1.1, 2.9.2 for trim/whitespace/normalisation/NFC/NFD/ořez/mezery and the
 *    field names), and the XSD string types keep xs:whiteSpace="preserve". They are applied
 *    anyway because a false mismatch reports `NotFound` and invites a duplicate send, while a
 *    false match at worst yields `Ambiguous` or a message with the same recipient, references
 *    and window.
 * Case is kept: nothing documents case changes.
 */
export const normalizeText: (text: string) => string = normalizeWith(isdsSubstitute(" ", ""));

/** Every reading of the spec's conflicting substitutions (see {@link isdsSubstitute}). */
const readings: ReadonlyArray<(text: string) => string> = [
  normalizeText,
  normalizeWith(isdsSubstitute("", "")),
  normalizeWith(isdsSubstitute(" ", " ")),
  normalizeWith(isdsSubstitute("", " ")),
];

/** Whether the listed text is what ISDS could have made of the sent one; absent equals blank. */
const sameText = (recorded: string | undefined, sent: string | undefined): boolean => {
  const listed = normalizeText(recorded ?? "");
  return readings.some((normalize) => normalize(sent ?? "") === listed);
};

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
 * messages (all states) in [submittedAt − slack, max(submittedAt, now) + slack], paging while
 * pages come back full, and matches recipient, annotation, sender reference number and sender
 * ident (texts compared after {@link normalizeText}; and the attachment size when
 * `expectedAttachmentBytes` is given).
 *
 * The list's window filters on dmDeliveryTime, the moment ISDS delivers the message into the
 * recipient's box (PDF §2.9.2 p. 78), which normally follows acceptance within seconds; the
 * window therefore extends to the current time, so a delivery that came later still matches. A
 * message still in state 1–2 (no delivery time yet) or rejected by the antivirus check (state
 * 3, never delivered) may therefore be missing from the window; the spec doesn't say.
 *
 * Clocks: `submittedAt` is the client's clock, dmDeliveryTime is ISDS's. The lower bound
 * assumes the client clock runs at most `slack` ahead of ISDS's (a message can't be delivered
 * before it was submitted, by one clock); the upper bound adds `slack` after `now` for a client
 * clock running behind. Raise `slack` when the client clock is not NTP-synchronised.
 *
 * `Found`/`Ambiguous` mean the submission went through (a matching sent message exists), not
 * that it was delivered: check the returned `dmMessageStatus`.
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
  // A message can't be delivered before it was submitted, but it can be delivered late; the
  // slack on both sides absorbs client/ISDS clock skew.
  const from = DateTime.subtractDuration(valid.submittedAt, slack);
  const to = DateTime.addDuration(DateTime.max(valid.submittedAt, yield* DateTime.now), slack);
  if (Option.isNone(formatXsDateTime(from)) || Option.isNone(formatXsDateTime(to))) {
    return yield* new IsdsInvalidRequest({
      operation: "GetListOfSentMessages",
      detail: "`submittedAt` ± `slack` falls outside years 0001–9999, so the search window has no xs:dateTime form",
    });
  }
  const matches = recordMatches(valid);

  // Keyed by dmID: a message can show up on two pages when new ones shift the list.
  const found = new Map<string, SentMessageMatch>();
  let offset = 1;
  let more = true;
  while (more) {
    const page = yield* listSentMessages({ from, to, states: "all", offset, limit: pageSize });
    for (const record of page) {
      if (matches(record) && !found.has(record.dmID)) {
        found.set(record.dmID, { dmID: record.dmID, dmMessageStatus: record.dmMessageStatus });
      }
    }
    more = page.length >= pageSize;
    offset += pageSize;
  }

  const all = [...found.values()];
  const [only] = all;
  if (only === undefined) return SentMessageReconciliation.NotFound();
  if (all.length === 1) return SentMessageReconciliation.Found(only);
  return SentMessageReconciliation.Ambiguous({ matches: all });
});
