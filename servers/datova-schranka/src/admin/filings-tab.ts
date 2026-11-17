import { csrfField, type Flash, formatTime, hidden } from "@mcps/core/admin/pages.js";
import { type AdminActionContext, type AdminTab, field } from "@mcps/core/admin/tab.js";
import { escapeHtml } from "@mcps/core/oauth/pages.js";
import { Effect } from "effect";
import { type AuditActor, AuditLog } from "../domain/audit-log.js";
import { type Box, BoxRegistry } from "../domain/boxes.js";
import { isMessageId } from "../domain/ids.js";
import type { FilingState } from "../domain/migrations.js";
import {
  type Filing,
  type FilingPreview,
  ReconcileOutcome,
  type SendEnvelope,
  SendResult,
  SendService,
} from "../domain/send/api.js";

/**
 * The Filings tab: messages from the send tools that need an administrator. pending_admin
 * filings (tier none) are approved (sent at once) or rejected; outcome_unknown filings are
 * reconciled with ISDS's sent list, marked sent with their dmID or confirmed not sent;
 * dispatching filings are shown as in flight. Approve, mark sent and confirm not sent need
 * the second factor when one is configured: a refused code is audited here and the service
 * is not called. Every service call audits itself. Filings of a removed box still show (by
 * box id) and their decisions still work.
 */

export const FILINGS_PATH = "/admin/filings";
const APPROVE_PATH = "/admin/filings/approve";
const REJECT_PATH = "/admin/filings/reject";
const RECONCILE_PATH = "/admin/filings/reconcile";
const MARK_SENT_PATH = "/admin/filings/mark-sent";
const CONFIRM_NOT_SENT_PATH = "/admin/filings/confirm-not-sent";

const ADMIN: AuditActor = { kind: "admin" };
const OPEN_LIMIT = 500;
const HISTORY_LIMIT = 100;
const MAX_REASON_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 300;
/** Our filing ids are `filing_` plus base64url; anything else never reaches the service. */
const FILING_ID = /^[A-Za-z0-9_-]{1,100}$/;

const SENT_MEANING = "ISDS accepted it and assigned the dmID; that does not mean it was delivered";

const messageOf = (error: { readonly message: string }) => {
  const line = error.message.replace(/\s+/g, " ").trim();
  return line.length > MAX_MESSAGE_LENGTH ? `${line.slice(0, MAX_MESSAGE_LENGTH)}…` : line;
};

// ---------------------------------------------------------------------------------------------
// Rendering

const code = (value: string) => `<code>${escapeHtml(value)}</code>`;

const ENVELOPE_LABELS: ReadonlyArray<readonly [keyof SendEnvelope, string]> = [
  ["toHands", "For the attention of"],
  ["senderRefNumber", "Our reference number"],
  ["senderIdent", "Our file mark"],
  ["recipientRefNumber", "Recipient's reference number"],
  ["recipientIdent", "Recipient's file mark"],
  ["personalDelivery", "Delivery to own hands"],
  ["allowSubstDelivery", "Deemed delivery allowed"],
  ["legalTitleLaw", "Legal title: law"],
  ["legalTitleYear", "Legal title: year"],
  ["legalTitleSect", "Legal title: section"],
  ["legalTitlePar", "Legal title: paragraph"],
  ["legalTitlePoint", "Legal title: point"],
];

const envelopeValue = (value: string | number | boolean) => {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return escapeHtml(String(value));
};

const previewBlock = (preview: FilingPreview) => {
  const envelope = ENVELOPE_LABELS.flatMap(([key, label]) => {
    const value = preview.envelope[key];
    return value === undefined ? [] : [`<dt>${label}</dt><dd>${envelopeValue(value)}</dd>`];
  });
  const attachments = preview.attachments
    .map(
      (attachment) =>
        `<tr><td>${escapeHtml(attachment.filename)}</td><td>${escapeHtml(attachment.mimeType)}</td><td>${escapeHtml(
          attachment.metaType,
        )}</td><td>${attachment.size}</td><td>${code(attachment.sha256)}</td></tr>`,
    )
    .join("");
  return `<dl><dt>Subject</dt><dd>${escapeHtml(preview.annotation)}</dd>${envelope.join("")}</dl>
<table><thead><tr><th>Attachment</th><th>MIME type</th><th>Kind</th><th>Bytes</th><th>SHA-256</th></tr></thead><tbody>${attachments}</tbody></table>
<p>${preview.attachments.length} attachments, ${preview.totalBytes} bytes in total. Content hash ${code(preview.contentHash)}.</p>`;
};

/** The sending box as it is now, or (removed, D4) by id with what the filing recorded. */
const senderText = (boxes: ReadonlyMap<string, Box>, filing: Filing) => {
  const box = boxes.get(filing.boxId);
  return box === undefined
    ? `removed data box ${code(filing.boxId)} (was “${escapeHtml(filing.preview.senderBox.label)}”, ${code(filing.preview.senderBox.dbId)})`
    : `“${escapeHtml(box.label)}” ${code(box.dbId)}`;
};

const filingHeader = (boxes: ReadonlyMap<string, Box>, filing: Filing) => `<h3>Filing ${code(filing.id)}</h3>
<p>From ${senderText(boxes, filing)} to ${code(filing.recipientDbId)}; tier ${escapeHtml(filing.tier)}; grant ${code(
  filing.grantKey,
)}; key ${code(filing.idempotencyKey)}; created ${formatTime(filing.createdAt)}${
  filing.submittedAt === undefined ? "" : `; submitted to ISDS ${formatTime(filing.submittedAt)}`
}${filing.expiresAt === undefined ? "" : `; expires ${formatTime(filing.expiresAt)}`}.</p>`;

const totpInput = (secondFactor: boolean) =>
  secondFactor
    ? `<label>Authentication code <input type="text" name="totp" inputmode="numeric" autocomplete="one-time-code" required></label>`
    : "";

const form = (path: string, csrf: string, filing: Filing, inner: string, button: string) =>
  `<form method="post" action="${path}">${csrfField(csrf)}${hidden("filing", filing.id)}${inner}<button type="submit">${button}</button></form>`;

const pendingBlock = (csrf: string, secondFactor: boolean, boxes: ReadonlyMap<string, Box>, filing: Filing) => `<section>
${filingHeader(boxes, filing)}
${previewBlock(filing.preview)}
${form(APPROVE_PATH, csrf, filing, totpInput(secondFactor), "Approve and send")}
${form(
  REJECT_PATH,
  csrf,
  filing,
  `<label>Reason (optional) <input type="text" name="reason" maxlength="${MAX_REASON_LENGTH}"></label>`,
  "Reject",
)}
</section>`;

const reconcileText = (filing: Filing) =>
  filing.reconcile === undefined || filing.reconcile === null
    ? "<p>Not reconciled yet.</p>"
    : `<details><summary>Last reconciliation ${formatTime(filing.reconciledAt ?? null)}</summary><pre>${escapeHtml(
        JSON.stringify(filing.reconcile, null, 2),
      )}</pre></details>`;

const unknownBlock = (csrf: string, secondFactor: boolean, boxes: ReadonlyMap<string, Box>, filing: Filing) => `<section>
${filingHeader(boxes, filing)}
${previewBlock(filing.preview)}
${reconcileText(filing)}
${form(RECONCILE_PATH, csrf, filing, "", "Reconcile now")}
${form(
  MARK_SENT_PATH,
  csrf,
  filing,
  `<label>dmID <input type="text" name="dmid" inputmode="numeric" pattern="[0-9]{1,20}" required></label>${totpInput(secondFactor)}`,
  "Mark sent",
)}
${form(CONFIRM_NOT_SENT_PATH, csrf, filing, totpInput(secondFactor), "Confirm not sent")}
</section>`;

const dispatchingRow = (boxes: ReadonlyMap<string, Box>, filing: Filing) =>
  `<li>${code(filing.id)} from ${senderText(boxes, filing)} to ${code(filing.recipientDbId)}: in flight since ${formatTime(
    filing.submittedAt ?? filing.updatedAt,
  )}.</li>`;

const historyRow = (boxes: ReadonlyMap<string, Box>, filing: Filing) =>
  `<tr><td>${formatTime(filing.updatedAt)}</td><td>${code(filing.id)}</td><td>${senderText(boxes, filing)}</td><td>${code(
    filing.recipientDbId,
  )}</td><td>${escapeHtml(filing.preview.annotation)}</td><td>${escapeHtml(filing.state)}</td><td>${
    filing.dmId === undefined ? "" : code(filing.dmId)
  }</td><td>${escapeHtml(filing.reason ?? "")}</td></tr>`;

interface FilingsPage {
  readonly csrf: string;
  readonly secondFactor: boolean;
  readonly boxes: ReadonlyMap<string, Box>;
  readonly pending: ReadonlyArray<Filing>;
  readonly unknown: ReadonlyArray<Filing>;
  readonly dispatching: ReadonlyArray<Filing>;
  readonly history: ReadonlyArray<Filing>;
}

const section = (items: ReadonlyArray<Filing>, empty: string, render: (filing: Filing) => string) =>
  items.length === 0 ? `<p>${empty}</p>` : items.map(render).join("\n");

const body = (page: FilingsPage) => `<h1>Filings</h1>
<p class="muted">Messages the MCP send tools submitted. Approvers see the metadata and SHA-256 hashes stored with a filing, not the attachment content. “Sent” means ${SENT_MEANING}.</p>
<h2>Waiting for approval</h2>
<p class="muted">Recipients of tier none: approving sends the message at once.</p>
${section(page.pending, "No filings are waiting.", (filing) => pendingBlock(page.csrf, page.secondFactor, page.boxes, filing))}
<h2>Outcome unknown</h2>
<p class="muted">Sending failed in a way that leaves open whether ISDS accepted the message. Never resend: reconcile with the box's sent messages, mark it sent with the dmID you found, or confirm it was not sent (the client then needs a new idempotency key).</p>
${section(page.unknown, "No filings have an unknown outcome.", (filing) => unknownBlock(page.csrf, page.secondFactor, page.boxes, filing))}
<h2>In flight</h2>
${page.dispatching.length === 0 ? "<p>No filings are being sent.</p>" : `<ul>${page.dispatching.map((filing) => dispatchingRow(page.boxes, filing)).join("")}</ul>`}
<h2>Recent filings</h2>
${
  page.history.length === 0
    ? "<p>No filings yet.</p>"
    : `<table><thead><tr><th>Updated</th><th>Filing</th><th>From</th><th>To</th><th>Subject</th><th>State</th><th>dmID</th><th>Reason</th></tr></thead><tbody>${page.history
        .map((filing) => historyRow(page.boxes, filing))
        .join("\n")}</tbody></table>`
}`;

// ---------------------------------------------------------------------------------------------
// Decisions

const ok = (text: string): Flash => ({ kind: "ok", text });
const failed = (text: string): Flash => ({ kind: "error", text });

const approvalFlash = (filingId: string): ((result: SendResult) => Flash) =>
  SendResult.$match({
    Sent: ({ dmID }) => ok(`Filing ${filingId} was sent: ${SENT_MEANING} (dmID ${dmID}).`),
    Refused: ({ reason }) => failed(`Filing ${filingId} was not sent: ${reason}`),
    OutcomeUnknown: () => failed(`Filing ${filingId}: it is not known whether ISDS accepted it. It is listed under outcome unknown; do not resend it.`),
    IsdsRejected: ({ status }) => failed(`ISDS refused filing ${filingId} (${status.code}: ${status.message}); it was not sent.`),
    Expired: () => failed(`Filing ${filingId} expired; nothing was sent.`),
    InProgress: () => failed(`Filing ${filingId} is being sent already.`),
    Queued: () => failed(`Filing ${filingId} still waits for approval; nothing was sent.`),
    ApprovalRequired: () => failed(`Filing ${filingId} waits for the client's confirmation; nothing was sent.`),
    NotSent: () => failed(`Filing ${filingId} was confirmed not sent; nothing was sent.`),
  });

const reconcileFlash = (filingId: string): ((outcome: ReconcileOutcome) => Flash) =>
  ReconcileOutcome.$match({
    Sent: ({ dmID }) => ok(`Filing ${filingId} was found in the sent messages: dmID ${dmID}. It is now sent.`),
    StillUnknown: ({ detail }) => ok(`Filing ${filingId} stays outcome unknown: ${detail}`),
    NotApplicable: ({ state }) => failed(`Filing ${filingId} is ${state}; there is nothing to reconcile.`),
  });

export const filingsTab: Effect.Effect<AdminTab, never, SendService | AuditLog | BoxRegistry> = Effect.gen(function* () {
  const service = yield* SendService;
  const audit = yield* AuditLog;
  const registry = yield* BoxRegistry;

  /** Audits a decision refused here (the service never saw it); a failed write is named in the message. */
  const refused = (action: string, filingId: string | undefined, reason: string, text: string): Effect.Effect<Flash> =>
    audit.record({ actor: ADMIN, action, outcome: "refused", detail: { filingId, reason } }).pipe(
      Effect.as<Flash>({ kind: "error", text }),
      Effect.catch((error) =>
        Effect.logError("filings tab: audit entry not written", error).pipe(
          Effect.as<Flash>({ kind: "error", text: `${text} The audit entry could not be written.` }),
        ),
      ),
      Effect.uninterruptible,
    );

  /** The second factor's refusal text, or undefined when it passed. */
  const secondFactorRefusal = (context: AdminActionContext, nothing: string) =>
    Effect.map(context.checkSecondFactor, (factor) => {
      switch (factor._tag) {
        case "Accepted":
          return undefined;
        case "Rejected":
          return { tag: factor._tag, text: `The authentication code is missing or wrong. ${nothing}` };
        case "Throttled":
          return { tag: factor._tag, text: `Too many failed attempts. Try again in ${factor.retryAfterSeconds} s. ${nothing}` };
        case "Unavailable":
          return { tag: factor._tag, text: `The authentication code could not be checked. ${nothing}` };
      }
    });

  /**
   * One decision: reads the filing id (and with `parse` further fields), checks the second
   * factor when `gated`, then runs `decide`. Failures of `decide` become the flash.
   */
  const decision = <A>(options: {
    readonly action: string;
    readonly gated: boolean;
    readonly nothing: string;
    readonly parse?: (form: URLSearchParams) => { readonly value: A } | { readonly refusal: string };
    readonly decide: (filingId: string, value: A | undefined) => Effect.Effect<Flash, { readonly message: string }>;
  }) =>
    Effect.fnUntraced(function* (form: URLSearchParams, context: AdminActionContext) {
      const filingId = field(form, "filing")?.trim() ?? "";
      if (!FILING_ID.test(filingId)) {
        return yield* refused(options.action, undefined, "invalid filing id", `Choose a filing. ${options.nothing}`);
      }
      const parsed = options.parse?.(form);
      if (parsed !== undefined && "refusal" in parsed) {
        return yield* refused(options.action, filingId, parsed.refusal, `${parsed.refusal} ${options.nothing}`);
      }
      if (options.gated) {
        const refusal = yield* secondFactorRefusal(context, options.nothing);
        if (refusal !== undefined) {
          return yield* refused(options.action, filingId, `second factor ${refusal.tag}`, refusal.text);
        }
      }
      return yield* options
        .decide(filingId, parsed?.value)
        .pipe(Effect.catch((error) => Effect.succeed<Flash>({ kind: "error", text: `Filing ${filingId}: ${messageOf(error)}` })));
    });

  const approve = decision({
    action: "filing.approve",
    gated: true,
    nothing: "Nothing was sent.",
    decide: (filingId) => Effect.map(service.approve(ADMIN, filingId), approvalFlash(filingId)),
  });

  const reject = decision<string | undefined>({
    action: "filing.reject",
    gated: false,
    nothing: "Nothing was changed.",
    parse: (form) => {
      const reason = field(form, "reason")?.trim().slice(0, MAX_REASON_LENGTH);
      return { value: reason === "" ? undefined : reason };
    },
    decide: (filingId, reason) =>
      Effect.as(service.reject(ADMIN, filingId, reason), {
        kind: "ok",
        text: `Filing ${filingId} was rejected; nothing was sent.`,
      } satisfies Flash),
  });

  const reconcile = decision({
    action: "filing.reconcile",
    gated: false,
    nothing: "Nothing was changed.",
    decide: (filingId) => Effect.map(service.reconcileNow(ADMIN, filingId), reconcileFlash(filingId)),
  });

  const markSent = decision<string>({
    action: "filing.mark_sent",
    gated: true,
    nothing: "Nothing was changed.",
    parse: (form) => {
      const dmId = field(form, "dmid")?.trim() ?? "";
      return isMessageId(dmId) ? { value: dmId } : { refusal: "A dmID is 1 to 20 digits." };
    },
    decide: (filingId, dmId = "") =>
      Effect.as(service.markSent(ADMIN, filingId, dmId), {
        kind: "ok",
        text: `Filing ${filingId} is marked sent as dmID ${dmId}.`,
      } satisfies Flash),
  });

  const confirmNotSent = decision({
    action: "filing.confirm_not_sent",
    gated: true,
    nothing: "Nothing was changed.",
    decide: (filingId) =>
      Effect.as(service.confirmNotSent(ADMIN, filingId), {
        kind: "ok",
        text: `Filing ${filingId} is confirmed not sent. The client must use a new idempotencyKey to send it again.`,
      } satisfies Flash),
  });

  const open = (state: FilingState) => service.listFilings({ states: [state], limit: OPEN_LIMIT });

  const render: AdminTab["render"] = Effect.fnUntraced(
    function* (csrf: string, request) {
      const [pending, unknown, dispatching, history, boxes] = yield* Effect.all([
        open("pending_admin"),
        open("outcome_unknown"),
        open("dispatching"),
        service.listFilings({ limit: HISTORY_LIMIT }),
        registry.list,
      ]);
      const page: FilingsPage = {
        csrf,
        secondFactor: request.secondFactor,
        boxes: new Map(boxes.map((box) => [box.id, box])),
        pending,
        unknown,
        dispatching,
        history,
      };
      return { body: body(page) };
    },
    Effect.catch((error) =>
      Effect.succeed({
        body: "<h1>Filings</h1>",
        error: { kind: "error" as const, text: `The filings could not be loaded: ${messageOf(error)}` },
        status: 500,
      }),
    ),
  );

  return {
    id: "filings",
    label: "Filings",
    path: FILINGS_PATH,
    render,
    actions: [
      { path: APPROVE_PATH, back: FILINGS_PATH, run: approve },
      { path: REJECT_PATH, back: FILINGS_PATH, run: reject },
      { path: RECONCILE_PATH, back: FILINGS_PATH, run: reconcile },
      { path: MARK_SENT_PATH, back: FILINGS_PATH, run: markSent },
      { path: CONFIRM_NOT_SENT_PATH, back: FILINGS_PATH, run: confirmNotSent },
    ],
  } satisfies AdminTab;
});
