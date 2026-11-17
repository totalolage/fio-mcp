/**
 * Send-request fixtures shared by the send domain tests: a sender box, a valid
 * SendMessageRequest builder and base64 helpers.
 */
import type { Box } from "../../../../src/domain/boxes.js";
import type { SendAttachment, SendMessageRequest } from "../../../../src/domain/send/api.js";
import { fakeBox } from "../../support/fake-box-registry.js";

export const SENDER_BOX_ID = "box_SSSSSSSSSSSSSSSSSSSSSS";
export const SENDER_DB_ID = "snd1234";
export const RECIPIENT_DB_ID = "rcp5678";

/** The box the fixture requests send from. */
export const senderBox: Box = fakeBox(SENDER_BOX_ID, SENDER_DB_ID);

/** Canonical standard base64 of a string (UTF-8) or bytes. */
export const base64Of = (content: string | Uint8Array): string => Buffer.from(content).toString("base64");

/** The bytes of a base64 string, as a plain Uint8Array. */
export const bytesOf = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, "base64"));

export const LETTER_CONTENT = "%PDF-1.7 letter";
export const ANNEX_CONTENT = "annex text";

export const sendAttachment = (overrides: Partial<SendAttachment> = {}): SendAttachment => ({
  filename: "letter.pdf",
  mimeType: "application/pdf",
  contentBase64: base64Of(LETTER_CONTENT),
  ...overrides,
});

/** A valid request with two attachments (letter.pdf, annex.txt) and a sender reference number. */
export const sendRequest = (overrides: Partial<SendMessageRequest> = {}): SendMessageRequest => ({
  boxId: SENDER_BOX_ID,
  idempotencyKey: "key-1",
  recipient: RECIPIENT_DB_ID,
  annotation: "Invoice 2026/11",
  envelope: { senderRefNumber: "REF-1" },
  attachments: [
    sendAttachment(),
    sendAttachment({ filename: "annex.txt", mimeType: "text/plain", contentBase64: base64Of(ANNEX_CONTENT) }),
  ],
  ...overrides,
});
