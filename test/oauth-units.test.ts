
import { assert, describe, it } from "@effect/vitest";
import { type Cause, Clock, Deferred, Effect, Fiber, Layer, Option, Queue, Redacted, Sink, Stdio, Stream, Terminal } from "effect";
import { HttpServerRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { makeSettingsStore, SETTING } from "../src/account-store.js";
import { Accounts } from "../src/accounts.js";
import { AdminPassword, makeAdminPassword } from "../src/admin/password.js";
import { decodeBase32, encodeBase32, matchingTotpSteps, newTotpSecret, totpCode } from "../src/admin/totp.js";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import {
  CommandFailed,
  hashPasswordCommand,
  listClientsCommand,
  revokeAllTokensCommand,
  revokeClientCommand,
  totpInitCommand,
} from "../src/oauth/cli.js";
import {
  hashPassword,
  hashSecret,
  type PasswordHash,
  PasswordHashError,
  parsePasswordHash,
  pkceMatches,
  verifyPassword,
} from "../src/oauth/crypto.js";
import { DEFAULT_THROTTLE, delayAfter, makeLoginGuard } from "../src/oauth/login.js";
import { consentPage, escapeHtml } from "../src/oauth/pages.js";
import { makeWindowLimiter } from "../src/oauth/rate-limit.js";
import { makeOAuthServer } from "../src/oauth/server.js";
import { MAX_SESSIONS, makeSessions, type PendingAuthorization } from "../src/oauth/sessions.js";
import { makeOAuthStore } from "../src/oauth/store.js";
import { isResource, parsePublicUrl, redirectUriMatches, redirectUriProblem } from "../src/oauth/urls.js";
import { paymentFormValues } from "../src/payment-form.js";
import { DEFAULT_GRANT_PAYMENTS, DEFAULT_PAYMENT_LIMITS } from "../src/payment-limits.js";
import { testConfig } from "./fixtures.js";
import { seededConfig } from "./support/config.js";
import { memoryDatabase } from "./support/database.js";

const FAST = { ln: 14, r: 8, p: 1 } as const;
/** A well-formed hash for tests that never check a password against it (or stub the check): no scrypt run. */
const UNCHECKED_HASH: PasswordHash = { params: FAST, salt: new Uint8Array(16), hash: new Uint8Array(32) };

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
    for (const bad of ["http://app.example/cb", "http://127.0.0.2/cb", "myapp://cb", "https://app.example/cb#f", "https://u@app.example/cb", "https://", "https://app.example/\u001b]52;c;x\u0007", "https://app.example/a b", "http://127.0.0.1:0/cb", "http://127.0.0.1:99999/cb", "http://127.0.0.1:/cb", "http://@127.0.0.1/cb", "http:////@127.0.0.1/cb", "http:127.0.0.1/cb"]) {
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
    assert.isTrue(redirectUriMatches("http://127.0.0.1/cb", "http://127.0.0.1:65535/cb"));
    for (const bad of ["http://127.0.0.1:99999/cb", "http://127.0.0.1:0/cb", "http://user@127.0.0.1/cb", "http://127.0.0.1:1/cb#x"]) {
      assert.isFalse(redirectUriMatches("http://127.0.0.1/cb", bad), bad);
    }
  });

  it("escapes HTML", () => {
    assert.strictEqual(escapeHtml(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  it("escapes account names in consent checkbox labels and values", () => {
    const html = consentPage({
      formId: "form-1",
      clientId: "fio_client_test",
      clientName: null,
      redirectUri: "http://127.0.0.1:45678/callback",
      csrf: "csrf",
      paymentsRequested: false,
      paymentsChecked: false,
      payments: paymentFormValues(DEFAULT_GRANT_PAYMENTS, DEFAULT_PAYMENT_LIMITS),
      paymentCeiling: DEFAULT_PAYMENT_LIMITS,
      accounts: ["<b>&"],
      error: undefined,
    });
    assert.include(html, 'value="&lt;b&gt;&amp;" checked> &lt;b&gt;&amp;</label>');
    assert.notInclude(html, 'value="<b>&"');
  });
});

describe("authorization endpoint request target", () => {
  const services = Layer.mergeAll(
    memoryDatabase(SERVER_MIGRATIONS),
    Accounts.Default.pipe(Layer.provideMerge(seededConfig(testConfig([])))),
  );

  it.effect("shows an error page for an absolute-form target that is not a URL", () =>
    Effect.gen(function* () {
      const server = yield* makeOAuthServer({ publicUrl: "https://fio.example.net" }).pipe(
        Effect.provide(AdminPassword.layer(Redacted.make(UNCHECKED_HASH))),
      );
      const authorize = server.routes.find((route) => route.method === "GET" && route.path === "/authorize");
      if (authorize === undefined) return assert.fail("no /authorize route");
      // The Node adapter keeps a target it cannot parse as is, and the router still routes `GET http://[/authorize` here.
      const request = HttpServerRequest.fromWeb(new Request("https://fio.example.net/authorize")).modify({ url: "http://[/authorize" });
      const response = yield* authorize.handler(request);
      assert.strictEqual(response.status, 400);
      assert.isUndefined(response.headers.location);
    }).pipe(Effect.provide(services)),
  );
});

describe("secrets", () => {
  it("checks PKCE S256 (RFC 7636 appendix B)", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert.isTrue(pkceMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
    assert.isFalse(pkceMatches(`${verifier}x`, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
    assert.isFalse(pkceMatches("short", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
  });

  // The only test with the production parameters (128 MiB, slow on a loaded machine); the rest use FAST.
  it.effect(
    "stores a password changed at /admin with the production scrypt parameters",
    () =>
      Effect.gen(function* () {
        const bootstrap = parsePasswordHash(yield* hashPassword(Redacted.make("the bootstrap password"), FAST));
        if (bootstrap instanceof PasswordHashError) return assert.fail("hash did not parse");
        const password = yield* makeAdminPassword(Redacted.make(bootstrap));
        const next = Redacted.make("the production password");
        const changed = yield* password.change("192.0.2.1", Redacted.make("the bootstrap password"), next);
        assert.strictEqual(changed._tag, "Accepted");
        const stored = yield* (yield* makeSettingsStore()).get(SETTING.adminPasswordHash);
        assert.match(Option.getOrElse(stored, () => ""), /^\$scrypt\$ln=17,r=8,p=1\$/);
        assert.strictEqual((yield* password.signIn("192.0.2.1", next))._tag, "Accepted");
      }).pipe(Effect.provide(memoryDatabase(SERVER_MIGRATIONS))),
    60_000,
  );

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
      const signedIn = yield* sessions.login((yield* sessions.start(request)).session, "stamp");
      for (let i = 0; i < MAX_SESSIONS.pending + 50; i++) yield* sessions.start(request);
      assert.isTrue(Option.isSome(yield* sessions.find(Redacted.value(signedIn.cookie))));
      assert.isTrue(Option.isNone(yield* sessions.find(Redacted.value(first.cookie))));
      // Signed-in sessions make room among themselves.
      const more = [];
      for (let i = 0; i < MAX_SESSIONS.signedIn; i++) more.push(yield* sessions.login((yield* sessions.start(request)).session, "stamp"));
      assert.isTrue(Option.isNone(yield* sessions.find(Redacted.value(signedIn.cookie))));
      assert.isTrue(Option.isSome(yield* sessions.find(Redacted.value(more[0]?.cookie ?? Redacted.make("")))));
    }),
  );

  it.effect("makes room among the sign-ins of the client with the most in progress", () =>
    Effect.gen(function* () {
      const sessions = yield* makeSessions();
      const other = yield* sessions.start({ ...request, clientId: "other" });
      const flooded = yield* sessions.start(request);
      for (let i = 0; i < MAX_SESSIONS.pending * 2; i++) yield* sessions.start(request);
      assert.isTrue(Option.isSome(yield* sessions.find(Redacted.value(other.cookie))));
      assert.isTrue(Option.isNone(yield* sessions.find(Redacted.value(flooded.cookie))));
    }),
  );

  it.effect("breaks ties against the client adding a sign-in", () =>
    Effect.gen(function* () {
      const sessions = yield* makeSessions();
      // A full pool, one sign-in per client; the admin's is the oldest.
      const admin = yield* sessions.start({ ...request, clientId: "admin" });
      for (let i = 1; i < MAX_SESSIONS.pending; i++) yield* sessions.start({ ...request, clientId: `client-${i}` });
      const own = yield* sessions.start({ ...request, clientId: "client-1" });
      assert.isTrue(Option.isSome(yield* sessions.find(Redacted.value(admin.cookie))));
      assert.isTrue(Option.isSome(yield* sessions.find(Redacted.value(own.cookie))));
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

  /**
   * Compares plain text and counts the checks instead of running scrypt:
   * these tests are about counting failures, not hashing.
   */
  const plainCheck = () => {
    const checks = { count: 0 };
    const verify = (password: Redacted.Redacted<string>) =>
      Effect.sync(() => {
        checks.count++;
        return Redacted.value(password) === "the right password";
      });
    return { checks, verify, expected: Effect.succeed(Redacted.make(UNCHECKED_HASH)) };
  };

  it.effect("rejects attempts during backoff without checking the password, per address (TestClock)", () =>
    Effect.gen(function* () {
      const { checks, verify, expected } = plainCheck();
      const guard = yield* makeLoginGuard(expected, DEFAULT_THROTTLE, verify);
      const wrong = Redacted.make("the wrong password");
      const right = Redacted.make("the right password");
      for (let i = 0; i < 6; i++) assert.strictEqual((yield* guard.attempt("10.0.0.1", wrong))._tag, "Rejected");
      assert.deepStrictEqual(yield* guard.attempt("10.0.0.1", right), { _tag: "Throttled", retryAfterSeconds: 1 });
      assert.strictEqual(checks.count, 6);
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
      // The first check holds until released, as a scrypt run still going when the second attempt arrives.
      const { checks, verify, expected } = plainCheck();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let first = true;
      const held = (password: Redacted.Redacted<string>) => {
        if (!first) return verify(password);
        first = false;
        return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(verify(password)));
      };
      const guard = yield* makeLoginGuard(expected, DEFAULT_THROTTLE, held);
      const wrong = Redacted.make("the wrong password");
      const fiber = yield* Effect.forkChild(guard.attempt("a", wrong));
      yield* Deferred.await(started);
      // Released even if an assertion fails: the admitted check is uninterruptible.
      const interrupting = yield* Effect.gen(function* () {
        // While the first check runs, others are turned away rather than run in parallel.
        assert.strictEqual((yield* guard.attempt("b", wrong))._tag, "Throttled");
        // Interruption waits for the admitted check (the permit stays held meanwhile), which still counts as a failure.
        const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
        yield* Effect.yieldNow;
        assert.strictEqual((yield* guard.attempt("b", wrong))._tag, "Throttled");
        return interruption;
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(interrupting);
      assert.strictEqual(checks.count, 1);
      for (let i = 0; i < 5; i++) assert.strictEqual((yield* guard.attempt("a", wrong))._tag, "Rejected");
      assert.strictEqual((yield* guard.attempt("a", Redacted.make("the right password")))._tag, "Throttled");
    }),
  );

  it.effect("locks an address out for 15 minutes after 10 failures", () =>
    Effect.gen(function* () {
      const { checks, verify, expected } = plainCheck();
      const guard = yield* makeLoginGuard(expected, { ...DEFAULT_THROTTLE, freeFailures: 0, baseDelayMs: 0 }, verify);
      for (let i = 0; i < 10; i++) yield* guard.attempt("a", Redacted.make("nope"));
      assert.strictEqual(checks.count, 10);
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
  const db = memoryDatabase(SERVER_MIGRATIONS);

  it.effect("detects reuse of any earlier refresh token and ends a grant at the rotation limit", () =>
    Effect.gen(function* () {
      const store = yield* makeOAuthStore(30);
      const sql = yield* SqlClient.SqlClient;
      const now = yield* Clock.currentTimeMillis;
      const setup = Effect.fnUntraced(function* (clientId: string) {
        yield* store.insertClient({ clientId, clientName: null, redirectUris: ["https://a.example/cb"], createdAt: now, lastUsedAt: null }, 10);
        const grant = { grantId: `grant_${clientId}`, clientId, scopes: ["fio:read"], accountFingerprints: ["main"], resource: "https://fio.example.test/mcp", payments: DEFAULT_GRANT_PAYMENTS };
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
          { grantId, clientId, scopes: ["fio:read"], accountFingerprints: ["main"], resource: "https://fio.example.test/mcp", payments: DEFAULT_GRANT_PAYMENTS },
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

describe("hash-password output", () => {
  it.effect("writes only the hash line to stdout and the prompts to stderr", () =>
    Effect.gen(function* () {
      const io = fakeStdio("", true);
      yield* hashPasswordCommand(FAST).pipe(
        Effect.provide(Layer.mergeAll(io.layer, fakeTerminal(["typed admin password", "typed admin password"]))),
      );
      const out = io.out.join("");
      assert.match(out, /^\$scrypt\$[^\n]+\n$/);
      assert.notInstanceOf(parsePasswordHash(out), PasswordHashError);
      assert.include(io.err.join(""), "Admin password: ");
      assert.include(io.err.join(""), "Repeat the password: ");
    }),
  );
});

describe("sign-in scrypt bound", () => {
  it.effect("runs at most one password check at a time across all addresses", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let running = 0;
      let peak = 0;
      const verify = () =>
        Effect.gen(function* () {
          running++;
          peak = Math.max(peak, running);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return false;
        }).pipe(Effect.ensuring(Effect.sync(() => running--)));
      const guard = yield* makeLoginGuard(Effect.succeed(Redacted.make(UNCHECKED_HASH)), DEFAULT_THROTTLE, verify);
      const wrong = Redacted.make("the wrong password");
      const fibers = yield* Effect.forEach(Array.from({ length: 10 }, (_, i) => `10.0.0.${i}`), (address) =>
        Effect.forkChild(guard.attempt(address, wrong), { startImmediately: true }),
      );
      yield* Deferred.await(entered);
      // Released before any assertion: the admitted check is uninterruptible.
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.forEach(fibers, Fiber.join);
      assert.strictEqual(peak, 1);
      assert.strictEqual(results.filter((result) => result._tag === "Rejected").length, 1);
      assert.strictEqual(results.filter((result) => result._tag === "Throttled").length, 9);
      // Once the check ends, the next sign-in is checked.
      assert.strictEqual((yield* guard.attempt("10.0.0.99", wrong))._tag, "Rejected");
      assert.strictEqual(peak, 1);
    }),
  );
});

describe("sign-in busy (SEC-09)", () => {
  it.effect("turns a concurrent attempt away as busy without counting it as a failure", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let checks = 0;
      const verify = (password: Redacted.Redacted<string>) =>
        Effect.gen(function* () {
          checks++;
          if (checks === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return Redacted.value(password) === "the right password";
        });
      // One free failure: a second counted failure starts the backoff.
      const throttle = { ...DEFAULT_THROTTLE, freeFailures: 1 };
      const guard = yield* makeLoginGuard(Effect.succeed(Redacted.make(UNCHECKED_HASH)), throttle, verify);
      const wrong = Redacted.make("the wrong password");
      const held = yield* Effect.forkChild(guard.attempt("10.0.0.1", wrong), { startImmediately: true });
      yield* Deferred.await(entered);
      assert.deepStrictEqual(yield* guard.attempt("10.0.0.1", wrong), { _tag: "Throttled", retryAfterSeconds: 1, busy: true });
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual((yield* Fiber.join(held))._tag, "Rejected");
      assert.strictEqual(checks, 1);
      // Only the held attempt was counted: the next one is still checked...
      assert.strictEqual((yield* guard.attempt("10.0.0.1", wrong))._tag, "Rejected");
      // ...and is the second failure, which starts the backoff.
      assert.deepStrictEqual(yield* guard.attempt("10.0.0.1", Redacted.make("the right password")), {
        _tag: "Throttled",
        retryAfterSeconds: 1,
      });
      assert.strictEqual(checks, 2);
    }),
  );
});

/** RFC 6238 appendix B's SHA-1 seed. */
const RFC_SECRET = new TextEncoder().encode("12345678901234567890");

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC 6238 SHA-1 test vectors, truncated to 6 digits", () => {
    const vectors: ReadonlyArray<readonly [number, string]> = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
      [20000000000, "353130"],
    ];
    for (const [seconds, code] of vectors) assert.strictEqual(totpCode(RFC_SECRET, seconds), code, `T = ${seconds}`);
  });

  it("decodes base32 with lowercase, spaces and padding, and refuses anything else", () => {
    assert.strictEqual(encodeBase32(RFC_SECRET), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    assert.deepStrictEqual(decodeBase32("gezd gnbv gy3t qojq\ngezd gnbv gy3t qojq"), RFC_SECRET);
    assert.deepStrictEqual(decodeBase32("MZXW6===\n"), new TextEncoder().encode("foo"));
    for (const bad of ["", " = ", "MZXW1", "MZ=XW6", "MZXW6!"]) assert.isUndefined(decodeBase32(bad), JSON.stringify(bad));
    // Lengths no encoder produces (1, 3 or 6 characters past a whole group) are refused, not truncated.
    for (const length of [25, 27, 30, 33]) assert.isUndefined(decodeBase32("A".repeat(length)), `${length} characters`);
    for (const length of [24, 26, 28, 29, 31, 32]) assert.isDefined(decodeBase32("A".repeat(length)), `${length} characters`);
    const random = newTotpSecret();
    assert.strictEqual(random.length, 20);
    assert.deepStrictEqual(decodeBase32(encodeBase32(random)), random);
  });

  it("accepts one step of drift either way and nothing further", () => {
    const now = 1111111111;
    const step = Math.floor(now / 30);
    for (const offset of [-1, 0, 1]) {
      assert.deepStrictEqual(matchingTotpSteps(RFC_SECRET, totpCode(RFC_SECRET, now + offset * 30), now), [step + offset]);
    }
    for (const offset of [-2, 2]) assert.deepStrictEqual(matchingTotpSteps(RFC_SECRET, totpCode(RFC_SECRET, now + offset * 30), now), []);
    assert.deepStrictEqual(matchingTotpSteps(RFC_SECRET, "050 471", now), [step]);
    for (const bad of ["", "50471", "0504711", "05047a", "０５０４７１"]) assert.deepStrictEqual(matchingTotpSteps(RFC_SECRET, bad, now), [], bad);
    // Near the epoch there is no step -1 to compare.
    assert.deepStrictEqual(matchingTotpSteps(RFC_SECRET, totpCode(RFC_SECRET, 0), 0), [0]);
  });
});

describe("admin TOTP second factor", () => {
  /** A step boundary; the TestClock starts here. */
  const T0 = 1_700_000_010_000;
  const codeAt = (millis: number) => totpCode(RFC_SECRET, Math.floor(millis / 1000));
  /** A 6-digit code that is none of the three accepted at `millis`. */
  const wrongCodeAt = (millis: number) => {
    const valid = new Set([-30_000, 0, 30_000].map((offset) => codeAt(millis + offset)));
    return ["000000", "111111", "222222", "333333"].find((code) => !valid.has(code)) ?? "444444";
  };
  const right = Redacted.make("the right password");
  const adminPassword = (throttle: typeof DEFAULT_THROTTLE, totp: boolean) =>
    Effect.gen(function* () {
      const bootstrap = parsePasswordHash(yield* hashPassword(right, FAST));
      if (bootstrap instanceof PasswordHashError) return yield* Effect.die("hash did not parse");
      yield* TestClock.setTime(T0);
      return yield* makeAdminPassword(Redacted.make(bootstrap), throttle, FAST, totp ? Redacted.make(RFC_SECRET) : undefined);
    });

  it.effect("needs the code with the password, counts a wrong or missing one, and refuses a replay", () =>
    Effect.gen(function* () {
      const password = yield* adminPassword({ ...DEFAULT_THROTTLE, freeFailures: 1 }, true);
      assert.isTrue(password.totpEnabled);
      assert.strictEqual((yield* password.signIn("10.0.0.1", right))._tag, "Rejected");
      assert.strictEqual((yield* password.signIn("10.0.0.1", right, wrongCodeAt(T0)))._tag, "Rejected");
      // Both were counted: the second failure started the backoff, even for a correct code.
      assert.deepStrictEqual(yield* password.signIn("10.0.0.1", right, codeAt(T0)), { _tag: "Throttled", retryAfterSeconds: 1 });
      yield* TestClock.adjust("1 second");
      const now = T0 + 1000;
      assert.strictEqual((yield* password.signIn("10.0.0.1", right, codeAt(now)))._tag, "Accepted");
      // Replayed, from anywhere, in sign-in or on its own: refused.
      assert.strictEqual((yield* password.signIn("10.0.0.2", right, codeAt(now)))._tag, "Rejected");
      assert.strictEqual((yield* password.verifyTotp("10.0.0.3", codeAt(now)))._tag, "Rejected");
      // The next step's code is still good once, and then used up for sign-in too.
      assert.strictEqual((yield* password.verifyTotp("10.0.0.3", codeAt(now + 30_000)))._tag, "Accepted");
      assert.strictEqual((yield* password.verifyTotp("10.0.0.3", codeAt(now + 30_000)))._tag, "Rejected");
      assert.strictEqual((yield* password.signIn("10.0.0.4", right, codeAt(now + 30_000)))._tag, "Rejected");
      // A wrong password does not use up the code it came with.
      assert.strictEqual((yield* password.signIn("10.0.0.5", Redacted.make("wrong password"), codeAt(now - 30_000)))._tag, "Rejected");
      assert.strictEqual((yield* password.signIn("10.0.0.5", right, codeAt(now - 30_000)))._tag, "Accepted");
      // Two steps off is outside the window.
      assert.strictEqual((yield* password.signIn("10.0.0.6", right, codeAt(now - 60_000)))._tag, "Rejected");
      // Codes are spent per step: once a minute has passed, a fresh code works again.
      yield* TestClock.adjust("90 seconds");
      assert.strictEqual((yield* password.signIn("10.0.0.6", right, codeAt(now + 90_000)))._tag, "Accepted");
    }).pipe(Effect.provide(memoryDatabase(SERVER_MIGRATIONS))),
  );

  it.effect("verifyTotp is throttled and counted in the sign-in guard", () =>
    Effect.gen(function* () {
      const password = yield* adminPassword({ ...DEFAULT_THROTTLE, freeFailures: 0 }, true);
      assert.strictEqual((yield* password.verifyTotp("10.0.0.1", wrongCodeAt(T0)))._tag, "Rejected");
      assert.deepStrictEqual(yield* password.signIn("10.0.0.1", right, codeAt(T0)), { _tag: "Throttled", retryAfterSeconds: 1 });
      assert.deepStrictEqual(yield* password.verifyTotp("10.0.0.1", codeAt(T0)), { _tag: "Throttled", retryAfterSeconds: 1 });
      yield* TestClock.adjust("1 second");
      assert.strictEqual((yield* password.verifyTotp("10.0.0.1", undefined))._tag, "Rejected");
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual((yield* password.verifyTotp("10.0.0.1", codeAt(T0 + 3000)))._tag, "Accepted");
    }).pipe(Effect.provide(memoryDatabase(SERVER_MIGRATIONS))),
  );

  it.effect("a password change does not wipe the code failures counted for an address", () =>
    Effect.gen(function* () {
      const password = yield* adminPassword({ ...DEFAULT_THROTTLE, freeFailures: 1 }, true);
      assert.strictEqual((yield* password.verifyTotp("10.0.0.1", wrongCodeAt(T0)))._tag, "Rejected");
      const next = Redacted.make("the next admin password");
      assert.strictEqual((yield* password.change("10.0.0.1", right, next))._tag, "Accepted");
      // Still one failure on record: the next wrong code starts the backoff.
      assert.strictEqual((yield* password.verifyTotp("10.0.0.1", wrongCodeAt(T0)))._tag, "Rejected");
      assert.deepStrictEqual(yield* password.signIn("10.0.0.1", next, codeAt(T0)), { _tag: "Throttled", retryAfterSeconds: 1 });
    }).pipe(Effect.provide(memoryDatabase(SERVER_MIGRATIONS))),
  );

  it.effect("without a secret, sign-in ignores the code and verifyTotp accepts at once", () =>
    Effect.gen(function* () {
      const password = yield* adminPassword({ ...DEFAULT_THROTTLE, freeFailures: 0 }, false);
      assert.isFalse(password.totpEnabled);
      for (let i = 0; i < 3; i++) assert.deepStrictEqual(yield* password.verifyTotp("10.0.0.1", "nonsense"), { _tag: "Accepted", value: undefined });
      assert.strictEqual((yield* password.signIn("10.0.0.1", right))._tag, "Accepted");
      assert.strictEqual((yield* password.signIn("10.0.0.1", right, "nonsense"))._tag, "Accepted");
    }).pipe(Effect.provide(memoryDatabase(SERVER_MIGRATIONS))),
  );
});

describe("totp-init output", () => {
  const run = Effect.gen(function* () {
    const io = fakeStdio("", false);
    yield* totpInitCommand().pipe(Effect.provide(io.layer));
    return io;
  });

  it.effect("prints a new base32 secret and its otpauth URI on stdout, and stores nothing", () =>
    Effect.gen(function* () {
      const io = yield* run;
      const [secret = "", uri = "", ...rest] = io.out.join("").split("\n");
      assert.deepStrictEqual(rest, [""]);
      assert.match(secret, /^[A-Z2-7]{32}$/);
      assert.strictEqual(decodeBase32(secret)?.length, 20);
      assert.strictEqual(uri, `otpauth://totp/fio-mcp:admin?secret=${secret}&issuer=fio-mcp&algorithm=SHA1&digits=6&period=30`);
      assert.include(io.err.join(""), "Nothing was stored.");
      assert.notInclude(io.err.join(""), secret);
      const again = yield* run;
      assert.notStrictEqual(again.out.join("").split("\n")[0], secret);
    }),
  );
});
