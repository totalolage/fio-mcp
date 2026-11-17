import { describe, expect, it } from "@effect/vitest";
import { Resources } from "@mcps/core/resources.js";
import { Context, Deferred, Effect, Fiber, Layer, Redacted, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { BoxRegistry } from "../../src/domain/boxes.js";
import { isBoxId } from "../../src/domain/ids.js";
import type { IsdsCredentials } from "../../src/isds/config.js";
import { IsdsCredentialsError } from "../../src/isds/errors.js";
import { memoryDatabase } from "./support/database.js";
import { certificateCredentials, loginKey, passwordCredentials } from "./support/fake-isds.js";
import {
  countRows,
  filingRows,
  insertAudit,
  insertFiling,
  insertNonce,
  insertTier,
  nonceRows,
} from "./support/registry-fixtures.js";
import { boxRows, startRegistry } from "./support/registry-harness.js";

const LOGINS = {
  alice: "aaa1111",
  "alice-again": "aaa1111",
  bob: "bbb2222",
  "cert-pass": "ccc3333",
  "cert-pass-2": "ccc3333",
  "other-pass": "ddd4444",
  "alice-cert": "aaa1111",
  broken: "NOT-AN-ID",
};

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(memoryDatabase()));

const sameCredentials = (actual: IsdsCredentials, expected: IsdsCredentials) => {
  expect(actual._tag).toBe(expected._tag);
  expect(loginKey(actual)).toBe(loginKey(expected));
  if (actual._tag === "Password" && expected._tag === "Password") {
    expect(Redacted.value(actual.password)).toBe(Redacted.value(expected.password));
  }
  if (actual._tag === "SystemCertificate" && expected._tag === "SystemCertificate") {
    expect(Array.from(actual.pkcs12)).toEqual(Array.from(expected.pkcs12));
  }
};

describe("BoxRegistry.add", () => {
  it.effect("logs in, stores the box under a new opaque id and lists it", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.adjust(5_000);
        const { registry, isds } = yield* startRegistry({ logins: LOGINS });
        const box = yield* registry.add({ label: "  Office  ", environment: "production", credentials: passwordCredentials("alice") });
        expect(isBoxId(box.id)).toBe(true);
        expect(box).toMatchObject({
          dbId: "aaa1111",
          label: "Office",
          environment: "production",
          authKind: "password",
          createdAt: 5_000,
          updatedAt: 5_000,
        });
        expect(box.owner.dbID).toBe("aaa1111");
        expect(isds.requests.map((r) => r.request.operation)).toEqual(["GetOwnerInfoFromLogin"]);
        expect(yield* registry.list).toEqual([box]);
        expect(yield* registry.get(box.id)).toEqual(box);
        const rows = yield* boxRows;
        expect(rows.map((row) => [row.id, row.db_id, row.label, row.label_key])).toEqual([
          [box.id, "aaa1111", "Office", "office"],
        ]);
      }),
    ),
  );

  it.effect("rejects credentials whose dbID is already stored", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const first = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        const error = yield* Effect.flip(
          registry.add({ label: "B", environment: "production", credentials: passwordCredentials("alice-again") }),
        );
        expect(error).toMatchObject({ _tag: "BoxAlreadyAdded", dbId: "aaa1111", existingBoxId: first.id });
        expect((yield* registry.list).length).toBe(1);
        expect(yield* countRows("boxes")).toBe(1);
      }),
    ),
  );

  it.effect("rejects a label another box has, ignoring case and surrounding space, before logging in", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry, isds } = yield* startRegistry({ logins: LOGINS });
        yield* registry.add({ label: "Office", environment: "production", credentials: passwordCredentials("alice") });
        const error = yield* Effect.flip(
          registry.add({ label: "  oFFICE ", environment: "production", credentials: passwordCredentials("bob") }),
        );
        expect(error).toMatchObject({ _tag: "BoxLabelTaken" });
        expect(isds.made.length).toBe(1);
        expect(yield* countRows("boxes")).toBe(1);
      }),
    ),
  );

  it.effect("refuses labels that break the rule without logging in", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry, isds } = yield* startRegistry({ logins: LOGINS });
        for (const label of ["", "   ", "x".repeat(65), "tab\there", "zero​width", "line sep"]) {
          const error = yield* Effect.flip(
            registry.add({ label, environment: "production", credentials: passwordCredentials("alice") }),
          );
          expect(error).toMatchObject({ _tag: "InvalidIdentifier", kind: "label" });
        }
        expect(isds.made.length).toBe(0);
        // 64 code points (astral characters count once) is allowed.
        const box = yield* registry.add({
          label: "😀".repeat(64),
          environment: "production",
          credentials: passwordCredentials("alice"),
        });
        expect(box.label).toBe("😀".repeat(64));
      }),
    ),
  );

  it.effect("refuses a box for the other ISDS environment", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry, isds } = yield* startRegistry({ logins: LOGINS });
        const error = yield* Effect.flip(
          registry.add({ label: "A", environment: "test", credentials: passwordCredentials("alice") }),
        );
        expect(error).toMatchObject({ _tag: "BoxEnvironmentMismatch", requested: "test", configured: "production" });
        expect(isds.made.length).toBe(0);
      }),
    ),
  );

  it.effect("propagates a login failure and stores nothing", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({
          logins: LOGINS,
          onMake: () => Effect.fail(new IsdsCredentialsError({ detail: "the PKCS#12 archive was rejected" })),
        });
        const error = yield* Effect.flip(
          registry.add({ label: "A", environment: "production", credentials: certificateCredentials("cert-pass") }),
        );
        expect(error).toBeInstanceOf(IsdsCredentialsError);
        expect(yield* registry.list).toEqual([]);
        expect(yield* countRows("boxes")).toBe(0);
      }),
    ),
  );

  it.effect("refuses a login answer without a valid dbID and stores nothing", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const error = yield* Effect.flip(
          registry.add({ label: "A", environment: "production", credentials: passwordCredentials("broken") }),
        );
        expect(error).toMatchObject({ _tag: "IsdsInvalidResponse", operation: "GetOwnerInfoFromLogin" });
        expect(yield* countRows("boxes")).toBe(0);
      }),
    ),
  );

  it.effect("gives a box re-added after removal a new id", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const first = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        yield* registry.remove(first.id);
        const again = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        expect(again.dbId).toBe(first.dbId);
        expect(again.id).not.toBe(first.id);
        expect(yield* Effect.flip(registry.get(first.id))).toMatchObject({ _tag: "BoxNotFound" });
      }),
    ),
  );
});

describe("BoxRegistry credentials", () => {
  it.effect("are sealed at rest and decrypt again on the next start, for both kinds", () =>
    withDatabase(
      Effect.gen(function* () {
        const password = passwordCredentials("alice", "hunter2-very-secret");
        const certificate = certificateCredentials("cert-pass", new TextEncoder().encode("PKCS12-ARCHIVE-BYTES"));
        const first = yield* startRegistry({ logins: LOGINS });
        const pw = yield* first.registry.add({ label: "PW", environment: "production", credentials: password });
        const cert = yield* first.registry.add({ label: "Cert", environment: "production", credentials: certificate });
        expect(cert.authKind).toBe("certificate");

        const raw = JSON.stringify(yield* boxRows);
        for (const secret of [
          "hunter2-very-secret",
          "cert-pass",
          "PKCS12-ARCHIVE-BYTES",
          Buffer.from("PKCS12-ARCHIVE-BYTES").toString("base64"),
          "username",
          "alice",
          "passphrase",
          "pkcs12",
        ]) {
          expect(raw).not.toContain(secret);
        }
        for (const row of yield* boxRows) expect(row.credentials_sealed.startsWith("v1.")).toBe(true);

        const second = yield* startRegistry({ logins: LOGINS });
        sameCredentials(yield* second.registry.credentials(pw.id), password);
        sameCredentials(yield* second.registry.credentials(cert.id), certificate);
        expect((yield* second.registry.list).map((box) => box.id)).toEqual([pw.id, cert.id]);
        expect(yield* second.registry.get(cert.id)).toEqual(cert);
      }),
    ),
  );

  it.effect("are the same object on every call until replaced", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const box = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        const before = yield* registry.credentials(box.id);
        yield* registry.relabel(box.id, "Renamed");
        expect(yield* registry.credentials(box.id)).toBe(before);

        const replacement = passwordCredentials("alice-again", "rotated-pw");
        yield* registry.replaceCredentials(box.id, replacement);
        const after = yield* registry.credentials(box.id);
        expect(after).not.toBe(before);
        sameCredentials(after, replacement);
        expect(yield* registry.credentials(box.id)).toBe(after);

        const reloaded = yield* startRegistry({ logins: LOGINS });
        const loaded = yield* reloaded.registry.credentials(box.id);
        expect(yield* reloaded.registry.credentials(box.id)).toBe(loaded);
        expect(yield* Effect.flip(registry.credentials("box_missing"))).toMatchObject({ _tag: "BoxNotFound" });
      }),
    ),
  );

  it.effect("passwords and passphrases are registered with the Redactor at load, add and replace", () =>
    withDatabase(
      Effect.gen(function* () {
        const first = yield* startRegistry({ logins: LOGINS });
        const box = yield* first.registry.add({
          label: "A",
          environment: "production",
          credentials: passwordCredentials("alice", "pw-on-add"),
        });
        expect(first.registered).toContain("pw-on-add");
        yield* first.registry.replaceCredentials(box.id, certificateCredentials("alice-cert"));
        expect(first.registered).toContain("alice-cert");
        expect(first.redactor.redact("x pw-on-add alice-cert y")).not.toMatch(/pw-on-add|alice-cert/);

        yield* first.registry.add({ label: "B", environment: "production", credentials: passwordCredentials("bob", "pw-of-bob") });
        const second = yield* startRegistry({ logins: LOGINS });
        expect(second.registered).toEqual(expect.arrayContaining(["alice-cert", "pw-of-bob"]));
        expect(second.registered).not.toContain("pw-on-add");
      }),
    ),
  );
});

describe("BoxRegistry.replaceCredentials", () => {
  it.effect("refuses credentials of another data box and leaves the box unchanged", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const box = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        const credentials = yield* registry.credentials(box.id);
        const [rowBefore] = yield* boxRows;
        const error = yield* Effect.flip(registry.replaceCredentials(box.id, passwordCredentials("bob")));
        expect(error).toMatchObject({
          _tag: "BoxIdentityMismatch",
          boxId: box.id,
          expectedDbId: "aaa1111",
          actualDbId: "bbb2222",
        });
        expect(yield* registry.get(box.id)).toEqual(box);
        expect(yield* registry.credentials(box.id)).toBe(credentials);
        expect(yield* boxRows).toEqual([rowBefore]);
      }),
    ),
  );

  it.effect("keeps the id and stores the new credentials, owner and auth kind", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const box = yield* registry.add({ label: "A", environment: "production", credentials: certificateCredentials("cert-pass") });
        yield* TestClock.adjust(60_000);
        const replacement = passwordCredentials("other-pass");
        const otherLogins = { ...LOGINS, "other-pass": "ccc3333" };
        const replacing = yield* startRegistry({ logins: otherLogins });
        const updated = yield* replacing.registry.replaceCredentials(box.id, replacement);
        expect(updated).toMatchObject({ id: box.id, dbId: "ccc3333", label: "A", authKind: "password", createdAt: 0 });
        expect(updated.updatedAt).toBe(60_000);
        expect(yield* replacing.registry.list).toEqual([updated]);
        sameCredentials(yield* replacing.registry.credentials(box.id), replacement);

        const reloaded = yield* startRegistry({ logins: otherLogins });
        sameCredentials(yield* reloaded.registry.credentials(box.id), replacement);
        expect(yield* reloaded.registry.get(box.id)).toEqual(updated);
      }),
    ),
  );

  it.effect("fails with BoxNotFound for an unknown box without logging in", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry, isds } = yield* startRegistry({ logins: LOGINS });
        const error = yield* Effect.flip(registry.replaceCredentials("box_missing", passwordCredentials("alice")));
        expect(error).toMatchObject({ _tag: "BoxNotFound", boxId: "box_missing" });
        expect(isds.made.length).toBe(0);
      }),
    ),
  );
});

describe("BoxRegistry.relabel", () => {
  it.effect("renames a box, allows a case change of its own label and refuses another box's label", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const a = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        yield* registry.add({ label: "B", environment: "production", credentials: passwordCredentials("bob") });
        yield* TestClock.adjust(1_000);
        expect(yield* registry.relabel(a.id, " a ")).toMatchObject({ id: a.id, label: "a", updatedAt: 1_000 });
        expect(yield* Effect.flip(registry.relabel(a.id, "b"))).toMatchObject({ _tag: "BoxLabelTaken" });
        expect(yield* Effect.flip(registry.relabel(a.id, ""))).toMatchObject({ _tag: "InvalidIdentifier" });
        expect(yield* Effect.flip(registry.relabel("box_missing", "C"))).toMatchObject({ _tag: "BoxNotFound" });
        expect((yield* registry.list).map((box) => box.label)).toEqual(["a", "B"]);
        expect((yield* boxRows).map((row) => row.label_key)).toEqual(["a", "b"]);
      }),
    ),
  );
});

describe("BoxRegistry.testConnection", () => {
  it.effect("pings with the stored credentials", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry, isds } = yield* startRegistry({ logins: LOGINS });
        const box = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        yield* registry.testConnection(box.id);
        const last = isds.requests.at(-1);
        expect(last?.request.operation).toBe("DummyOperation");
        expect(last?.config.credentials).toBe(yield* registry.credentials(box.id));
        expect(yield* Effect.flip(registry.testConnection("box_missing"))).toMatchObject({ _tag: "BoxNotFound" });
      }),
    ),
  );
});

describe("BoxRegistry.remove", () => {
  it.effect("deletes the box and its tiers, expires its open filings and their nonces, keeps the rest", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const gone = yield* registry.add({ label: "Gone", environment: "production", credentials: passwordCredentials("alice") });
        const kept = yield* registry.add({ label: "Kept", environment: "production", credentials: passwordCredentials("bob") });

        yield* insertTier(gone.id, "rcp0001");
        yield* insertTier(gone.id, "rcp0002");
        yield* insertTier(kept.id, "rcp0001");
        yield* insertFiling({ id: "f1-awaiting", boxId: gone.id, state: "awaiting_approval" });
        yield* insertFiling({ id: "f2-pending", boxId: gone.id, state: "pending_admin" });
        yield* insertFiling({ id: "f3-sent", boxId: gone.id, state: "sent" });
        yield* insertFiling({ id: "f4-other", boxId: kept.id, state: "awaiting_approval" });
        yield* insertNonce({ hash: "n1", filingId: "f1-awaiting", boxId: gone.id });
        yield* insertNonce({ hash: "n2", filingId: "f1-awaiting", boxId: gone.id, usedAt: 7 });
        yield* insertNonce({ hash: "n3", filingId: "f3-sent", boxId: gone.id });
        yield* insertNonce({ hash: "n4", filingId: "f4-other", boxId: kept.id });
        yield* insertAudit("a1", gone.id);
        yield* insertAudit("a2", kept.id);

        yield* TestClock.adjust(9_000);
        const removed = yield* registry.remove(gone.id);
        expect(removed).toEqual({ box: gone, expiredFilings: 2 });

        expect(yield* registry.list).toEqual([kept]);
        expect(yield* Effect.flip(registry.get(gone.id))).toMatchObject({ _tag: "BoxNotFound" });
        expect(yield* Effect.flip(registry.credentials(gone.id))).toMatchObject({ _tag: "BoxNotFound" });
        expect((yield* boxRows).map((row) => row.id)).toEqual([kept.id]);

        const sql = yield* SqlClient.SqlClient;
        const tiers = yield* sql<{ readonly box_id: string }>`SELECT box_id FROM recipient_tiers`;
        expect(tiers.map((row) => row.box_id)).toEqual([kept.id]);

        expect(yield* filingRows).toEqual([
          { id: "f1-awaiting", state: "expired", payload_sealed: null, updated_at: 9_000 },
          { id: "f2-pending", state: "expired", payload_sealed: null, updated_at: 9_000 },
          { id: "f3-sent", state: "sent", payload_sealed: "sealed-f3-sent", updated_at: 1 },
          { id: "f4-other", state: "awaiting_approval", payload_sealed: "sealed-f4-other", updated_at: 1 },
        ]);
        expect(yield* nonceRows).toEqual([
          { nonce_hash: "n1", used_at: 9_000 },
          { nonce_hash: "n2", used_at: 7 },
          { nonce_hash: "n3", used_at: null },
          { nonce_hash: "n4", used_at: null },
        ]);
        expect(yield* countRows("audit_log")).toBe(2);
        expect(yield* Effect.flip(registry.remove(gone.id))).toMatchObject({ _tag: "BoxNotFound" });
      }),
    ),
  );
});

describe("BoxRegistry loading", () => {
  it.effect("does not load boxes of the other environment and reports them as skipped", () =>
    withDatabase(
      Effect.gen(function* () {
        const testEnv = yield* startRegistry({ logins: LOGINS, environment: "test" });
        const testBox = yield* testEnv.registry.add({
          label: "Sandbox",
          environment: "test",
          credentials: passwordCredentials("alice"),
        });

        const production = yield* startRegistry({ logins: LOGINS });
        expect(yield* production.registry.list).toEqual([]);
        expect(yield* production.registry.skipped).toEqual([
          { id: testBox.id, dbId: "aaa1111", label: "Sandbox", environment: "test" },
        ]);
        expect(yield* Effect.flip(production.registry.get(testBox.id))).toMatchObject({ _tag: "BoxNotFound" });
        expect(production.registered).not.toContain("secret-of-alice");
        const warning = production.logs.find((line) => line.includes("level=WARN"));
        expect(warning).toContain("not loaded");
        expect(warning).toContain(testBox.id);

        // The skipped row still holds its dbID and label.
        const duplicate = yield* Effect.flip(
          production.registry.add({ label: "Other", environment: "production", credentials: passwordCredentials("alice") }),
        );
        expect(duplicate).toMatchObject({ _tag: "BoxAlreadyAdded", existingBoxId: testBox.id });
        expect(yield* testEnv.registry.skipped).toEqual([]);
      }),
    ),
  );

  it.effect("fails with BoxCredentialsUnreadable when a sealed value was altered", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const box = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* boxRows;
        const parts = (row?.credentials_sealed ?? "").split(".");
        const ciphertext = parts[2] ?? "";
        const flipped = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
        yield* sql`UPDATE boxes SET credentials_sealed = ${[parts[0], parts[1], flipped, parts[3]].join(".")}`;
        expect(yield* Effect.flip(startRegistry({ logins: LOGINS }))).toMatchObject({
          _tag: "BoxCredentialsUnreadable",
          boxId: box.id,
        });
        yield* sql`UPDATE boxes SET credentials_sealed = ${"not-a-sealed-value"}`;
        expect(yield* Effect.flip(startRegistry({ logins: LOGINS }))).toMatchObject({ _tag: "BoxCredentialsUnreadable" });
      }),
    ),
  );

  it.effect("fails with BoxCredentialsUnreadable when sealed credentials were moved to another box", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const a = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        const b = yield* registry.add({ label: "B", environment: "production", credentials: passwordCredentials("bob") });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE boxes SET credentials_sealed = (SELECT credentials_sealed FROM boxes WHERE id = ${a.id}) WHERE id = ${b.id}`;
        expect(yield* Effect.flip(startRegistry({ logins: LOGINS }))).toMatchObject({
          _tag: "BoxCredentialsUnreadable",
          boxId: b.id,
        });
      }),
    ),
  );
});

describe("BoxRegistry list, changes and resources", () => {
  it.effect("keeps the same list value until a change and streams every new one", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const empty = yield* registry.list;
        expect(yield* registry.list).toBe(empty);

        const seen = yield* Effect.forkChild(Stream.runCollect(Stream.take(registry.changes, 3)), {
          startImmediately: true,
        });
        const box = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        const afterAdd = yield* registry.list;
        expect(afterAdd).not.toBe(empty);
        expect(yield* registry.list).toBe(afterAdd);
        yield* registry.testConnection(box.id);
        expect(yield* registry.list).toBe(afterAdd);
        yield* registry.relabel(box.id, "B");
        const lists = yield* Fiber.join(seen);
        expect(Array.from(lists).map((list) => list.map((b) => b.label))).toEqual([[], ["A"], ["B"]]);
      }),
    ),
  );

  it.effect("maps boxes to core Resources by id and label, same array until a change", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry, context } = yield* startRegistry({ logins: LOGINS });
        const resourcesContext = yield* Layer.build(BoxRegistry.resources).pipe(Effect.provideContext(context));
        const resources = Context.get(resourcesContext, Resources);
        const box = yield* registry.add({ label: "Office", environment: "production", credentials: passwordCredentials("alice") });
        const first = yield* resources.list;
        expect(first).toEqual([{ id: box.id, label: "Office" }]);
        expect(yield* resources.list).toBe(first);
        const seen = yield* Effect.forkChild(Stream.runCollect(Stream.take(resources.changes, 2)), {
          startImmediately: true,
        });
        yield* registry.remove(box.id);
        const lists = yield* Fiber.join(seen);
        expect(Array.from(lists)).toEqual([[{ id: box.id, label: "Office" }], []]);
        expect(Array.from(lists)[0]).toBe(first);
      }),
    ),
  );
});

describe("BoxRegistry changes under interruption", () => {
  /** Holds the database connection in a transaction until `release` completes. */
  const holdDatabase = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const release = yield* Deferred.make<void>();
    const held = yield* Effect.forkChild(sql.withTransaction(Deferred.await(release)), { startImmediately: true });
    return {
      release: Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(held))),
    };
  });

  it.effect("a remove interrupted while its write waits for the database still lands in memory and storage", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const box = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        const database = yield* holdDatabase;
        const removing = yield* Effect.forkChild(registry.remove(box.id), { startImmediately: true });
        expect((yield* registry.list).length).toBe(1);
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(removing), { startImmediately: true });
        yield* database.release;
        yield* Fiber.join(interrupting);
        expect(yield* registry.list).toEqual([]);
        expect(yield* Effect.flip(registry.credentials(box.id))).toMatchObject({ _tag: "BoxNotFound" });
        expect(yield* countRows("boxes")).toBe(0);
      }),
    ),
  );
});

describe("BoxRegistry edge cases", () => {
  it.effect("registers the secret of an add whose login fails", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry, registered } = yield* startRegistry({
          logins: LOGINS,
          onMake: () => Effect.fail(new IsdsCredentialsError({ detail: "rejected" })),
        });
        yield* Effect.flip(
          registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice", "failed-pw") }),
        );
        expect(registered).toContain("failed-pw");
      }),
    ),
  );

  it.effect("a skipped box of the other environment still holds its label", () =>
    withDatabase(
      Effect.gen(function* () {
        const testEnv = yield* startRegistry({ logins: LOGINS, environment: "test" });
        yield* testEnv.registry.add({ label: "Sandbox", environment: "test", credentials: passwordCredentials("alice") });
        const production = yield* startRegistry({ logins: LOGINS });
        const error = yield* Effect.flip(
          production.registry.add({ label: "SANDBOX", environment: "production", credentials: passwordCredentials("bob") }),
        );
        expect(error).toMatchObject({ _tag: "BoxLabelTaken" });
      }),
    ),
  );

  it.effect("fails startup with DomainStoreError when a stored owner does not decode", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE boxes SET owner_json = ${"{not json"}`;
        expect(yield* Effect.flip(startRegistry({ logins: LOGINS }))).toMatchObject({ _tag: "DomainStoreError" });
      }),
    ),
  );

  it.effect("of two concurrent adds of the same data box exactly one is stored", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const results = yield* Effect.all(
          [
            Effect.result(registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") })),
            Effect.result(
              registry.add({ label: "B", environment: "production", credentials: passwordCredentials("alice-again") }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const stored = yield* registry.list;
        expect(stored.length).toBe(1);
        expect(results.filter((result) => result._tag === "Success").length).toBe(1);
        const failure = results.find((result) => result._tag === "Failure");
        expect(failure?._tag === "Failure" ? failure.failure : undefined).toMatchObject({
          _tag: "BoxAlreadyAdded",
          existingBoxId: stored[0]?.id,
        });
        expect(yield* countRows("boxes")).toBe(1);
      }),
    ),
  );

  it.effect("a remove that fails part way changes nothing", () =>
    withDatabase(
      Effect.gen(function* () {
        const { registry } = yield* startRegistry({ logins: LOGINS });
        const box = yield* registry.add({ label: "A", environment: "production", credentials: passwordCredentials("alice") });
        yield* insertTier(box.id, "rcp0001");
        yield* insertFiling({ id: "f1", boxId: box.id, state: "awaiting_approval" });
        yield* insertNonce({ hash: "n1", filingId: "f1", boxId: box.id });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER refuse_box_delete BEFORE DELETE ON boxes BEGIN SELECT RAISE(ABORT, 'refused'); END`;
        expect(yield* Effect.flip(registry.remove(box.id))).toMatchObject({ _tag: "DomainStoreError" });
        expect(yield* registry.list).toEqual([box]);
        expect(yield* countRows("recipient_tiers")).toBe(1);
        expect((yield* filingRows).map((row) => [row.state, row.payload_sealed])).toEqual([["awaiting_approval", "sealed-f1"]]);
        expect((yield* nonceRows).map((row) => row.used_at)).toEqual([null]);
      }),
    ),
  );
});
