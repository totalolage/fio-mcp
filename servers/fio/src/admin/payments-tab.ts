import type { Flash } from "@mcps/core/admin/pages.js";
import { ADMIN_PATH } from "@mcps/core/admin/sessions.js";
import { type AdminActionContext, type AdminTab, type AdminTabRequest, type AdminTabView, field } from "@mcps/core/admin/tab.js";
import type { OAuthStore } from "@mcps/core/oauth/store.js";
import { Clock, Effect } from "effect";
import { readGrantPayments } from "../oauth/grant-payments.js";
import { PaymentControls } from "../payment-controls.js";
import { formatAuditCursor, parseAuditCursor } from "../payment-ledger.js";
import { unlistedPayees } from "../payment-limits.js";
import { type PendingRow, paymentsBody, pendingBody } from "./payments-pages.js";

/**
 * The admin UI's payments tab (SEC-27, SEC-29): the payment audit at
 * /admin/payments and the batches held for approval at
 * /admin/payments/pending, approved (after the second factor) or declined
 * there. `oauth` reads grants with the Fio grant payments codec.
 */

export const PAYMENTS = `${ADMIN_PATH}/payments` as const;
export const PENDING = `${PAYMENTS}/pending` as const;

const AUDIT_PAGE_ROWS = 100;

export const makePaymentsTab = Effect.fn("PaymentsTab.make")(function* (oauth: OAuthStore) {
  const payments = yield* PaymentControls;

  /** Audit rows newest first, `?grant=` filters, `?before=` pages back. */
  const showPayments = (_csrf: string, request: AdminTabRequest): Effect.Effect<AdminTabView> => {
    const query = request.query;
    const grant = query.get("grant") || undefined;
    // A malformed or legacy cursor shows the first page.
    const before = parseAuditCursor(query.get("before") ?? "");
    return payments.listAudit({ limit: AUDIT_PAGE_ROWS, ...(grant === undefined ? {} : { grantId: grant }), ...(before === undefined ? {} : { before }) }).pipe(
      Effect.map((rows): AdminTabView => {
        const last = rows.at(-1);
        const older =
          rows.length < AUDIT_PAGE_ROWS || last === undefined
            ? undefined
            : `${PAYMENTS}?${new URLSearchParams({ ...(grant === undefined ? {} : { grant }), before: formatAuditCursor(last) })}`;
        return { body: paymentsBody({ rows, grant, older }) };
      }),
      Effect.catch((error) =>
        Effect.succeed<AdminTabView>({
          body: paymentsBody({ rows: [], grant, older: undefined }),
          error: { kind: "error", text: error.message },
          status: 500,
        }),
      ),
    );
  };

  /** Held batches (the service drops expired ones first), payees marked against the grant's allowlist now. */
  const pendingRows = Effect.gen(function* () {
    const views = yield* payments.listPending;
    const grants = yield* oauth
      .listGrants(yield* Clock.currentTimeMillis)
      .pipe(Effect.mapError((error) => ({ message: error.description })));
    return views.map(({ batch, audit }): PendingRow => {
      const grant = grants.find((candidate) => candidate.grantId === batch.grantId);
      return {
        pendingId: batch.pendingId,
        accountName: batch.accountName,
        xml: batch.xml,
        xmlSha256: batch.xmlSha256,
        expiresAt: batch.expiresAt,
        audit,
        unlisted: grant === undefined ? undefined : unlistedPayees(readGrantPayments(grant.settings).allowlist, audit.payees),
      };
    });
  });

  const showPending = (csrf: string, request: AdminTabRequest): Effect.Effect<AdminTabView> =>
    pendingRows.pipe(
      Effect.map((rows): AdminTabView => ({ body: pendingBody({ csrf, rows, secondFactor: request.secondFactor }) })),
      Effect.catch((error) =>
        Effect.succeed<AdminTabView>({
          body: pendingBody({ csrf, rows: [], secondFactor: request.secondFactor }),
          error: { kind: "error", text: error.message },
          status: 500,
        }),
      ),
    );

  /** Uploads the held batch's exact XML once, after the second factor (SEC-27 confirm). */
  const approvePayment = Effect.fnUntraced(function* (form: URLSearchParams, context: AdminActionContext) {
    const factor = yield* context.checkSecondFactor;
    switch (factor._tag) {
      case "Rejected":
        return { kind: "error", text: "The authentication code is wrong. Nothing was uploaded." } satisfies Flash;
      case "Throttled":
        return {
          kind: "error",
          text: `Too many failed attempts. Try again in ${factor.retryAfterSeconds} s. Nothing was uploaded.`,
        } satisfies Flash;
      case "Unavailable":
        return { kind: "error", text: "The authentication code could not be checked. Nothing was uploaded." } satisfies Flash;
      case "Accepted":
        break;
    }
    // Checked again under the grant's lock: a grant revoked after the
    // page loaded makes the approval upload nothing.
    const grantLive = (grantId: string) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => oauth.listGrants(now)).pipe(
        Effect.map((grants) => grants.some((grant) => grant.grantId === grantId)),
        Effect.mapError((error) => ({ message: error.description })),
      );
    const result = yield* payments.approvePending(field(form, "pending") ?? "", grantLive);
    yield* Effect.logInfo(`admin: approved a held payment batch (${result.outcome})`);
    return {
      kind: result.outcome === "accepted" ? "ok" : "error",
      text: `Batch ${result.pendingId}: ${result.outcome}. ${result.message}`,
    } satisfies Flash;
  });

  const declinePayment = (form: URLSearchParams) =>
    payments.declinePending(field(form, "pending") ?? "").pipe(
      Effect.tap((declined) => (declined ? Effect.logInfo("admin: declined a held payment batch") : Effect.void)),
      Effect.map(
        (declined): Flash =>
          declined
            ? { kind: "ok", text: "Declined the batch; nothing was sent to FIO." }
            : { kind: "error", text: "That batch is no longer pending (approved, declined or expired)." },
      ),
    );

  return {
    id: "payments",
    label: "Payments",
    path: PAYMENTS,
    nav: "after-clients",
    render: showPayments,
    pages: [{ path: PENDING, render: showPending }],
    actions: [
      { path: `${PENDING}/approve`, back: PENDING, run: approvePayment },
      { path: `${PENDING}/decline`, back: PENDING, run: declinePayment },
    ],
  } satisfies AdminTab;
});
