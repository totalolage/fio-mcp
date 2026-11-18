import { ADMIN_PATH } from "@mcps/core/admin/sessions.js";
import type { AdminTab, AdminTabRequest, AdminTabView } from "@mcps/core/admin/tab.js";
import { Effect } from "effect";
import { PaymentControls } from "../payment-controls.js";
import { formatAuditCursor, parseAuditCursor } from "../payment-ledger.js";
import { paymentsBody } from "./payments-pages.js";

export const PAYMENTS = `${ADMIN_PATH}/payments` as const;

const AUDIT_PAGE_ROWS = 100;

export const makePaymentsTab = Effect.fn("PaymentsTab.make")(function* () {
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

  return {
    id: "payments",
    label: "Payments",
    path: PAYMENTS,
    nav: "after-clients",
    render: showPayments,
    actions: [],
  } satisfies AdminTab;
});
