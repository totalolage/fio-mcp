import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import type { FetchFn } from "../src/fio-client.js";
import { clearSecrets } from "../src/redact.js";
import { createFioServer } from "../src/server.js";
import {
  IMPORT_OK_XML,
  IMPORT_PERMISSION_XML,
  PAY_TOKEN,
  READ_TOKEN,
  STATEMENT_JSON,
  baseConfig,
  payAccount,
  readAccount,
} from "./fixtures.js";

const READ_TOOLS = [
  "export_transactions",
  "get_last_statement",
  "get_new_transactions",
  "get_server_capabilities",
  "get_statement",
  "get_transactions",
  "set_download_marker",
];
const PAYMENT_TOOLS = ["preview_payment_orders", "submit_payment_orders"];

interface Call {
  url: string;
  method: string;
  body?: FormData;
}

type Route = (call: Call) => Response | Promise<Response>;

function mockFetch(route: Route) {
  const calls: Call[] = [];
  const fn: FetchFn = async (input, init) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET" };
    if (init?.body instanceof FormData) call.body = init.body;
    calls.push(call);
    return route(call);
  };
  return { fetch: vi.fn(fn), calls };
}

const ok = (body: string) => new Response(body, { status: 200 });
const status = (code: number, body = "") => new Response(body, { status: code });

async function connect(config: ServerConfig, route: Route = () => ok(STATEMENT_JSON)) {
  const mock = mockFetch(route);
  const fio = createFioServer(config, { fetch: mock.fetch });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const listChanged = vi.fn();
  client.setNotificationHandler(ToolListChangedNotificationSchema, listChanged);
  await Promise.all([fio.server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = async () => (await client.listTools()).tools;
  const names = async () => (await tools()).map((t) => t.name).sort();
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, fio, listChanged, tools, names, call, ...mock };
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function data(result: CallToolResult): any {
  expect(result.isError, text(result)).toBeFalsy();
  return JSON.parse(text(result));
}

/** Waits for in-flight notifications to reach the client. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const domesticOrder = {
  type: "domestic",
  amount: 100,
  accountTo: "2212-2000000699",
  bankCode: "0300",
  date: "2025-11-03",
  comment: "Rent & <utilities>",
};

afterEach(() => clearSecrets());

describe("tool set per permission configuration", () => {
  it("read-only token exposes read tools and no payment tools", async () => {
    const { names, tools } = await connect(baseConfig([readAccount()]));
    expect(await names()).toEqual(READ_TOOLS);
    const getTransactions = (await tools()).find((t) => t.name === "get_transactions");
    expect(getTransactions?.inputSchema.properties).not.toHaveProperty("account");
    expect(getTransactions?.annotations).toMatchObject({ readOnlyHint: true });
    const newTx = (await tools()).find((t) => t.name === "get_new_transactions");
    expect(newTx?.annotations?.readOnlyHint).toBe(false);
    expect(newTx?.description).toMatch(/marker/);
  });

  it("payments token adds payment tools with safety annotations", async () => {
    const { names, tools } = await connect(baseConfig([payAccount()]));
    expect(await names()).toEqual([...READ_TOOLS, ...PAYMENT_TOOLS].sort());
    const submit = (await tools()).find((t) => t.name === "submit_payment_orders");
    expect(submit?.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true, readOnlyHint: false });
    expect(submit?.description).toMatch(/NOT executed/);
    expect(submit?.inputSchema.required).toContain("confirm");
    const preview = (await tools()).find((t) => t.name === "preview_payment_orders");
    expect(preview?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("restricts the account enum to accounts holding the capability", async () => {
    const { tools } = await connect(baseConfig([readAccount("personal"), payAccount("business")]));
    const byName = Object.fromEntries((await tools()).map((t) => [t.name, t]));
    expect(byName.get_transactions?.inputSchema.properties?.account).toMatchObject({ enum: ["personal", "business"] });
    expect(byName.get_transactions?.inputSchema.required).toContain("account");
    // Only "business" can pay, so the payment tools need no account parameter.
    expect(byName.submit_payment_orders?.inputSchema.properties).not.toHaveProperty("account");
    expect(byName.preview_payment_orders?.inputSchema.properties).not.toHaveProperty("account");
  });

  it("offers an account enum on payment tools when several accounts can pay", async () => {
    const { tools } = await connect(
      baseConfig([readAccount("personal"), payAccount("business"), payAccount("shop", `${PAY_TOKEN}x`)]),
    );
    const submit = (await tools()).find((t) => t.name === "submit_payment_orders");
    expect(submit?.inputSchema.properties?.account).toMatchObject({ enum: ["business", "shop"] });
  });

  it("reports capabilities without exposing tokens", async () => {
    const { call } = await connect(baseConfig([readAccount("personal"), payAccount("business")]));
    const result = await call("get_server_capabilities");
    expect(text(result)).not.toContain(READ_TOKEN);
    expect(text(result)).not.toContain(PAY_TOKEN);
    const caps = data(result);
    expect(caps.accounts).toEqual([
      expect.objectContaining({ name: "personal", declaredPermissions: ["read"], effectivePermissions: ["read"] }),
      expect.objectContaining({
        name: "business",
        effectivePermissions: ["read", "payments"],
        accountNumber: "2400222222",
        rateLimit: expect.objectContaining({ intervalSeconds: 0 }),
      }),
    ]);
    expect(caps.tools).toContain("submit_payment_orders");
  });
});

describe("read tools", () => {
  it("fetches and normalises transactions for a period", async () => {
    const { call, calls } = await connect(baseConfig([readAccount()]));
    const result = data(await call("get_transactions", { dateFrom: "2012-06-26", dateTo: "2012-06-30" }));
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: `https://fioapi.test/v1/rest/periods/${READ_TOKEN}/2012-06-26/2012-06-30/transactions.json`,
    });
    expect(result.account).toBe("personal");
    expect(result.transactions[0]).toMatchObject({ id: 1148734530, amount: 1, counterpartyName: "Pavel, Novák" });
  });

  it("routes the other read tools to the documented endpoints", async () => {
    const { call, calls } = await connect(baseConfig([readAccount()]), ({ url }) =>
      ok(url.includes("lastStatement") ? "2025,9" : url.includes("set-last") ? "" : STATEMENT_JSON),
    );
    data(await call("get_statement", { year: 2025, number: 3 }));
    expect(data(await call("get_new_transactions"))).toMatchObject({ markerAdvanced: true });
    data(await call("set_download_marker", { movementId: 1147608196 }));
    data(await call("set_download_marker", { date: "2023-07-27" }));
    expect(data(await call("get_last_statement"))).toMatchObject({ year: 2025, number: 9 });
    expect(data(await call("export_transactions", { source: "statement", format: "sta", year: 2025, number: 3 }))).toMatchObject({
      format: "sta",
    });
    const base = `https://fioapi.test/v1/rest`;
    expect(calls.map((c) => c.url)).toEqual([
      `${base}/by-id/${READ_TOKEN}/2025/3/transactions.json`,
      `${base}/last/${READ_TOKEN}/transactions.json`,
      `${base}/set-last-id/${READ_TOKEN}/1147608196/`,
      `${base}/set-last-date/${READ_TOKEN}/2023-07-27/`,
      `${base}/lastStatement/${READ_TOKEN}/statement`,
      `${base}/by-id/${READ_TOKEN}/2025/3/transactions.sta`,
    ]);
  });

  it("rejects inconsistent arguments before calling FIO", async () => {
    const { call, fetch } = await connect(baseConfig([readAccount()]));
    expect((await call("set_download_marker", {})).isError).toBe(true);
    expect((await call("set_download_marker", { movementId: 1, date: "2024-01-01" })).isError).toBe(true);
    expect((await call("export_transactions", { source: "period", format: "sta", dateFrom: "2024-01-01", dateTo: "2024-01-02" })).isError).toBe(
      true,
    );
    expect((await call("get_transactions", { dateFrom: "2024-02-01", dateTo: "2024-01-01" })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails fast with a retry-after hint when the token is rate limited", async () => {
    const config = { ...baseConfig([readAccount()]), rateLimitIntervalMs: 30_000, maxWaitMs: 5_000 };
    const { call, fetch } = await connect(config);
    data(await call("get_last_statement"));
    const second = await call("get_last_statement");
    expect(second.isError).toBe(true);
    expect(text(second)).toMatch(/Retry after (29|30) s/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("redacts tokens echoed in successful responses", async () => {
    const { call } = await connect(baseConfig([readAccount()]), () => ok(`id;note\n1;${READ_TOKEN}`));
    const result = await call("export_transactions", { source: "period", format: "csv", dateFrom: "2024-01-01", dateTo: "2024-01-02" });
    expect(text(result)).not.toContain(READ_TOKEN);
    expect(text(result)).toContain("1;***");
  });

  it("explains documented HTTP errors without revoking anything", async () => {
    const { call, names } = await connect(baseConfig([readAccount()]), () => status(422));
    const result = await call("get_transactions", { dateFrom: "2020-01-01", dateTo: "2020-01-31" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/older than 90 days/);
    expect(await names()).toEqual(READ_TOOLS);
  });
});

describe("runtime downgrade", () => {
  it("removes every tool of a token FIO rejects with 401/403 and notifies the client", async () => {
    const { call, names, listChanged } = await connect(baseConfig([readAccount()]), () =>
      status(403, `denied ${READ_TOKEN}`),
    );
    await flush();
    listChanged.mockClear();
    const result = await call("get_transactions", { dateFrom: "2024-01-01", dateTo: "2024-01-31" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/lost: read/);
    expect(text(result)).toMatch(/no longer available: .*get_transactions/);
    expect(text(result)).not.toContain(READ_TOKEN);
    await flush();
    expect(listChanged).toHaveBeenCalled();
    expect(await names()).toEqual(["get_server_capabilities"]);
  });

  it("needs two consecutive HTTP 500s before treating a token as dead", async () => {
    let responses = [status(500), ok(STATEMENT_JSON), status(500), status(500)];
    const { call, names } = await connect(baseConfig([readAccount()]), () => responses.shift() ?? ok(""));
    const args = { dateFrom: "2024-01-01", dateTo: "2024-01-31" };

    const first = await call("get_transactions", args);
    expect(first.isError).toBe(true);
    expect(text(first)).toMatch(/If the next request fails the same way/);
    expect(await names()).toEqual(READ_TOOLS);

    data(await call("get_transactions", args)); // success resets the count
    expect((await call("get_transactions", args)).isError).toBe(true);
    expect(await names()).toEqual(READ_TOOLS);

    const fourth = await call("get_transactions", args);
    expect(text(fourth)).toMatch(/lost: read, payments|lost: read/);
    expect(await names()).toEqual(["get_server_capabilities"]);
    responses = [];
  });

  it("does not count 500s separated by another HTTP answer as consecutive", async () => {
    // 404, and a 409 that fails fast because its retry would exceed the wait budget.
    for (const middle of [404, 409]) {
      const responses = [status(500), status(middle), status(500)];
      const config = { ...baseConfig([readAccount()]), rateLimitIntervalMs: 50, maxWaitMs: 20 };
      const { call, names } = await connect(config, () => responses.shift() ?? ok(STATEMENT_JSON));
      const args = { dateFrom: "2024-01-01", dateTo: "2024-01-31" };
      for (let i = 0; i < 3; i++) {
        const result = await call("get_transactions", args);
        expect(result.isError).toBe(true);
        if (i === 1 && middle === 409) expect(text(result)).toMatch(/409/);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      expect(await names(), `500, ${middle}, 500`).toEqual(READ_TOOLS);
    }
  });

  it("shrinks the account enum when one of several accounts is lost", async () => {
    const config = baseConfig([readAccount("personal"), readAccount("savings", `${READ_TOKEN}2`)]);
    const { call, tools, listChanged } = await connect(config, ({ url }) =>
      url.includes(`${READ_TOKEN}2/`) ? ok(STATEMENT_JSON) : status(401),
    );
    await flush();
    listChanged.mockClear();
    const args = { dateFrom: "2024-01-01", dateTo: "2024-01-31" };
    expect((await call("get_transactions", { ...args, account: "personal" })).isError).toBe(true);
    await flush();
    expect(listChanged).toHaveBeenCalled();
    const getTransactions = (await tools()).find((t) => t.name === "get_transactions");
    expect(getTransactions?.inputSchema.properties).not.toHaveProperty("account");
    // A stale client naming the lost account is refused rather than silently redirected.
    expect((await call("get_transactions", { ...args, account: "personal" })).isError).toBe(true);
    expect(data(await call("get_transactions", args)).account).toBe("savings");
  });

  it("removes payment tools when FIO refuses an import for lack of permission", async () => {
    const { call, names, listChanged } = await connect(baseConfig([readAccount("personal"), payAccount("business")]), ({ url }) =>
      url.endsWith("/import/") ? ok(IMPORT_PERMISSION_XML) : ok(STATEMENT_JSON),
    );
    await flush();
    listChanged.mockClear();
    const result = await call("submit_payment_orders", { orders: [domesticOrder], confirm: true });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/permission/);
    expect(text(result)).toMatch(/no longer available: .*submit_payment_orders/);
    await flush();
    expect(listChanged).toHaveBeenCalled();
    expect(await names()).toEqual(READ_TOOLS);
    const caps = data(await call("get_server_capabilities"));
    expect(caps.accounts[1]).toMatchObject({ effectivePermissions: ["read"], lostPermissions: [expect.objectContaining({ capability: "payments" })] });
  });
});

describe("payment tools", () => {
  it("previews the batch without contacting FIO", async () => {
    const { call, fetch } = await connect(baseConfig([payAccount()]));
    const preview = data(await call("preview_payment_orders", { orders: [domesticOrder] }));
    expect(fetch).not.toHaveBeenCalled();
    expect(preview).toMatchObject({ dryRun: true, payerAccount: "2400222222", orderCount: 1, totalsByCurrency: { CZK: 100 } });
    expect(preview.xml).toContain("<comment>Rent &amp; &lt;utilities&gt;</comment>");
  });

  it("uploads exactly the previewed XML as a multipart import and parses the result", async () => {
    const { call, calls } = await connect(baseConfig([payAccount()]), () => ok(IMPORT_OK_XML));
    const preview = data(await call("preview_payment_orders", { orders: [domesticOrder] }));
    const result = await call("submit_payment_orders", { orders: [domesticOrder], confirm: true });
    const submitted = data(result);
    expect(text(result)).not.toContain(PAY_TOKEN);
    expect(calls).toHaveLength(1);
    const [upload] = calls;
    expect(upload).toMatchObject({ method: "POST", url: "https://fioapi.test/v1/rest/import/" });
    expect(upload?.body?.get("type")).toBe("xml");
    expect(upload?.body?.get("token")).toBe(PAY_TOKEN);
    const file = upload?.body?.get("file") as File;
    expect(file.name).toBe("orders.xml");
    expect(await file.text()).toBe(preview.xml);
    expect(submitted.result).toMatchObject({ accepted: true, batchIds: ["105545555"] });
    expect(submitted.nextStep).toMatch(/NOT executed/);
  });

  it("requires explicit confirmation to submit", async () => {
    const { call, fetch } = await connect(baseConfig([payAccount()]));
    expect((await call("submit_payment_orders", { orders: [domesticOrder] })).isError).toBe(true);
    expect((await call("submit_payment_orders", { orders: [domesticOrder], confirm: false })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("learns the payer account number from a statement when not configured", async () => {
    const { call } = await connect(baseConfig([payAccount("business", PAY_TOKEN, null)]));
    const before = await call("preview_payment_orders", { orders: [domesticOrder] });
    expect(before.isError).toBe(true);
    expect(text(before)).toMatch(/account number .* is unknown/);
    data(await call("get_transactions", { dateFrom: "2024-01-01", dateTo: "2024-01-02" }));
    expect(data(await call("preview_payment_orders", { orders: [domesticOrder] })).payerAccount).toBe("2400222222");
  });

  it("warns that the outcome is unknown when an upload fails ambiguously", async () => {
    const ambiguous = IMPORT_OK_XML.replace("<status>ok</status>", "");
    const { call } = await connect(baseConfig([payAccount()]), () => ok(ambiguous));
    const submitted = data(await call("submit_payment_orders", { orders: [domesticOrder], confirm: true }));
    expect(submitted.result.outcome).toBe("unknown");
    expect(submitted.nextStep).toMatch(/105545555.*Check the pending batches/s);

    for (const route of [() => status(502), () => ok("<html>oops</html>"), (): Response => { throw new TypeError("socket hang up"); }]) {
      const { call: callOther, names } = await connect(baseConfig([payAccount()]), route);
      const result = await callOther("submit_payment_orders", { orders: [domesticOrder], confirm: true });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/may or may not have created a batch/);
      expect(await names()).toContain("submit_payment_orders");
    }
  });

  it("does not revoke payments on an ordinary rejected batch", async () => {
    const rejected = IMPORT_OK_XML.replace("<status>ok</status>", "<status>error</status>").replace(
      "<errorCode>0</errorCode>",
      "<errorCode>1</errorCode>",
    );
    const { call, names } = await connect(baseConfig([payAccount()]), () => ok(rejected));
    const submitted = data(await call("submit_payment_orders", { orders: [domesticOrder], confirm: true }));
    expect(submitted.result.accepted).toBe(false);
    expect(await names()).toContain("submit_payment_orders");
  });
});
