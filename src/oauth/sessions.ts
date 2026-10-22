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
const MAX_SESSIONS = 200;

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
  readonly expiresAt: number;
}

export interface IssuedSession {
  readonly session: AuthSession;
  /** Cookie value: `<id>.<signature>`. */
  readonly cookie: Redacted.Redacted<string>;
}

export const makeSessions = Effect.fn("AuthSessions.make")(function* () {
  const key = yield* newSigningKey;
  const sessions = new Map<string, AuthSession>();

  const prune = (now: number) => {
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next();
      if (oldest.done === true) break;
      sessions.delete(oldest.value);
    }
  };

  const issue = Effect.fnUntraced(function* (request: PendingAuthorization, loggedIn: boolean, expiresAt?: number) {
    const now = yield* Clock.currentTimeMillis;
    prune(now);
    const id = Redacted.value(yield* randomSecret(""));
    const session: AuthSession = {
      key: hashSecret(id),
      csrf: yield* randomSecret(""),
      request,
      loggedIn,
      expiresAt: expiresAt ?? now + SESSION_TTL_MS,
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
  const login = Effect.fnUntraced(function* (session: AuthSession) {
    sessions.delete(session.key);
    return yield* issue(session.request, true, session.expiresAt);
  });

  const end = (session: AuthSession) => Effect.sync(() => void sessions.delete(session.key));

  return { start, find, login, end };
});

export type AuthSessions = Effect.Success<ReturnType<typeof makeSessions>>;
