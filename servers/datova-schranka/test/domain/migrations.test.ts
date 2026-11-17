import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { FILING_STATES } from "../../src/domain/migrations.js";
import { memoryDatabase } from "./support/database.js";

const insertFiling = (id: string, state: string, grantKey = "g1", key = id, dmId: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO filings (id, grant_key, box_id, idempotency_key, content_hash, tier, state, recipient_db_id,
        preview_json, dm_id, created_at, updated_at)
      VALUES (${id}, ${grantKey}, 'box_1', ${key}, 'h', 'full', ${state}, 'abc1234', '{}', ${dmId}, 0, 0)
    `;
  });

describe("domain migrations", () => {
  it.effect("create the domain tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
      const names = rows.map((row) => row.name);
      for (const table of ["approval_nonces", "audit_log", "boxes", "filings", "recipient_tiers"]) {
        assert.include(names, table);
      }
      assert.notInclude(names, "server_settings");
    }).pipe(Effect.provide(memoryDatabase())),
  );

  it.effect("accept exactly the filing states of FILING_STATES", () =>
    Effect.gen(function* () {
      for (const [index, state] of FILING_STATES.entries()) {
        yield* insertFiling(`f${index}`, state);
      }
      const bogus = yield* Effect.exit(insertFiling("bogus", "delivered"));
      assert.isTrue(bogus._tag === "Failure");
    }).pipe(Effect.provide(memoryDatabase())),
  );

  it.effect("keep one filing per grant, box and idempotency key, and one filing per dmID", () =>
    Effect.gen(function* () {
      yield* insertFiling("a", "sent", "g1", "k", "100");
      assert.isTrue((yield* Effect.exit(insertFiling("b", "sent", "g1", "k")))._tag === "Failure");
      yield* insertFiling("c", "sent", "g2", "k");
      assert.isTrue((yield* Effect.exit(insertFiling("d", "sent", "g3", "k", "100")))._tag === "Failure");
    }).pipe(Effect.provide(memoryDatabase())),
  );
});
