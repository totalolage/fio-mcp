import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Exit, Layer, Option, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { type Account, toAccount } from "../src/accounts.js";
import { databaseLayer, migrate, SERVER_MIGRATIONS } from "../src/cache/db.js";
import { requireAccount, visibleAccounts } from "../src/mcp/permissions.js";
import { makeOAuthStore } from "../src/oauth/store.js";
import { CurrentPrincipal, type Principal } from "../src/transport/principal.js";
import { PAY_TOKEN, READ_TOKEN } from "./fixtures.js";

/**
 * Grants bind the accounts behind the consented tokens, not their names: a
 * grant reloaded after the configuration changed must follow the token.
 */

const ROTATED_TOKEN = "r0tAtEdToKeNAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmn";
const RESOURCE = "https://fio.example.test/mcp";

/** Every migration before grants held fingerprints. */
const BEFORE_FINGERPRINTS = Object.fromEntries(Object.entries(SERVER_MIGRATIONS).filter(([id]) => id < "0004"));

const account = (name: string, token: string): Account =>
  toAccount({ name, token: Redacted.make(token), accountNumber: undefined, currency: undefined });

/** Stores a grant for `accounts` with a live access token, as consent does. */
const grantFor = Effect.fnUntraced(function* (accounts: ReadonlyArray<Account>) {
  const store = yield* makeOAuthStore();
  const now = yield* Clock.currentTimeMillis;
  const clientId = "client_identity";
  yield* store.insertClient({ clientId, clientName: null, redirectUris: ["https://a.example/cb"], createdAt: now, lastUsedAt: null }, 10);
  const grant = {
    grantId: "fio_grant_identity",
    clientId,
    scopes: ["fio:read"],
    accountFingerprints: accounts.map((a) => a.tokenFingerprint),
    resource: RESOURCE,
  };
  yield* store.createGrant(grant, { codeHash: "code_identity", clientId, redirectUri: "https://a.example/cb", codeChallenge: "x", expiresAt: now + 60_000 }, now);
  yield* store.insertTokens(grant.grantId, {
    accessHash: "access_identity",
    accessExpiresAt: now + 60_000,
    refreshHash: "refresh_identity",
    refreshExpiresAt: now + 60_000,
  });
});

/** The principal the HTTP guard builds from the stored grant, as on a later request. */
const reloadedPrincipal = Effect.gen(function* () {
  const store = yield* makeOAuthStore();
  const now = yield* Clock.currentTimeMillis;
  const grant = yield* store.accessGrant("access_identity", now);
  assert.isTrue(Option.isSome(grant));
  const { grantId, scopes, accountFingerprints } = Option.getOrThrow(grant);
  return { subject: grantId, scopes, accountFingerprints } satisfies Principal;
});

const allowed = (principal: Principal, target: Account) =>
  requireAccount(target).pipe(Effect.provideService(CurrentPrincipal, principal), Effect.exit, Effect.map(Exit.isSuccess));

const visibleNames = (principal: Principal, list: ReadonlyArray<Account>) =>
  visibleAccounts(list).pipe(
    Effect.provideService(CurrentPrincipal, principal),
    Effect.map((visible) => visible.map((a) => a.name)),
  );

describe("grant account identity", () => {
  const db = databaseLayer(":memory:", SERVER_MIGRATIONS).pipe(Layer.provide(NodeFileSystem.layer));

  it.effect("stores token fingerprints, not names", () =>
    Effect.gen(function* () {
      const legacy = account("legacy", READ_TOKEN);
      yield* grantFor([legacy]);
      const principal = yield* reloadedPrincipal;
      assert.deepStrictEqual(principal.accountFingerprints, [legacy.tokenFingerprint]);
      assert.notInclude(principal.accountFingerprints, "legacy");
    }).pipe(Effect.provide(db)),
  );

  it.effect("does not pass a grant to another token that takes over the old name", () =>
    Effect.gen(function* () {
      yield* grantFor([account("legacy", READ_TOKEN)]);
      // The configuration renames the account and gives its old name to another token.
      const renamed = account("renamed", READ_TOKEN);
      const impostor = account("legacy", PAY_TOKEN);
      const principal = yield* reloadedPrincipal;
      assert.isFalse(yield* allowed(principal, impostor));
      assert.isTrue(yield* allowed(principal, renamed));
      assert.deepStrictEqual(yield* visibleNames(principal, [renamed, impostor]), ["renamed"]);
    }).pipe(Effect.provide(db)),
  );

  it.effect("keeps a grant when the same token is renamed", () =>
    Effect.gen(function* () {
      yield* grantFor([account("main", READ_TOKEN), account("savings", PAY_TOKEN)]);
      const principal = yield* reloadedPrincipal;
      const list = [account("Běžný účet", READ_TOKEN), account("Spoření", PAY_TOKEN)];
      for (const target of list) assert.isTrue(yield* allowed(principal, target));
      assert.deepStrictEqual(yield* visibleNames(principal, list), ["Běžný účet", "Spoření"]);
    }).pipe(Effect.provide(db)),
  );

  it.effect("drops an account from the grant when its token is rotated", () =>
    Effect.gen(function* () {
      yield* grantFor([account("main", READ_TOKEN), account("savings", PAY_TOKEN)]);
      const principal = yield* reloadedPrincipal;
      // A new FIO token for "main": the user has to consent to it again.
      const list = [account("main", ROTATED_TOKEN), account("savings", PAY_TOKEN)];
      assert.isFalse(yield* allowed(principal, account("main", ROTATED_TOKEN)));
      assert.deepStrictEqual(yield* visibleNames(principal, list), ["savings"]);
    }).pipe(Effect.provide(db)),
  );

  it.effect("revokes grants made by account name when migrating", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* makeOAuthStore();
      const now = yield* Clock.currentTimeMillis;
      // A grant written before 0004: accounts by name.
      yield* sql`INSERT INTO oauth_clients ${sql.insert({ client_id: "old_client", client_name: null, redirect_uris_json: '["https://a.example/cb"]', created_at: now, last_used_at: null })}`;
      yield* sql`INSERT INTO oauth_grants ${sql.insert({ grant_id: "old_grant", client_id: "old_client", scopes: "fio:read", accounts_json: '["legacy"]', resource: RESOURCE, created_at: now, revoked_at: null })}`;
      yield* sql`INSERT INTO oauth_tokens ${sql.insert([
        { token_hash: "old_access", grant_id: "old_grant", kind: "access", expires_at: now + 60_000, rotated_at: null },
        { token_hash: "old_refresh", grant_id: "old_grant", kind: "refresh", expires_at: now + 60_000, rotated_at: null },
      ])}`;

      yield* migrate(SERVER_MIGRATIONS);

      assert.isTrue(Option.isNone(yield* store.accessGrant("old_access", now)));
      const rotation = yield* store.rotateRefresh("old_refresh", "old_client", now, () => undefined);
      assert.strictEqual(rotation._tag, "Unknown");
      const [row] = yield* sql<{ revoked_at: number | null; account_fingerprints_json: string }>`
        SELECT revoked_at, account_fingerprints_json FROM oauth_grants WHERE grant_id = 'old_grant'
      `;
      assert.isNotNull(row?.revoked_at);
      assert.strictEqual(row?.account_fingerprints_json, '["legacy"]');
    }).pipe(
      Effect.provide(
        databaseLayer(":memory:", BEFORE_FINGERPRINTS).pipe(Layer.provide(NodeFileSystem.layer)),
      ),
    ),
  );
});
