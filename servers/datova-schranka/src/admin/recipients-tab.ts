import { csrfField, type Flash, formatTime, hidden } from "@mcps/core/admin/pages.js";
import { type AdminTab, field } from "@mcps/core/admin/tab.js";
import { escapeHtml } from "@mcps/core/oauth/pages.js";
import { Effect } from "effect";
import { type AuditActor, type AuditFinalOutcome, AuditLog } from "../domain/audit-log.js";
import { BoxClients } from "../domain/box-clients.js";
import { type Box, BoxRegistry } from "../domain/boxes.js";
import { isBoxId, isDataBoxId } from "../domain/ids.js";
import { NOTE_MAX_LENGTH, type RecipientTier, type RecipientTierEntry, RecipientTiers } from "../domain/recipient-tiers.js";
import { IsdsStatusError } from "../isds/errors.js";

/**
 * The Recipients tab: per sending box, which recipients get which send tier. Unlisted
 * recipients are tier none (every message waits for an administrator); approve needs the
 * user's confirmation with a nonce; full sends at once. Adding a recipient checks it with
 * ISDS (CheckDataBox) first. Every action writes one audit row.
 */

export const RECIPIENTS_PATH = "/admin/recipients";
const ADD_PATH = "/admin/recipients/add";
const EDIT_PATH = "/admin/recipients/edit";
const REMOVE_PATH = "/admin/recipients/remove";

const SET_ACTION = "recipient.set";
const REMOVE_ACTION = "recipient.remove";
const ADMIN: AuditActor = { kind: "admin" };
const MAX_REASON_LENGTH = 300;

interface Outcome {
  readonly flash: Flash;
  readonly outcome: AuditFinalOutcome;
  readonly action: string;
  readonly boxId: string | undefined;
  readonly detail: unknown;
}

interface Target {
  readonly box: Box;
  readonly recipient: string;
  readonly tier: RecipientTier;
  readonly note: string | undefined;
}

/** Effect.uninterruptibleMask's restore: makes its effect interruptible again. */
type Restore = <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;

type Refusal = Omit<Outcome, "outcome" | "flash"> & { readonly text: string };

const refusal = (refused: Refusal): Outcome => ({
  flash: { kind: "error", text: refused.text },
  outcome: "refused",
  action: refused.action,
  boxId: refused.boxId,
  detail: refused.detail,
});

/** An error's message on one line, short enough for a flash. */
const messageOf = (error: { readonly message: string }) => {
  const line = error.message.replace(/\s+/g, " ").trim();
  return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH)}…` : line;
};

const TIER_TEXT: Record<RecipientTier, string> = {
  none: "none (every message waits for an administrator)",
  approve: "approve (the user confirms each message)",
  full: "full (messages are sent at once)",
};

const tierOptions = (choices: ReadonlyArray<RecipientTier>, current: RecipientTier | undefined) =>
  choices
    .map((tier) => `<option value="${tier}"${tier === current ? " selected" : ""}>${escapeHtml(TIER_TEXT[tier])}</option>`)
    .join("");

const noteInput = (value: string | undefined) =>
  `<input type="text" name="note" maxlength="${NOTE_MAX_LENGTH}" value="${escapeHtml(value ?? "")}" aria-label="Note">`;

const entryRow = (csrf: string, box: Box, entry: RecipientTierEntry) => `<tr>
<td><code>${escapeHtml(entry.recipientDbId)}</code></td>
<td><form method="post" action="${EDIT_PATH}">${csrfField(csrf)}${hidden("box", box.id)}${hidden("recipient", entry.recipientDbId)}<select name="tier" aria-label="Tier">${tierOptions(["approve", "full", "none"], entry.tier)}</select> ${noteInput(entry.note)} <button type="submit">Save</button></form></td>
<td>${formatTime(entry.updatedAt)}</td>
<td><form method="post" action="${REMOVE_PATH}">${csrfField(csrf)}${hidden("box", box.id)}${hidden("recipient", entry.recipientDbId)}<button type="submit">Remove</button></form></td>
</tr>`;

const boxSection = (csrf: string, box: Box, entries: ReadonlyArray<RecipientTierEntry>) => `<section>
<h2>“${escapeHtml(box.label)}” <code>${escapeHtml(box.dbId)}</code></h2>
${
  entries.length === 0
    ? "<p>No listed recipients: every message from this box waits for an administrator.</p>"
    : `<table><thead><tr><th>Recipient</th><th>Tier and note</th><th>Changed</th><th></th></tr></thead><tbody>${entries
        .map((entry) => entryRow(csrf, box, entry))
        .join("\n")}</tbody></table>`
}
<form method="post" action="${ADD_PATH}">${csrfField(csrf)}${hidden("box", box.id)}
<label>Recipient data box ID <input type="text" name="recipient" required pattern="[a-zA-Z0-9]{7}" maxlength="7" autocomplete="off"></label>
<label>Tier <select name="tier">${tierOptions(["approve", "full"], "approve")}</select></label>
<label>Note ${noteInput(undefined)}</label>
<button type="submit">Add recipient</button></form>
</section>`;

const body = (csrf: string, sections: ReadonlyArray<readonly [Box, ReadonlyArray<RecipientTierEntry>]>) => `<h1>Recipients</h1>
<p class="muted">Which recipients each data box may send to without an administrator. A recipient that is not listed is tier none: every message to it waits here for an administrator's approval. Tier approve: the MCP client gets a preview and sends only after the user confirms it. Tier full: messages are sent at once. Adding a recipient checks it with ISDS; every send checks again that the recipient's box is accessible.</p>
${sections.length === 0 ? "<p>No data boxes yet. Add one on the data boxes tab.</p>" : sections.map(([box, entries]) => boxSection(csrf, box, entries)).join("\n")}`;

export const recipientsTab: Effect.Effect<AdminTab, never, BoxRegistry | RecipientTiers | BoxClients | AuditLog> =
  Effect.gen(function* () {
    const registry = yield* BoxRegistry;
    const tiers = yield* RecipientTiers;
    const clients = yield* BoxClients;
    const audit = yield* AuditLog;

    /** Writes the outcome's audit row; a failed write is logged and named in the message. */
    const recorded = (outcome: Outcome): Effect.Effect<Flash> =>
      audit
        .record({ actor: ADMIN, action: outcome.action, boxId: outcome.boxId, outcome: outcome.outcome, detail: outcome.detail })
        .pipe(
          Effect.as(outcome.flash),
          Effect.catch((error) =>
            Effect.logError("recipients tab: audit entry not written", error).pipe(
              Effect.as({ ...outcome.flash, text: `${outcome.flash.text} The audit entry could not be written.` }),
            ),
          ),
        );

    /**
     * Reads and checks the form: the box must exist, the recipient be a dbID and the tier
     * one of `tiers`. Fails with the refusal to audit.
     */
    const targetOf = Effect.fnUntraced(function* (
      form: URLSearchParams,
      action: string,
      allowed: ReadonlyArray<RecipientTier> | undefined,
    ) {
      const boxField = field(form, "box")?.trim() ?? "";
      const boxId = isBoxId(boxField) ? boxField : undefined;
      if (boxId === undefined) {
        return yield* Effect.fail(refusal({ text: "Choose a data box.", action, boxId, detail: { reason: "no box" } }));
      }
      const box = yield* registry
        .get(boxId)
        .pipe(
          Effect.mapError(() =>
            refusal({ text: "That data box no longer exists.", action, boxId, detail: { reason: "box not found" } }),
          ),
        );
      const recipient = field(form, "recipient")?.trim().toLowerCase() ?? "";
      if (!isDataBoxId(recipient)) {
        return yield* Effect.fail(
          refusal({
            text: "A recipient data box ID is 7 letters and digits.",
            action,
            boxId,
            detail: { reason: "invalid recipient" },
          }),
        );
      }
      const tierField = field(form, "tier") ?? "";
      const tier = allowed?.find((candidate) => candidate === tierField);
      if (allowed !== undefined && tier === undefined) {
        return yield* Effect.fail(
          refusal({
            text: `Choose the tier: ${allowed.join(" or ")}.`,
            action,
            boxId,
            detail: { recipient, reason: "invalid tier" },
          }),
        );
      }
      const note = field(form, "note")?.trim();
      return { box, recipient, tier: tier ?? "none", note: note === "" ? undefined : note } satisfies Target;
    });

    const saved = (target: Target, dbState: number | undefined): Effect.Effect<Outcome> =>
      tiers.set(target.box.id, target.recipient, target.tier, target.note).pipe(
        Effect.map((): Outcome => {
          const inactive =
            dbState === undefined || dbState === 1
              ? ""
              : ` ISDS reports its data box in state ${dbState}, not 1 (accessible): sending to it is refused until it is accessible again (every send checks the state).`;
          return {
            flash: {
              kind: "ok",
              text: `Recipient ${target.recipient} of “${target.box.label}” is now tier ${target.tier}.${inactive}`,
            },
            outcome: "ok",
            action: SET_ACTION,
            boxId: target.box.id,
            detail: { recipient: target.recipient, tier: target.tier, note: target.note, dbState },
          };
        }),
        Effect.catch((error) =>
          Effect.succeed<Outcome>({
            flash: { kind: "error", text: `Nothing was saved: ${messageOf(error)}` },
            outcome: error._tag === "DomainStoreError" ? "error" : "refused",
            action: SET_ACTION,
            boxId: target.box.id,
            detail: { recipient: target.recipient, tier: target.tier, error: error._tag },
          }),
        ),
      );

    const removed = (target: Target): Effect.Effect<Outcome> =>
      tiers.remove(target.box.id, target.recipient).pipe(
        Effect.as<Outcome>({
          flash: {
            kind: "ok",
            text: `Recipient ${target.recipient} of “${target.box.label}” is back to tier none: its messages wait for an administrator.`,
          },
          outcome: "ok",
          action: REMOVE_ACTION,
          boxId: target.box.id,
          detail: { recipient: target.recipient },
        }),
        Effect.catch((error) =>
          Effect.succeed<Outcome>({
            flash: { kind: "error", text: `Nothing was removed: ${messageOf(error)}` },
            outcome: "error",
            action: REMOVE_ACTION,
            boxId: target.box.id,
            detail: { recipient: target.recipient, error: error._tag },
          }),
        ),
      );

    /** Why adding the recipient stops when CheckDataBox did not answer with a state. */
    const checkFailure = (target: Target, error: { readonly _tag: string; readonly message: string }): Outcome => {
      if (error instanceof IsdsStatusError && error.classification === "BoxNotFound") {
        return refusal({
          text: `ISDS reports no data box ${target.recipient}. Nothing was saved.`,
          action: SET_ACTION,
          boxId: target.box.id,
          detail: { recipient: target.recipient, tier: target.tier, reason: "recipient not found" },
        });
      }
      if (error._tag === "BoxNotFound") {
        return refusal({
          text: "That data box no longer exists.",
          action: SET_ACTION,
          boxId: target.box.id,
          detail: { recipient: target.recipient, reason: "box not found" },
        });
      }
      return {
        flash: { kind: "error", text: `The recipient could not be checked with ISDS, so nothing was saved: ${messageOf(error)}` },
        outcome: "error",
        action: SET_ACTION,
        boxId: target.box.id,
        detail: { recipient: target.recipient, tier: target.tier, error: error._tag },
      };
    };

    /** CheckDataBox for the recipient, through the sending box's client (holding its permit). */
    const checked = (target: Target) =>
      clients.use(target.box.id, (client) => client.checkDataBox({ dbID: target.recipient })).pipe(
        Effect.mapError((error) => checkFailure(target, error)),
      );

    /** Finishes a started audit row with the outcome; a failed write is logged and named in the message. */
    const finished = (id: string, outcome: Outcome): Effect.Effect<Flash> =>
      audit.finish(id, outcome.outcome, outcome.detail).pipe(
        Effect.as(outcome.flash),
        Effect.catch((error) =>
          Effect.logError("recipients tab: audit entry not finished", error).pipe(
            Effect.as({ ...outcome.flash, text: `${outcome.flash.text} The audit entry could not be completed.` }),
          ),
        ),
      );

    const intentOf = (target: Target) => ({ recipient: target.recipient, tier: target.tier, note: target.note });

    /**
     * Writes the audit row's intent first (fail closed: without the row nothing changes), runs
     * `work` and finishes the row with its outcome on every exit. Only what `work` passes to
     * `restore` (the ISDS check) can be interrupted; an interrupted check finishes the row as
     * an error with nothing saved. Once the tier is being saved, the save and the row's
     * outcome both happen.
     */
    const audited = (
      target: Target,
      action: string,
      work: (restore: Restore) => Effect.Effect<Outcome, Outcome>,
    ): Effect.Effect<Flash> =>
      Effect.uninterruptibleMask((restore) =>
        audit.start({ actor: ADMIN, action, boxId: target.box.id, detail: intentOf(target) }).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.logError("recipients tab: audit entry not written", error).pipe(
                Effect.as<Flash>({ kind: "error", text: "Nothing was saved: the audit entry could not be written." }),
              ),
            onSuccess: (id) =>
              work(restore).pipe(
                Effect.catch((outcome) => Effect.succeed(outcome)),
                Effect.onInterrupt(() =>
                  audit
                    .finish(id, "error", { ...intentOf(target), error: "interrupted" })
                    .pipe(Effect.catch((error) => Effect.logError("recipients tab: audit entry not finished", error))),
                ),
                Effect.flatMap((outcome) => finished(id, outcome)),
              ),
          }),
        ),
      );

    /** Checks the form, then runs `next`; a refused form is audited as one finished row. */
    const withTarget = (
      form: URLSearchParams,
      action: string,
      allowed: ReadonlyArray<RecipientTier> | undefined,
      next: (target: Target) => Effect.Effect<Flash>,
    ): Effect.Effect<Flash> =>
      targetOf(form, action, allowed).pipe(
        Effect.matchEffect({ onFailure: (outcome) => Effect.uninterruptible(recorded(outcome)), onSuccess: next }),
      );

    const editWork = Effect.fnUntraced(function* (target: Target) {
      const listed = yield* tiers.list(target.box.id).pipe(
        Effect.mapError(
          (error): Outcome => ({
            flash: { kind: "error", text: `Nothing was saved: ${messageOf(error)}` },
            outcome: "error",
            action: SET_ACTION,
            boxId: target.box.id,
            detail: { recipient: target.recipient, error: error._tag },
          }),
        ),
      );
      if (!listed.some((entry) => entry.recipientDbId === target.recipient)) {
        return yield* Effect.fail(
          refusal({
            text: `Recipient ${target.recipient} is not listed for “${target.box.label}”; add it instead.`,
            action: SET_ACTION,
            boxId: target.box.id,
            detail: { recipient: target.recipient, reason: "not listed" },
          }),
        );
      }
      return yield* target.tier === "none" ? removed(target) : saved(target, undefined);
    });

    const add = (form: URLSearchParams) =>
      withTarget(form, SET_ACTION, ["approve", "full"], (target) =>
        audited(target, SET_ACTION, (restore) =>
          Effect.flatMap(restore(checked(target)), ({ dbState }) => saved(target, dbState)),
        ),
      );
    const edit = (form: URLSearchParams) =>
      withTarget(form, SET_ACTION, ["approve", "full", "none"], (target) =>
        audited(target, target.tier === "none" ? REMOVE_ACTION : SET_ACTION, () => editWork(target)),
      );
    const remove = (form: URLSearchParams) =>
      withTarget(form, REMOVE_ACTION, undefined, (target) => audited(target, REMOVE_ACTION, () => removed(target)));

    const render: AdminTab["render"] = Effect.fnUntraced(
      function* (csrf: string) {
        const boxes = yield* registry.list;
        const sections = yield* Effect.forEach(boxes, (box) =>
          Effect.map(tiers.list(box.id), (entries) => [box, entries] as const),
        );
        return { body: body(csrf, sections) };
      },
      Effect.catch((error) =>
        Effect.succeed({
          body: "<h1>Recipients</h1>",
          error: { kind: "error" as const, text: `The recipients could not be loaded: ${messageOf(error)}` },
          status: 500,
        }),
      ),
    );

    return {
      id: "recipients",
      label: "Recipients",
      path: RECIPIENTS_PATH,
      render,
      actions: [
        { path: ADD_PATH, back: RECIPIENTS_PATH, run: add },
        { path: EDIT_PATH, back: RECIPIENTS_PATH, run: edit },
        { path: REMOVE_PATH, back: RECIPIENTS_PATH, run: remove },
      ],
    } satisfies AdminTab;
  });
