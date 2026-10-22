import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import type { FetchFn } from "../src/fio-client.js";
import { PERMISSION_DENIED } from "../src/errors.js";
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

const ALL_TOOLS = [
  "export_transactions",
  "get_last_statement",
  "get_new_transactions",
  "get_server_status",
  "get_statement",
  "get_transactions",
  "preview_payment_orders",
  "set_download_marker",
  "submit_payment_orders",
];

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
  await Promise.all([fio.connect(serverTransport), client.connect(clientTransport)]);
  const tools = async () => (await client.listTools()).tools;
  const names = async () => (await tools()).map((t) => t.name).sort();
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, fio, tools, names, call, ...mock };
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

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

afterEach(() => clearSecrets());

describe("tool set", () => {
  it("exposes every tool, including payments, with one account", async () => {
    const { names, tools } = await connect(baseConfig([readAccount()]));
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
    const { names, tools } = await connect(baseConfig([readAccount("personal"), payAccount("business")]));
    expect(await names()).toEqual(ALL_TOOLS);
    for (const tool of await tools()) {
      if (tool.name === "get_server_status") continue;
      expect(tool.inputSchema.properties?.account, tool.name).toMatchObject({ enum: ["personal", "business"] });
      expect(tool.inputSchema.required, tool.name).toContain("account");
    }
  });

  it("rejects an account argument on a single-account server", async () => {
    const { call, fetch } = await connect(baseConfig([readAccount()]));
    const result = await call("get_last_statement", { account: "other" });
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports status without exposing tokens", async () => {
    const { call } = await connect(baseConfig([readAccount("personal"), payAccount("business")]));
    const result = await call("get_server_status");
    expect(text(result)).not.toContain(READ_TOKEN);
    expect(text(result)).not.toContain(PAY_TOKEN);
    expect(data(result).accounts).toEqual([
      expect.objectContaining({ name: "personal", accountNumber: null }),
      expect.objectContaining({
        name: "business",
        accountNumber: "2400222222",
        currency: "CZK",
        rateLimit: expect.objectContaining({ intervalSeconds: 0 }),
      }),
    ]);
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

  it("explains documented HTTP errors", async () => {
    const { call } = await connect(baseConfig([readAccount()]), () => status(422));
    const result = await call("get_transactions", { dateFrom: "2020-01-01", dateTo: "2020-01-31" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/older than 90 days/);
    expect(text(result)).not.toContain(PERMISSION_DENIED);
  });

  it("keeps FIO's meaning for HTTP 500 on reads", async () => {
    const { call } = await connect(baseConfig([readAccount()]), () => status(500));
    const result = await call("get_transactions", { dateFrom: "2024-01-01", dateTo: "2024-01-31" });
    expect(text(result)).toMatch(/token does not exist or is inactive/);
    expect(text(result)).not.toContain(PERMISSION_DENIED);
  });
});

describe("token redaction at the MCP boundary", () => {
  it("redacts tokens echoed by the SDK's input validation", async () => {
    const { call, fetch } = await connect(baseConfig([readAccount()]));
    const result = await call("get_last_statement", { [READ_TOKEN]: READ_TOKEN });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain(READ_TOKEN);
    expect(text(result)).not.toContain(READ_TOKEN.slice(0, 20));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("redacts tokens that cross the error excerpt boundary", async () => {
    const body = `${"x".repeat(280)}${READ_TOKEN} tail`;
    const { call } = await connect(baseConfig([readAccount()]), () => status(404, body));
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
      const { call, names } = await connect(baseConfig([readAccount()]), () => status(code, `denied ${READ_TOKEN}`));
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
    const { call, names } = await connect(baseConfig([payAccount()]), () => ok(IMPORT_PERMISSION_XML));
    const result = await call("submit_payment_orders", { orders: [domesticOrder], confirm: true });
    expect(result.isError).toBe(true);
    expect(text(result).split("\n")[0]).toBe(PERMISSION_DENIED);
    expect(text(result)).toMatch(/Token does not have permission/);
    expect(text(result)).toMatch(/Sledování účtu a zadávání/);
    expect(await names()).toEqual(ALL_TOOLS);
  });

  it("answers HTTP 401/403/500 on a payment upload with the permission message", async () => {
    for (const code of [401, 403, 500]) {
      const { call } = await connect(baseConfig([payAccount()]), () => status(code));
      const result = await call("submit_payment_orders", { orders: [domesticOrder], confirm: true });
      expect(result.isError).toBe(true);
      expect(text(result).split("\n")[0], `HTTP ${code}`).toBe(PERMISSION_DENIED);
      expect(text(result)).toMatch(/Sledování účtu a zadávání/);
      expect(text(result)).not.toMatch(/may or may not have created a batch/);
    }
  });

  it("does not treat an ordinary rejection as a permission problem", async () => {
    const { call } = await connect(baseConfig([payAccount()]), () => ok(IMPORT_PERMISSION_XML.replace("Token does not have permission to enter payment orders", "Payments to this country are not permitted")));
    const submitted = data(await call("submit_payment_orders", { orders: [domesticOrder], confirm: true }));
    expect(submitted.result.outcome).toBe("rejected");
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
      const { call: callOther } = await connect(baseConfig([payAccount()]), route);
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
    const { call } = await connect(baseConfig([payAccount()]), () => ok(rejected));
    const submitted = data(await call("submit_payment_orders", { orders: [domesticOrder], confirm: true }));
    expect(submitted.result.accepted).toBe(false);
  });
});
