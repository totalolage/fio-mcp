import { FioApiError } from "./errors.js";

/**
 * Normalises FIO's JSON account statement (PDF §5.3.1.6) into named fields.
 * FIO wraps each transaction column as `{ value, name, id }` keyed `columnN`;
 * absent optional columns are `null`.
 */

export interface StatementInfo {
  accountId: string | null;
  bankId: string | null;
  currency: string | null;
  iban: string | null;
  bic: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  dateStart: string | null;
  dateEnd: string | null;
  yearList: number | null;
  idList: number | null;
  idFrom: number | null;
  idTo: number | null;
  idLastDownload: number | null;
}

export interface Transaction {
  id: number | null;
  date: string | null;
  amount: number | null;
  currency: string | null;
  counterpartyAccount: string | null;
  counterpartyName: string | null;
  counterpartyBankCode: string | null;
  counterpartyBankName: string | null;
  counterpartyBic: string | null;
  constantSymbol: string | null;
  variableSymbol: string | null;
  specificSymbol: string | null;
  userIdentification: string | null;
  messageForRecipient: string | null;
  type: string | null;
  executedBy: string | null;
  details: string | null;
  comment: string | null;
  instructionId: number | null;
  payerReference: string | null;
}

export interface NormalizedStatement {
  info: StatementInfo;
  transactionCount: number;
  transactions: Transaction[];
}

type ColumnKind = "number" | "string" | "date";

/** columnN → field name, per the PDF's JSON column table. */
const COLUMNS: Record<string, [keyof Transaction, ColumnKind]> = {
  column22: ["id", "number"],
  column0: ["date", "date"],
  column1: ["amount", "number"],
  column14: ["currency", "string"],
  column2: ["counterpartyAccount", "string"],
  column10: ["counterpartyName", "string"],
  column3: ["counterpartyBankCode", "string"],
  column12: ["counterpartyBankName", "string"],
  column26: ["counterpartyBic", "string"],
  column4: ["constantSymbol", "string"],
  column5: ["variableSymbol", "string"],
  column6: ["specificSymbol", "string"],
  column7: ["userIdentification", "string"],
  column16: ["messageForRecipient", "string"],
  column8: ["type", "string"],
  column9: ["executedBy", "string"],
  column18: ["details", "string"],
  column25: ["comment", "string"],
  column17: ["instructionId", "number"],
  column27: ["payerReference", "string"],
};

const EMPTY_TRANSACTION: Transaction = Object.fromEntries(
  Object.values(COLUMNS).map(([field]) => [field, null]),
) as unknown as Transaction;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * FIO dates arrive as epoch milliseconds in the PDF examples and as
 * `YYYY-MM-DD+GMT` strings in the XML format; accept both and return the
 * calendar date as published (`2012-07-27+0200` → `2012-07-27`).
 */
export function toDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Statements are in Prague time; shift so the calendar date matches what FIO shows.
    return pragueDate(value);
  }
  if (typeof value === "string") {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return match?.[1] ?? value;
  }
  return null;
}

const PRAGUE_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Prague",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function pragueDate(ms: number): string {
  return PRAGUE_DATE.format(new Date(ms));
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // FIO pads empty text columns with a single space; report those as null.
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function columnValue(column: unknown): unknown {
  return isRecord(column) ? column.value : column;
}

export function normalizeTransaction(raw: Record<string, unknown>): Transaction {
  const tx: Transaction = { ...EMPTY_TRANSACTION };
  for (const [key, [field, kind]] of Object.entries(COLUMNS)) {
    const value = columnValue(raw[key]);
    const converted = kind === "number" ? toNumber(value) : kind === "date" ? toDate(value) : toText(value);
    (tx as unknown as Record<string, unknown>)[field] = converted;
  }
  return tx;
}

export function normalizeStatement(json: unknown): NormalizedStatement {
  const statement = isRecord(json) ? json.accountStatement : undefined;
  if (!isRecord(statement)) {
    throw new FioApiError("bad_response", "FIO response is not a JSON account statement (missing accountStatement).");
  }
  const info = isRecord(statement.info) ? statement.info : {};
  const list = isRecord(statement.transactionList) ? statement.transactionList.transaction : undefined;
  // Defensive: some serializers collapse one-element arrays to an object.
  const rawTransactions = Array.isArray(list) ? list : isRecord(list) ? [list] : [];
  const transactions = rawTransactions.filter(isRecord).map(normalizeTransaction);
  return {
    info: {
      accountId: toText(info.accountId),
      bankId: toText(info.bankId),
      currency: toText(info.currency),
      iban: toText(info.iban),
      bic: toText(info.bic),
      openingBalance: toNumber(info.openingBalance),
      closingBalance: toNumber(info.closingBalance),
      dateStart: toDate(info.dateStart),
      dateEnd: toDate(info.dateEnd),
      yearList: toNumber(info.yearList),
      idList: toNumber(info.idList),
      idFrom: toNumber(info.idFrom),
      idTo: toNumber(info.idTo),
      idLastDownload: toNumber(info.idLastDownload),
    },
    transactionCount: transactions.length,
    transactions,
  };
}

export function parseStatementJson(body: string): NormalizedStatement {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new FioApiError("bad_response", "FIO returned a response that is not valid JSON.");
  }
  return normalizeStatement(json);
}

/**
 * `/lastStatement/{token}/statement` has no documented response body. Accept
 * the common shapes ("2024,7", "2024/7", JSON) and always return the raw text.
 */
export function parseLastStatement(body: string): { year: number | null; number: number | null; raw: string } {
  const raw = body.trim();
  try {
    const json: unknown = JSON.parse(raw);
    if (isRecord(json)) {
      const year = toNumber(json.year ?? json.yearList);
      const number = toNumber(json.id ?? json.number ?? json.idList);
      if (year !== null || number !== null) return { year, number, raw };
    }
  } catch {
    // not JSON
  }
  const match = /^\D*(\d{4})\D+(\d{1,4})\D*$/.exec(raw);
  if (match) return { year: Number(match[1]), number: Number(match[2]), raw };
  return { year: null, number: null, raw };
}
