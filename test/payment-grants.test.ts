import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/sql";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import { type Grant, makeOAuthStore } from "../src/oauth/store.js";
import { DEFAULT_GRANT_PAYMENTS, type GrantPayments } from "../src/payment-limits.js";
import { memoryDatabase } from "./support/database.js";

const RESOURCE = "https://fio.example.test/mcp";

const PAYMENTS: GrantPayments = {
  limits: { maxPerOrder: { CZK: 1000 }, maxPerDay: { CZK: 5000 }, maxOrdersPerDay: 3 },
  allowlist: { mode: "enforce", entries: [{ account: "123-456/0800", label: "Rent" }] },
};

const setup = Effect.fnUntraced(function* (payments: GrantPayments) {
  const store = yield* makeOAuthStore();
  const now = yield* Clock.currentTimeMillis;
  const clientId = "client_payments";
  yield* store.insertClient(
    { clientId, clientName: null, redirectUris: ["https://a.example/cb"], createdAt: now, lastUsedAt: null },
    10,
  );
  const grant: Grant = {
    grantId: "fio_grant_payments",
    clientId,
    scopes: ["fio:read", "fio:payments"],
    accountFingerprints: ["fp"],
    resource: RESOURCE,
    payments,
  };
  yield* store.createGrant(
    grant,
    { codeHash: "code_payments", clientId, redirectUri: "https://a.example/cb", codeChallenge: "x", expiresAt: now + 60_000 },
    now,
  );
  return { store, now, grant };
});

describe("grant payment settings (migration 0008)", () => {
  it.effect("stores defaults as NULL and reads them back as server defaults", () =>
    Effect.gen(function* () {
      const { store, now } = yield* setup(DEFAULT_GRANT_PAYMENTS);
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ payment_limits_json: string | null; payee_allowlist_json: string | null }>`
        SELECT payment_limits_json, payee_allowlist_json FROM oauth_grants
      `;
      assert.deepStrictEqual(row, { payment_limits_json: null, payee_allowlist_json: null });
      const [grant] = yield* store.listGrants(now);
      assert.deepStrictEqual(grant?.payments, DEFAULT_GRANT_PAYMENTS);
    }).pipe(Effect.provide(memoryDatabase(SERVER_MIGRATIONS))),
  );

  it.effect("round-trips explicit limits and allowlist", () =>
    Effect.gen(function* () {
      const { store, now } = yield* setup(PAYMENTS);
      const [grant] = yield* store.listGrants(now);
      assert.deepStrictEqual(grant?.payments, PAYMENTS);
    }).pipe(Effect.provide(memoryDatabase(SERVER_MIGRATIONS))),
  );

  it.effect("updates a live grant's settings, and refuses a revoked one", () =>
    Effect.gen(function* () {
      const { store, now, grant } = yield* setup(DEFAULT_GRANT_PAYMENTS);
      assert.isTrue(yield* store.updateGrantPayments(grant.grantId, PAYMENTS, now));
      const [updated] = yield* store.listGrants(now);
      assert.deepStrictEqual(updated?.payments, PAYMENTS);
      yield* store.revokeGrant(grant.grantId, now);
      assert.isFalse(yield* store.updateGrantPayments(grant.grantId, DEFAULT_GRANT_PAYMENTS, now));
      assert.isFalse(yield* store.updateGrantPayments("fio_grant_unknown", PAYMENTS, now));
    }).pipe(Effect.provide(memoryDatabase(SERVER_MIGRATIONS))),
  );

  it.effect("fails closed on stored settings that do not decode", () =>
    Effect.gen(function* () {
      const { store, now } = yield* setup(PAYMENTS);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE oauth_grants SET payment_limits_json = '{"maxPerOrder":{"CZK":-1}}'`;
      const exit = yield* Effect.exit(store.listGrants(now));
      assert.isTrue(Exit.isFailure(exit));
      const access = yield* Effect.exit(store.accessGrant("missing", now));
      assert.isTrue(Exit.isSuccess(access) && Option.isNone(access.value));
    }).pipe(Effect.provide(memoryDatabase(SERVER_MIGRATIONS))),
  );
});
