import { Effect, Option, Redacted, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { otpauthUri } from "../src/admin/totp.js";
import {
  ADDRESS,
  codeAt,
  DEMO_IDENTITY,
  makeDemoPassword,
  PASSWORD,
  SECRET,
  STRICT_THROTTLE,
} from "./support/demo-admin-password.js";

/**
 * The core admin password with the optional TOTP second factor, as a demo
 * app composes it: the code is checked after the password under one
 * LoginGuard permit, accepted codes are single-use across `signIn` and
 * `verifyTotp`, both share one throttle, and a password-only change keeps
 * the code failures counted so far.
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const pw = (text: string) => Redacted.make(text);
const NEW_PASSWORD = "a brand new admin password";

describe("demo app admin password", () => {
  it("needs no code and counts nothing for TOTP when no secret is configured", async () => {
    const { password } = await run(makeDemoPassword({ throttle: STRICT_THROTTLE }));
    expect(password.totpEnabled).toBe(false);
    expect((await run(password.signIn(ADDRESS, pw(PASSWORD))))._tag).toBe("Accepted");
    expect(await run(password.verifyTotp(ADDRESS, undefined))).toEqual({ _tag: "Accepted", value: undefined });
    expect(await run(password.verifyTotp(ADDRESS, "000000"))).toEqual({ _tag: "Accepted", value: undefined });
    expect((await run(password.signIn(ADDRESS, pw("wrong password"))))._tag).toBe("Rejected");
    // One failure is free under STRICT_THROTTLE: the verifyTotp calls above counted nothing.
    expect((await run(password.signIn(ADDRESS, pw(PASSWORD))))._tag).toBe("Accepted");
  });

  it("checks the code after the password and accepts each code once", async () => {
    const { password } = await run(makeDemoPassword({ totp: true }));
    expect(password.totpEnabled).toBe(true);
    const code = codeAt(0);

    expect((await run(password.signIn(ADDRESS, pw(PASSWORD))))._tag).toBe("Rejected");
    expect((await run(password.signIn(ADDRESS, pw(PASSWORD), "000000")))._tag).toBe("Rejected");
    // A wrong password stops before the code, so the code is not used up.
    expect((await run(password.signIn(ADDRESS, pw("wrong password"), code)))._tag).toBe("Rejected");

    const accepted = await run(password.signIn(ADDRESS, pw(PASSWORD), code));
    expect(accepted).toEqual({ _tag: "Accepted", value: await run(password.stamp) });
    expect((await run(password.signIn(ADDRESS, pw(PASSWORD), code)))._tag).toBe("Rejected");
  });

  it("shares the used codes between sign-in and verifyTotp", async () => {
    const { password } = await run(makeDemoPassword({ totp: true }));
    // The next step's code stays inside the window if a step boundary passes mid-test.
    const code = codeAt(0);
    const next = codeAt(1);

    expect((await run(password.signIn(ADDRESS, pw(PASSWORD), code)))._tag).toBe("Accepted");
    expect((await run(password.verifyTotp(ADDRESS, code)))._tag).toBe("Rejected");
    expect(await run(password.verifyTotp(ADDRESS, next))).toEqual({ _tag: "Accepted", value: undefined });
    expect((await run(password.verifyTotp(ADDRESS, next)))._tag).toBe("Rejected");
    expect((await run(password.signIn(ADDRESS, pw(PASSWORD), next)))._tag).toBe("Rejected");
    expect((await run(password.verifyTotp(ADDRESS, undefined)))._tag).toBe("Rejected");
  });

  it("counts verifyTotp failures in the sign-in throttle", async () => {
    const { password } = await run(makeDemoPassword({ totp: true, throttle: STRICT_THROTTLE }));
    expect((await run(password.verifyTotp(ADDRESS, "000000")))._tag).toBe("Rejected");
    expect((await run(password.verifyTotp(ADDRESS, undefined)))._tag).toBe("Rejected");
    expect((await run(password.signIn(ADDRESS, pw(PASSWORD), codeAt(0))))._tag).toBe("Throttled");
    expect((await run(password.verifyTotp(ADDRESS, codeAt(0))))._tag).toBe("Throttled");
    // Another address has its own count.
    expect((await run(password.signIn("198.51.100.9", pw(PASSWORD), codeAt(0))))._tag).toBe("Accepted");
  });

  it("keeps code failures across a password-only change", async () => {
    const { password, stored } = await run(makeDemoPassword({ totp: true, throttle: STRICT_THROTTLE }));
    expect((await run(password.verifyTotp(ADDRESS, "000000")))._tag).toBe("Rejected");

    const changed = await run(password.change(ADDRESS, pw(PASSWORD), pw(NEW_PASSWORD)));
    expect(changed._tag).toBe("Accepted");
    expect(Option.isSome(await run(Ref.get(stored)))).toBe(true);
    expect(changed).toEqual({ _tag: "Accepted", value: await run(password.stamp) });

    // Had the change cleared the first failure, this one would be free.
    expect((await run(password.verifyTotp(ADDRESS, "000000")))._tag).toBe("Rejected");
    expect((await run(password.signIn(ADDRESS, pw(NEW_PASSWORD), codeAt(0))))._tag).toBe("Throttled");
  });

  it("signs in with the stored password and both factors after a change", async () => {
    const { password } = await run(makeDemoPassword({ totp: true }));
    expect((await run(password.change(ADDRESS, pw(PASSWORD), pw(NEW_PASSWORD))))._tag).toBe("Accepted");
    expect((await run(password.signIn(ADDRESS, pw(PASSWORD), codeAt(0))))._tag).toBe("Rejected");
    expect((await run(password.signIn(ADDRESS, pw(NEW_PASSWORD), codeAt(0))))._tag).toBe("Accepted");
  });

  it("answers a concurrent sign-in with busy, uncounted", async () => {
    const { password } = await run(makeDemoPassword({ totp: true, throttle: STRICT_THROTTLE }));
    const code = codeAt(0);
    const results = await run(
      Effect.all([password.signIn(ADDRESS, pw("wrong password"), code), password.signIn(ADDRESS, pw("wrong password"), code)], {
        concurrency: "unbounded",
      }),
    );
    expect(results.map((result) => result._tag).sort()).toEqual(["Rejected", "Throttled"]);
    expect(results.find((result) => result._tag === "Throttled")).toEqual({ _tag: "Throttled", retryAfterSeconds: 1, busy: true });
    // The busy attempt was not counted: one failure is still free.
    expect((await run(password.signIn(ADDRESS, pw(PASSWORD), code)))._tag).toBe("Accepted");
  });

  it("names the app in the otpauth URI", () => {
    expect(otpauthUri(DEMO_IDENTITY, SECRET)).toBe(
      "otpauth://totp/demo-mcp:admin?secret=AEBAGBAFAYDQQCIKBMGA2DQPCAIREEYU&issuer=demo-mcp&algorithm=SHA1&digits=6&period=30",
    );
  });
});
