import { randomBytes } from "node:crypto";
import { afterEach, assert, describe, it } from "@effect/vitest";
import { attachmentUri, effectiveMimeType, normalizeMimeType } from "../../src/mcp/download-tool.js";
import { ok } from "../isds/fake-transport.js";
import { BOX, BOX_ID, DB_ID, grant, type Harness, LABEL, type StartOptions, startTools, textOf } from "./support/harness.js";
import {
  DM_ID,
  downloadWithFirstFile,
  FAKE_NONCE,
  INJECTION,
  REPLIES,
  sha256,
  withAttribute,
} from "./support/replies.js";
import { nonces } from "./support/untrusted.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const start = async (options: Partial<StartOptions> = {}) => {
  harness = await startTools({ boxes: [BOX], replies: REPLIES, principals: { reader: grant("g-reader") }, ...options });
  return harness;
};

const download = async (h: Harness) => (await h.connect("reader")).call("download_message", { box: LABEL, messageId: DM_ID });

interface AttachmentMeta {
  readonly index: number;
  readonly filename: string;
  readonly declaredMimeType: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly inline: boolean;
  readonly uri?: string;
  readonly reason?: string;
  readonly note?: string;
}

const metadataOf = (text: string) =>
  JSON.parse(text) as {
    readonly messageId: string;
    readonly attachments: ReadonlyArray<AttachmentMeta>;
    readonly zfo: { readonly ref: string; readonly sha256: string; readonly bytes: number };
    readonly notice: string;
  };

describe("download_message", () => {
  it("returns the metadata text, then each attachment's exact bytes as an embedded resource", async () => {
    const bytes = new Uint8Array(randomBytes(64 * 1024));
    const h = await start({ replies: { ...REPLIES, MessageDownload: ok(downloadWithFirstFile(bytes)) } });
    const result = await download(h);
    assert.notOk(result.isError, textOf(result));
    assert.isUndefined(result.structuredContent);
    assert.deepStrictEqual(
      result.content.map((block) => block.type),
      ["text", "resource", "resource"],
    );
    const [pdf, xml] = result.content.slice(1).map((block) => block.resource);
    assert.strictEqual(pdf?.uri, `datova-schranka://box/${BOX_ID}/message/${DM_ID}/attachment/0`);
    assert.strictEqual(pdf?.mimeType, "application/pdf");
    assert.strictEqual(sha256(Buffer.from(pdf?.blob ?? "", "base64")), sha256(bytes));
    assert.strictEqual(xml?.uri, `datova-schranka://box/${BOX_ID}/message/${DM_ID}/attachment/1`);
    assert.strictEqual(xml?.mimeType, "application/octet-stream");

    const metadata = metadataOf(textOf(result));
    assert.strictEqual(metadata.messageId, DM_ID);
    const [first, second] = metadata.attachments;
    assert.deepStrictEqual(
      [first?.index, first?.inline, first?.uri, first?.size, first?.sha256, first?.mimeType],
      [0, true, pdf?.uri, bytes.byteLength, sha256(bytes), "application/pdf"],
    );
    assert.deepStrictEqual(
      [second?.index, second?.inline, second?.uri, second?.sha256, second?.mimeType],
      [1, true, xml?.uri, sha256(Buffer.from(xml?.blob ?? "", "base64")), "application/octet-stream"],
    );
    assert.strictEqual(Buffer.from(xml?.blob ?? "", "base64").byteLength, second?.size);
    assert.deepStrictEqual([metadata.zfo.ref, metadata.zfo.sha256], [`${DB_ID}/${DM_ID}.zfo`, sha256(h.zfoWrites[0]?.bytes ?? new Uint8Array())]);
    assert.include(metadata.notice, "untrusted data from the sender");
    assert.lengthOf(await h.audit(), 1);
  });

  it("guards the sender's filename and declared MIME type; the URI never carries them", async () => {
    const xml = withAttribute(withAttribute(downloadWithFirstFile(new Uint8Array([1, 2, 3])), "dmFileDescr", INJECTION, 0), "dmMimeType", `text/html; ${INJECTION}`, 0);
    const h = await start({ replies: { ...REPLIES, MessageDownload: ok(xml) } });
    const result = await download(h);
    const text = textOf(result);
    assert.lengthOf(nonces(text), 1);
    assert.notInclude(text, FAKE_NONCE);
    const [first] = metadataOf(text).attachments;
    assert.match(first?.filename ?? "", /^<untrusted-[0-9a-f]{32}>[\s\S]*<\/untrusted-[0-9a-f]{32}>$/);
    assert.match(first?.declaredMimeType ?? "", /^<untrusted-[0-9a-f]{32}>text\/html<\/untrusted-[0-9a-f]{32}>$/);
    assert.strictEqual(first?.mimeType, "application/octet-stream");
    assert.strictEqual(result.content[1]?.resource?.mimeType, "application/octet-stream");
    assert.notInclude(result.content[1]?.resource?.uri ?? "", "Pay");
  });

  it("lists an attachment over the cap with its hash and no resource or URI", async () => {
    const h = await start({ config: { attachmentInlineMaxBytes: 64 } });
    const result = await download(h);
    assert.notOk(result.isError, textOf(result));
    // The small PDF fits under the 64-byte cap; the XML enclosure does not.
    assert.deepStrictEqual(
      result.content.map((block) => block.resource?.uri ?? block.type),
      ["text", attachmentUri(BOX_ID, DM_ID, 0)],
    );
    const [, skipped] = metadataOf(textOf(result)).attachments;
    assert.strictEqual(skipped?.inline, false);
    assert.isUndefined(skipped?.uri);
    assert.strictEqual(skipped?.note, "available in the signed ZFO");
    assert.isString(skipped?.reason);
    assert.match(skipped?.sha256 ?? "", /^[0-9a-f]{64}$/);
  });

  it("withholds an attachment whose base64 output redaction would alter, and keeps the others byte-exact", async () => {
    const bytes = new TextEncoder().encode("SuperSecret12");
    assert.include(Buffer.from(bytes).toString("base64"), "U3VwZXJTZWNyZXQx");
    const h = await start({
      replies: { ...REPLIES, MessageDownload: ok(downloadWithFirstFile(bytes)) },
      secrets: ["U3VwZXJTZWNyZXQx"],
    });
    const result = await download(h);
    assert.notOk(result.isError, textOf(result));
    assert.deepStrictEqual(
      result.content.map((block) => block.resource?.uri ?? block.type),
      ["text", attachmentUri(BOX_ID, DM_ID, 1)],
    );
    const [withheld, kept] = metadataOf(textOf(result)).attachments;
    assert.strictEqual(sha256(Buffer.from(result.content[1]?.resource?.blob ?? "", "base64")), kept?.sha256);
    assert.deepStrictEqual(
      [withheld?.inline, withheld?.reason, withheld?.uri],
      [false, "withheld: output redaction would alter it; available in the signed ZFO", undefined],
    );
    assert.strictEqual(withheld?.sha256, sha256(bytes));
  });
});

describe("download MIME types", () => {
  it("normalizes the declaration and passes only the allowed types", () => {
    assert.strictEqual(normalizeMimeType("  Application/PDF; charset=binary "), "application/pdf");
    assert.strictEqual(effectiveMimeType("Application/PDF; charset=binary"), "application/pdf");
    for (const allowed of ["image/png", "image/jpeg", "image/gif", "image/tiff", "text/plain"]) {
      assert.strictEqual(effectiveMimeType(allowed), allowed);
    }
    for (const other of ["text/html", "image/svg+xml", "application/xml", "", "application/pdf/x"]) {
      assert.strictEqual(effectiveMimeType(other), "application/octet-stream", other);
    }
  });
});
