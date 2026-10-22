import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { Migrations } from "../cache/db.js";
import { ServerError } from "./errors.js";

/**
 * Persistent OAuth state in the server's SQLite file: registered clients,
 * grants (one per consent; the refresh-token family), authorization codes,
 * and tokens. Codes and tokens are stored only as SHA-256 hashes. Every
 * SqlError is logged (redacted) and becomes a value-free ServerError.
 */

/**
 * Continues the one migration id sequence after the cache's 0001 (the
 * migrator skips ids at or below the latest applied one).
 */
export const OAUTH_MIGRATIONS: Migrations = {
  "0002_create_oauth": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT,
        redirect_uris_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      )
    `;
    yield* sql`
      CREATE TABLE oauth_grants (
        grant_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        accounts_json TEXT NOT NULL,
        resource TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      )
    `;
    yield* sql`CREATE INDEX oauth_grants_by_client ON oauth_grants (client_id)`;
    yield* sql`
      CREATE TABLE oauth_codes (
        code_hash TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      )
    `;
    yield* sql`
      CREATE TABLE oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
        expires_at INTEGER NOT NULL,
        rotated_at INTEGER
      )
    `;
    yield* sql`CREATE INDEX oauth_tokens_by_grant ON oauth_tokens (grant_id)`;
  }),
};

export interface Client {
  readonly clientId: string;
  readonly clientName: string | null;
  readonly redirectUris: ReadonlyArray<string>;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

export interface ClientSummary extends Client {
  /** Grants that are not revoked and still have a usable token or code. */
  readonly liveGrants: number;
}

export interface Grant {
  readonly grantId: string;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly accounts: ReadonlyArray<string>;
  readonly resource: string;
}

export interface NewCode {
  readonly codeHash: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly expiresAt: number;
}

export interface IssuedCode {
  readonly grant: Grant;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
}

export type Redemption =
  | { readonly _tag: "Unknown" }
  /** Second use: the grant was revoked (OAuth 2.1 §4.1.3). */
  | { readonly _tag: "Reused" }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "Redeemed"; readonly code: IssuedCode };

export type Rotation =
  | { readonly _tag: "Unknown" }
  /** An already-rotated refresh token: the whole grant was revoked. */
  | { readonly _tag: "Reused"; readonly clientId: string }
  /** `next` declined the grant (e.g. scope beyond it); nothing changed. */
  | { readonly _tag: "Declined" }
  /** The grant reached MAX_ROTATIONS and was revoked. */
  | { readonly _tag: "Exhausted" }
  | { readonly _tag: "Rotated"; readonly grant: Grant };

export interface TokenPair {
  readonly accessHash: string;
  readonly accessExpiresAt: number;
  readonly refreshHash: string;
  readonly refreshExpiresAt: number;
}

/**
 * Refresh rotations per grant. Every rotated token is kept while the grant
 * lives (reuse of any of them revokes the grant), so the count bounds the
 * rows a grant can accumulate; reaching it ends the grant and the client
 * authorizes again. Hourly refreshes take over 200 days to get there.
 */
export const MAX_ROTATIONS = 5000;

const StringList = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeList = Schema.decodeUnknownSync(StringList);
const encodeList = Schema.encodeSync(StringList);

const failure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ServerError, R> =>
    Effect.catch(effect, (cause) =>
      Effect.logError(`oauth: failed to ${operation}`, cause).pipe(
        Effect.andThen(Effect.fail(new ServerError({ description: `The server failed to ${operation}.` }))),
      ),
    );

interface ClientRow {
  readonly client_id: string;
  readonly client_name: string | null;
  readonly redirect_uris_json: string;
  readonly created_at: number;
  readonly last_used_at: number | null;
}

interface GrantRow {
  readonly grant_id: string;
  readonly client_id: string;
  readonly scopes: string;
  readonly accounts_json: string;
  readonly resource: string;
}

const toClient = (row: ClientRow): Client => ({
  clientId: row.client_id,
  clientName: row.client_name,
  redirectUris: decodeList(row.redirect_uris_json),
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

const toGrant = (row: GrantRow): Grant => ({
  grantId: row.grant_id,
  clientId: row.client_id,
  scopes: row.scopes.split(" ").filter((s) => s !== ""),
  accounts: decodeList(row.accounts_json),
  resource: row.resource,
});

export const makeOAuthStore = Effect.fn("OAuthStore.make")(function* (maxRotations: number = MAX_ROTATIONS) {
  const sql = yield* SqlClient.SqlClient;

  const liveGrant = (now: number) => sql`
    g.revoked_at IS NULL AND (
      EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.grant_id AND t.rotated_at IS NULL AND t.expires_at > ${now})
      OR EXISTS (SELECT 1 FROM oauth_codes c WHERE c.grant_id = g.grant_id AND c.used_at IS NULL AND c.expires_at > ${now})
    )
  `;

  /** Inserts the client unless `maxClients` are registered; false when full. */
  const insertClient = (client: Client, maxClients: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM oauth_clients`;
          if ((row?.total ?? 0) >= maxClients) return false;
          yield* sql`
            INSERT INTO oauth_clients ${sql.insert({
              client_id: client.clientId,
              client_name: client.clientName,
              redirect_uris_json: encodeList(client.redirectUris),
              created_at: client.createdAt,
              last_used_at: client.lastUsedAt,
            })}
          `;
          return true;
        }),
      )
      .pipe(failure("register the client"));

  const client = (clientId: string) =>
    sql<ClientRow>`SELECT * FROM oauth_clients WHERE client_id = ${clientId}`.pipe(
      Effect.map(([row]) => Option.map(Option.fromNullishOr(row), toClient)),
      failure("read the client"),
    );

  const listClients = (now: number) =>
    sql<ClientRow & { live_grants: number }>`
      SELECT oauth_clients.*, (
        SELECT COUNT(*) FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id AND ${liveGrant(now)}
      ) AS live_grants
      FROM oauth_clients ORDER BY created_at
    `.pipe(
      Effect.map((rows) => rows.map((row): ClientSummary => ({ ...toClient(row), liveGrants: row.live_grants }))),
      failure("list clients"),
    );

  const deleteGrantsWhere = Effect.fnUntraced(function* (condition: Parameters<typeof sql.and>[0][number]) {
    yield* sql`DELETE FROM oauth_tokens WHERE grant_id IN (SELECT grant_id FROM oauth_grants WHERE ${condition})`;
    yield* sql`DELETE FROM oauth_codes WHERE grant_id IN (SELECT grant_id FROM oauth_grants WHERE ${condition})`;
    yield* sql`DELETE FROM oauth_grants WHERE ${condition}`;
  });

  /** Deletes the client with every grant, code, and token. False when it does not exist. */
  const deleteClient = (clientId: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ client_id: string }>`SELECT client_id FROM oauth_clients WHERE client_id = ${clientId}`;
          if (row === undefined) return false;
          yield* deleteGrantsWhere(sql`client_id = ${clientId}`);
          yield* sql`DELETE FROM oauth_clients WHERE client_id = ${clientId}`;
          return true;
        }),
      )
      .pipe(failure("revoke the client"));

  /** Stores a consented grant and its authorization code. */
  const createGrant = (grant: Grant, code: NewCode, now: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO oauth_grants ${sql.insert({
              grant_id: grant.grantId,
              client_id: grant.clientId,
              scopes: grant.scopes.join(" "),
              accounts_json: encodeList(grant.accounts),
              resource: grant.resource,
              created_at: now,
              revoked_at: null,
            })}
          `;
          yield* sql`
            INSERT INTO oauth_codes ${sql.insert({
              code_hash: code.codeHash,
              grant_id: grant.grantId,
              client_id: code.clientId,
              redirect_uri: code.redirectUri,
              code_challenge: code.codeChallenge,
              expires_at: code.expiresAt,
              used_at: null,
            })}
          `;
          yield* sql`UPDATE oauth_clients SET last_used_at = ${now} WHERE client_id = ${grant.clientId}`;
        }),
      )
      .pipe(failure("store the authorization"));

  const revokeGrantNow = Effect.fnUntraced(function* (grantId: string, now: number) {
    yield* sql`UPDATE oauth_grants SET revoked_at = ${now} WHERE grant_id = ${grantId} AND revoked_at IS NULL`;
    yield* sql`DELETE FROM oauth_tokens WHERE grant_id = ${grantId}`;
    yield* sql`DELETE FROM oauth_codes WHERE grant_id = ${grantId} AND used_at IS NULL`;
  });

  /** Marks a code used and returns what it was issued for. A second use revokes the grant. */
  const redeemCode = (codeHash: string, now: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<
            GrantRow & { redirect_uri: string; code_challenge: string; expires_at: number; used_at: number | null; revoked_at: number | null }
          >`
            SELECT g.grant_id, g.client_id, g.scopes, g.accounts_json, g.resource, g.revoked_at,
                   c.redirect_uri, c.code_challenge, c.expires_at, c.used_at
            FROM oauth_codes c JOIN oauth_grants g ON g.grant_id = c.grant_id
            WHERE c.code_hash = ${codeHash}
          `;
          if (row === undefined) return { _tag: "Unknown" } satisfies Redemption as Redemption;
          if (row.used_at !== null) {
            yield* revokeGrantNow(row.grant_id, now);
            return { _tag: "Reused" } satisfies Redemption as Redemption;
          }
          yield* sql`UPDATE oauth_codes SET used_at = ${now} WHERE code_hash = ${codeHash}`;
          if (row.expires_at <= now || row.revoked_at !== null) {
            return { _tag: "Expired" } satisfies Redemption as Redemption;
          }
          return {
            _tag: "Redeemed",
            code: {
              grant: toGrant(row),
              clientId: row.client_id,
              redirectUri: row.redirect_uri,
              codeChallenge: row.code_challenge,
            },
          } satisfies Redemption as Redemption;
        }),
      )
      .pipe(failure("redeem the authorization code"));

  const insertTokens = (grantId: string, pair: TokenPair) =>
    sql`
      INSERT INTO oauth_tokens ${sql.insert([
        { token_hash: pair.accessHash, grant_id: grantId, kind: "access", expires_at: pair.accessExpiresAt, rotated_at: null },
        { token_hash: pair.refreshHash, grant_id: grantId, kind: "refresh", expires_at: pair.refreshExpiresAt, rotated_at: null },
      ])}
    `.pipe(Effect.asVoid, failure("store the tokens"));

  /**
   * Consumes a refresh token of `clientId` and stores its successor pair in
   * the same transaction. A token that was already rotated revokes its grant
   * (committed, not rolled back). `next` may decline (undefined) before
   * anything changes.
   */
  const rotateRefresh = (
    refreshHash: string,
    clientId: string,
    now: number,
    next: (grant: Grant) => TokenPair | undefined,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<GrantRow & { expires_at: number; rotated_at: number | null; revoked_at: number | null }>`
            SELECT g.grant_id, g.client_id, g.scopes, g.accounts_json, g.resource, g.revoked_at, t.expires_at, t.rotated_at
            FROM oauth_tokens t JOIN oauth_grants g ON g.grant_id = t.grant_id
            WHERE t.token_hash = ${refreshHash} AND t.kind = 'refresh'
          `;
          if (row === undefined || row.revoked_at !== null || row.client_id !== clientId) {
            return { _tag: "Unknown" } satisfies Rotation as Rotation;
          }
          // Reuse is checked before expiry: rotated tokens stay until their grant ends.
          if (row.rotated_at !== null) {
            yield* revokeGrantNow(row.grant_id, now);
            return { _tag: "Reused", clientId: row.client_id } satisfies Rotation as Rotation;
          }
          if (row.expires_at <= now) return { _tag: "Unknown" } satisfies Rotation as Rotation;
          const grant = toGrant(row);
          const pair = next(grant);
          if (pair === undefined) return { _tag: "Declined" } satisfies Rotation as Rotation;
          const [rotations] = yield* sql<{ total: number }>`
            SELECT COUNT(*) AS total FROM oauth_tokens
            WHERE grant_id = ${grant.grantId} AND kind = 'refresh' AND rotated_at IS NOT NULL
          `;
          if ((rotations?.total ?? 0) >= maxRotations) {
            yield* revokeGrantNow(grant.grantId, now);
            return { _tag: "Exhausted" } satisfies Rotation as Rotation;
          }
          yield* sql`UPDATE oauth_tokens SET rotated_at = ${now} WHERE token_hash = ${refreshHash}`;
          // The superseded access tokens of this grant end with the rotation.
          yield* sql`DELETE FROM oauth_tokens WHERE grant_id = ${grant.grantId} AND kind = 'access'`;
          yield* sql`
            INSERT INTO oauth_tokens ${sql.insert([
              { token_hash: pair.accessHash, grant_id: grant.grantId, kind: "access", expires_at: pair.accessExpiresAt, rotated_at: null },
              { token_hash: pair.refreshHash, grant_id: grant.grantId, kind: "refresh", expires_at: pair.refreshExpiresAt, rotated_at: null },
            ])}
          `;
          yield* sql`UPDATE oauth_clients SET last_used_at = ${now} WHERE client_id = ${grant.clientId}`;
          return { _tag: "Rotated", grant } satisfies Rotation as Rotation;
        }),
      )
      .pipe(failure("refresh the tokens"));

  /** The grant behind a live, unexpired access token. */
  const accessGrant = (accessHash: string, now: number) =>
    sql<GrantRow>`
      SELECT g.grant_id, g.client_id, g.scopes, g.accounts_json, g.resource
      FROM oauth_tokens t JOIN oauth_grants g ON g.grant_id = t.grant_id
      WHERE t.token_hash = ${accessHash} AND t.kind = 'access' AND t.expires_at > ${now} AND g.revoked_at IS NULL
    `.pipe(
      Effect.map(([row]) => Option.map(Option.fromNullishOr(row), toGrant)),
      failure("check the access token"),
    );

  /** Grant and client of any stored token (access or refresh, rotated or not). */
  const tokenOwner = (tokenHash: string) =>
    sql<{ grant_id: string; client_id: string }>`
      SELECT g.grant_id, g.client_id
      FROM oauth_tokens t JOIN oauth_grants g ON g.grant_id = t.grant_id
      WHERE t.token_hash = ${tokenHash}
    `.pipe(
      Effect.map(([row]) => Option.map(Option.fromNullishOr(row), (r) => ({ grantId: r.grant_id, clientId: r.client_id }))),
      failure("look up the token"),
    );

  const revokeGrant = (grantId: string, now: number) =>
    sql.withTransaction(revokeGrantNow(grantId, now)).pipe(failure("revoke the grant"));

  /** Revokes every grant; returns how many were live. */
  const revokeAll = (now: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM oauth_grants g WHERE ${liveGrant(now)}`;
          yield* sql`UPDATE oauth_grants SET revoked_at = ${now} WHERE revoked_at IS NULL`;
          yield* sql`DELETE FROM oauth_tokens`;
          yield* sql`DELETE FROM oauth_codes`;
          return row?.total ?? 0;
        }),
      )
      .pipe(failure("revoke all tokens"));

  /**
   * Drops expired codes and tokens, dead grants, clients never authorized
   * within `unusedClientMs` of registering, and authorized clients without
   * a live grant whose last use is older than `idleClientMs`.
   */
  const purge = (now: number, limits: { readonly unusedClientMs: number; readonly idleClientMs: number }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM oauth_codes WHERE expires_at <= ${now}`;
          // Rotated refresh tokens stay while their grant lives, so reuse is still detected.
          yield* sql`DELETE FROM oauth_tokens WHERE expires_at <= ${now} AND rotated_at IS NULL`;
          yield* deleteGrantsWhere(sql`grant_id IN (SELECT grant_id FROM oauth_grants g WHERE NOT (${liveGrant(now)}))`);
          yield* sql`
            DELETE FROM oauth_clients
            WHERE NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)
              AND (
                (last_used_at IS NULL AND created_at <= ${now - limits.unusedClientMs})
                OR (last_used_at IS NOT NULL AND last_used_at <= ${now - limits.idleClientMs})
              )
          `;
        }),
      )
      .pipe(failure("purge expired authorizations"));

  return {
    insertClient,
    client,
    listClients,
    deleteClient,
    createGrant,
    redeemCode,
    insertTokens,
    rotateRefresh,
    accessGrant,
    tokenOwner,
    revokeGrant,
    revokeAll,
    purge,
  };
});

export type OAuthStore = Effect.Success<ReturnType<typeof makeOAuthStore>>;
