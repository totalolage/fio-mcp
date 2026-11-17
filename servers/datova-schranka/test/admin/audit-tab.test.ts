import { escapeHtml } from "@mcps/core/oauth/pages.js";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_PATH, auditTab, DETAIL_CHARACTERS } from "../../src/admin/audit-tab.js";
import { type AuditEventInput, type AuditFinalOutcome, AuditLog } from "../../src/domain/audit-log.js";
import { BoxRegistry } from "../../src/domain/boxes.js";
import { passwordCredentials } from "../domain/support/fake-isds.js";
import { AdminBrowser, type AdminHarness, flashOf, startAdmin } from "./support/admin-harness.js";

/** The audit tab: newest first, cursor paging through tied timestamps, grant/box/action filters, escaped and truncated values. */

type Event = AuditEventInput & { readonly outcome: AuditFinalOutcome };

let app: AdminHarness | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const start = async () => {
  app = await startAdmin(Effect.map(auditTab, (tab) => [tab]), { logins: { alice: "aaa1111", bob: "bbb2222" } });
  const browser = new AdminBrowser(app);
  expect((await browser.signIn()).status).toBe(303);
  return { app, browser };
};

/** Records `events` with the clock at `at` each, so rows can share a timestamp. */
const recordAt = (harness: AdminHarness, events: ReadonlyArray<{ readonly at: number; readonly event: Event }>) =>
  harness.run(
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      for (const { at, event } of events) {
        yield* TestClock.setTime(at);
        yield* audit.record(event);
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );

const toolCall = (seq: number, extra: Partial<Event> = {}): Event => ({
  actor: { kind: "tool", grantId: "grant-a", clientId: "client-a", subject: "admin" },
  action: "list_messages",
  outcome: "ok",
  detail: { seq },
  ...extra,
});

/** The `seq` of each row a page shows, in order. */
const seqs = (html: string) => Array.from(html.matchAll(/\{&quot;seq&quot;:(\d+)\}/g), (match) => Number(match[1]));

const linkTo = (html: string, text: string) => {
  const found = new RegExp(`<a href="([^"]+)">${text}</a>`).exec(html)?.[1];
  return found?.replaceAll("&amp;", "&");
};

/** Every page from `path` on, following the Older links. */
const allPages = async (browser: AdminBrowser, path: string) => {
  const pages: Array<string> = [];
  for (let next: string | undefined = path; next !== undefined; next = linkTo(pages.at(-1) ?? "", "Older")) {
    const page = await browser.get(next);
    expect(page.status).toBe(200);
    pages.push(page.html);
    expect(pages.length).toBeLessThan(10);
  }
  return pages;
};

describe("audit tab", () => {
  it("pages newest first through more than a page of rows with tied timestamps, skipping and repeating none", async () => {
    const { app, browser } = await start();
    // 150 rows share one timestamp, so the 100-row page boundary falls inside the tie.
    await recordAt(app, [
      ...Array.from({ length: 30 }, (_, i) => ({ at: 4_000, event: toolCall(i) })),
      ...Array.from({ length: 150 }, (_, i) => ({ at: 5_000, event: toolCall(30 + i) })),
      { at: 6_000, event: toolCall(180) },
    ]);
    const all = await app.run(Effect.flatMap(AuditLog, (audit) => audit.list({ limit: 500 })));
    expect(new Set(all.entries.map((entry) => entry.at))).toEqual(new Set([4_000, 5_000, 6_000]));

    const pages = await allPages(browser, AUDIT_PATH);
    expect(pages.map((html) => seqs(html).length)).toEqual([100, 81]);
    const shown = pages.flatMap(seqs);
    expect(shown[0]).toBe(180);
    expect(new Set(shown).size).toBe(181);
    expect(shown).toEqual(all.entries.map((entry) => (entry.detail as { seq: number }).seq));
    const at = all.entries.map((entry) => entry.at);
    expect(at).toEqual([...at].sort((a, b) => b - a));
    // Paging links back to the newest page; the first page has no such link.
    expect(linkTo(pages[0] ?? "", "Newest")).toBeUndefined();
    expect(linkTo(pages[1] ?? "", "Newest")).toBe(AUDIT_PATH);
    expect(linkTo(pages[1] ?? "", "Older")).toBeUndefined();
  });

  it("shows the first page for a malformed cursor and ignores empty filters", async () => {
    const { app, browser } = await start();
    await recordAt(app, Array.from({ length: 3 }, (_, i) => ({ at: 1_000 + i, event: toolCall(i) })));
    for (const query of ["?before=garbage", "?before=12.", "?before=-5.abc", "?grant=&box=&action=&before="]) {
      const page = await browser.get(`${AUDIT_PATH}${query}`);
      expect(page.status).toBe(200);
      expect(seqs(page.html)).toEqual([2, 1, 0]);
      expect(page.html).not.toContain("Show all");
    }
  });

  it("filters by grant, box and action alone and combined, keeping the filters in the Older link", async () => {
    const { app, browser } = await start();
    const variants = [
      { actor: { kind: "tool" as const, grantId: "grant-a" }, boxId: "box-1", action: "list_messages" },
      { actor: { kind: "tool" as const, grantId: "grant-b" }, boxId: "box-1", action: "list_messages" },
      { actor: { kind: "tool" as const, grantId: "grant-a" }, boxId: "box-2", action: "list_messages" },
      { actor: { kind: "tool" as const, grantId: "grant-a" }, boxId: "box-1", action: "download_message" },
    ];
    // 105 rows match every filter; one row per other variant differs in exactly one field.
    await recordAt(app, [
      ...Array.from({ length: 105 }, (_, i) => ({ at: 2_000, event: toolCall(i, variants[0]) })),
      { at: 3_000, event: toolCall(200, variants[1]) },
      { at: 3_000, event: toolCall(201, variants[2]) },
      { at: 3_000, event: toolCall(202, variants[3]) },
    ]);

    const shown = async (query: string) => (await allPages(browser, `${AUDIT_PATH}?${query}`)).flatMap(seqs).sort((a, b) => a - b);
    const matching = Array.from({ length: 105 }, (_, i) => i);
    expect(await shown("grant=grant-b")).toEqual([200]);
    expect(await shown("box=box-2")).toEqual([201]);
    expect(await shown("action=download_message")).toEqual([202]);
    expect(await shown("grant=grant-a")).toEqual([...matching, 201, 202]);
    expect(await shown("grant=grant-a&box=box-1")).toEqual([...matching, 202]);
    expect(await shown("grant=grant-a&box=box-1&action=list_messages")).toEqual(matching);

    const first = await browser.get(`${AUDIT_PATH}?grant=grant-a&box=box-1&action=list_messages`);
    const older = new URL(linkTo(first.html, "Older") ?? "", "https://ds.example.test");
    expect(older.pathname).toBe(AUDIT_PATH);
    expect([...older.searchParams.keys()]).toEqual(["grant", "box", "action", "before"]);
    expect(older.searchParams.get("grant")).toBe("grant-a");
    expect(older.searchParams.get("box")).toBe("box-1");
    expect(older.searchParams.get("action")).toBe("list_messages");
    const second = await browser.get(`${older.pathname}${older.search}`);
    expect(linkTo(second.html, "Newest")).toBe(`${AUDIT_PATH}?grant=grant-a&box=box-1&action=list_messages`);
    // The form keeps the filters, and Show all clears them.
    expect(first.html).toContain('<input name="grant" value="grant-a">');
    expect(first.html).toContain('<input name="box" value="box-1">');
    expect(first.html).toContain('<input name="action" value="list_messages">');
    expect(first.html).toContain(`<a href="${AUDIT_PATH}">Show all</a>`);
  });

  it("escapes untrusted action, actor, detail and filter values", async () => {
    const { app, browser } = await start();
    const script = `<script>alert("x")</script>`;
    const breakout = `"><img src=x onerror='1'>`;
    await recordAt(app, [
      {
        at: 1_000,
        event: {
          actor: { kind: "tool", grantId: breakout, clientId: script, subject: script },
          action: script,
          boxId: breakout,
          outcome: "refused",
          detail: { note: script },
        },
      },
    ]);
    const page = await browser.get(`${AUDIT_PATH}?${new URLSearchParams({ action: script })}`);
    expect(page.status).toBe(200);
    expect(page.html).not.toContain("<script>");
    expect(page.html).not.toContain("<img");
    expect(page.html).toContain(escapeHtml(script));
    expect(page.html).toContain(escapeHtml(breakout));
    expect(page.html).toContain(`{&quot;note&quot;:&quot;&lt;script&gt;alert(\\&quot;x\\&quot;)&lt;/script&gt;&quot;}`);
    expect(page.html).toContain(`<input name="action" value="${escapeHtml(script)}">`);
    // Filter links carry the values URL-encoded inside an escaped attribute.
    expect(page.html).toContain(`href="${escapeHtml(`${AUDIT_PATH}?${new URLSearchParams({ grant: breakout })}`)}"`);
  });

  it("cuts long detail JSON to the character budget before escaping it", async () => {
    const { app, browser } = await start();
    await recordAt(app, [
      { at: 1_000, event: toolCall(0, { action: "long", detail: { text: "a".repeat(1_000) } }) },
      { at: 2_000, event: toolCall(0, { action: "angles", detail: "<".repeat(1_000) }) },
      { at: 3_000, event: toolCall(0, { action: "exact", detail: "b".repeat(DETAIL_CHARACTERS - 2) }) },
    ]);
    const long = (await browser.get(`${AUDIT_PATH}?action=long`)).html;
    const prefix = DETAIL_CHARACTERS - '{"text":"'.length;
    expect(long).toContain(`<code>{&quot;text&quot;:&quot;${"a".repeat(prefix)}…</code>`);
    expect(long).not.toContain("a".repeat(prefix + 1));
    const angles = (await browser.get(`${AUDIT_PATH}?action=angles`)).html;
    expect(angles).toContain(`<code>&quot;${"&lt;".repeat(DETAIL_CHARACTERS - 1)}…</code>`);
    expect(angles).not.toContain("&lt;".repeat(DETAIL_CHARACTERS));
    // JSON exactly at the budget is shown whole, without the marker.
    const exact = (await browser.get(`${AUDIT_PATH}?action=exact`)).html;
    expect(exact).toContain(`<code>&quot;${"b".repeat(DETAIL_CHARACTERS - 2)}&quot;</code>`);
  });

  it("labels a box that still exists and shows only the id of a removed one", async () => {
    const { app, browser } = await start();
    const [office, spare] = await app.run(
      Effect.gen(function* () {
        const registry = yield* BoxRegistry;
        const office = yield* registry.add({ label: "Office", environment: "production", credentials: passwordCredentials("alice") });
        const spare = yield* registry.add({ label: "Spare", environment: "production", credentials: passwordCredentials("bob") });
        yield* registry.remove(spare.id);
        return [office, spare] as const;
      }),
    );
    await recordAt(app, [
      { at: 1_000, event: toolCall(0, { boxId: office.id }) },
      { at: 2_000, event: toolCall(1, { boxId: spare.id }) },
    ]);
    const html = (await browser.get(AUDIT_PATH)).html;
    expect(html).toContain(`<td>Office<br><a href="${AUDIT_PATH}?box=${office.id}"><code>${office.id}</code></a></td>`);
    expect(html).toContain(`<td><a href="${AUDIT_PATH}?box=${spare.id}"><code>${spare.id}</code></a></td>`);
    expect(html).not.toContain("Spare");
  });

  it("marks each outcome distinctly", async () => {
    const { app, browser } = await start();
    await recordAt(app, [
      { at: 1_000, event: toolCall(0, { outcome: "ok" }) },
      { at: 2_000, event: toolCall(1, { outcome: "error" }) },
      { at: 3_000, event: toolCall(2, { outcome: "refused" }) },
      { at: 4_000, event: toolCall(3, { outcome: "uncertain" }) },
    ]);
    await app.run(Effect.flatMap(AuditLog, (audit) => audit.start({ actor: { kind: "system" }, action: "sync" })));
    const html = (await browser.get(AUDIT_PATH)).html;
    for (const cell of [
      "<strong>✓ ok</strong>",
      '<strong class="danger">✗ error</strong>',
      '<strong class="danger">⊘ refused</strong>',
      '<strong class="danger">? uncertain</strong>',
      '<strong class="muted">… started</strong>',
    ]) {
      expect(html).toContain(cell);
    }
  });

  it("shows an error message instead of failing when the log cannot be read", async () => {
    const { app, browser } = await start();
    await app.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP TABLE audit_log`));
    const page = await browser.get(`${AUDIT_PATH}?grant=grant-a`);
    expect(page.status).toBe(500);
    expect(flashOf(page.html)?.kind).toBe("error");
    expect(flashOf(page.html)?.text).toMatch(/^datova-schranka: failed to /);
    expect(page.html).toContain('<input name="grant" value="grant-a">');
    expect(page.html).toContain("No audit entries.");
  });

  it("serves nothing before sign-in", async () => {
    app = await startAdmin(Effect.map(auditTab, (tab) => [tab]));
    await recordAt(app, [{ at: 1_000, event: toolCall(0) }]);
    const page = await new AdminBrowser(app).get(AUDIT_PATH);
    expect(page.status).not.toBe(200);
    expect(seqs(page.html)).toEqual([]);
  });
});
