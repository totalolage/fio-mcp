import { formatTime } from "@mcps/core/admin/pages.js";
import { ADMIN_PATH } from "@mcps/core/admin/sessions.js";
import type { AdminTab, AdminTabRequest, AdminTabView } from "@mcps/core/admin/tab.js";
import { escapeHtml } from "@mcps/core/oauth/pages.js";
import { Effect } from "effect";
import { type AuditEntry, AuditLog, type AuditOutcome, type AuditPage, formatAuditCursor, parseAuditCursor } from "../domain/audit-log.js";
import { BoxRegistry } from "../domain/boxes.js";

/**
 * The admin UI's audit tab at /admin/audit: the audit log newest first, 100
 * rows a page, filtered by `?grant=`, `?box=` (box id) and `?action=` (the
 * tool or admin action), with `?before=` paging back. Every logged value is
 * untrusted text and is escaped; an entry's detail shows as JSON cut to
 * DETAIL_CHARACTERS characters.
 */

export const AUDIT_PATH = `${ADMIN_PATH}/audit` as const;

const PAGE_ROWS = 100;

/** How many characters of an entry's detail JSON the table shows. */
export const DETAIL_CHARACTERS = 300;

/** The filters a request names; a type alias so it widens to URL parameters. */
type Filters = {
  readonly grant?: string;
  readonly box?: string;
  readonly action?: string;
};

const filtersOf = (query: URLSearchParams): Filters => {
  const grant = query.get("grant") || undefined;
  const box = query.get("box") || undefined;
  const action = query.get("action") || undefined;
  return {
    ...(grant === undefined ? {} : { grant }),
    ...(box === undefined ? {} : { box }),
    ...(action === undefined ? {} : { action }),
  };
};

const filtered = (filters: Filters) => filters.grant !== undefined || filters.box !== undefined || filters.action !== undefined;

/** The tab's URL for `params`, escaped for an attribute. */
const href = (params: Readonly<Record<string, string>>) => {
  const search = new URLSearchParams(params).toString();
  return escapeHtml(search === "" ? AUDIT_PATH : `${AUDIT_PATH}?${search}`);
};

/** The detail as JSON, at most DETAIL_CHARACTERS code points, then an ellipsis. */
export const detailText = (detail: unknown): string => {
  const json = detail === undefined ? undefined : JSON.stringify(detail);
  if (json === undefined) return "";
  const characters = Array.from(json);
  return characters.length <= DETAIL_CHARACTERS ? json : `${characters.slice(0, DETAIL_CHARACTERS).join("")}…`;
};

const OUTCOMES: Readonly<Record<AuditOutcome, { readonly mark: string; readonly className: string }>> = {
  ok: { mark: "✓", className: "" },
  started: { mark: "…", className: "muted" },
  uncertain: { mark: "?", className: "danger" },
  refused: { mark: "⊘", className: "danger" },
  error: { mark: "✗", className: "danger" },
};

const outcomeCell = (outcome: AuditOutcome) => {
  const { mark, className } = OUTCOMES[outcome] ?? { mark: "", className: "danger" };
  return `<strong${className === "" ? "" : ` class="${className}"`}>${mark} ${escapeHtml(outcome)}</strong>`;
};

const actorCell = (entry: AuditEntry) =>
  [
    escapeHtml(entry.actorKind),
    entry.grantId === undefined ? "" : `<br>grant <a href="${href({ grant: entry.grantId })}"><code>${escapeHtml(entry.grantId)}</code></a>`,
    entry.clientId === undefined ? "" : `<br><span class="muted">client <code>${escapeHtml(entry.clientId)}</code></span>`,
    entry.subject === undefined ? "" : `<br><span class="muted">subject <code>${escapeHtml(entry.subject)}</code></span>`,
  ].join("");

const boxCell = (boxId: string | undefined, labels: ReadonlyMap<string, string>) => {
  if (boxId === undefined) return "";
  const label = labels.get(boxId);
  return `${label === undefined ? "" : `${escapeHtml(label)}<br>`}<a href="${href({ box: boxId })}"><code>${escapeHtml(boxId)}</code></a>`;
};

const row = (entry: AuditEntry, labels: ReadonlyMap<string, string>) => `<tr>
<td>${formatTime(entry.at)}</td>
<td>${actorCell(entry)}</td>
<td><a href="${href({ action: entry.action })}"><code>${escapeHtml(entry.action)}</code></a></td>
<td>${boxCell(entry.boxId, labels)}</td>
<td>${outcomeCell(entry.outcome)}</td>
<td><code>${escapeHtml(detailText(entry.detail))}</code></td>
</tr>`;

const input = (name: keyof Filters, label: string, value: string | undefined) =>
  `<label>${label} <input name="${name}" value="${escapeHtml(value ?? "")}"></label>`;

interface Body {
  readonly page: AuditPage;
  readonly filters: Filters;
  readonly paged: boolean;
  readonly labels: ReadonlyMap<string, string>;
}

const body = ({ page, filters, paged, labels }: Body) => {
  const next = page.next;
  return `<h1>Audit</h1>
<p class="muted">Tool calls, consent and admin changes, newest first. Filter by grant, box id or action (the tool name for tool calls).</p>
<form method="get" action="${AUDIT_PATH}">
${input("grant", "Grant", filters.grant)}
${input("box", "Box id", filters.box)}
${input("action", "Action", filters.action)}
<button type="submit">Filter</button>${filtered(filters) ? ` <a href="${AUDIT_PATH}">Show all</a>` : ""}
</form>
${
  page.entries.length === 0
    ? "<p>No audit entries.</p>"
    : `<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Box</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>
${page.entries.map((entry) => row(entry, labels)).join("\n")}
</tbody></table>`
}
<p>${paged ? `<a href="${href(filters)}">Newest</a>` : ""}${paged && next !== undefined ? " · " : ""}${
    next === undefined ? "" : `<a href="${href({ ...filters, before: formatAuditCursor(next) })}">Older</a>`
  }</p>`;
};

export const auditTab: Effect.Effect<AdminTab, never, AuditLog | BoxRegistry> = Effect.gen(function* () {
  const audit = yield* AuditLog;
  const registry = yield* BoxRegistry;

  const render = Effect.fn("AuditTab.render")(function* (_csrf: string, request: AdminTabRequest) {
    const filters = filtersOf(request.query);
    // A malformed cursor shows the first page.
    const before = parseAuditCursor(request.query.get("before") ?? "");
    const paged = before !== undefined;
    const labels = new Map((yield* registry.list).map((box) => [box.id, box.label] as const));
    return yield* audit
      .list({
        limit: PAGE_ROWS,
        ...(before === undefined ? {} : { before }),
        ...(filters.grant === undefined ? {} : { grantId: filters.grant }),
        ...(filters.box === undefined ? {} : { boxId: filters.box }),
        ...(filters.action === undefined ? {} : { action: filters.action }),
      })
      .pipe(
        Effect.map((page): AdminTabView => ({ body: body({ page, filters, paged, labels }) })),
        Effect.catch((error) =>
          Effect.succeed<AdminTabView>({
            body: body({ page: { entries: [], next: undefined }, filters, paged, labels }),
            error: { kind: "error", text: error.message },
            status: 500,
          }),
        ),
      );
  });

  return { id: "audit", label: "Audit", path: AUDIT_PATH, render, actions: [] } satisfies AdminTab;
});
