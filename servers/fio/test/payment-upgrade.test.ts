import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import { sha256Hex } from "../src/payment-controls.js";
import { IMPORT_OK_XML } from "./fixtures.js";
import { text } from "./support/mcp.js";
import { type OAuthHarness, RESOURCE, startOAuth, tokensFor } from "./support/oauth.js";

const order = { type: "domestic", amount: 60_000, accountTo: "2212-2000000699", bankCode: "0300", date: "2026-12-01" };
const heldOrder = { ...order, amount: 1 };
const heldKey = "pre-upgrade-held-batch";

const oldMigrations = Object.fromEntries(
  Object.entries(SERVER_MIGRATIONS).filter(([id]) => id < "0012_"),
);

const connect = async (harness: OAuthHarness, access: string) => {
  const client = new Client({ name: "payment-upgrade", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), {
    requestInit: { headers: { Authorization: `Bearer ${access}` } },
    fetch: harness.fetch,
  }));
  return client;
};

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

const preview = async (client: Client, orders: ReadonlyArray<typeof order>) => {
  const result = await call(client, "preview_payment_orders", { account: "main", orders });
  expect(result.isError, text(result)).toBeFalsy();
  return JSON.parse(text(result)) as { xml: string; orderCount: number };
};

const submit = (client: Client, orders: ReadonlyArray<typeof order>, idempotencyKey: string, account = "main") =>
  call(client, "submit_payment_orders", { account, orders, idempotencyKey, confirm: true });

it("preserves grants and retires legacy held payments without uploading or releasing their keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fio-payment-upgrade-"));
  const dbPath = join(dir, "fio.sqlite");
  const uploads: Array<string> = [];
  const fio = {
    importXml: (_account: unknown, xml: string) => Effect.sync(() => {
      uploads.push(xml);
      return IMPORT_OK_XML;
    }),
  };
  try {
    const old = await startOAuth({ dbPath, migrations: oldMigrations, fio });
    const { payments, readOnly, previousRows } = await (async () => {
      try {
        const payments = await tokensFor(old, { payments: true, accounts: ["main"] });
        const readOnly = await tokensFor(old, { accounts: ["main"] });
        const client = await connect(old, payments.access);
        const { xml } = await preview(client, [heldOrder]).finally(() => client.close());
        const grant = (await old.store((store) => store.listGrants(old.clock.currentTimeMillisUnsafe()))
          ).find((candidate) => candidate.clientId === payments.clientId);
        if (grant === undefined) throw new Error("Expected the legacy grant");

        const previousRows = await old.sql(Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const limits = JSON.stringify({ maxPerOrder: { CZK: 1 }, maxPerDay: { CZK: 1 }, maxOrdersPerDay: 1 });
          const allowlist = JSON.stringify({ mode: "confirm", entries: [{ account: "123/0800" }] });
          yield* sql`
            UPDATE oauth_grants SET payment_limits_json = ${limits}, payee_allowlist_json = ${allowlist}
            WHERE grant_id = ${grant.grantId}
          `;
          const now = old.clock.currentTimeMillisUnsafe();
          const digest = sha256Hex(xml);
          const audit = {
            created_at: now,
            updated_at: now,
            prague_day: "2026-11-18",
            grant_id: grant.grantId,
            client_id: payments.clientId,
            account_id: grant.resources[0] ?? "",
            account_name: "main",
            key_owner: 1,
            xml_sha256: digest,
            order_count: 1,
            totals_json: JSON.stringify({ CZK: 100 }),
            payees_json: "[]",
          };
          yield* sql`INSERT INTO payment_audit ${sql.insert({
            ...audit,
            id: "pay_0001",
            idempotency_key: heldKey,
            outcome: "pending-confirmation",
            response_json: JSON.stringify({ ok: { outcome: "awaiting-admin-confirmation", pendingId: "pend_0001" } }),
          })}`;
          yield* sql`INSERT INTO payment_pending ${sql.insert({
            pending_id: "pend_0001",
            audit_id: "pay_0001",
            grant_id: grant.grantId,
            account_id: audit.account_id,
            account_name: "main",
            xml,
            xml_sha256: digest,
            created_at: now,
            expires_at: now + 86_400_000,
          })}`;
          for (const [index, outcome] of ["accepted", "unknown", "rejected", "refused"].entries()) {
            yield* sql`INSERT INTO payment_audit ${sql.insert({
              ...audit,
              id: `pay_a00${index}`,
              idempotency_key: `pre-upgrade-${outcome}`,
              outcome,
              response_json: JSON.stringify({ ok: { outcome } }),
            })}`;
          }
          return yield* sql`SELECT * FROM payment_audit WHERE id <> 'pay_0001' ORDER BY id`;
        }));
        return { payments, readOnly, previousRows };
      } finally {
        await old.close();
      }
    })();

    const upgraded = await startOAuth({ dbPath, fio });
    try {
      expect(uploads).toEqual([]);
      const rows = await upgraded.sql(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const held = yield* sql`SELECT outcome, reason, key_owner FROM payment_audit WHERE id = 'pay_0001'`;
        const previous = yield* sql`SELECT * FROM payment_audit WHERE id <> 'pay_0001' ORDER BY id`;
        const pendingTable = yield* sql`SELECT name FROM sqlite_schema WHERE name = 'payment_pending'`;
        return { held, previous, pendingTable };
      }));
      expect(rows.held).toEqual([{ outcome: "refused", reason: "local approval removed during upgrade", key_owner: 1 }]);
      expect(rows.previous).toEqual(previousRows);
      expect(rows.pendingTable).toEqual([]);

      const writer = await connect(upgraded, payments.access);
      const reader = await connect(upgraded, readOnly.access);
      try {
        const denied = await submit(reader, [order], "readonly-payment-batch");
        expect(denied.isError).toBe(true);
        expect(text(denied)).toContain("permissions");
        const outsideGrant = await submit(writer, [order], "wrong-account-batch", "savings");
        expect(outsideGrant.isError).toBe(true);
        const replay = await submit(writer, [heldOrder], heldKey);
        expect(replay.isError).toBe(true);
        expect(text(replay)).toContain("retired during an upgrade. Nothing was sent to FIO.");
        expect((await submit(writer, [order], heldKey)).isError).toBe(true);
        expect(uploads).toEqual([]);

        // 21 orders to an unlisted payee, each over the old default per-order limit
        // and together over the old default daily total and order count.
        const batch = Array.from({ length: 21 }, () => order);
        const prepared = await preview(writer, batch);
        expect(prepared).not.toHaveProperty("withinLimits");
        expect(prepared).not.toHaveProperty("limits");
        expect(prepared).not.toHaveProperty("allowlist");
        expect(uploads).toEqual([]);
        const key = "post-upgrade-payment-batch";
        const result = await submit(writer, batch, key);
        expect(result.isError, text(result)).toBeFalsy();
        expect(JSON.parse(text(result)).result.outcome).toBe("accepted");
        expect(text(result)).toContain("sign");
        expect(uploads).toEqual([prepared.xml]);
        expect(JSON.parse(text(await submit(writer, batch, key)))).toMatchObject({
          orderCount: 21,
          result: { outcome: "accepted", batchIds: ["105545555"] },
        });
        expect(uploads).toHaveLength(1);
      } finally {
        await Promise.all([writer.close(), reader.close()]);
      }
    } finally {
      await upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
