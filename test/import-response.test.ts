import { describe, expect, it } from "vitest";
import { looksLikeMissingPaymentPermission, parseImportResponse } from "../src/import-response.js";
import { IMPORT_ERROR_XML, IMPORT_OK_XML, IMPORT_PERMISSION_XML } from "./fixtures.js";

describe("import response parsing", () => {
  it("parses an accepted batch", () => {
    expect(parseImportResponse(IMPORT_OK_XML)).toEqual({
      outcome: "accepted",
      accepted: true,
      status: "ok",
      errorCode: 0,
      errorMeaning: "OK; the instructions were accepted.",
      batchIds: ["105545555"],
      messages: [],
      sums: [{ id: "CZK", credit: 0, debit: 100 }],
      orders: [{ id: "1", messages: [{ status: "ok", errorCode: 0, text: "OK" }] }],
    });
  });

  it("parses a rejected batch with per-order messages and decodes entities", () => {
    const result = parseImportResponse(IMPORT_ERROR_XML);
    expect(result.accepted).toBe(false);
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe(1);
    expect(result.errorMeaning).toBe("Validation found errors.");
    expect(result.messages).toEqual(["Validation errors & warnings"]);
    expect(result.batchIds).toEqual([]);
    expect(result.orders).toEqual([
      {
        id: "1",
        messages: [
          { status: "error", errorCode: 1103, text: "Account <to> is invalid" },
          { status: "warning", errorCode: 1200, text: "Currency differs from account currency" },
        ],
      },
      { id: "2", messages: [{ status: "ok", errorCode: 0, text: "OK" }] },
    ]);
  });

  it("treats a warning status as accepted", () => {
    const xml = IMPORT_OK_XML.replace("<status>ok</status>", "<status>warning</status>").replace(
      "<errorCode>0</errorCode>",
      "<errorCode>2</errorCode>",
    );
    expect(parseImportResponse(xml)).toMatchObject({ accepted: true, status: "warning", errorCode: 2 });
  });

  it("reports an unknown outcome for missing or contradictory status", () => {
    const missing = IMPORT_OK_XML.replace("<status>ok</status>", "");
    expect(parseImportResponse(missing)).toMatchObject({ outcome: "unknown", accepted: false, batchIds: ["105545555"] });
    const contradictory = IMPORT_OK_XML.replace("<status>ok</status>", "<status>error</status>");
    expect(parseImportResponse(contradictory)).toMatchObject({ outcome: "unknown", accepted: false });
    expect(parseImportResponse(IMPORT_ERROR_XML).outcome).toBe("rejected");
    expect(parseImportResponse(IMPORT_OK_XML).outcome).toBe("accepted");
  });

  it("rejects bodies that are not import responses", () => {
    expect(() => parseImportResponse("<html><body>Internal error</body></html>")).toThrow(/unexpected import response/);
    // Truncated before </result>: must not be read as a definite rejection.
    const truncated = IMPORT_ERROR_XML.slice(0, IMPORT_ERROR_XML.indexOf("</result>"));
    expect(() => parseImportResponse(truncated)).toThrow(/not valid XML/);
    expect(() => parseImportResponse("")).toThrow();
  });
});

describe("permission refusal heuristic", () => {
  it("flags a rejected batch whose batch-level message is a permission refusal", () => {
    expect(looksLikeMissingPaymentPermission(parseImportResponse(IMPORT_PERMISSION_XML))).toBe(true);
    const czech = IMPORT_PERMISSION_XML.replace(
      "Token does not have permission to enter payment orders",
      "Token nemá oprávnění k zadávání příkazů",
    );
    expect(looksLikeMissingPaymentPermission(parseImportResponse(czech))).toBe(true);
  });

  it("ignores ordinary validation errors and per-order wording", () => {
    expect(looksLikeMissingPaymentPermission(parseImportResponse(IMPORT_ERROR_XML))).toBe(false);
    const perOrder = IMPORT_ERROR_XML.replace("Account &lt;to&gt; is invalid", "Payments to this country are not permitted");
    expect(looksLikeMissingPaymentPermission(parseImportResponse(perOrder))).toBe(false);
    for (const batchLevel of [
      "Payments to this country are not permitted",
      "Beneficiary is not authorized to receive this payment",
      "Access denied for currency USD",
    ]) {
      const xml = IMPORT_PERMISSION_XML.replace("Token does not have permission to enter payment orders", batchLevel);
      expect(looksLikeMissingPaymentPermission(parseImportResponse(xml)), batchLevel).toBe(false);
    }
  });

  it("ignores permission wording when the outcome is ambiguous", () => {
    const withBatch = IMPORT_PERMISSION_XML.replace("<status>fatal</status>", "<status>fatal</status><idInstruction>777</idInstruction>");
    const result = parseImportResponse(withBatch);
    expect(result.outcome).toBe("unknown");
    expect(looksLikeMissingPaymentPermission(result)).toBe(false);
  });

  it("ignores permission wording on an accepted batch", () => {
    const accepted = IMPORT_OK_XML.replace(
      "</status>",
      "</status><message>Orders must be authorized; permission required in Internetbanking</message>",
    );
    expect(looksLikeMissingPaymentPermission(parseImportResponse(accepted))).toBe(false);
  });
});
