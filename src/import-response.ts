import { XMLParser, XMLValidator } from "fast-xml-parser";
import { FioApiError } from "./errors.js";
import { excerpt } from "./fio-client.js";

/** Import response (PDF §6, responseImportIB.xsd). */

export type ImportStatus = "ok" | "error" | "warning" | "fatal";

export interface ImportMessage {
  status: string | null;
  errorCode: number | null;
  text: string;
}

export type ImportOutcome = "accepted" | "rejected" | "unknown";

export interface ImportResult {
  /**
   * accepted: FIO created the batch (status ok or warning); it still needs authorization in Internetbanking.
   * rejected: status error/fatal and no batch ID, so nothing was created.
   * unknown: missing/undocumented status, or a contradiction such as an error status with a batch ID.
   */
  outcome: ImportOutcome;
  accepted: boolean;
  status: ImportStatus | string;
  errorCode: number | null;
  errorMeaning: string;
  /** idInstruction: ID(s) of the created batch. */
  batchIds: string[];
  messages: string[];
  /** The meaning of `sum id` is undocumented. */
  sums: { id: string | null; credit: number | null; debit: number | null }[];
  orders: { id: string | null; messages: ImportMessage[] }[];
}

const ERROR_CODES: Record<number, string> = {
  0: "OK; the instructions were accepted.",
  1: "Validation found errors.",
  2: "Validation warnings: some values are filled incorrectly.",
  11: "Syntax error.",
  12: "Empty import: no instructions in the file.",
  13: "File too long: over 2 MB.",
  14: "Empty file: contains no instructions.",
};

const ARRAY_TAGS = new Set(["idInstruction", "message", "sum", "detail"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (isNode(value)) return textOf(value["#text"]);
  return "";
}

function intOrNull(value: unknown): number | null {
  const s = textOf(value).trim();
  if (!/^-?\d+$/.test(s)) return null;
  return Number(s);
}

function decimalOrNull(value: unknown): number | null {
  const s = textOf(value).trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseImportResponse(body: string): ImportResult {
  // Validate first: the parser alone accepts truncated XML, which could turn a
  // cut-off "accepted" response into an apparent rejection.
  if (XMLValidator.validate(body) !== true) {
    throw new FioApiError("bad_response", `FIO returned an import response that is not valid XML: ${excerpt(body)}`);
  }
  let doc: unknown;
  try {
    doc = parser.parse(body);
  } catch {
    throw new FioApiError("bad_response", `FIO returned an import response that is not valid XML: ${excerpt(body)}`);
  }
  const root = isNode(doc) ? doc.responseImport : undefined;
  const result = isNode(root) ? root.result : undefined;
  if (!isNode(root) || !isNode(result)) {
    throw new FioApiError("bad_response", `FIO returned an unexpected import response: ${excerpt(body)}`);
  }

  const status = textOf(result.status).trim().toLowerCase();
  const errorCode = intOrNull(result.errorCode);
  const sums = isNode(result.sums)
    ? asArray(result.sums.sum)
        .filter(isNode)
        .map((sum) => ({
          id: typeof sum["@_id"] === "string" ? sum["@_id"] : null,
          credit: decimalOrNull(sum.sumCredit),
          debit: decimalOrNull(sum.sumDebet),
        }))
    : [];
  const details = isNode(root.ordersDetails) ? asArray(root.ordersDetails.detail).filter(isNode) : [];

  const batchIds = asArray(result.idInstruction).map(textOf).filter((s) => s !== "");
  const outcome: ImportOutcome =
    status === "ok" || status === "warning"
      ? "accepted"
      : (status === "error" || status === "fatal") && batchIds.length === 0
        ? "rejected"
        : "unknown";

  return {
    outcome,
    accepted: outcome === "accepted",
    status,
    errorCode,
    errorMeaning: errorCode === null ? "No errorCode in response." : (ERROR_CODES[errorCode] ?? `Undocumented errorCode ${errorCode}.`),
    batchIds,
    messages: asArray(result.message).map(textOf).filter((s) => s !== ""),
    sums,
    orders: details.map((detail) => ({
      id: typeof detail["@_id"] === "string" ? detail["@_id"] : null,
      messages: (isNode(detail.messages) ? asArray(detail.messages.message) : []).map((m) => ({
        status: isNode(m) && typeof m["@_status"] === "string" ? m["@_status"] : null,
        errorCode: isNode(m) ? intOrNull(m["@_errorCode"]) : null,
        text: textOf(m),
      })),
    })),
  };
}

/** The refusal must name the token/API... */
const TOKEN_CONTEXT = /\btoken|\bAPI\b/i;
/** ...and deny a right. */
const DENIAL_TEXT =
  /permission|not (allowed|permitted|authori[sz]ed)|unauthori[sz]ed|forbidden|access denied|read[- ]only|insufficient (rights|privileges)|opr[aá]vn[eě]n|nem[aá]te pr[aá]vo|nem[aá] pr[aá]vo|nepovolen|pouze pro (čtení|cteni|sledov[aá]n[ií])/i;

/**
 * Heuristic for an import that FIO refused because the token lacks the
 * payment-order permission. FIO does not document this response, so this is
 * deliberately narrow: the whole batch must be rejected (outcome "rejected")
 * AND one batch-level message must both mention the token or API and deny a
 * right ("Token does not have permission…", "Token nemá oprávnění…"). Content
 * restrictions such as "payments to this country are not permitted" or
 * "beneficiary not authorized" do not mention the token and are ignored, as
 * are per-order messages.
 */
export function looksLikeMissingPaymentPermission(result: ImportResult): boolean {
  // Only a definite rejection: an ambiguous outcome must reach the user with its batch IDs.
  if (result.outcome !== "rejected") return false;
  return result.messages.some((m) => TOKEN_CONTEXT.test(m) && DENIAL_TEXT.test(m));
}
