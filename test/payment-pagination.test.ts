import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatAuditCursor, parseAuditCursor } from "../src/payment-ledger.js";
import { NOW } from "./support/cache.js";
import { type InProcessHarness, PASSWORD, PUBLIC_URL, startOAuth } from "./support/oauth.js";

const ADMIN_COOKIE = "__Secure-fio-mcp-admin";
/** AUDIT_PAGE_ROWS in src/admin/server.ts. */
const PAGE_ROWS = 100;

let harness: InProcessHarness;

beforeEach(async () => {
  harness = await startOAuth();
});

afterEach(async () => {
  await harness.close();
});

/** A signed-in /admin browser that only GETs (see the full one in admin.test.ts). */
const signedIn = async () => {
  let cookie = "";
  const absorb = (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      if (pair.startsWith(`${ADMIN_COOKIE}=`)) cookie = pair;
    }
    return response;
  };
  const get = async (path: string) => absorb(await harness.fetch(new URL(path, PUBLIC_URL), { headers: cookie === "" ? {} : { cookie } }));
  const login = await (await get("/admin/login")).text();
  const csrf = /name="csrf" value="([^"]*)"/.exec(login)?.[1] ?? "";
  const signIn = absorb(
    await harness.fetch(new URL("/admin/login", PUBLIC_URL), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC_URL, cookie },
      body: new URLSearchParams({ password: PASSWORD, csrf }),
    }),
  );
  expect(signIn.status).toBe(303);
  return async (path: string) => {
    const response = await get(path);
    return { status: response.status, html: await response.text() };
  };
};

interface Seeded {
  readonly id: string;
  readonly createdAt: number;
  readonly grantId: string;
}

/** Inserts audit rows straight into the table; ids are random, so ties sort by an id unrelated to insertion order. */
const seed = (times: ReadonlyArray<number>) => {
  const rows: Array<Seeded> = times.map((createdAt, index) => ({
    id: `pay_${randomBytes(12).toString("hex")}`,
    createdAt,
    grantId: `fio_grant_seed_${String(index).padStart(3, "0")}`,
  }));
  return harness
    .sql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO payment_audit ${sql.insert(
          rows.map((row) => ({
            id: row.id,
            created_at: row.createdAt,
            updated_at: row.createdAt,
            prague_day: "2026-10-22",
            grant_id: row.grantId,
            order_count: 1,
            totals_json: JSON.stringify({ CZK: 100 }),
            payees_json: "[]",
            outcome: "refused",
          })),
        )}`;
      }),
    )
    .then(() =>
      // The listing order: created_at DESC, id DESC (SQLite compares TEXT bytewise, as does `<` on these ASCII ids).
      [...rows].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)),
    );
};

/** The seeded grants of a page's table rows, in page order. */
const grantsOf = (html: string) =>
  html
    .split("<tr>")
    .slice(1)
    .flatMap((row) => /fio_grant_seed_\d{3}/.exec(row)?.[0] ?? []);

const olderLinkOf = (html: string) =>
  /<a href="([^"]*)">Older submissions<\/a>/.exec(html)?.[1]?.replaceAll("&amp;", "&");

describe("audit cursor", () => {
  it("round-trips and rejects anything else", () => {
    const cursor = { createdAt: NOW, id: "pay_0123456789abcdef01234567" };
    expect(parseAuditCursor(formatAuditCursor(cursor))).toEqual(cursor);
    for (const bad of [
      "",
      String(NOW),
      `${NOW}_`,
      `_pay_00`,
      `${NOW}_pay_XYZ`,
      `${NOW}_pay_00' OR 1=1 --`,
      `1234567890123456_pay_00`,
      `${NOW}.5_pay_00`,
      `-1_pay_00`,
    ]) {
      expect(parseAuditCursor(bad), bad).toBeUndefined();
    }
  });
});

describe("/admin/payments paging", () => {
  it("lists every row exactly once in order when a page ends inside a run of equal timestamps", async () => {
    const get = await signedIn();
    const tied = NOW - 200_000;
    // 90 distinct newer rows, 30 rows sharing one millisecond across the 100-row boundary, 40 older rows.
    const times = [
      ...Array.from({ length: 90 }, (_, i) => NOW - i * 1_000),
      ...Array.from({ length: 30 }, () => tied),
      ...Array.from({ length: 40 }, (_, i) => tied - (i + 1) * 1_000),
    ];
    const expected = (await seed(times)).map((row) => row.grantId);

    const seen: Array<string> = [];
    let path: string | undefined = "/admin/payments";
    let pages = 0;
    while (path !== undefined) {
      const page = await get(path);
      expect(page.status).toBe(200);
      seen.push(...grantsOf(page.html));
      path = olderLinkOf(page.html);
      pages += 1;
      expect(pages).toBeLessThanOrEqual(3);
    }
    expect(seen).toHaveLength(times.length);
    expect(new Set(seen).size).toBe(times.length);
    expect(seen).toEqual(expected);
  });

  it("puts the tie-breaking id in the next link", async () => {
    const get = await signedIn();
    const rows = await seed(Array.from({ length: PAGE_ROWS + 1 }, () => NOW));
    const first = await get("/admin/payments");
    const last = rows[PAGE_ROWS - 1];
    expect(olderLinkOf(first.html)).toBe(`/admin/payments?before=${NOW}_${last?.id}`);
    const second = await get(olderLinkOf(first.html) ?? "");
    expect(grantsOf(second.html)).toEqual([rows[PAGE_ROWS]?.grantId]);
    expect(olderLinkOf(second.html)).toBeUndefined();
  });

  it("shows the first page for a malformed cursor", async () => {
    const get = await signedIn();
    const rows = await seed([NOW, NOW - 1_000, NOW - 2_000]);
    const firstPage = rows.map((row) => row.grantId);
    for (const before of ["abc", String(NOW), `${NOW}_pay_00' OR 1=1 --`, "99999999999999999999_pay_00", `${NOW}_`]) {
      const page = await get(`/admin/payments?${new URLSearchParams({ before })}`);
      expect(page.status, before).toBe(200);
      expect(grantsOf(page.html), before).toEqual(firstPage);
    }
  });
});
