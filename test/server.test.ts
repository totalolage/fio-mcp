import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { PERMISSION_DENIED } from "../src/errors.js";
import {
  IMPORT_OK_XML,
  IMPORT_PERMISSION_XML,
  PAY_TOKEN,
  payAccount,
  READ_TOKEN,
  readAccount,
  STATEMENT_JSON,
  type TestAccount,
  testConfig,
} from "./fixtures.js";
import type { FioHttpHandler, FioHttpReply } from "./support/fio-http.js";
import { connect as connectHarness, type Harness, text } from "./support/mcp.js";

const ALL_TOOLS = [
  "export_transactions",
  "get_cache_status",
  "get_last_statement",
  "get_new_transactions",
  "get_server_status",
  "get_statement",
  "get_transactions",
  "preview_payment_orders",
  "search_transactions",
  "set_download_marker",
  "submit_payment_orders",
  "summarize_transactions",
  "sync_transactions",
];

const ok = (body: string): FioHttpReply => ({ status: 200, body });
const status = (code: number, body = ""): FioHttpReply => ({ status: code, body, contentType: "text/html" });

const open: Array<Harness> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

async function connect(
  accounts: ReadonlyArray<TestAccount>,
  route: FioHttpHandler | FioHttpReply = ok(STATEMENT_JSON),
  overrides: Parameters<typeof testConfig>[1] = {},
) {
  const harness = await connectHarness(testConfig(accounts, overrides), route);
  open.push(harness);
  const fetched = async () => (await harness.requests()).length;
  return { ...harness, fetched };
}

// biome-ignore lint/suspicious/noExplicitAny: test helper over parsed JSON
function data(result: CallToolResult): any {
  expect(result.isError, text(result)).toBeFalsy();
  return JSON.parse(text(result));
}

const domesticOrder = {
  type: "domestic",
  amount: 100,
  accountTo: "2212-2000000699",
  bankCode: "0300",
  date: "2025-11-03",
  comment: "Rent & <utilities>",
};

describe("tool set", () => {
  it("exposes every tool, including payments, with one account", async () => {
    const { names, tools } = await connect([readAccount()]);
    expect(await names()).toEqual(ALL_TOOLS);
    const byName = Object.fromEntries((await tools()).map((t) => [t.name, t]));
    expect(byName.get_transactions?.inputSchema.properties).not.toHaveProperty("account");
    expect(byName.get_transactions?.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.get_new_transactions?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get_new_transactions?.description).toMatch(/marker/);
    expect(byName.submit_payment_orders?.annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    });
    expect(byName.submit_payment_orders?.description).toMatch(/NOT executed/);
    expect(byName.submit_payment_orders?.inputSchema.required).toContain("confirm");
    expect(byName.preview_payment_orders?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("offers every account on every tool when several are configured", async () => {
    const { names, tools } = await connect([readAccount("personal"), payAccount("business")]);
    expect(await names()).toEqual(ALL_TOOLS);
    for (const tool of await tools()) {
      if (tool.name === "get_server_status") continue;
      if (tool.name === "get_cache_status") continue;
      expect(tool.inputSchema.properties?.account, tool.name).toMatchObject({ enum: ["personal", "business"] });
      expect(tool.inputSchema.required, tool.name).toContain("account");
    }
  });

  it("keeps printable account names with spaces in the in-memory tool schema enum", async () => {
    const { tools } = await connect([readAccount("Business Credit"), payAccount("Účet Běžný")]);
    for (const tool of await tools()) {
      if (tool.name === "get_server_status") continue;
      if (tool.name === "get_cache_status") continue;
      expect(tool.inputSchema.properties?.account, tool.name).toMatchObject({ enum: ["Business Credit", "Účet Běžný"] });
    }
  });

  it("rejects an account argument on a single-account server", async () => {
    const { call, fetched } = await connect([readAccount()]);
    const result = await call("get_last_statement", { account: "other" });
    expect(result.isError).toBe(true);
    expect(await fetched()).toBe(0);
  });

  it("reports status without exposing tokens", async () => {
    const { call } = await connect([readAccount("personal"), payAccount("business")]);
    const result = await call("get_server_status");
    expect(text(result)).not.toContain(READ_TOKEN);
    expect(text(result)).not.toContain(PAY_TOKEN);
    expect(data(result).accounts).toEqual([
      expect.objectContaining({ name: "personal", accountNumber: null }),
      expect.objectContaining({
        name: "business",
        accountNumber: "2400222222",
        currency: "CZK",
        rateLimit: expect.objectContaining({ intervalSeconds: 0, last409At: null }),
      }),
    ]);
  });
});

describe("cache and FIO over one MCP session", () => {
  it("lists all tools, fetches from FIO, then answers a search from the cache without FIO", async () => {
    const { call, names, requests } = await connect([readAccount()], ok(STATEMENT_JSON), {
      cache: {
        enabled: true,
        dbPath: ":memory:",
        syncOnStartup: false,
        syncIntervalMinutes: 0,
        backfillFrom: "2000-01-01",
        overlapDays: 10,
        maxAgeMinutes: 60,
      },
    });
    expect(await names()).toEqual(ALL_TOOLS);
    const live = data(
      await call("get_transactions", { dateFrom: "2012-06-26", dateTo: "2012-06-30", source: "fio" }),
    );
    expect(live).toMatchObject({ source: "fio", transactionCount: 2 });
    expect(await requests()).toHaveLength(1);
    const found = data(await call("search_transactions", { counterparty: "Novák" }));
    expect(found).toMatchObject({ source: "cache", total: 1 });
    expect(found.transactions[0]).toMatchObject({ id: 1148734530, counterpartyName: "Pavel, Novák" });
    expect(found.freshness).toMatchObject({ coveredFrom: "2012-06-26", coveredTo: "2012-06-30" });
    // The cache answered: still one FIO request.
    expect(await requests()).toHaveLength(1);
  });
});

describe("read tools", () => {
  it("fetches and normalises transactions for a period", async () => {
    const { call, requests } = await connect([readAccount()]);
    const result = data(await call("get_transactions", { dateFrom: "2012-06-26", dateTo: "2012-06-30" }));
    expect((await requests())[0]).toMatchObject({
      method: "GET",
      path: "/periods/<token>/2012-06-26/2012-06-30/transactions.json",
    });
    expect(result.account).toBe("personal");
    expect(result.transactions[0]).toMatchObject({ id: 1148734530, amount: 1, counterpartyName: "Pavel, Novák" });
  });

  it("routes the other read tools to the documented endpoints", async () => {
    const { call, requests } = await connect([readAccount()], ({ path }) => {
      if (path.includes("lastStatement")) return ok("2025,9");
      if (path.includes("set-last")) return ok("");
      return ok(STATEMENT_JSON);
    });
    data(await call("get_statement", { year: 2025, number: 3 }));
    expect(data(await call("get_new_transactions"))).toMatchObject({ markerAdvanced: true });
    data(await call("set_download_marker", { movementId: 1147608196 }));
    data(await call("set_download_marker", { date: "2023-07-27" }));
    expect(data(await call("get_last_statement"))).toMatchObject({ year: 2025, number: 9 });
    expect(
      data(await call("export_transactions", { source: "statement", format: "sta", year: 2025, number: 3 })),
    ).toMatchObject({ format: "sta" });
    expect((await requests()).map((r) => r.path)).toEqual([
      "/by-id/<token>/2025/3/transactions.json",
      "/last/<token>/transactions.json",
      "/set-last-id/<token>/1147608196/",
      "/set-last-date/<token>/2023-07-27/",
      "/lastStatement/<token>/statement",
      "/by-id/<token>/2025/3/transactions.sta",
    ]);
  });

  it("rejects inconsistent arguments before calling FIO", async () => {
    const { call, fetched } = await connect([readAccount()]);
    expect((await call("set_download_marker", {})).isError).toBe(true);
    expect((await call("set_download_marker", { movementId: 1, date: "2024-01-01" })).isError).toBe(true);
    expect(
      (
        await call("export_transactions", {
          source: "period",
          format: "sta",
          dateFrom: "2024-01-01",
          dateTo: "2024-01-02",
        })
      ).isError,
    ).toBe(true);
    expect((await call("get_transactions", { dateFrom: "2024-02-01", dateTo: "2024-01-01" })).isError).toBe(true);
    expect(await fetched()).toBe(0);
  });

  it("fails fast with a retry-after hint when the token is rate limited", async () => {
    const { call, fetched } = await connect([readAccount()], ok("2025,9"), {
      rateLimitIntervalMs: 30_000,
      maxWaitMs: 5_000,
    });
    data(await call("get_last_statement"));
    const second = await call("get_last_statement");
    expect(second.isError).toBe(true);
    expect(text(second)).toMatch(/Retry after (29|30) s/);
    expect(await fetched()).toBe(1);
  });

  it("redacts tokens echoed in successful responses", async () => {
    const { call } = await connect([readAccount()], ok(`id;note\n1;${READ_TOKEN}`));
    const result = await call("export_transactions", {
      source: "period",
      format: "csv",
      dateFrom: "2024-01-01",
      dateTo: "2024-01-02",
    });
    expect(text(result)).not.toContain(READ_TOKEN);
    expect(text(result)).toContain("1;***");
  });

  it("explains documented HTTP errors", async () => {
    const { call } = await connect([readAccount()], status(422));
    const result = await call("get_transactions", { dateFrom: "2020-01-01", dateTo: "2020-01-31" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/older than 90 days/);
    expect(text(result)).toMatch(/Nastavení → API/);
    expect(text(result)).not.toContain(PERMISSION_DENIED);
  });

  it("keeps FIO's meaning for HTTP 500 on reads", async () => {
    const { call } = await connect([readAccount()], status(500));
    const result = await call("get_transactions", { dateFrom: "2024-01-01", dateTo: "2024-01-31" });
    expect(text(result)).toMatch(/token does not exist or is inactive/);
    expect(text(result)).not.toContain(PERMISSION_DENIED);
  });
});

describe("token redaction at the MCP boundary", () => {
  it("does not echo token-like arguments in input validation errors", async () => {
    const { call, fetched } = await connect([readAccount()]);
    const result = await call("get_last_statement", { [READ_TOKEN]: READ_TOKEN });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain(READ_TOKEN.slice(0, 20));
    expect(await fetched()).toBe(0);
  });

  it("redacts tokens that cross the error excerpt boundary", async () => {
    const body = `${"x".repeat(280)}${READ_TOKEN} tail`;
    const { call } = await connect([readAccount()], status(404, body));
    const result = await call("get_last_statement");
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain(READ_TOKEN.slice(0, 20));
    expect(text(result)).toContain("x***");
  });
});

describe("permission denied", () => {
  const args = { dateFrom: "2024-01-01", dateTo: "2024-01-31" };

  it("answers 401/403 with the permission message, without leaking the token", async () => {
    for (const code of [401, 403]) {
      const { call, names } = await connect([readAccount()], status(code, `denied ${READ_TOKEN}`));
      const result = await call("get_transactions", args);
      expect(result.isError).toBe(true);
      expect(text(result).split("\n")[0]).toBe("You don't have permissions to do that.");
      expect(text(result)).toContain(`HTTP ${code}`);
      expect(text(result)).not.toContain(READ_TOKEN);
      // Nothing is removed: the tools stay listed.
      expect(await names()).toEqual(ALL_TOOLS);
    }
  });

  it("answers a payment upload refused for the token with the permission message", async () => {
    const { call, names } = await connect([payAccount()], ok(IMPORT_PERMISSION_XML));
    const result = await call("submit_payment_orders", { orders: [domesticOrder], confirm: true });
    expect(result.isError).toBe(true);
    expect(text(result).split("\n")[0]).toBe(PERMISSION_DENIED);
    expect(text(result)).toMatch(/Token does not have permission/);
    expect(text(result)).toMatch(/Sledování účtu a zadávání/);
    expect(await names()).toEqual(ALL_TOOLS);
  });

  it("answers HTTP 401/403/500 on a payment upload with the permission message", async () => {
    for (const code of [401, 403, 500]) {
      const { call } = await connect([payAccount()], status(code));
      const result = await call("submit_payment_orders", { orders: [domesticOrder], confirm: true });
      expect(result.isError).toBe(true);
      expect(text(result).split("\n")[0], `HTTP ${code}`).toBe(PERMISSION_DENIED);
      expect(text(result)).toMatch(/Sledování účtu a zadávání/);
      expect(text(result)).not.toMatch(/may or may not have created a batch/);
    }
  });

  it("does not treat an ordinary rejection as a permission problem", async () => {
    const { call } = await connect(
      [payAccount()],
      ok(
        IMPORT_PERMISSION_XML.replace(
          "Token does not have permission to enter payment orders",
          "Payments to this country are not permitted",
        ),
      ),
    );
    const submitted = data(await call("submit_payment_orders", { orders: [domesticOrder], confirm: true }));
    expect(submitted.result.outcome).toBe("rejected");
  });
});

describe("payment tools", () => {
  it("previews the batch without contacting FIO", async () => {
    const { call, fetched } = await connect([payAccount()]);
    const preview = data(await call("preview_payment_orders", { orders: [domesticOrder] }));
    expect(await fetched()).toBe(0);
    expect(preview).toMatchObject({
      dryRun: true,
      payerAccount: "2400222222",
      orderCount: 1,
      totalsByCurrency: { CZK: 100 },
    });
    expect(preview.xml).toContain("<comment>Rent &amp; &lt;utilities&gt;</comment>");
  });

  it("uploads exactly the previewed XML as a multipart import and parses the result", async () => {
    const { call, requests } = await connect([payAccount()], ok(IMPORT_OK_XML));
    // Non-ASCII text, including an astral character (a surrogate pair), must reach FIO byte for byte.
    const order = { ...domesticOrder, messageForRecipient: "Nájem za říjen, Žluťoučký kůň 😀" };
    const preview = data(await call("preview_payment_orders", { orders: [order] }));
    expect(preview.xml).toContain("<messageForRecipient>Nájem za říjen, Žluťoučký kůň 😀</messageForRecipient>");
    const result = await call("submit_payment_orders", { orders: [order], confirm: true });
    const submitted = data(result);
    expect(text(result)).not.toContain(PAY_TOKEN);
    const recorded = await requests();
    expect(recorded).toHaveLength(1);
    const [upload] = recorded;
    expect(upload).toMatchObject({ method: "POST", path: "/import/", tokenInUrl: false, tokenOutsideTokenField: false });
    expect(upload?.fields).toMatchObject({ type: "xml", token: "<token>", lng: "en" });
    expect(upload?.files).toEqual([
      // `text` is the UTF-8 decoding of the uploaded file, so equality means the bytes are preview.xml's UTF-8
      // with nothing replaced by U+FFFD.
      expect.objectContaining({ field: "file", filename: "orders.xml", text: preview.xml }),
    ]);
    expect(submitted.result).toMatchObject({ accepted: true, batchIds: ["105545555"] });
    expect(submitted.nextStep).toMatch(/NOT executed/);
  });

  it("rejects text XML cannot carry before previewing or uploading", async () => {
    const { call, fetched } = await connect([payAccount()], ok(IMPORT_OK_XML));
    for (const comment of ["a\uffffb", "a\ud800b"]) {
      const order = { ...domesticOrder, comment };
      const preview = await call("preview_payment_orders", { orders: [order] });
      expect(preview.isError).toBe(true);
      expect(text(preview)).toMatch(/not valid in XML/);
      expect((await call("submit_payment_orders", { orders: [order], confirm: true })).isError).toBe(true);
    }
    expect(await fetched()).toBe(0);
  });

  it("requires explicit confirmation to submit", async () => {
    const { call, fetched } = await connect([payAccount()]);
    expect((await call("submit_payment_orders", { orders: [domesticOrder] })).isError).toBe(true);
    expect((await call("submit_payment_orders", { orders: [domesticOrder], confirm: false })).isError).toBe(true);
    expect(await fetched()).toBe(0);
  });

  it("learns the payer account number from a statement when not configured", async () => {
    const { call } = await connect([payAccount("business", PAY_TOKEN, null)]);
    const before = await call("preview_payment_orders", { orders: [domesticOrder] });
    expect(before.isError).toBe(true);
    expect(text(before)).toMatch(/account number .* is unknown/);
    data(await call("get_transactions", { dateFrom: "2024-01-01", dateTo: "2024-01-02" }));
    expect(data(await call("preview_payment_orders", { orders: [domesticOrder] })).payerAccount).toBe("2400222222");
  });

  it("warns that the outcome is unknown when an upload fails ambiguously", async () => {
    const ambiguous = IMPORT_OK_XML.replace("<status>ok</status>", "");
    const { call } = await connect([payAccount()], ok(ambiguous));
    const submitted = data(await call("submit_payment_orders", { orders: [domesticOrder], confirm: true }));
    expect(submitted.result.outcome).toBe("unknown");
    expect(submitted.nextStep).toMatch(/105545555.*Check the pending batches/s);

    for (const reply of [status(502), ok("<html>oops</html>"), { transportError: "socket hang up" }]) {
      const { call: callOther } = await connect([payAccount()], reply);
      const result = await callOther("submit_payment_orders", { orders: [domesticOrder], confirm: true });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/may or may not have created a batch/);
    }
  });

  it("reports an ordinary rejected batch as a result, not an error", async () => {
    const rejected = IMPORT_OK_XML.replace("<status>ok</status>", "<status>error</status>").replace(
      "<errorCode>0</errorCode>",
      "<errorCode>1</errorCode>",
    );
    const { call } = await connect([payAccount()], ok(rejected));
    const submitted = data(await call("submit_payment_orders", { orders: [domesticOrder], confirm: true }));
    expect(submitted.result.accepted).toBe(false);
  });
});
