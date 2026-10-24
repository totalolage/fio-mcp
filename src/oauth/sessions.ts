import { Clock, Effect, Option, Redacted } from "effect";
import { hashSecret, newSigningKey, randomSecret, safeEqual, sign } from "./crypto.js";

/**
 * Browser state between /authorize and the redirect back to the client:
 * the validated authorization request, the CSRF token, and whether the
 * admin password was entered. Held in memory only; the browser carries a
 * signed, HttpOnly, Secure, SameSite=Lax cookie naming it. Sessions live
 * ten minutes, end at the redirect, and change id at login.
 */

export const SESSION_COOKIE = "__Host-fio-mcp-auth";
export const SESSION_TTL_MS = 10 * 60_000;
/**
 * Sessions held at once. Anyone can start one, so sign-ins in progress are
 * capped apart from signed-in ones (which need the password); starting
 * sign-ins never ends a signed-in session. At the cap a signed-in session
 * replaces the oldest signed-in one, and a sign-in replaces the oldest
 * sign-in of the client with the most in progress (counting the new one,
 * ties going against the new one's client), so a flood through one client
 * displaces its own sign-ins first.
 */
export const MAX_SESSIONS = { pending: 100, signedIn: 20 } as const;

/** A validated /authorize request, waiting for login and consent. */
export interface PendingAuthorization {
  readonly clientId: string;
  readonly clientName: string | null;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeChallenge: string;
  readonly requestedScopes: ReadonlyArray<string>;
  readonly resource: string;
}

export interface AuthSession {
  readonly key: string;
  readonly csrf: Redacted.Redacted<string>;
  readonly request: PendingAuthorization;
  readonly loggedIn: boolean;
  /** The admin password's stamp at login (src/admin/password.ts); a signed-in session ends when it changes. */
  readonly passwordStamp: string | undefined;
  readonly expiresAt: number;
  /**
   * The accounts the consent page last showed: name → token fingerprint. A
   * consent is accepted only for these, unchanged (an account renamed or
   * given a new token in between is shown again instead).
   */
  consentShown: ReadonlyMap<string, string> | undefined;
}

export interface IssuedSession {
  readonly session: AuthSession;
  /** Cookie value: `<id>.<signature>`. */
  readonly cookie: Redacted.Redacted<string>;
}

export const makeSessions = Effect.fn("AuthSessions.make")(function* () {
  const key = yield* newSigningKey;
  const sessions = new Map<string, AuthSession>();

  /**
   * The session to drop for room among `sameKind` (oldest first) before one
   * for `clientId` is added: the oldest of the client with the most,
   * counting the new one and breaking ties against `clientId`.
   */
  const victim = (sameKind: ReadonlyArray<AuthSession>, loggedIn: boolean, clientId: string) => {
    if (loggedIn) return sameKind[0];
    const counts = new Map<string, number>([[clientId, 1]]);
    for (const session of sameKind) counts.set(session.request.clientId, (counts.get(session.request.clientId) ?? 0) + 1);
    let busiest = clientId;
    for (const [candidate, count] of counts) if (count > (counts.get(busiest) ?? 0)) busiest = candidate;
    // Without one of its own (every client holds one), the oldest goes.
    return sameKind.find((session) => session.request.clientId === busiest) ?? sameKind[0];
  };

  /** Drops expired sessions, then makes room for one more of `loggedIn`'s kind for `clientId`. */
  const prune = (now: number, loggedIn: boolean, clientId: string) => {
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    const cap = loggedIn ? MAX_SESSIONS.signedIn : MAX_SESSIONS.pending;
    // Insertion order is age order: a signed-in session is re-inserted at login.
    let sameKind = [...sessions.values()].filter((session) => session.loggedIn === loggedIn);
    while (sameKind.length >= cap) {
      const dropped = victim(sameKind, loggedIn, clientId);
      if (dropped === undefined) break;
      sessions.delete(dropped.key);
      sameKind = sameKind.filter((session) => session !== dropped);
    }
  };

  const issue = Effect.fnUntraced(function* (
    request: PendingAuthorization,
    loggedIn: boolean,
    passwordStamp?: string,
    expiresAt?: number,
  ) {
    const now = yield* Clock.currentTimeMillis;
    prune(now, loggedIn, request.clientId);
    const id = Redacted.value(yield* randomSecret(""));
    const session: AuthSession = {
      key: hashSecret(id),
      csrf: yield* randomSecret(""),
      request,
      loggedIn,
      passwordStamp,
      expiresAt: expiresAt ?? now + SESSION_TTL_MS,
      consentShown: undefined,
    };
    sessions.set(session.key, session);
    return { session, cookie: Redacted.make(`${id}.${sign(key, id)}`) } satisfies IssuedSession;
  });

  /** A new session for a validated authorization request. */
  const start = (request: PendingAuthorization) => issue(request, false);

  /** The live session the cookie names, if its signature is valid. */
  const find = Effect.fnUntraced(function* (cookie: string | undefined) {
    if (cookie === undefined) return Option.none<AuthSession>();
    const dot = cookie.lastIndexOf(".");
    if (dot <= 0) return Option.none<AuthSession>();
    const id = cookie.slice(0, dot);
    if (!safeEqual(cookie.slice(dot + 1), sign(key, id))) return Option.none<AuthSession>();
    const now = yield* Clock.currentTimeMillis;
    const session = sessions.get(hashSecret(id));
    if (session === undefined || session.expiresAt <= now) return Option.none<AuthSession>();
    return Option.some(session);
  });

  /** After a correct password: the same request under a fresh id and CSRF token (no fixation). */
  const login = Effect.fnUntraced(function* (session: AuthSession, passwordStamp: string) {
    sessions.delete(session.key);
    return yield* issue(session.request, true, passwordStamp, session.expiresAt);
  });

  const end = (session: AuthSession) => Effect.sync(() => void sessions.delete(session.key));

  return { start, find, login, end };
});

export type AuthSessions = Effect.Success<ReturnType<typeof makeSessions>>;
