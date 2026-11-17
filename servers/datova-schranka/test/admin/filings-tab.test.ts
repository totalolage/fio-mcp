import { assert, describe, it } from "@effect/vitest";
import type { AdminActionContext, AdminTab } from "@mcps/core/admin/tab.js";
import type { LoginResult } from "@mcps/core/oauth/login.js";
import { makeRedactor, Redactor } from "@mcps/core/redaction.js";
import { Effect, Layer } from "effect";
import { FILINGS_PATH, filingsTab } from "../../src/admin/filings-tab.js";
import { AuditLog } from "../../src/domain/audit-log.js";
import { DomainStoreError } from "../../src/domain/errors.js";
import {
  DmIdLinked,
  type Filing,
  FilingStateConflict,
  ReconcileOutcome,
  SendResult,
} from "../../src/domain/send/api.js";
import { memoryDatabase } from "../domain/support/database.js";
import { fakeBox, makeFakeBoxRegistry } from "../domain/support/fake-box-registry.js";
import { passwordCredentials } from "../domain/support/fake-isds.js";
import {
  BOX_ID,
  type FakeSendAnswers,
  type FakeSendCall,
  fakeSendService,
  filing,
  preview,
  REMOVED_BOX_ID,
} from "../send-support/fake-send-service.js";

const ACCEPTED: LoginResult<void> = { _tag: "Accepted", value: undefined };
const REFUSALS: ReadonlyArray<readonly [LoginResult<void>, string]> = [
  [{ _tag: "Rejected" }, "missing or wrong"],
  [{ _tag: "Throttled", retryAfterSeconds: 30 }, "30 s"],
  [{ _tag: "Unavailable" }, "could not be checked"],
];

/** An action context answering `factor` and counting how often the second factor was checked. */
const contextFor = (factor: LoginResult<void>) => {
  const checks = { count: 0 };
  const context: AdminActionContext = {
    checkSecondFactor: Effect.sync(() => {
      checks.count += 1;
      return factor;
    }),
    files: [],
  };
  return { context, checks };
};

const PENDING = filing({
  id: "filing_pending",
  state: "pending_admin",
  expiresAt: Date.UTC(2026, 10, 24, 8, 0),
  preview: preview({
    annotation: `Faktura <img src=x onerror="alert(1)">`,
    envelope: { senderRefNumber: `R&D "1"`, toHands: "<b>Jana</b>", personalDelivery: true },
    attachments: [
      { filename: "<script>x</script>.pdf", mimeType: "application/pdf", metaType: "main", size: 2048, sha256: "c".repeat(64) },
      { filename: "annex.xml", mimeType: "text/xml", metaType: "enclosure", size: 10, sha256: "d".repeat(64) },
    ],
    totalBytes: 2058,
  }),
});
const UNKNOWN = filing({
  id: "filing_unknown",
  state: "outcome_unknown",
  submittedAt: Date.UTC(2026, 10, 17, 8, 1),
  reconciledAt: Date.UTC(2026, 10, 17, 8, 2),
  reconcile: { result: "not found", note: "<i>none</i>" },
  updatedAt: Date.UTC(2026, 10, 17, 8, 2),
});
const DISPATCHING = filing({ id: "filing_dispatching", state: "dispatching", submittedAt: Date.UTC(2026, 10, 17, 8, 3) });
const SENT = filing({ id: "filing_sent", state: "sent", dmId: "123456789", updatedAt: Date.UTC(2026, 10, 17, 7, 0) });
const ORPHAN = filing({
  id: "filing_orphan",
  state: "outcome_unknown",
  boxId: REMOVED_BOX_ID,
  preview: preview({ senderBox: { id: REMOVED_BOX_ID, dbId: "rrr1111", label: "Old office" } }),
});

/**
 * The tab over a fake SendService (holding `filings`, answering `answers`), a registry with
 * the one box BOX_ID (REMOVED_BOX_ID is gone) and a real AuditLog over an in-memory database.
 */
const withTab = <A, E>(
  filings: ReadonlyArray<Filing>,
  answers: FakeSendAnswers,
  body: (harness: { readonly tab: AdminTab; readonly calls: Array<FakeSendCall> }) => Effect.Effect<A, E, AuditLog>,
) =>
  Effect.gen(function* () {
    const send = fakeSendService(filings, answers);
    const registry = yield* makeFakeBoxRegistry([
      { box: { ...fakeBox(BOX_ID, "aaa1111"), label: "Office" }, credentials: passwordCredentials("alice") },
    ]);
    const audit = AuditLog.Default.pipe(
      Layer.provide(Layer.succeed(Redactor, makeRedactor([]))),
      Layer.provide(memoryDatabase()),
    );
    return yield* Effect.gen(function* () {
      const tab = yield* filingsTab;
      return yield* body({ tab, calls: send.calls });
    }).pipe(Effect.provide(Layer.mergeAll(send.layer, registry.layer, audit)));
  });

const run = (tab: AdminTab, path: string, form: Record<string, string>, context: AdminActionContext) => {
  const action = tab.actions.find((candidate) => candidate.path === path);
  return action === undefined ? Effect.die(`no action ${path}`) : action.run(new URLSearchParams(form), context);
};

const audits = Effect.gen(function* () {
  const page = yield* (yield* AuditLog).list();
  return page.entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    outcome: entry.outcome,
    actorKind: entry.actorKind,
    boxId: entry.boxId,
    detail: entry.detail,
  }));
});

const auditIds = Effect.map(audits, (rows) => rows.map((row) => row.id));

const decisions = (calls: ReadonlyArray<FakeSendCall>) => calls.filter((call) => call.op !== "listFilings");

const page = (tab: AdminTab, secondFactor: boolean) =>
  tab.render("csrf-token", { query: new URLSearchParams(), secondFactor });

describe("filings tab", () => {
  it.effect("sits at /admin/filings", () =>
    withTab([], {}, ({ tab }) =>
      Effect.sync(() => {
        assert.strictEqual(tab.id, "filings");
        assert.strictEqual(tab.label, "Filings");
        assert.strictEqual(tab.path, FILINGS_PATH);
        assert.strictEqual(FILINGS_PATH, "/admin/filings");
      }),
    ),
  );

  it.effect("shows a pending filing's full preview, escaped, with approve and reject forms", () =>
    withTab([PENDING], {}, ({ tab }) =>
      Effect.gen(function* () {
        const html = (yield* page(tab, true)).body;
        assert.include(html, "filing_pending");
        assert.include(html, "Faktura &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
        assert.include(html, "R&amp;D &quot;1&quot;");
        assert.include(html, "&lt;b&gt;Jana&lt;/b&gt;");
        assert.include(html, "&lt;script&gt;x&lt;/script&gt;.pdf");
        assert.notInclude(html, "<script>");
        assert.notInclude(html, "<img");
        assert.notInclude(html, "<b>Jana");
        assert.include(html, "c".repeat(64));
        assert.include(html, "d".repeat(64));
        assert.include(html, "2048");
        assert.include(html, "2058");
        assert.include(html, PENDING.contentHash);
        assert.include(html, "Office");
        assert.include(html, "aaa1111");
        assert.include(html, `action="/admin/filings/approve"`);
        assert.include(html, `action="/admin/filings/reject"`);
        assert.include(html, `name="csrf" value="csrf-token"`);
        assert.include(html, `name="totp"`);
        assert.include(html, "not the attachment content");
        assert.notInclude((yield* page(tab, false)).body, `name="totp"`);
      }),
    ),
  );

  it.effect("shows outcome_unknown filings with reconcile, mark sent and confirm not sent", () =>
    withTab([UNKNOWN], {}, ({ tab }) =>
      Effect.gen(function* () {
        const html = (yield* page(tab, true)).body;
        assert.include(html, "filing_unknown");
        for (const path of ["/admin/filings/reconcile", "/admin/filings/mark-sent", "/admin/filings/confirm-not-sent"]) {
          assert.include(html, `action="${path}"`);
        }
        assert.include(html, `name="dmid"`);
        assert.include(html, "&lt;i&gt;none&lt;/i&gt;");
        assert.notInclude(html, "<i>none</i>");
        // Mark sent and confirm not sent each ask for the code; reconcile does not.
        assert.strictEqual(html.split(`name="totp"`).length - 1, 2);
      }),
    ),
  );

  it.effect("lists dispatching filings as in flight, without any action", () =>
    withTab([DISPATCHING], {}, ({ tab }) =>
      Effect.gen(function* () {
        const html = (yield* page(tab, true)).body;
        assert.include(html, "filing_dispatching");
        assert.include(html, "in flight");
        assert.notInclude(html, `value="filing_dispatching"`);
      }),
    ),
  );

  it.effect("shows the recent history from the last 100 filings", () =>
    withTab([SENT, PENDING], {}, ({ tab, calls }) =>
      Effect.gen(function* () {
        const html = (yield* page(tab, false)).body;
        assert.include(html, "filing_sent");
        assert.include(html, "123456789");
        const queries = calls.flatMap((call) => (call.op === "listFilings" ? [call.query] : []));
        assert.deepStrictEqual(queries, [
          { states: ["pending_admin"], limit: 500 },
          { states: ["outcome_unknown"], limit: 500 },
          { states: ["dispatching"], limit: 500 },
          { limit: 100 },
        ]);
      }),
    ),
  );

  it.effect("still shows a removed box's filings with the box id and their decisions", () =>
    withTab([ORPHAN], {}, ({ tab }) =>
      Effect.gen(function* () {
        const html = (yield* page(tab, true)).body;
        assert.include(html, "filing_orphan");
        assert.include(html, REMOVED_BOX_ID);
        assert.include(html, "removed");
        assert.include(html, "Old office");
        assert.include(html, `action="/admin/filings/confirm-not-sent"`);
      }),
    ),
  );

  it.effect("reports a listing failure as the page error", () =>
    withTab([], { listFilings: Effect.fail(new DomainStoreError({ operation: "list filings" })) }, ({ tab }) =>
      Effect.gen(function* () {
        const view = yield* page(tab, false);
        assert.strictEqual(view.error?.kind, "error");
        assert.include(view.error?.text ?? "", "could not be loaded");
      }),
    ),
  );
});

describe("filings tab decisions", () => {
  it.effect("approve with an accepted second factor sends and says what sent means", () =>
    withTab(
      [PENDING],
      { approve: Effect.succeed(SendResult.Sent({ filingId: PENDING.id, dmID: "987654321" })) },
      ({ tab, calls }) =>
        Effect.gen(function* () {
          const { context, checks } = contextFor(ACCEPTED);
          const flash = yield* run(tab, "/admin/filings/approve", { filing: PENDING.id, totp: "123456" }, context);
          assert.strictEqual(flash.kind, "ok");
          assert.include(flash.text, "987654321");
          assert.include(flash.text, "does not mean it was delivered");
          assert.strictEqual(checks.count, 1);
          assert.deepStrictEqual(decisions(calls), [{ op: "approve", admin: { kind: "admin" }, filingId: PENDING.id }]);
          // The service audits its own calls.
          assert.deepStrictEqual(yield* audits, []);
        }),
    ),
  );

  it.effect("approve reports results that did not send", () =>
    Effect.forEach(
      [
        [SendResult.Refused({ reason: "the recipient is not active", filingId: PENDING.id }), "the recipient is not active"],
        [SendResult.OutcomeUnknown({ filingId: PENDING.id }), "not known whether ISDS accepted"],
        [
          SendResult.IsdsRejected({
            filingId: PENDING.id,
            status: { code: "1214", message: "Neplatná příloha", classification: "AttachmentRejected" },
          }),
          "1214",
        ],
        [SendResult.Expired({ filingId: PENDING.id }), "expired"],
      ] as const,
      ([result, text]) =>
        withTab([PENDING], { approve: Effect.succeed(result) }, ({ tab }) =>
          Effect.gen(function* () {
            const flash = yield* run(tab, "/admin/filings/approve", { filing: PENDING.id }, contextFor(ACCEPTED).context);
            assert.strictEqual(flash.kind, "error");
            assert.include(flash.text, text);
          }),
        ),
    ),
  );

  for (const [factor, text] of REFUSALS) {
    it.effect(`a ${factor._tag} second factor stops approve, mark sent and confirm not sent`, () =>
      withTab([PENDING, UNKNOWN], {}, ({ tab, calls }) =>
        Effect.gen(function* () {
          const forms: ReadonlyArray<readonly [string, Record<string, string>, string]> = [
            ["/admin/filings/approve", { filing: PENDING.id, totp: "000000" }, "filing.approve"],
            ["/admin/filings/mark-sent", { filing: UNKNOWN.id, dmid: "123456789", totp: "000000" }, "filing.mark_sent"],
            ["/admin/filings/confirm-not-sent", { filing: UNKNOWN.id }, "filing.confirm_not_sent"],
          ];
          for (const [path, form, action] of forms) {
            const before = new Set((yield* auditIds));
            const flash = yield* run(tab, path, form, contextFor(factor).context);
            assert.strictEqual(flash.kind, "error");
            assert.include(flash.text, text);
            // Rows written at the same (test clock) time have no defined order: find the new one by id.
            const added = (yield* audits).filter((row) => !before.has(row.id));
            assert.strictEqual(added.length, 1);
            const { id: _id, ...row } = added[0] ?? { id: "" };
            assert.deepStrictEqual(row, {
              action,
              outcome: "refused",
              actorKind: "admin",
              boxId: undefined,
              detail: { filingId: form.filing, reason: `second factor ${factor._tag}` },
            });
          }
          assert.deepStrictEqual(decisions(calls), []);
        }),
      ),
    );
  }

  it.effect("mark sent needs a valid dmID before the second factor is checked", () =>
    withTab([UNKNOWN], {}, ({ tab, calls }) =>
      Effect.gen(function* () {
        for (const dmid of ["", "12a45", "1".repeat(21)]) {
          const { context, checks } = contextFor(ACCEPTED);
          const flash = yield* run(tab, "/admin/filings/mark-sent", { filing: UNKNOWN.id, dmid }, context);
          assert.strictEqual(flash.kind, "error");
          assert.include(flash.text, "dmID");
          assert.strictEqual(checks.count, 0);
        }
        assert.deepStrictEqual(decisions(calls), []);
        const rows = yield* audits;
        assert.deepStrictEqual(
          rows.map((row) => [row.action, row.outcome]),
          Array.from({ length: 3 }, () => ["filing.mark_sent", "refused"]),
        );
      }),
    ),
  );

  it.effect("mark sent and confirm not sent call the service after the second factor", () =>
    withTab([UNKNOWN], { markSent: Effect.void, confirmNotSent: Effect.void }, ({ tab, calls }) =>
      Effect.gen(function* () {
        const marked = yield* run(
          tab,
          "/admin/filings/mark-sent",
          { filing: UNKNOWN.id, dmid: " 123456789 " },
          contextFor(ACCEPTED).context,
        );
        assert.strictEqual(marked.kind, "ok");
        assert.include(marked.text, "123456789");
        const confirmed = yield* run(tab, "/admin/filings/confirm-not-sent", { filing: UNKNOWN.id }, contextFor(ACCEPTED).context);
        assert.strictEqual(confirmed.kind, "ok");
        assert.include(confirmed.text, "new idempotencyKey");
        assert.deepStrictEqual(decisions(calls), [
          { op: "markSent", admin: { kind: "admin" }, filingId: UNKNOWN.id, dmId: "123456789" },
          { op: "confirmNotSent", admin: { kind: "admin" }, filingId: UNKNOWN.id },
        ]);
        assert.deepStrictEqual(yield* audits, []);
      }),
    ),
  );

  it.effect("mark sent reports a dmID linked to another filing", () =>
    withTab(
      [UNKNOWN],
      { markSent: Effect.fail(new DmIdLinked({ dmId: "123456789", filingId: "filing_other" })) },
      ({ tab }) =>
        Effect.gen(function* () {
          const flash = yield* run(
            tab,
            "/admin/filings/mark-sent",
            { filing: UNKNOWN.id, dmid: "123456789" },
            contextFor(ACCEPTED).context,
          );
          assert.strictEqual(flash.kind, "error");
          assert.include(flash.text, "already linked to filing filing_other");
        }),
    ),
  );

  it.effect("reject and reconcile now need no second factor", () =>
    withTab(
      [PENDING, UNKNOWN],
      { reject: Effect.void, reconcileNow: Effect.succeed(ReconcileOutcome.Sent({ dmID: "555" })) },
      ({ tab, calls }) =>
        Effect.gen(function* () {
          const { context, checks } = contextFor({ _tag: "Rejected" });
          const rejected = yield* run(tab, "/admin/filings/reject", { filing: PENDING.id, reason: "  wrong recipient " }, context);
          assert.strictEqual(rejected.kind, "ok");
          const reconciled = yield* run(tab, "/admin/filings/reconcile", { filing: UNKNOWN.id }, context);
          assert.strictEqual(reconciled.kind, "ok");
          assert.include(reconciled.text, "555");
          assert.strictEqual(checks.count, 0);
          assert.deepStrictEqual(decisions(calls), [
            { op: "reject", admin: { kind: "admin" }, filingId: PENDING.id, reason: "wrong recipient" },
            { op: "reconcileNow", admin: { kind: "admin" }, filingId: UNKNOWN.id },
          ]);
        }),
    ),
  );

  it.effect("reject without a reason passes none; reconcile reports a filing that stays unknown", () =>
    withTab(
      [PENDING, UNKNOWN],
      {
        reject: Effect.void,
        reconcileNow: Effect.succeed(ReconcileOutcome.StillUnknown({ detail: "no matching sent message" })),
      },
      ({ tab, calls }) =>
        Effect.gen(function* () {
          const { context } = contextFor(ACCEPTED);
          yield* run(tab, "/admin/filings/reject", { filing: PENDING.id, reason: "" }, context);
          const flash = yield* run(tab, "/admin/filings/reconcile", { filing: UNKNOWN.id }, context);
          assert.include(flash.text, "no matching sent message");
          assert.deepStrictEqual(decisions(calls)[0], { op: "reject", admin: { kind: "admin" }, filingId: PENDING.id, reason: undefined });
        }),
    ),
  );

  it.effect("reports a decision on a filing that moved on", () =>
    withTab(
      [PENDING],
      {
        reject: Effect.fail(new FilingStateConflict({ filingId: PENDING.id, state: "sent", expected: "pending_admin" })),
        reconcileNow: Effect.succeed(ReconcileOutcome.NotApplicable({ state: "sent" })),
      },
      ({ tab }) =>
        Effect.gen(function* () {
          const { context } = contextFor(ACCEPTED);
          const rejected = yield* run(tab, "/admin/filings/reject", { filing: PENDING.id }, context);
          assert.strictEqual(rejected.kind, "error");
          assert.include(rejected.text, "is sent, not pending_admin");
          const reconciled = yield* run(tab, "/admin/filings/reconcile", { filing: PENDING.id }, context);
          assert.strictEqual(reconciled.kind, "error");
          assert.include(reconciled.text, "sent");
        }),
    ),
  );

  it.effect("decisions on a removed box's filing still reach the service", () =>
    withTab([ORPHAN], { confirmNotSent: Effect.void, reconcileNow: Effect.succeed(ReconcileOutcome.StillUnknown({ detail: "box removed" })) }, ({ tab, calls }) =>
      Effect.gen(function* () {
        const { context } = contextFor(ACCEPTED);
        const confirmed = yield* run(tab, "/admin/filings/confirm-not-sent", { filing: ORPHAN.id }, context);
        assert.strictEqual(confirmed.kind, "ok");
        const reconciled = yield* run(tab, "/admin/filings/reconcile", { filing: ORPHAN.id }, context);
        assert.include(reconciled.text, "box removed");
        assert.deepStrictEqual(
          decisions(calls).map((call) => call.op),
          ["confirmNotSent", "reconcileNow"],
        );
      }),
    ),
  );

  it.effect("refuses a malformed filing id without the service, auditing it", () =>
    withTab([], {}, ({ tab, calls }) =>
      Effect.gen(function* () {
        const { context, checks } = contextFor(ACCEPTED);
        const flash = yield* run(tab, "/admin/filings/approve", { filing: "<bad id>" }, context);
        assert.strictEqual(flash.kind, "error");
        assert.strictEqual(checks.count, 0);
        assert.deepStrictEqual(decisions(calls), []);
        const rows = yield* audits;
        assert.deepStrictEqual(rows.map((row) => [row.action, row.outcome]), [["filing.approve", "refused"]]);
      }),
    ),
  );
});
