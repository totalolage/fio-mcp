import { describe, expect, it } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import type { SqlClient } from "effect/sql";
import { BoxSecretTooShort, MIN_BOX_SECRET_LENGTH } from "../../src/domain/boxes.js";
import { memoryDatabase } from "./support/database.js";
import { certificateCredentials, passwordCredentials } from "./support/fake-isds.js";
import { boxRows, startRegistry } from "./support/registry-harness.js";

/** D2: a box password or certificate passphrase shorter than 8 characters is refused before any ISDS call. */

const LOGINS = { alice: "aaa1111", "alice-new": "aaa1111", "cert-pass": "ccc3333" };

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(memoryDatabase()));

describe("box secret length (D2)", () => {
  it("is 8 characters", () => {
    expect(MIN_BOX_SECRET_LENGTH).toBe(8);
  });

  it.effect("refuses a short password at add, without logging in, registering or storing it", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry, isds, registered } = yield* startRegistry({ logins: LOGINS });
        const error = yield* Effect.flip(
          registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice", "seven77") }),
        );
        expect(error).toBeInstanceOf(BoxSecretTooShort);
        expect(error).toMatchObject({ _tag: "BoxSecretTooShort", secret: "password", minimum: 8 });
        expect(error.message).toBe("The ISDS password must be at least 8 characters long.");
        expect(error.message).not.toContain("seven77");
        expect(isds.requests).toEqual([]);
        expect(registered).not.toContain("seven77");
        expect(yield* boxRows).toEqual([]);
      }),
    ),
  );

  it.effect("refuses a short certificate passphrase at add", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry, isds } = yield* startRegistry({ logins: LOGINS });
        const error = yield* Effect.flip(
          registry.add({ label: "A", environment: "production", credentials: certificateCredentials("short") }),
        );
        expect(error).toMatchObject({ _tag: "BoxSecretTooShort", secret: "passphrase" });
        expect(error.message).toBe("The certificate passphrase must be at least 8 characters long.");
        expect(isds.requests).toEqual([]);
      }),
    ),
  );

  it.effect("counts characters, not UTF-16 units or bytes, and accepts exactly 8", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: { ...LOGINS, emoji: "eee5555" } });
        // Seven astral code points are 14 UTF-16 units: still too short.
        const astral = "😀".repeat(7);
        const short = yield* Effect.flip(
          registry.add({ label: "E", environment: "production", credentials: passwordCredentials("emoji", astral) }),
        );
        expect(short._tag).toBe("BoxSecretTooShort");
        const box = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice", "exactly8") });
        expect(box.dbId).toBe("aaa1111");
      }),
    ),
  );

  it.effect("refuses a short replacement before any ISDS call and keeps the stored credentials", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry, isds } = yield* startRegistry({ logins: LOGINS });
        const box = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        const before = yield* boxRows;
        const requests = isds.requests.length;
        const error = yield* Effect.flip(registry.replaceCredentials(box.id, passwordCredentials("alice-new", "1234567")));
        expect(error).toMatchObject({ _tag: "BoxSecretTooShort", secret: "password" });
        const certificate = yield* Effect.flip(registry.replaceCredentials(box.id, certificateCredentials("pass")));
        expect(certificate).toMatchObject({ _tag: "BoxSecretTooShort", secret: "passphrase" });
        expect(isds.requests.length).toBe(requests);
        expect(yield* boxRows).toEqual(before);
      }),
    ),
  );

  it.effect("reports a missing box before the secret length on replace", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const error = yield* Effect.flip(registry.replaceCredentials("box_missing", passwordCredentials("alice", "x")));
        expect(error._tag).toBe("BoxNotFound");
      }),
    ),
  );
});
