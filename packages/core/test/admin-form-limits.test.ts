import { inspect } from "node:util";
import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_FORM_BYTES } from "../src/admin/server.js";
import { field } from "../src/admin/tab.js";
import { AdminBrowser, BULK_MAX_BYTES, type DemoAdmin, type DemoAdminOptions, IMPORT_MAX_BYTES, startDemoAdmin } from "./support/demo-admin.js";

/**
 * How core reads a tab action's form: url-encoded up to 16 KiB unless the
 * action raises the limit (AdminFormLimits.maxBytes) or also takes
 * multipart forms with files (AdminFormLimits.multipart). Larger, unknown
 * or unverified forms are refused before the action runs; a multipart form
 * goes through the same session, Origin, CSRF and second-factor checks as a
 * url-encoded one. Every case runs through a web handler and on a Node
 * HTTP server (where bodies arrive chunked).
 */

const apps: Array<DemoAdmin> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const URLENCODED = { "content-type": "application/x-www-form-urlencoded" };
const encoder = new TextEncoder();

/** A url-encoded form of exactly `bytes` bytes: the CSRF token and a long `name` value of `fill` bytes. */
const sized = (csrf: string, name: string, bytes: number, fill = 0x78) => {
  const head = encoder.encode(`csrf=${encodeURIComponent(csrf)}&${name}=`);
  const body = new Uint8Array(new ArrayBuffer(bytes)).fill(fill);
  body.set(head);
  return body;
};

/** A signed-in browser with the Boxes page's CSRF token. */
const signedIn = async (app: DemoAdmin) => {
  const browser = new AdminBrowser(app);
  await browser.signIn();
  await browser.get("/admin");
  return browser;
};

const certificateBytes = (size: number) => {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256;
  return bytes;
};

const importForm = (csrf: string | undefined, certificate: Uint8Array<ArrayBuffer>, extra: Record<string, string> = {}) => {
  const form = new FormData();
  if (csrf !== undefined) form.set("csrf", csrf);
  form.set("label", "Office box");
  form.set("passphrase", "pkcs12 passphrase");
  for (const [name, value] of Object.entries(extra)) form.set(name, value);
  form.set("certificate", new Blob([certificate], { type: "application/x-pkcs12" }), "office.p12");
  return form;
};

/** A form as multipart bytes and their content type. */
const encoded = async (form: FormData) => {
  const response = new Response(form);
  return { type: response.headers.get("content-type") ?? "", bytes: new Uint8Array(await response.arrayBuffer()) };
};

/** `bytes` in chunks of `size`, then `rest` more bytes of filler (generated as pulled). */
const chunked = (bytes: Uint8Array, size: number, rest = 0) => {
  let offset = 0;
  let extra = rest;
  const filler = new Uint8Array(size).fill(0x78);
  const pulls = { bytes: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (offset < bytes.length) {
        const next = bytes.slice(offset, offset + size);
        offset += next.length;
        pulls.bytes += next.length;
        return controller.enqueue(next);
      }
      if (extra <= 0) return controller.close();
      const next = filler.slice(0, Math.min(size, extra));
      extra -= next.length;
      pulls.bytes += next.length;
      controller.enqueue(next);
    },
  });
  return { stream, pulls };
};

const boxLabels = async (browser: AdminBrowser) => [...(await browser.get("/admin")).html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);

describe.each(["web", "node"] as const)("admin form limits (%s)", (transport) => {
  const start = async (options: DemoAdminOptions = {}) => {
    const app = await startDemoAdmin({ ...options, node: transport === "node" });
    apps.push(app);
    return app;
  };

  it("reads url-encoded forms up to 16 KiB by default and refuses one byte more", async () => {
    const app = await start();
    const browser = await signedIn(app);
    const csrf = browser.csrf ?? "";
    expect(DEFAULT_MAX_FORM_BYTES).toBe(16 * 1024);

    const over = await browser.send("/admin/boxes/add", sized(csrf, "label", DEFAULT_MAX_FORM_BYTES + 1), URLENCODED);
    expect(over.status).toBe(403);
    expect(await boxLabels(browser)).toEqual(["Inbox"]);

    const at = await browser.send("/admin/boxes/add", sized(csrf, "label", DEFAULT_MAX_FORM_BYTES), URLENCODED);
    expect(at.status).toBe(303);
    expect((await boxLabels(browser)).length).toBe(2);
  });

  it("counts the bytes received, not the decoded text", async () => {
    const app = await start();
    const browser = await signedIn(app);
    // Each 0xFF byte decodes to U+FFFD, three bytes as UTF-8.
    const invalid = sized(browser.csrf ?? "", "label", DEFAULT_MAX_FORM_BYTES, 0xff);

    expect((await browser.send("/admin/boxes/add", invalid, URLENCODED)).status).toBe(303);
    expect((await boxLabels(browser))[1]).toMatch(/^�+$/);
  });

  it("stops reading a streamed url-encoded body at the limit", async () => {
    const app = await start();
    const browser = await signedIn(app);
    const { stream, pulls } = chunked(encoder.encode(`csrf=${encodeURIComponent(browser.csrf ?? "")}&label=`), 1024, 4 * 1024 * 1024);

    expect((await browser.send("/admin/boxes/add", stream, URLENCODED)).status).toBe(403);
    if (transport === "web") expect(pulls.bytes).toBeLessThan(4 * DEFAULT_MAX_FORM_BYTES);
    expect(await boxLabels(browser)).toEqual(["Inbox"]);
  });

  it("honours an action's larger url-encoded limit", async () => {
    const app = await start();
    const browser = await signedIn(app);
    const csrf = browser.csrf ?? "";

    const posted = await browser.send("/admin/boxes/bulk", sized(csrf, "labels", BULK_MAX_BYTES), URLENCODED);
    expect(posted.status).toBe(303);
    const page = await browser.get("/admin");
    expect(page.html).toMatch(/Got \d+ characters\./);

    expect((await browser.send("/admin/boxes/bulk", sized(csrf, "labels", BULK_MAX_BYTES + 1), URLENCODED)).status).toBe(403);
  });

  it("delivers a multipart form's fields and file bytes to an action that takes them", async () => {
    const seen: Array<string | undefined> = [];
    const app = await start({
      secondFactor: (_request, form) => {
        seen.push(field(form, "totp"));
        return Effect.succeed({ _tag: "Accepted", value: undefined });
      },
    });
    const browser = await signedIn(app);
    const certificate = certificateBytes(200 * 1024);

    const posted = await browser.send("/admin/boxes/import", importForm(browser.csrf, certificate, { totp: "123456" }));
    expect(posted.status).toBe(303);
    expect(posted.location).toBe("/admin");
    expect((await browser.get("/admin")).html).toContain("Imported a certificate.");

    // The second factor saw the multipart form's code.
    expect(seen).toEqual(["123456"]);
    const [received] = await app.imports();
    expect(received?.label).toBe("Office box");
    expect(received?.passphrase).toBe("pkcs12 passphrase");
    expect(received?.files.length).toBe(1);
    const file = received?.certificate;
    expect(file?.field).toBe("certificate");
    expect(file?.name).toBe("office.p12");
    expect(file?.contentType).toBe("application/x-pkcs12");
    expect(file === undefined ? undefined : Redacted.value(file.content)).toEqual(certificate);
  });

  it("reads a multipart form sent in small chunks", async () => {
    const app = await start();
    const browser = await signedIn(app);
    const certificate = certificateBytes(100 * 1024);
    const form = await encoded(importForm(browser.csrf, certificate));
    const { stream } = chunked(form.bytes, 1000);

    expect((await browser.send("/admin/boxes/import", stream, { "content-type": form.type })).status).toBe(303);
    const [received] = await app.imports();
    expect(received?.certificate === undefined ? undefined : Redacted.value(received.certificate.content)).toEqual(certificate);
  });

  it("never prints a file's bytes", async () => {
    const app = await start();
    const browser = await signedIn(app);
    const marker = encoder.encode("PRIVATE-KEY-MATERIAL");

    expect((await browser.send("/admin/boxes/import", importForm(browser.csrf, marker))).status).toBe(303);
    const [received] = await app.imports();
    const file = received?.certificate;
    expect(file).toBeDefined();
    for (const shown of [String(file?.content), JSON.stringify(file), inspect(file, { depth: 5 }), inspect(received, { depth: 5 })]) {
      expect(shown).not.toContain("PRIVATE-KEY-MATERIAL");
      expect(shown).not.toMatch(/80\D{1,3}82\D{1,3}73/);
    }
  });

  it("refuses a multipart form over the action's limit without running it", async () => {
    const app = await start();
    const browser = await signedIn(app);

    const over = await browser.send("/admin/boxes/import", importForm(browser.csrf, certificateBytes(IMPORT_MAX_BYTES)));
    expect(over.status).toBe(403);
    expect(await app.imports()).toEqual([]);
  });

  it("counts bytes after a multipart form's closing boundary", async () => {
    const app = await start();
    const browser = await signedIn(app);
    const form = await encoded(importForm(browser.csrf, certificateBytes(1024)));
    const { stream } = chunked(form.bytes, 16 * 1024, IMPORT_MAX_BYTES);

    expect((await browser.send("/admin/boxes/import", stream, { "content-type": form.type })).status).toBe(403);
    expect(await app.imports()).toEqual([]);
  });

  it("stops reading a multipart body at the limit", async () => {
    const app = await start();
    const browser = await signedIn(app);
    const boundary = "----limitsboundary";
    const head = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${browser.csrf}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="certificate"; filename="huge.p12"\r\nContent-Type: application/x-pkcs12\r\n\r\n`,
    );
    // A web handler would have to pull all 64 MiB to read the whole body.
    const { stream, pulls } = chunked(head, 16 * 1024, transport === "web" ? 64 * 1024 * 1024 : 4 * 1024 * 1024);

    const refused = await browser.send("/admin/boxes/import", stream, { "content-type": `multipart/form-data; boundary=${boundary}` });
    expect(refused.status).toBe(403);
    if (transport === "web") expect(pulls.bytes).toBeLessThan(2 * IMPORT_MAX_BYTES);
    expect(await app.imports()).toEqual([]);
  });

  it("checks a multipart form's CSRF token, Origin and session before the action and its second factor", async () => {
    const seen: Array<string | undefined> = [];
    const app = await start({
      secondFactor: (_request, form) => {
        seen.push(field(form, "totp"));
        return Effect.succeed({ _tag: "Accepted", value: undefined });
      },
    });
    const browser = await signedIn(app);
    const certificate = certificateBytes(1024);

    expect((await browser.send("/admin/boxes/import", importForm(undefined, certificate))).status).toBe(403);
    expect((await browser.send("/admin/boxes/import", importForm("x".repeat(43), certificate))).status).toBe(403);
    expect(
      (await browser.send("/admin/boxes/import", importForm(browser.csrf, certificate), { origin: "https://evil.example" })).status,
    ).toBe(403);
    const anonymous = await new AdminBrowser(app).send("/admin/boxes/import", importForm(browser.csrf, certificate));
    expect(anonymous.status).toBe(303);
    expect(anonymous.location).toBe("/admin/login");

    expect(seen).toEqual([]);
    expect(await app.imports()).toEqual([]);
  });

  it("refuses multipart forms on actions that did not ask for them", async () => {
    const app = await start();
    const browser = await signedIn(app);
    const form = new FormData();
    form.set("csrf", browser.csrf ?? "");
    form.set("label", "Archive");
    form.set("labels", "Archive");

    expect((await browser.send("/admin/boxes/add", form)).status).toBe(403);
    expect((await browser.send("/admin/boxes/bulk", form)).status).toBe(403);
    expect(await boxLabels(browser)).toEqual(["Inbox"]);
  });
});
