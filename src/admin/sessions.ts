import { Clock, Effect, Option, Redacted } from "effect";
import { hashSecret, newSigningKey, randomSecret, safeEqual, sign } from "../oauth/crypto.js";

/**
 * Admin UI sessions, in memory only and separate from the OAuth sign-in
 * sessions. The browser holds `__Secure-fio-mcp-admin` (HttpOnly, Secure,
 * SameSite=Strict, Path=/admin): `<id>.<HMAC>`; the server keeps the
 * SHA-256 of the id.
 *
 * A pre-login session carries only the sign-in form's CSRF token. Signing
 * in replaces it with a new session (new id and CSRF token: no fixation).
 * Signed-in sessions end after ADMIN_IDLE_MS without a request, after
 * ADMIN_ABSOLUTE_MS in any case, at sign-out, or when the admin password
 * changes (their password stamp no longer matches).
 */

export const ADMIN_COOKIE = "__Secure-fio-mcp-admin";
export const ADMIN_PATH = "/admin";
export const ADMIN_IDLE_MS = 15 * 60_000;
export const ADMIN_ABSOLUTE_MS = 8 * 60 * 60_000;
export const ADMIN_PRELOGIN_MS = 10 * 60_000;
export const MAX_ADMIN_SESSIONS = { preLogin: 100, signedIn: 10 } as const;

export interface AdminSession {
  readonly key: string;
  readonly csrf: Redacted.Redacted<string>;
  readonly signedIn: boolean;
  /** The admin password's stamp at sign-in. */
  readonly passwordStamp: string | undefined;
  readonly createdAt: number;
  lastSeenAt: number;
  /** A one-shot message for the next page (Post/Redirect/Get), never in a URL. */
  flash: { readonly kind: "ok" | "error"; readonly text: string } | undefined;
}

export interface IssuedAdminSession {
  readonly session: AdminSession;
  /** Cookie value: `<id>.<signature>`. */
  readonly cookie: Redacted.Redacted<string>;
}

export const makeAdminSessions = Effect.fn("AdminSessions.make")(function* () {
  const key = yield* newSigningKey;
  const sessions = new Map<string, AdminSession>();

  const expiresAt = (session: AdminSession) =>
    session.signedIn
      ? Math.min(session.lastSeenAt + ADMIN_IDLE_MS, session.createdAt + ADMIN_ABSOLUTE_MS)
      : session.createdAt + ADMIN_PRELOGIN_MS;

  /** Drops expired sessions, then the oldest of the same kind beyond its cap. */
  const prune = (now: number, signedIn: boolean) => {
    for (const [id, session] of sessions) if (expiresAt(session) <= now) sessions.delete(id);
    const cap = signedIn ? MAX_ADMIN_SESSIONS.signedIn : MAX_ADMIN_SESSIONS.preLogin;
    const sameKind = [...sessions.values()].filter((session) => session.signedIn === signedIn);
    for (const dropped of sameKind.slice(0, Math.max(0, sameKind.length - cap + 1))) sessions.delete(dropped.key);
  };

  const issue = Effect.fnUntraced(function* (signedIn: boolean, passwordStamp: string | undefined) {
    const now = yield* Clock.currentTimeMillis;
    prune(now, signedIn);
    const id = Redacted.value(yield* randomSecret(""));
    const session: AdminSession = {
      key: hashSecret(id),
      csrf: yield* randomSecret(""),
      signedIn,
      passwordStamp,
      createdAt: now,
      lastSeenAt: now,
      flash: undefined,
    };
    sessions.set(session.key, session);
    return { session, cookie: Redacted.make(`${id}.${sign(key, id)}`) } satisfies IssuedAdminSession;
  });

  /** A session for the sign-in form. */
  const start = () => issue(false, undefined);

  /** After a correct password: a new signed-in session; the pre-login one ends. */
  const signIn = Effect.fnUntraced(function* (previous: AdminSession | undefined, passwordStamp: string) {
    if (previous !== undefined) sessions.delete(previous.key);
    return yield* issue(true, passwordStamp);
  });

  /** The live session the cookie names (signature checked), touched as used. */
  const find = Effect.fnUntraced(function* (cookie: string | undefined) {
    if (cookie === undefined) return Option.none<AdminSession>();
    const dot = cookie.lastIndexOf(".");
    if (dot <= 0) return Option.none<AdminSession>();
    const id = cookie.slice(0, dot);
    if (!safeEqual(cookie.slice(dot + 1), sign(key, id))) return Option.none<AdminSession>();
    const now = yield* Clock.currentTimeMillis;
    const session = sessions.get(hashSecret(id));
    if (session === undefined) return Option.none<AdminSession>();
    if (expiresAt(session) <= now) {
      sessions.delete(session.key);
      return Option.none<AdminSession>();
    }
    if (session.signedIn) session.lastSeenAt = now;
    return Option.some(session);
  });

  const end = (session: AdminSession) => Effect.sync(() => void sessions.delete(session.key));

  /** Ends every signed-in session except `keep` (after a password change). */
  const endOthers = (keep: AdminSession) =>
    Effect.sync(() => {
      for (const session of [...sessions.values()]) {
        if (session.signedIn && session.key !== keep.key) sessions.delete(session.key);
      }
    });

  return { start, signIn, find, end, endOthers, expiresAt };
});

export type AdminSessions = Effect.Success<ReturnType<typeof makeAdminSessions>>;
