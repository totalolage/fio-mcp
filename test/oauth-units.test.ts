import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { type Cause, Clock, Effect, Fiber, Layer, Option, Queue, Redacted, Sink, Stdio, Stream, Terminal } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { databaseLayer, SERVER_MIGRATIONS } from "../src/cache/db.js";
import { CommandFailed, hashPasswordCommand, listClientsCommand, revokeAllTokensCommand, revokeClientCommand } from "../src/oauth/cli.js";
import {
  hashPassword,
  hashSecret,
  PasswordHashError,
  parsePasswordHash,
  pkceMatches,
  verifyPassword,
} from "../src/oauth/crypto.js";
import { DEFAULT_THROTTLE, delayAfter, makeLoginGuard } from "../src/oauth/login.js";
import { escapeHtml } from "../src/oauth/pages.js";
import { makeWindowLimiter } from "../src/oauth/rate-limit.js";
import { MAX_SESSIONS, makeSessions, type PendingAuthorization } from "../src/oauth/sessions.js";
import { makeOAuthStore } from "../src/oauth/store.js";
import { isResource, parsePublicUrl, redirectUriMatches, redirectUriProblem } from "../src/oauth/urls.js";

const FAST = { ln: 14, r: 8, p: 1 } as const;

describe("URL rules", () => {
  it("accepts only https origins (http for loopback) as FIO_MCP_PUBLIC_URL", () => {
    assert.deepStrictEqual(parsePublicUrl("https://FIO.nas.example.net/"), { origin: "https://fio.nas.example.net" });
    assert.deepStrictEqual(parsePublicUrl("https://fio.example.net:8443"), { origin: "https://fio.example.net:8443" });
    assert.deepStrictEqual(parsePublicUrl("http://localhost:3000"), { origin: "http://localhost:3000" });
    for (const bad of ["http://fio.example.net", "https://fio.example.net/mcp", "https://fio.example.net/?a", "https://u:p@fio.example.net", "fio.example.net"]) {
      assert.isTrue("problem" in parsePublicUrl(bad), bad);
    }
  });

  it("matches the resource case-insensitively in scheme and host, never another path", () => {
    const resource = "https://fio.example.net/mcp";
    for (const ok of ["https://fio.example.net/mcp", "HTTPS://FIO.EXAMPLE.NET/mcp", "https://fio.example.net/mcp/", "https://fio.example.net:443/mcp"]) {
      assert.isTrue(isResource(ok, resource), ok);
    }
    for (const bad of ["https://fio.example.net", "https://fio.example.net/MCP", "https://fio.example.net/mcp?x=1", "https://fio.example.net/mcp#f", "http://fio.example.net/mcp", "https://evil.example/mcp"]) {
      assert.isFalse(isResource(bad, resource), bad);
    }
  });

  it("allows https and loopback http redirect URIs only", () => {
    for (const ok of ["https://app.example/cb", "http://127.0.0.1:1234/cb", "http://[::1]/cb", "http://localhost:8080/cb?x=1"]) {
      assert.isUndefined(redirectUriProblem(ok), ok);
    }
    for (const bad of ["http://app.example/cb", "http://127.0.0.2/cb", "myapp://cb", "https://app.example/cb#f", "https://u@app.example/cb", "https://", "https://app.example/\u001b]52;c;x\u0007", "https://app.example/a b"]) {
      assert.isDefined(redirectUriProblem(bad), bad);
    }
  });

  it("matches redirect URIs exactly except the loopback port", () => {
    assert.isTrue(redirectUriMatches("http://127.0.0.1:1234/cb", "http://127.0.0.1:9999/cb"));
    assert.isTrue(redirectUriMatches("http://localhost/cb", "http://localhost:9999/cb"));
    assert.isFalse(redirectUriMatches("http://127.0.0.1:1234/cb", "http://localhost:1234/cb"));
    assert.isFalse(redirectUriMatches("http://127.0.0.1:1234/cb", "http://127.0.0.1:1234/cb/"));
    assert.isFalse(redirectUriMatches("http://127.0.0.1/cb", "http://127.0.0.1:1/cb?x"));
    assert.isFalse(redirectUriMatches("https://app.example:443/cb", "https://app.example/cb"));
    assert.isFalse(redirectUriMatches("https://app.example/cb", "https://app.example/CB"));
  });

  it("escapes HTML", () => {
    assert.strictEqual(escapeHtml(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});

describe("secrets", () => {
  it("checks PKCE S256 (RFC 7636 appendix B)", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert.isTrue(pkceMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
    assert.isFalse(pkceMatches(`${verifier}x`, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
    assert.isFalse(pkceMatches("short", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
  });

  it.effect("hashes and verifies the admin password with scrypt", () =>
    Effect.gen(function* () {
      const line = yield* hashPassword(Redacted.make("a long admin password"), FAST);
      assert.match(line, /^\$scrypt\$ln=14,r=8,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
      const parsed = parsePasswordHash(line);
      assert.isFalse(parsed instanceof PasswordHashError);
      if (parsed instanceof PasswordHashError) return;
      assert.isTrue(yield* verifyPassword(Redacted.make("a long admin password"), parsed));
      assert.isFalse(yield* verifyPassword(Redacted.make("a long admin passwore"), parsed));
    }),
  );

  it("rejects malformed or out-of-range hashes without echoing them", () => {
    const salt = Buffer.alloc(16, 1).toString("base64").replace(/=+$/, "");
    const key = Buffer.alloc(32, 2).toString("base64").replace(/=+$/, "");
    for (const line of ["secret-value", `$scrypt$ln=30,r=8,p=1$${salt}$${key}`, `$scrypt$ln=14,r=8,p=9$${salt}$${key}`]) {
      const parsed = parsePasswordHash(line);
      assert.isTrue(parsed instanceof PasswordHashError, line);
      if (parsed instanceof PasswordHashError) assert.notInclude(parsed.detail, "secret-value");
    }
  });

  it("stores tokens as SHA-256 hex", () => {
    assert.strictEqual(hashSecret("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("authorization sessions", () => {
  const request: PendingAuthorization = {
    clientId: "c",
    clientName: null,
    redirectUri: "http://127.0.0.1/cb",
    state: undefined,
    codeChallenge: "x",
    requestedScopes: ["fio:read"],
    resource: "https://fio.example.test/mcp",
  };

  it.effect("caps sign-ins in progress apart from signed-in sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* makeSessions();
      const first = yield* sessions.start(request);
      const signedIn = yield* sessions.login((yield* sessions.start(request)).session);
      for (let i = 0; i < MAX_SESSIONS.pending + 50; i++) yield* sessions.start(request);
      assert.isTrue(Option.isSome(yield* sessions.find(Redacted.value(signedIn.cookie))));
      assert.isTrue(Option.isNone(yield* sessions.find(Redacted.value(first.cookie))));
      // Signed-in sessions make room among themselves.
      const more = [];
      for (let i = 0; i < MAX_SESSIONS.signedIn; i++) more.push(yield* sessions.login((yield* sessions.start(request)).session));
      assert.isTrue(Option.isNone(yield* sessions.find(Redacted.value(signedIn.cookie))));
      assert.isTrue(Option.isSome(yield* sessions.find(Redacted.value(more[0]?.cookie ?? Redacted.make("")))));
    }),
  );
});

describe("window limiter", () => {
  it("allows `limit` events per window per key and forgets the stalest keys", () => {
    const limiter = makeWindowLimiter({ limit: 2, windowMs: 10_000, maxKeys: 2 });
    limiter.record("a", 0);
    limiter.record("a", 4_000);
    assert.strictEqual(limiter.retryAfter("a", 5_000), 5);
    assert.strictEqual(limiter.retryAfter("b", 5_000), 0);
    // The first event leaves the window.
    assert.strictEqual(limiter.retryAfter("a", 10_000), 0);
    limiter.record("a", 10_000);
    assert.strictEqual(limiter.retryAfter("a", 10_000), 4);
    limiter.record("b", 11_000);
    limiter.record("c", 11_000);
    // Three keys: "a", the stalest, is forgotten.
    assert.strictEqual(limiter.retryAfter("a", 11_000), 0);
  });
});

describe("login throttling", () => {
  it("doubles the delay after the free failures and locks out", () => {
    const delays = Array.from({ length: 11 }, (_, i) => delayAfter(DEFAULT_THROTTLE, i + 1));
    assert.deepStrictEqual(delays, [0, 0, 0, 0, 0, 1000, 2000, 4000, 8000, 900_000, 900_000]);
  });

  it.effect("rejects attempts during backoff without checking the password, per address (TestClock)", () =>
    Effect.gen(function* () {
      const parsed = parsePasswordHash(yield* hashPassword(Redacted.make("the right password"), FAST));
      if (parsed instanceof PasswordHashError) return assert.fail("hash did not parse");
      const guard = yield* makeLoginGuard(Redacted.make(parsed));
      const wrong = Redacted.make("the wrong password");
      const right = Redacted.make("the right password");
      for (let i = 0; i < 6; i++) assert.strictEqual((yield* guard.attempt("10.0.0.1", wrong))._tag, "Rejected");
      assert.deepStrictEqual(yield* guard.attempt("10.0.0.1", right), { _tag: "Throttled", retryAfterSeconds: 1 });
      // Another address is unaffected.
      assert.strictEqual((yield* guard.attempt("10.0.0.2", right))._tag, "Accepted");
      yield* TestClock.adjust("1 second");
      assert.strictEqual((yield* guard.attempt("10.0.0.1", right))._tag, "Accepted");
      // Success resets the count.
      assert.strictEqual((yield* guard.attempt("10.0.0.1", wrong))._tag, "Rejected");
      assert.strictEqual((yield* guard.attempt("10.0.0.1", right))._tag, "Accepted");
    }),
  );

  it.effect("keeps the permit and counts the failure when the caller is interrupted mid-check", () =>
    Effect.gen(function* () {
      const parsed = parsePasswordHash(yield* hashPassword(Redacted.make("the right password"), FAST));
      if (parsed instanceof PasswordHashError) return assert.fail("hash did not parse");
      const guard = yield* makeLoginGuard(Redacted.make(parsed));
      const wrong = Redacted.make("the wrong password");
      const fiber = yield* Effect.forkChild(guard.attempt("a", wrong));
      yield* Effect.yieldNow;
      // While the first check runs, others are turned away rather than run in parallel.
      assert.strictEqual((yield* guard.attempt("b", wrong))._tag, "Throttled");
      // Interruption waits for the admitted check, which still counts as a failure.
      yield* Fiber.interrupt(fiber);
      for (let i = 0; i < 5; i++) assert.strictEqual((yield* guard.attempt("a", wrong))._tag, "Rejected");
      assert.strictEqual((yield* guard.attempt("a", Redacted.make("the right password")))._tag, "Throttled");
    }),
  );

  it.effect("locks an address out for 15 minutes after 10 failures", () =>
    Effect.gen(function* () {
      const parsed = parsePasswordHash(yield* hashPassword(Redacted.make("the right password"), FAST));
      if (parsed instanceof PasswordHashError) return assert.fail("hash did not parse");
      const guard = yield* makeLoginGuard(Redacted.make(parsed), { ...DEFAULT_THROTTLE, freeFailures: 0, baseDelayMs: 0 });
      for (let i = 0; i < 10; i++) yield* guard.attempt("a", Redacted.make("nope"));
      const right = Redacted.make("the right password");
      assert.deepStrictEqual(yield* guard.attempt("a", right), { _tag: "Throttled", retryAfterSeconds: 900 });
      yield* TestClock.adjust("14 minutes");
      assert.strictEqual((yield* guard.attempt("a", right))._tag, "Throttled");
      yield* TestClock.adjust("1 minute");
      assert.strictEqual((yield* guard.attempt("a", right))._tag, "Accepted");
    }),
  );
});

/** Stdio with the given stdin; stdout and stderr are collected. */
const fakeStdio = (stdin: string, isTerminal: boolean) => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const decoder = new TextDecoder();
  const collect = (into: Array<string>) => {
    const append = (chunk: string | Uint8Array) =>
      Effect.sync(() => {
        into.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
      });
    return Sink.forEach(append);
  };
  const layer = Stdio.layerTest({
    stdin: Stream.make(new TextEncoder().encode(stdin)),
    stdinIsTerminal: Effect.succeed(isTerminal),
    stdout: () => collect(out),
    stderr: () => collect(err),
  });
  return { layer, out, err };
};

/** A terminal that "types" the given lines (no echo). */
const fakeTerminal = (lines: ReadonlyArray<string>) => {
  let next = 0;
  return Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readLine: Effect.die("not used"),
      display: () => Effect.void,
      readInput: Effect.gen(function* () {
        const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
        const key = (name: string) => ({ name, ctrl: false, meta: false, shift: false });
        for (const char of lines[next++] ?? "") yield* Queue.offer(queue, { input: Option.some(char), key: key(char) });
        yield* Queue.offer(queue, { input: Option.none(), key: key("return") });
        return queue;
      }),
    }),
  );
};

describe("hash-password", () => {
  it.effect("hashes a piped password (trailing newline dropped) to stdout", () =>
    Effect.gen(function* () {
      const io = fakeStdio("piped admin password\n", false);
      yield* hashPasswordCommand(FAST).pipe(Effect.provide(Layer.mergeAll(io.layer, fakeTerminal([]))));
      const line = io.out.join("").trim();
      const parsed = parsePasswordHash(line);
      if (parsed instanceof PasswordHashError) return assert.fail("output is not a hash");
      assert.isTrue(yield* verifyPassword(Redacted.make("piped admin password"), parsed));
      assert.notInclude(io.out.join("") + io.err.join(""), "piped admin password");
    }),
  );

  it.effect("asks twice on a terminal without echoing", () =>
    Effect.gen(function* () {
      const io = fakeStdio("", true);
      yield* hashPasswordCommand(FAST).pipe(
        Effect.provide(Layer.mergeAll(io.layer, fakeTerminal(["typed admin password", "typed admin password"]))),
      );
      const parsed = parsePasswordHash(io.out.join("").trim());
      if (parsed instanceof PasswordHashError) return assert.fail("output is not a hash");
      assert.isTrue(yield* verifyPassword(Redacted.make("typed admin password"), parsed));
      assert.include(io.err.join(""), "Admin password:");
      assert.notInclude(io.err.join(""), "typed admin password");
    }),
  );

  it.effect("refuses short passwords and mismatched repeats", () =>
    Effect.gen(function* () {
      const short = fakeStdio("short\n", false);
      const tooShort = yield* Effect.flip(
        hashPasswordCommand(FAST).pipe(Effect.provide(Layer.mergeAll(short.layer, fakeTerminal([])))),
      );
      assert.instanceOf(tooShort, CommandFailed);
      assert.include(tooShort.message, "12");
      const tty = fakeStdio("", true);
      const mismatch = yield* Effect.flip(
        hashPasswordCommand(FAST).pipe(
          Effect.provide(Layer.mergeAll(tty.layer, fakeTerminal(["first admin password", "other admin password"]))),
        ),
      );
      assert.include(mismatch.message, "do not match");
      assert.strictEqual(short.out.join("") + tty.out.join(""), "");
    }),
  );
});

describe("admin commands", () => {
  const db = databaseLayer(":memory:", SERVER_MIGRATIONS).pipe(Layer.provide(NodeFileSystem.layer));

  it.effect("detects reuse of any earlier refresh token and ends a grant at the rotation limit", () =>
    Effect.gen(function* () {
      const store = yield* makeOAuthStore(30);
      const sql = yield* SqlClient.SqlClient;
      const now = yield* Clock.currentTimeMillis;
      const setup = Effect.fnUntraced(function* (clientId: string) {
        yield* store.insertClient({ clientId, clientName: null, redirectUris: ["https://a.example/cb"], createdAt: now, lastUsedAt: null }, 10);
        const grant = { grantId: `grant_${clientId}`, clientId, scopes: ["fio:read"], accounts: ["main"], resource: "https://fio.example.test/mcp" };
        yield* store.createGrant(grant, { codeHash: `c_${clientId}`, clientId, redirectUri: "https://a.example/cb", codeChallenge: "x", expiresAt: now + 60_000 }, now);
        yield* store.insertTokens(grant.grantId, pair(clientId, 0));
        return grant;
      });
      const pair = (clientId: string, n: number) => ({
        accessHash: `${clientId}_a${n}`,
        accessExpiresAt: now + 3_600_000,
        refreshHash: `${clientId}_r${n}`,
        refreshExpiresAt: now + 3_600_000,
      });
      // The oldest token of a long chain still revokes the family.
      yield* setup("x");
      for (let n = 1; n <= 25; n++) assert.strictEqual((yield* store.rotateRefresh(`x_r${n - 1}`, "x", now + n, () => pair("x", n)))._tag, "Rotated");
      assert.strictEqual((yield* store.rotateRefresh("x_r0", "x", now + 100, () => pair("x", 99)))._tag, "Reused");
      assert.isTrue(Option.isNone(yield* store.accessGrant("x_a25", now + 100)));
      // At the limit the grant ends; its rows stay bounded.
      yield* setup("y");
      for (let n = 1; n <= 30; n++) assert.strictEqual((yield* store.rotateRefresh(`y_r${n - 1}`, "y", now + n, () => pair("y", n)))._tag, "Rotated");
      assert.strictEqual((yield* store.rotateRefresh("y_r30", "y", now + 100, () => pair("y", 31)))._tag, "Exhausted");
      assert.isTrue(Option.isNone(yield* store.accessGrant("y_a30", now + 100)));
      const [rows] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM oauth_tokens WHERE grant_id = 'grant_y'`;
      assert.strictEqual(rows?.total, 0);
    }).pipe(Effect.provide(db)),
  );

  it.effect("lists clients, revokes one, and revokes every token", () =>
    Effect.gen(function* () {
      const store = yield* makeOAuthStore();
      const now = yield* Clock.currentTimeMillis;
      for (const clientId of ["fio_client_a", "fio_client_b"]) {
        yield* store.insertClient({ clientId, clientName: `App ${clientId}`, redirectUris: ["https://a.example/cb"], createdAt: now, lastUsedAt: null }, 10);
        const grantId = `grant_${clientId}`;
        yield* store.createGrant(
          { grantId, clientId, scopes: ["fio:read"], accounts: ["main"], resource: "https://fio.example.test/mcp" },
          { codeHash: `code_${clientId}`, clientId, redirectUri: "https://a.example/cb", codeChallenge: "x", expiresAt: now + 60_000 },
          now,
        );
        yield* store.insertTokens(grantId, {
          accessHash: `access_${clientId}`,
          accessExpiresAt: now + 3_600_000,
          refreshHash: `refresh_${clientId}`,
          refreshExpiresAt: now + 3_600_000,
        });
      }

      const list = fakeStdio("", false);
      yield* listClientsCommand().pipe(Effect.provide(list.layer));
      const listed = list.out.join("");
      assert.include(listed, "fio_client_a");
      assert.include(listed, "fio_client_b");
      assert.include(listed, "active_grants=1");
      assert.include(listed, 'redirect_uris=["https://a.example/cb"]');

      const revoke = fakeStdio("", false);
      yield* revokeClientCommand("fio_client_a").pipe(Effect.provide(revoke.layer));
      assert.include(revoke.out.join(""), "Revoked client fio_client_a");
      assert.isTrue(Option.isNone(yield* store.client("fio_client_a")));
      assert.isTrue(Option.isNone(yield* store.accessGrant("access_fio_client_a", now)));
      const missing = yield* Effect.flip(revokeClientCommand("fio_client_a").pipe(Effect.provide(fakeStdio("", false).layer)));
      assert.include(missing.message, "no registered client");

      assert.isTrue(Option.isSome(yield* store.accessGrant("access_fio_client_b", now)));
      const all = fakeStdio("", false);
      yield* revokeAllTokensCommand().pipe(Effect.provide(all.layer));
      assert.include(all.out.join(""), "Revoked 1 active grants");
      assert.isTrue(Option.isNone(yield* store.accessGrant("access_fio_client_b", now)));
    }).pipe(Effect.provide(db)),
  );
});
