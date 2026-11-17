/**
 * The production app (FEATURES: read tools, boxes and audit tabs) end to end
 * over HTTP and OAuth with a fake ISDS: boxes added in /admin by password and
 * by PKCS#12 upload, consent in the browser with the delivery checkbox, the
 * read tools over MCP, and the audit tab's record of all of it.
 */

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REDACTED } from "@mcps/core/redaction.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Redacted } from "effect";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BOX_AUDIT_ACTIONS } from "../../src/admin/boxes-tab.js";
import { IsdsAuthError } from "../../src/isds/errors.js";
import { READ_SCOPE, SEND_SCOPE } from "../../src/mcp/tool-group.js";
import { CONSENT_ACTION } from "../../src/oauth/app.js";
import { fakeIsdsTransports, loginResponder } from "../domain/support/fake-isds.js";
import { fixture, ok } from "../isds/fake-transport.js";
import { createTestPki, type TestPki } from "../isds/support/pki.js";
import { type E2eApp, SCRUBBED, startE2eApp } from "./support/app.js";

const MAIN = { label: "Main", username: "main-user", password: "main-password-7f3a", dbId: "abc2def" };
const SIGNED = { label: "Signed", dbId: "ghi3jkm" };
const MESSAGE_ID = "8765432";
/** A login the fake ISDS refuses (HTTP 401, as ISDS answers a wrong password). */
const REJECTED = { label: "Rejected", username: "rejected-user", password: "rejected-password-9q4w" };
/** What the fake ISDS logs, with the box password, on every GetListOfSentMessages (the app's Redactor must hide it). */
const SENT_LOG = "fake ISDS: list sent with password";

const READ_TOOLS = [
  "get_server_status",
  "list_received_messages",
  "list_sent_messages",
  "get_message",
  "get_delivery_info",
  "get_message_state_changes",
  "find_data_box",
  "check_data_box",
  "download_message",
];

/** The attachments the fake ISDS returns: arbitrary bytes, and text holding a box secret (blobs are never redacted). */
const ATTACHMENTS = [
  { filename: "výzva.pdf", mimeType: "application/pdf", bytes: new Uint8Array(randomBytes(4096)) },
  {
    filename: "note.txt",
    mimeType: "text/plain",
    bytes: new TextEncoder().encode(`the box password ${MAIN.password} is not redacted inside an attachment\n`),
  },
];

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** MessageDownload.xml with its files replaced by ATTACHMENTS. */
const messageDownload = () => {
  const files = ATTACHMENTS.map(
    (file, n) =>
      `<p:dmFile dmMimeType="${file.mimeType}" dmFileMetaType="${n === 0 ? "main" : "enclosure"}" dmFileDescr="${file.filename}"><p:dmEncodedContent>${Buffer.from(file.bytes).toString("base64")}</p:dmEncodedContent></p:dmFile>`,
  ).join("");
  return fixture("MessageDownload.xml").replace(/<p:dmFiles>[\s\S]*<\/p:dmFiles>/, `<p:dmFiles>${files}</p:dmFiles>`);
};

const READ_REPLIES: Readonly<Record<string, string>> = {
  GetListOfReceivedMessages: fixture("GetListOfReceivedMessages-multi.xml"),
  GetListOfSentMessages: fixture("GetListOfReceivedMessages-single.xml").replaceAll(
    "GetListOfReceivedMessages",
    "GetListOfSentMessages",
  ),
  GetMessageStateChanges: fixture("GetMessageStateChanges.xml"),
  MessageEnvelopeDownload: fixture("MessageEnvelopeDownload.xml"),
  SignedMessageDownload: fixture("SignedMessageDownload.xml"),
  GetDeliveryInfo: fixture("GetDeliveryInfo.xml"),
  MessageDownload: messageDownload(),
};

let pki: TestPki;
let app: E2eApp | undefined;
let isds: ReturnType<typeof fakeIsdsTransports>;

beforeAll(() => {
  pki = createTestPki();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** The app over a fake ISDS that logs MAIN in by username and SIGNED by its certificate passphrase. */
const start = async () => {
  const logins = loginResponder({ [MAIN.username]: MAIN.dbId, [pki.clientPassphrase]: SIGNED.dbId }, (config, request) => {
    const reply = READ_REPLIES[request.operation];
    if (reply === undefined) return Effect.die(`unexpected ISDS operation ${request.operation}`);
    const password = config.credentials._tag === "Password" ? Redacted.value(config.credentials.password) : "";
    return request.operation === "GetListOfSentMessages"
      ? Effect.as(Effect.logInfo(`${SENT_LOG} ${password}`), ok(reply))
      : Effect.succeed(ok(reply));
  });
  isds = fakeIsdsTransports((config, request) =>
    config.credentials._tag === "Password" && config.credentials.username === REJECTED.username
      ? Effect.fail(new IsdsAuthError({ service: request.service, operation: request.operation, httpStatus: 401 }))
      : logins(config, request),
  );
  app = await startE2eApp({ isds: isds.layer });
  return app;
};

/** Adds MAIN by password and SIGNED by PKCS#12 through the boxes tab. */
const addBoxes = async (running: E2eApp) => {
  const admin = await running.admin();
  const byPassword = await admin.addPasswordBox(MAIN);
  expect(byPassword).toMatchObject({ status: 200, kind: "ok", added: true });
  expect(byPassword.text).toContain(MAIN.dbId);
  const byCertificate = await admin.addCertificateBox({
    label: SIGNED.label,
    pkcs12: pki.clientPkcs12,
    passphrase: pki.clientPassphrase,
  });
  expect(byCertificate).toMatchObject({ status: 200, kind: "ok", added: true });
  expect(byCertificate.text).toContain(SIGNED.dbId);
  return admin;
};

const textOf = (result: CallToolResult) =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

const countBy = (values: ReadonlyArray<string>) =>
  Object.fromEntries(Array.from(new Set(values), (value) => [value, values.filter((v) => v === value).length]));

describe("datova-schranka end to end (fake ISDS)", () => {
  it("adds boxes in /admin, consents in the browser, calls six read tools over MCP and audits each step once", async () => {
    const running = await start();
    const admin = await addBoxes(running);

    // The uploaded PKCS#12 reached the ISDS transport byte for byte.
    const certificate = isds.made
      .map((config) => config.credentials)
      .find((credentials) => credentials._tag === "SystemCertificate");
    expect(certificate?._tag === "SystemCertificate" && sha256(certificate.pkcs12)).toBe(sha256(pki.clientPkcs12));

    const grant = await running.consent({ boxes: [MAIN.label], scopes: [READ_SCOPE], deliveryConsent: true });
    const mcp = await running.mcp(grant.access);

    const tools = await mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const tool of tools) {
      const box = (tool.inputSchema.properties as Record<string, { readonly enum?: ReadonlyArray<string> }> | undefined)
        ?.box;
      if (tool.name === "get_server_status") expect(box).toBeUndefined();
      else expect(box?.enum).toEqual([MAIN.label]);
    }

    const calls: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["get_server_status", {}],
      ["list_sent_messages", { box: MAIN.label }],
      ["list_received_messages", { box: MAIN.label }],
      ["get_message", { box: MAIN.label, messageId: MESSAGE_ID }],
      ["download_message", { box: MAIN.label, messageId: MESSAGE_ID }],
      ["get_message_state_changes", { box: MAIN.label }],
    ];
    const results = new Map<string, CallToolResult>();
    for (const [name, args] of calls) {
      const result = await mcp.call(name, args);
      expect({ name, isError: result.isError ?? false, text: result.isError ? textOf(result) : "" }).toEqual({
        name,
        isError: false,
        text: "",
      });
      results.set(name, result);
    }

    expect(textOf(results.get("get_server_status") as CallToolResult)).toContain(MAIN.label);
    expect(textOf(results.get("get_server_status") as CallToolResult)).not.toContain(SIGNED.label);

    // Every attachment arrives as an embedded resource whose bytes are the fixture's, after HTTP and redaction.
    const download = results.get("download_message") as CallToolResult;
    const resources = download.content.flatMap((block) => (block.type === "resource" ? [block.resource] : []));
    expect(
      resources.map((resource) => ({
        mimeType: resource.mimeType,
        sha256: "blob" in resource ? sha256(Buffer.from(String(resource.blob), "base64")) : "no blob",
      })),
    ).toEqual(ATTACHMENTS.map((file) => ({ mimeType: file.mimeType, sha256: sha256(file.bytes) })));
    expect(resources.every((resource) => resource.uri.includes(`/message/${MESSAGE_ID}/attachment/`))).toBe(true);
    // The signed message went to the ZFO store in the data directory.
    expect(existsSync(join(running.dir, "zfo", MAIN.dbId, `${MESSAGE_ID}.zfo`))).toBe(true);

    // One row per tool call, the consent, and the two box additions; nothing else.
    const rows = await admin.auditRows();
    const toolActions = calls.map(([name]) => name);
    expect(countBy(rows.map((row) => row.action))).toEqual(
      countBy([...toolActions, CONSENT_ACTION, BOX_AUDIT_ACTIONS.add, BOX_AUDIT_ACTIONS.add]),
    );
    expect(rows.filter((row) => toolActions.includes(row.action)).every((row) => row.outcome.includes("ok"))).toBe(true);
    expect(rows.filter((row) => row.action === BOX_AUDIT_ACTIONS.add).every((row) => row.outcome.includes("ok"))).toBe(true);

    // The app's Redactor hid the box password in the line the fake ISDS logged; the harness had nothing left to scrub.
    const logs = running.logs();
    const sentLines = logs.filter((line) => line.includes(SENT_LOG));
    expect(sentLines).toHaveLength(1);
    expect(sentLines[0]).toContain(REDACTED);
    expect(sentLines[0]).not.toContain(SCRUBBED);
    // No text the harness handed back (logs, pages, audit cells, messages) held a credential it had to scrub.
    expect(running.scrubbed()).toEqual([]);
  });

  it("refuses and audits calls for a box outside the grant and read calls on an isds:send-only grant", async () => {
    const running = await start();
    const admin = await addBoxes(running);
    const before = (await admin.auditRows()).length;

    // Read consent without the delivery checkbox is refused at consent: no grant comes of it.
    await expect(running.consent({ boxes: [MAIN.label], scopes: [READ_SCOPE], deliveryConsent: false })).rejects.toThrow(
      /^consent answered/,
    );

    const signedOnly = await running.mcp(
      (await running.consent({ boxes: [SIGNED.label], scopes: [READ_SCOPE], deliveryConsent: true })).access,
    );
    const outside = await signedOnly.call("list_sent_messages", { box: MAIN.label });
    expect(outside.isError).toBe(true);

    const sendOnly = await running.mcp(
      (await running.consent({ boxes: [MAIN.label], scopes: [SEND_SCOPE], deliveryConsent: false })).access,
    );
    const sendTools = await sendOnly.listTools();
    expect(sendTools.map((tool) => tool.name).filter((name) => READ_TOOLS.includes(name))).toEqual([]);
    const wrongScope = await sendOnly.call("list_sent_messages", { box: MAIN.label });
    expect(wrongScope.isError).toBe(true);

    const all = await admin.auditRows();
    const rows = all.slice(0, all.length - before);
    const refusals = rows.filter((row) => row.action === "list_sent_messages");
    expect(refusals).toHaveLength(2);
    expect(refusals.every((row) => row.outcome.includes("refused"))).toBe(true);
    expect(countBy(rows.map((row) => row.action))).toEqual({ [CONSENT_ACTION]: 2, list_sent_messages: 2 });
    // No ISDS call was made for either refusal.
    expect(isds.requests.filter((request) => request.request.operation === "GetListOfSentMessages")).toEqual([]);
    expect(running.scrubbed()).toEqual([]);
  });
  it("reports a refused box addition as an outcome, its message free of the credentials, and audits it", async () => {
    const running = await start();
    const admin = await addBoxes(running);

    const rejected = await admin.addPasswordBox(REJECTED);
    expect(rejected).toMatchObject({ status: 200, kind: "error", added: false });
    const duplicate = await admin.addPasswordBox({ ...MAIN, label: "Main again" });
    expect(duplicate).toMatchObject({ status: 200, kind: "error", added: false });
    for (const outcome of [rejected, duplicate]) {
      expect(outcome.text).toMatch(/^Not added: /);
      expect(outcome.text).not.toContain(REJECTED.password);
      expect(outcome.text).not.toContain(MAIN.password);
    }

    const page = await admin.page("/admin");
    expect(page.html).not.toContain(REJECTED.password);
    expect(page.html).not.toContain("Rejected");

    const adds = (await admin.auditRows()).filter((row) => row.action === BOX_AUDIT_ACTIONS.add);
    expect(adds.map((row) => row.outcome.includes("ok"))).toEqual([false, false, true, true]);
    for (const row of adds) expect(row.detail).not.toContain(REJECTED.password);
    // The checks above see scrubbed text; this one says nothing needed scrubbing.
    expect(running.scrubbed()).toEqual([]);
  });
});
