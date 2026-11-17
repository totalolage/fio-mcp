import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { DOMAIN_MIGRATIONS } from "../../../src/domain/migrations.js";
import { SEND_MIGRATIONS } from "../../../src/domain/send/migrations.js";
import { sendDatabase } from "./support/database.js";

describe("send migrations", () => {
  it.effect("use ids after the domain's and never reuse one", () =>
    Effect.sync(() => {
      const ids = Object.keys(SEND_MIGRATIONS);
      assert.deepStrictEqual(ids, ["0201_filing_reason"]);
      const domainIds = Object.keys(DOMAIN_MIGRATIONS);
      for (const id of ids) {
        assert.notInclude(domainIds, id);
        assert.isTrue(domainIds.every((domainId) => domainId < id));
      }
    }),
  );

  it.effect("add a nullable reason column to filings and record the migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ name: string; type: string; notnull: number }>`PRAGMA table_info(filings)`;
      const reason = columns.find((column) => column.name === "reason");
      assert.deepStrictEqual(reason && { type: reason.type, notnull: reason.notnull }, { type: "TEXT", notnull: 0 });

      yield* sql`
        INSERT INTO filings (id, grant_key, box_id, idempotency_key, content_hash, tier, state, recipient_db_id,
          preview_json, created_at, updated_at)
        VALUES ('f1', 'g1', 'box_1', 'k1', 'h', 'none', 'refused', 'abc1234', '{}', 0, 0)
      `;
      const [row] = yield* sql<{ reason: string | null }>`SELECT reason FROM filings WHERE id = 'f1'`;
      assert.strictEqual(row?.reason, null);

      const recorded = yield* sql<{ name: string }>`SELECT name FROM datova_schranka_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        recorded.map((migration) => migration.name),
        ["boxes", "recipient_tiers", "audit_log", "filings", "approval_nonces", "filing_reason"],
      );
    }).pipe(Effect.provide(sendDatabase())),
  );
});
