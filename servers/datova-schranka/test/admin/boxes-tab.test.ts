import type { LoginResult } from "@mcps/core/oauth/login.js";
import { Redactor } from "@mcps/core/redaction.js";
import { Effect, Fiber, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BOX_FORM_MAX_BYTES, boxesTab } from "../../src/admin/boxes-tab.js";
import { type AuditEntry, AuditLog } from "../../src/domain/audit-log.js";
import { BoxRegistry } from "../../src/domain/boxes.js";
import { newBoxId } from "../../src/domain/ids.js";
import { IsdsCredentialsError } from "../../src/isds/errors.js";
import { loginResponder } from "../domain/support/fake-isds.js";
import { createTestPki, type TestPki } from "../isds/support/pki.js";
import { AdminBrowser, type AdminHarness, type AdminHarnessOptions, multipart, startAdmin } from "./support/admin-harness.js";

/**
 * The Boxes tab through core's admin server: every action, its audit row,
 * duplicate and short-secret refusals, the second factor of destructive
 * actions, the 256 KiB form cap, and that no secret ever reaches a page, a
 * message, an audit row or a log line.
 */

const PASSWORD_A = "alice-password-9f2c";
const PASSWORD_B = "bob-password-77d1";
const LOGINS = { alice: "aaa1111", "alice-new": "aaa1111", bob: "bbb2222", carol: "ccc3333" };

let pki: TestPki;
beforeAll(() => {
  pki = createTestPki();
});

let app: AdminHarness | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const start = async (options: AdminHarnessOptions = {}) => {
  app = await startAdmin(
    Effect.map(boxesTab, (tab) => [tab]),
    { logins: { ...LOGINS, [pki.clientPassphrase]: "ppp9999" }, ...options },
  );
  const browser = new AdminBrowser(app);
  expect((await browser.signIn()).status).toBe(303);
  await browser.get("/admin");
  return { app, browser };
};

const passwordForm = (label: string, username: string, password: string, extra: Record<string, string> = {}) =>
  multipart({ label, auth: "password", username, password, passphrase: "", ...extra });

const audits = (harness: AdminHarness) =>
  harness.run(Effect.flatMap(AuditLog, (log) => log.list())).then((page) => [...page.entries].reverse());

const boxes = (harness: AdminHarness) => harness.run(Effect.flatMap(BoxRegistry, (registry) => registry.list));

/** Every page the browser saw, every log line and every audit row, as one text. */
const everything = async (harness: AdminHarness, browser: AdminBrowser) =>
  [...browser.pages, ...harness.logs, JSON.stringify(await audits(harness))].join("\n");

const addAlice = async (browser: AdminBrowser) => {
  const added = await browser.actMultipart("/admin/boxes/add", passwordForm("Office", "alice", PASSWORD_A));
  expect(added.flash?.kind).toBe("ok");
  const [box] = await boxes(app as AdminHarness);
  if (box === undefined) throw new Error("no box added");
  return box;
};

const rowSummary = (entry: AuditEntry) => ({ action: entry.action, outcome: entry.outcome, actorKind: entry.actorKind, boxId: entry.boxId });

describe("Boxes tab page", () => {
  it("is the landing page with a multipart add form and no second-factor field without TOTP", async () => {
    const { browser } = await start();
    const page = await browser.get("/admin");
    expect(page.status).toBe(200);
    expect(page.html).toContain("<h1>Data boxes</h1>");
    expect(page.html).toContain("No data boxes yet.");
    expect(page.html).toMatch(/action="\/admin\/boxes\/add" enctype="multipart\/form-data"/);
    expect(page.html).toContain('name="certificate"');
    expect(page.html).not.toContain('name="totp"');
  });

  it("lists a box with dbID, owner, type, sign-in kind, environment and escaped values", async () => {
    const { app, browser } = await start();
    await browser.actMultipart("/admin/boxes/add", passwordForm(`<b>"Office"</b>`, "alice", PASSWORD_A));
    const page = await browser.get("/admin");
    expect(page.html).toContain("&lt;b&gt;&quot;Office&quot;&lt;/b&gt;");
    expect(page.html).not.toContain(`<b>"Office"</b>`);
    expect(page.html).toContain("<code>aaa1111</code>");
    expect(page.html).toContain("Příklad &amp; syn s.r.o., IČO 12345678, Praha");
    expect(page.html).toContain("<td>PO</td>");
    expect(page.html).toContain("Username and password");
    expect(page.html).toContain("<td>production</td>");
    expect(await everything(app, browser)).not.toContain(PASSWORD_A);
  });

  it("asks for the authenticator code on replace and remove when TOTP is configured", async () => {
    const { browser } = await start({ password: (real) => ({ ...real, totpEnabled: true }) });
    await addAlice(browser);
    const page = await browser.get("/admin");
    expect(page.html.match(/name="totp"/g)?.length).toBe(2);
  });

  it("warns about stored boxes of another ISDS environment, which are not loaded", async () => {
    const seed = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO boxes ${sql.insert({
        id: newBoxId(),
        db_id: "ttt0000",
        label: "Sandbox <test>",
        label_key: "sandbox <test>",
        environment: "test",
        box_type: "PO",
        auth_kind: "password",
        owner_json: "{}",
        credentials_sealed: "not-decryptable",
        created_at: 1,
        updated_at: 1,
      })}`;
    }).pipe(Effect.orDie);
    const { app, browser } = await start({ seed });
    const page = await browser.get("/admin");
    expect(page.html).toContain('role="alert"');
    expect(page.html).toContain("One stored data box is");
    expect(page.html).toContain("Sandbox &lt;test&gt; (<code>ttt0000</code>, test)");
    expect(await boxes(app)).toEqual([]);
  });
});

describe("adding a box", () => {
  it("signs in with username and password and shows the dbID and owner", async () => {
    const { app, browser } = await start();
    const added = await browser.actMultipart("/admin/boxes/add", passwordForm("Office", "alice", PASSWORD_A));
    expect(added.flash).toEqual({
      kind: "ok",
      text: "Added “Office”: data box aaa1111, Příklad & syn s.r.o., IČO 12345678, Praha. Clients reach it once they are authorized for it.",
    });
    const [box] = await boxes(app);
    expect(box).toMatchObject({ label: "Office", dbId: "aaa1111", authKind: "password", environment: "production" });
    expect(app.isds.requests.map((entry) => entry.request.operation)).toEqual(["GetOwnerInfoFromLogin"]);
    expect((await audits(app)).map(rowSummary)).toEqual([{ action: "box_add", outcome: "ok", actorKind: "admin", boxId: box?.id }]);
    expect(await everything(app, browser)).not.toContain(PASSWORD_A);
  });

  it("uploads a PKCS#12 certificate byte for byte and signs in with its passphrase", async () => {
    const { app, browser } = await start();
    const form = multipart(
      { label: "Certified", auth: "certificate", username: "", password: "", passphrase: pki.clientPassphrase },
      { certificate: { name: "client.p12", bytes: pki.clientPkcs12 } },
    );
    const added = await browser.actMultipart("/admin/boxes/add", form);
    expect(added.flash?.kind).toBe("ok");
    expect(added.flash?.text).toContain("data box ppp9999");
    const [box] = await boxes(app);
    expect(box?.authKind).toBe("certificate");
    const stored = await app.run(Effect.flatMap(BoxRegistry, (registry) => registry.credentials(box?.id ?? "")));
    if (stored._tag !== "SystemCertificate") throw new Error("not a certificate");
    expect(Buffer.from(stored.pkcs12).equals(Buffer.from(pki.clientPkcs12))).toBe(true);
    expect(Redacted.value(stored.passphrase)).toBe(pki.clientPassphrase);
    const page = await browser.get("/admin");
    expect(page.html).toContain("System certificate");
    const text = await everything(app, browser);
    expect(text).not.toContain(pki.clientPassphrase);
    expect(text).not.toContain(Buffer.from(pki.clientPkcs12).toString("base64").slice(0, 40));
  });

  it("rejects a second box with the same dbID or the same label, with clear messages", async () => {
    const { app, browser } = await start();
    await addAlice(browser);
    const sameBox = await browser.actMultipart("/admin/boxes/add", passwordForm("Other", "alice-new", PASSWORD_B));
    expect(sameBox.flash).toEqual({ kind: "error", text: "Not added: Data box aaa1111 is already added." });
    const sameLabel = await browser.actMultipart("/admin/boxes/add", passwordForm(" office ", "bob", PASSWORD_B));
    expect(sameLabel.flash).toEqual({ kind: "error", text: 'Not added: A data box labelled "office" already exists.' });
    expect((await boxes(app)).map((box) => box.label)).toEqual(["Office"]);
    expect((await audits(app)).map((entry) => [entry.action, entry.outcome])).toEqual([
      ["box_add", "ok"],
      ["box_add", "refused"],
      ["box_add", "refused"],
    ]);
    expect(await everything(app, browser)).not.toContain(PASSWORD_B);
  });

  it("refuses a password or passphrase shorter than 8 characters before signing in", async () => {
    const { app, browser } = await start();
    const short = await browser.actMultipart("/admin/boxes/add", passwordForm("Office", "alice", "short77"));
    expect(short.flash).toEqual({ kind: "error", text: "Not added: The ISDS password must be at least 8 characters long." });
    const form = multipart(
      { label: "Certified", auth: "certificate", passphrase: "tiny" },
      { certificate: { name: "client.p12", bytes: pki.clientPkcs12 } },
    );
    const shortPassphrase = await browser.actMultipart("/admin/boxes/add", form);
    expect(shortPassphrase.flash).toEqual({ kind: "error", text: "Not added: The certificate passphrase must be at least 8 characters long." });
    expect(app.isds.requests).toEqual([]);
    expect(await boxes(app)).toEqual([]);
    const rows = await audits(app);
    expect(rows.map((entry) => [entry.action, entry.outcome])).toEqual([
      ["box_add", "refused"],
      ["box_add", "refused"],
    ]);
    expect(rows[0]?.detail).toMatchObject({ error: "BoxSecretTooShort", authKind: "password" });
    expect(rows[0]?.detail).not.toHaveProperty("label");
    expect(await everything(app, browser)).not.toContain("short77");
  });

  it("refuses incomplete forms without signing in", async () => {
    const { app, browser } = await start();
    const cases: Array<[FormData, string]> = [
      [multipart({ label: "A" }), "Not added: Choose how the box signs in: username and password, or a certificate."],
      [passwordForm("A", "", PASSWORD_A), "Not added: Enter the ISDS username."],
      [passwordForm("A", "alice", ""), "Not added: Enter the ISDS password."],
      [multipart({ label: "A", auth: "certificate", passphrase: pki.clientPassphrase }), "Not added: Choose the PKCS#12 certificate file (.p12 or .pfx)."],
      [
        multipart({ label: "A", auth: "certificate", passphrase: pki.clientPassphrase }, { certificate: { name: "", bytes: new Uint8Array() } }),
        "Not added: Choose the PKCS#12 certificate file (.p12 or .pfx).",
      ],
      [
        multipart({ label: "A", auth: "certificate", passphrase: "" }, { certificate: { name: "c.p12", bytes: pki.clientPkcs12 } }),
        "Not added: Enter the certificate passphrase.",
      ],
    ];
    for (const [form, text] of cases) {
      expect((await browser.actMultipart("/admin/boxes/add", form)).flash).toEqual({ kind: "error", text });
    }
    expect(app.isds.requests).toEqual([]);
    expect((await audits(app)).map((entry) => entry.outcome)).toEqual(cases.map(() => "refused"));
  });

  it("shows a failed ISDS sign-in as a redacted summary and records an error", async () => {
    const { app, browser } = await start({
      onMake: (config) =>
        Effect.fail(
          new IsdsCredentialsError({
            detail: `could not open the key with ${config.credentials._tag === "Password" ? Redacted.value(config.credentials.password) : "?"}`,
          }),
        ),
    });
    const failed = await browser.actMultipart("/admin/boxes/add", passwordForm("Office", "alice", PASSWORD_A));
    expect(failed.flash?.kind).toBe("error");
    expect(failed.flash?.text).toMatch(/^Not added: The ISDS credentials could not be used: could not open the key with /);
    expect(failed.flash?.text).not.toContain(PASSWORD_A);
    const [row] = await audits(app);
    expect(row).toMatchObject({ action: "box_add", outcome: "error", detail: { error: "IsdsCredentialsError" } });
    expect(await everything(app, browser)).not.toContain(PASSWORD_A);
    expect(await boxes(app)).toEqual([]);
  });

  it("refuses a form over 256 KiB without running the action", async () => {
    const { app, browser } = await start();
    const big = multipart(
      { label: "Huge", auth: "certificate", passphrase: pki.clientPassphrase },
      { certificate: { name: "huge.p12", bytes: new Uint8Array(BOX_FORM_MAX_BYTES + 1) } },
    );
    const refused = await browser.postMultipart("/admin/boxes/add", big);
    expect(refused.status).toBe(403);
    expect(app.isds.requests).toEqual([]);
    expect(await boxes(app)).toEqual([]);
    expect(await audits(app)).toEqual([]);
    // Just under the cap is read and reaches the action.
    await browser.get("/admin");
    const fits = multipart(
      { label: "Fits", auth: "certificate", passphrase: pki.clientPassphrase },
      { certificate: { name: "fits.p12", bytes: new Uint8Array(BOX_FORM_MAX_BYTES - 4096).fill(1) } },
    );
    expect((await browser.actMultipart("/admin/boxes/add", fits)).flash?.kind).toBe("ok");
  });
});

describe("changing a box", () => {
  it("renames a box and refuses a taken label", async () => {
    const { app, browser } = await start();
    const box = await addAlice(browser);
    await browser.actMultipart("/admin/boxes/add", passwordForm("Archive", "bob", PASSWORD_B));
    expect((await browser.act("/admin/boxes/relabel", { box: box.id, label: "Main office" })).flash).toEqual({
      kind: "ok",
      text: "Renamed “Office” to “Main office”.",
    });
    expect((await browser.act("/admin/boxes/relabel", { box: box.id, label: "archive" })).flash).toEqual({
      kind: "error",
      text: 'Not renamed: A data box labelled "archive" already exists.',
    });
    const missing = newBoxId();
    expect((await browser.act("/admin/boxes/relabel", { box: missing, label: "X" })).flash?.text).toMatch(/^Not renamed: /);
    expect((await browser.act("/admin/boxes/relabel", { box: "<not an id>".repeat(100), label: "X" })).flash?.text).toMatch(/^Not renamed: /);
    const rows = (await audits(app)).filter((entry) => entry.action === "box_relabel");
    expect(rows.map((entry) => [entry.outcome, entry.boxId])).toEqual([
      ["ok", box.id],
      ["refused", box.id],
      ["refused", missing],
      ["refused", undefined],
    ]);
    expect(rows[0]?.detail).toEqual({ from: "Office", to: "Main office", dbId: "aaa1111" });
  });

  it("replaces credentials that sign in to the same dbID and refuses another box's", async () => {
    const { app, browser } = await start();
    const box = await addAlice(browser);
    const replaced = await browser.actMultipart("/admin/boxes/credentials", passwordForm("", "alice-new", PASSWORD_B, { box: box.id }));
    expect(replaced.flash).toEqual({ kind: "ok", text: "Replaced the credentials of “Office” (data box aaa1111)." });
    const mismatch = await browser.actMultipart("/admin/boxes/credentials", passwordForm("", "carol", "carol-password-1", { box: box.id }));
    expect(mismatch.flash).toEqual({
      kind: "error",
      text: "Not replaced: The new credentials log in to data box ccc3333, not aaa1111; add it as a new box instead.",
    });
    const short = await browser.actMultipart("/admin/boxes/credentials", passwordForm("", "alice-new", "sh0rt-7", { box: box.id }));
    expect(short.flash?.text).toBe("Not replaced: The ISDS password must be at least 8 characters long.");
    const stored = await app.run(Effect.flatMap(BoxRegistry, (registry) => registry.credentials(box.id)));
    expect(stored._tag === "Password" && stored.username).toBe("alice-new");
    expect((await audits(app)).filter((entry) => entry.action === "box_replace_credentials").map((entry) => entry.outcome)).toEqual([
      "ok",
      "refused",
      "refused",
    ]);
    const text = await everything(app, browser);
    for (const secret of [PASSWORD_A, PASSWORD_B, "carol-password-1", "sh0rt-7"]) expect(text).not.toContain(secret);
  });

  it("tests the connection and reports a failure", async () => {
    let failing = false;
    const { app, browser } = await start({
      onMake: () => (failing ? Effect.fail(new IsdsCredentialsError({ detail: "the certificate expired" })) : Effect.void),
    });
    const box = await addAlice(browser);
    expect((await browser.act("/admin/boxes/test", { box: box.id })).flash).toEqual({
      kind: "ok",
      text: "ISDS accepted the credentials of “Office” (data box aaa1111).",
    });
    failing = true;
    const failed = await browser.act("/admin/boxes/test", { box: box.id });
    expect(failed.flash?.kind).toBe("error");
    expect(failed.flash?.text).toMatch(/^Connection test failed: /);
    expect((await audits(app)).filter((entry) => entry.action === "box_test").map((entry) => entry.outcome)).toEqual(["ok", "error"]);
  });
});

describe("destructive actions and the second factor", () => {
  it("removes a confirmed box, shows the expired filings and keeps the audit rows", async () => {
    const { app, browser } = await start();
    const box = await addAlice(browser);
    expect((await browser.act("/admin/boxes/remove", { box: box.id })).flash).toEqual({
      kind: "error",
      text: "Tick the box to confirm the removal.",
    });
    expect(await boxes(app)).toHaveLength(1);
    const removed = await browser.act("/admin/boxes/remove", { box: box.id, confirm: "yes" });
    expect(removed.flash).toEqual({ kind: "ok", text: "Removed “Office” (data box aaa1111). 0 filings waiting for approval expired." });
    expect(await boxes(app)).toEqual([]);
    const rows = await audits(app);
    expect(rows.map((entry) => [entry.action, entry.outcome])).toEqual([
      ["box_add", "ok"],
      ["box_remove", "refused"],
      ["box_remove", "ok"],
    ]);
    expect(rows[2]?.detail).toEqual({ label: "Office", dbId: "aaa1111", expiredFilings: 0 });
  });

  it("does not remove or replace credentials unless the second factor is accepted", async () => {
    let factor: LoginResult<void> = { _tag: "Rejected" };
    const checked: Array<string> = [];
    const { app, browser } = await start({
      secondFactor: (_request, form) => {
        checked.push(form.get("totp") ?? "");
        return Effect.succeed(factor);
      },
    });
    const box = await addAlice(browser);
    const requests = app.isds.requests.length;
    const replace = await browser.actMultipart("/admin/boxes/credentials", passwordForm("", "alice-new", PASSWORD_B, { box: box.id, totp: "000000" }));
    expect(replace.flash).toEqual({ kind: "error", text: "The authentication code is missing or wrong. The credentials were not replaced." });
    expect(app.isds.requests.length).toBe(requests);
    const remove = await browser.act("/admin/boxes/remove", { box: box.id, confirm: "yes", totp: "000000" });
    expect(remove.flash).toEqual({ kind: "error", text: "The authentication code is missing or wrong. Nothing was removed." });
    factor = { _tag: "Throttled", retryAfterSeconds: 30 };
    expect((await browser.act("/admin/boxes/remove", { box: box.id, confirm: "yes" })).flash?.text).toBe(
      "Too many failed attempts. Try again in 30 s. Nothing was removed.",
    );
    factor = { _tag: "Unavailable" };
    expect((await browser.act("/admin/boxes/remove", { box: box.id, confirm: "yes" })).flash?.text).toBe(
      "The authentication code could not be checked. Nothing was removed.",
    );
    expect(await boxes(app)).toHaveLength(1);
    const stored = await app.run(Effect.flatMap(BoxRegistry, (registry) => registry.credentials(box.id)));
    expect(stored._tag === "Password" && stored.username).toBe("alice");
    factor = { _tag: "Accepted", value: undefined };
    expect((await browser.act("/admin/boxes/remove", { box: box.id, confirm: "yes", totp: "123456" })).flash?.kind).toBe("ok");
    expect(checked).toEqual(["000000", "000000", "", "", "123456"]);
    const rows = (await audits(app)).filter((entry) => entry.action !== "box_add");
    expect(rows.map((entry) => [entry.action, entry.outcome])).toEqual([
      ["box_replace_credentials", "refused"],
      ["box_remove", "refused"],
      ["box_remove", "refused"],
      ["box_remove", "refused"],
      ["box_remove", "ok"],
    ]);
    // Rename and test are not destructive: no second factor.
    expect(checked).toHaveLength(5);
  });

  it("does not ask for the second factor of an incomplete replacement form", async () => {
    const checked: Array<string> = [];
    const { browser } = await start({
      secondFactor: () => {
        checked.push("checked");
        return Effect.succeed<LoginResult<void>>({ _tag: "Accepted", value: undefined });
      },
    });
    const box = await addAlice(browser);
    const incomplete = await browser.actMultipart("/admin/boxes/credentials", passwordForm("", "alice-new", "", { box: box.id }));
    expect(incomplete.flash?.text).toBe("Not replaced: Enter the ISDS password.");
    expect(checked).toEqual([]);
  });
});

describe("every admin action is audited once", () => {
  it("writes one admin row per posted action", async () => {
    const { app, browser } = await start();
    const box = await addAlice(browser);
    await browser.act("/admin/boxes/relabel", { box: box.id, label: "Renamed" });
    await browser.act("/admin/boxes/test", { box: box.id });
    await browser.actMultipart("/admin/boxes/credentials", passwordForm("", "alice-new", PASSWORD_B, { box: box.id }));
    await browser.act("/admin/boxes/remove", { box: box.id, confirm: "yes" });
    const rows = await audits(app);
    expect(rows.map(rowSummary)).toEqual(
      ["box_add", "box_relabel", "box_test", "box_replace_credentials", "box_remove"].map((action) => ({
        action,
        outcome: "ok",
        actorKind: "admin",
        boxId: box.id,
      })),
    );
    const text = await everything(app, browser);
    for (const secret of [PASSWORD_A, PASSWORD_B]) expect(text).not.toContain(secret);
  });
});

describe("council follow-ups", () => {
  it("never stores a label that holds the box's password or passphrase", async () => {
    const { app, browser } = await start();
    const added = await browser.actMultipart("/admin/boxes/add", passwordForm(`My ${PASSWORD_A.toUpperCase()}`, "alice", PASSWORD_A));
    expect(added.flash).toEqual({ kind: "error", text: "Not added: A box label must not contain a box's password or passphrase." });
    expect(app.isds.requests).toEqual([]);
    const box = await addAlice(browser);
    const renamed = await browser.act("/admin/boxes/relabel", { box: box.id, label: PASSWORD_A });
    expect(renamed.flash).toEqual({ kind: "error", text: "Not renamed: A box label must not contain a box's password or passphrase." });
    const checked: Array<string> = [];
    await app.close();
    const restarted = await start({
      secondFactor: () => {
        checked.push("checked");
        return Effect.succeed<LoginResult<void>>({ _tag: "Accepted", value: undefined });
      },
    });
    await restarted.browser.actMultipart("/admin/boxes/add", passwordForm("Office password-1234", "alice", PASSWORD_A));
    const [stored] = await boxes(restarted.app);
    const replaced = await restarted.browser.actMultipart(
      "/admin/boxes/credentials",
      passwordForm("", "alice-new", "password-1234", { box: stored?.id ?? "" }),
    );
    expect(replaced.flash).toEqual({ kind: "error", text: "Not replaced: A box label must not contain a box's password or passphrase." });
    expect(checked).toEqual([]);
    expect((await audits(restarted.app)).map((entry) => [entry.action, entry.outcome])).toEqual([
      ["box_add", "ok"],
      ["box_replace_credentials", "refused"],
    ]);
    const refusal = (await audits(restarted.app))[1];
    expect(JSON.stringify(refusal?.detail)).not.toContain("password-1234");
    expect(JSON.stringify(await audits(restarted.app))).not.toContain(PASSWORD_A);
  });

  it("refuses a short replacement secret before using up the second factor", async () => {
    const checked: Array<string> = [];
    const { browser } = await start({
      secondFactor: () => {
        checked.push("checked");
        return Effect.succeed<LoginResult<void>>({ _tag: "Accepted", value: undefined });
      },
    });
    const box = await addAlice(browser);
    const short = await browser.actMultipart("/admin/boxes/credentials", passwordForm("", "alice-new", "sh0rt-7", { box: box.id }));
    expect(short.flash?.text).toBe("Not replaced: The ISDS password must be at least 8 characters long.");
    expect(checked).toEqual([]);
  });

  it("finishes a committed add and writes its audit row when the request is interrupted", async () => {
    let entered: () => void = () => undefined;
    const signingIn = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = loginResponder(LOGINS);
    const { app } = await start({
      respond: (config, request) =>
        Effect.sync(() => entered()).pipe(
          Effect.andThen(Effect.promise(() => gate)),
          Effect.andThen(base(config, request)),
        ),
    });
    const exit = await app.run(
      Effect.gen(function* () {
        const tab = yield* boxesTab;
        const add = tab.actions.find((action) => action.path === "/admin/boxes/add");
        if (add === undefined) return yield* Effect.die("no add action");
        const form = new URLSearchParams({ label: "Office", auth: "password", username: "alice", password: PASSWORD_A });
        const accepted = Effect.succeed<LoginResult<void>>({ _tag: "Accepted", value: undefined });
        const fiber = yield* Effect.forkChild(add.run(form, { checkSecondFactor: accepted, files: [] }), { startImmediately: true });
        yield* Effect.promise(() => signingIn);
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
        release();
        yield* Fiber.join(interrupting);
        return yield* Fiber.await(fiber);
      }),
    );
    // The interruption waited for the action; the fiber still ends interrupted.
    expect(exit._tag).toBe("Failure");
    const [box] = await boxes(app);
    expect(box?.dbId).toBe("aaa1111");
    expect((await audits(app)).map(rowSummary)).toEqual([{ action: "box_add", outcome: "ok", actorKind: "admin", boxId: box?.id }]);
  });

  it("shows and logs a failed audit write without hiding the change", async () => {
    const { app, browser } = await start();
    const box = await addAlice(browser);
    await app.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP TABLE audit_log`).pipe(Effect.orDie));
    const renamed = await browser.act("/admin/boxes/relabel", { box: box.id, label: "Renamed" });
    expect(renamed.flash?.kind).toBe("error");
    expect(renamed.flash?.text).toMatch(/^Renamed “Office” to “Renamed”\. The audit row could not be written: /);
    expect((await boxes(app)).map((entry) => entry.label)).toEqual(["Renamed"]);
    expect(app.logs.some((line) => line.includes("admin: the audit row of box_relabel could not be written"))).toBe(true);
    const text = [...browser.pages, ...app.logs].join("\n");
    expect(text).not.toContain(PASSWORD_A);
  });
});

describe("labels never expose another box's secret", () => {
  it("refuses a label holding any stored or pending box secret, and audits the refusals without it", async () => {
    const checked: Array<string> = [];
    const { app, browser } = await start({
      secondFactor: () => {
        checked.push("checked");
        return Effect.succeed<LoginResult<void>>({ _tag: "Accepted", value: undefined });
      },
    });
    await addAlice(browser);
    await browser.actMultipart("/admin/boxes/add", passwordForm("Archive", "bob", PASSWORD_B));
    const archive = (await boxes(app)).find((box) => box.label === "Archive");
    const crossRename = await browser.act("/admin/boxes/relabel", { box: archive?.id ?? "", label: `x ${PASSWORD_A} x` });
    expect(crossRename.flash).toEqual({ kind: "error", text: "Not renamed: A box label must not contain a box's password or passphrase." });
    const crossAdd = await browser.actMultipart("/admin/boxes/add", passwordForm(PASSWORD_B, "carol", "carol-password-1"));
    expect(crossAdd.flash).toEqual({ kind: "error", text: "Not added: A box label must not contain a box's password or passphrase." });
    // A secret the registry registered for a sign-in still in flight.
    await app.run(Effect.map(Redactor, (redactor) => redactor.register(["pending-secret-5k2q"])));
    const pending = await browser.act("/admin/boxes/relabel", { box: archive?.id ?? "", label: "pending-secret-5k2q" });
    expect(pending.flash?.text).toBe("Not renamed: A box label must not contain a box's password or passphrase.");
    expect((await boxes(app)).map((box) => box.label)).toEqual(["Office", "Archive"]);
    const refusals = (await audits(app)).filter((entry) => entry.outcome === "refused");
    expect(refusals.map((entry) => [entry.action, entry.boxId])).toEqual([
      ["box_relabel", archive?.id],
      ["box_add", undefined],
      ["box_relabel", archive?.id],
    ]);
    const text = JSON.stringify(refusals);
    for (const secret of [PASSWORD_A, PASSWORD_B, "carol-password-1", "pending-secret-5k2q"]) expect(text).not.toContain(secret);
    // An unknown box is refused before the second factor.
    const unknown = await browser.actMultipart("/admin/boxes/credentials", passwordForm("", "alice-new", "fresh-password-1", { box: newBoxId() }));
    expect(unknown.flash?.text).toMatch(/^Not replaced: No data box .* is configured\.$/);
    expect(checked).toEqual([]);
  });
});

describe("label and secret changes are serialized", () => {
  it("refuses a secret that another box's label holds", async () => {
    const { app, browser } = await start();
    await browser.actMultipart("/admin/boxes/add", passwordForm("Sunflower-2024!", "bob", PASSWORD_B));
    const added = await browser.actMultipart("/admin/boxes/add", passwordForm("Office", "alice", "sunflower-2024!"));
    expect(added.flash?.text).toBe("Not added: A box label must not contain a box's password or passphrase.");
    const box = await addAlice(browser);
    const replaced = await browser.actMultipart("/admin/boxes/credentials", passwordForm("", "alice-new", "Sunflower-2024!", { box: box.id }));
    expect(replaced.flash?.text).toBe("Not replaced: A box label must not contain a box's password or passphrase.");
    expect(app.isds.requests.filter((entry) => entry.request.operation === "GetOwnerInfoFromLogin")).toHaveLength(2);
  });

  it("holds a rename to the incoming password until the replacement finished, then refuses it", async () => {
    let entered: () => void = () => undefined;
    const signingIn = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = loginResponder(LOGINS);
    const { app, browser } = await start({
      respond: (config, request) =>
        config.credentials._tag === "Password" && config.credentials.username === "alice-new"
          ? Effect.sync(() => entered()).pipe(
              Effect.andThen(Effect.promise(() => gate)),
              Effect.andThen(base(config, request)),
            )
          : base(config, request),
    });
    const box = await addAlice(browser);
    await browser.actMultipart("/admin/boxes/add", passwordForm("Archive", "bob", PASSWORD_B));
    const archive = (await boxes(app)).find((entry) => entry.label === "Archive");
    const incoming = "incoming-password-3v8";
    const replacing = browser.postMultipart("/admin/boxes/credentials", passwordForm("", "alice-new", incoming, { box: box.id }));
    await signingIn;
    let renamed = false;
    const renaming = browser.post("/admin/boxes/relabel", { box: archive?.id ?? "", label: incoming }).then((page) => {
      renamed = true;
      return page;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(renamed).toBe(false);
    release();
    await Promise.all([replacing, renaming]);
    expect((await boxes(app)).map((entry) => entry.label)).toEqual(["Office", "Archive"]);
    const rows = (await audits(app)).filter((entry) => entry.action !== "box_add");
    expect(rows.map((entry) => [entry.action, entry.outcome])).toEqual([
      ["box_replace_credentials", "ok"],
      ["box_relabel", "refused"],
    ]);
    const page = await browser.get("/admin");
    expect(page.html).not.toContain(incoming);
  });
});
