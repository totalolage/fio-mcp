import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { FioResponseError } from "../src/errors.js";
import { normalizeStatement as normalize, parseStatementJson as parseJson, parseLastStatement, toDate } from "../src/statement.js";

const parseStatementJson = (body: string) => Effect.runSync(parseJson(body));
const normalizeStatement = (json: unknown) => Effect.runSync(normalize(json));
const statementError = (body: string) => {
  const error = Effect.runSync(Effect.flip(parseJson(body)));
  expect(error).toBeInstanceOf(FioResponseError);
  return error.message;
};

import { STATEMENT_JSON } from "./fixtures.js";

describe("statement normalisation", () => {
  it("maps columnN fields to named fields", () => {
    const statement = parseStatementJson(STATEMENT_JSON);
    expect(statement.info).toEqual({
      accountId: "2400222222",
      bankId: "2010",
      currency: "CZK",
      iban: "CZ7920100000002400222222",
      bic: "FIOBCZPPXXX",
      openingBalance: 195,
      closingBalance: 195.01,
      dateStart: "2012-06-26",
      dateEnd: "2012-06-30",
      yearList: null,
      idList: null,
      idFrom: 1148734530,
      idTo: 1149190193,
      idLastDownload: 1149190192,
    });
    expect(statement.transactionCount).toBe(2);
    expect(statement.transactions[0]).toEqual({
      id: 1148734530,
      date: "2012-06-26",
      amount: 1,
      currency: "CZK",
      counterpartyAccount: "2900233333",
      counterpartyName: "Pavel, Novák",
      counterpartyBankCode: "2010",
      counterpartyBankName: "Fio banka, a.s.",
      counterpartyBic: null,
      constantSymbol: "0558",
      variableSymbol: null,
      specificSymbol: null,
      userIdentification: null,
      messageForRecipient: null,
      type: "Příjem převodem uvnitř banky",
      executedBy: null,
      details: null,
      comment: null,
      instructionId: 2105685816,
      payerReference: null,
    });
  });

  it("keeps leading zeroes in symbols and accepts string dates", () => {
    const [, second] = parseStatementJson(STATEMENT_JSON).transactions;
    expect(second?.variableSymbol).toBe("0001");
    expect(second?.date).toBe("2012-06-30");
  });

  it("handles an empty transaction list", () => {
    const statement = normalizeStatement({ accountStatement: { info: { accountId: "1" }, transactionList: {} } });
    expect(statement.transactions).toEqual([]);
    expect(statement.transactionCount).toBe(0);
  });

  it("rejects responses that are not statements", () => {
    expect(statementError("not json")).toMatch(/not valid JSON/);
    expect(statementError("{}")).toMatch(/accountStatement/);
  });

  it("converts epoch milliseconds to the Prague calendar date", () => {
    // 2012-06-25T22:00:00Z is midnight 26 June in Prague (CEST).
    expect(toDate(1340661600000)).toBe("2012-06-26");
    expect(toDate("2024-01-05+0100")).toBe("2024-01-05");
    expect(toDate(null)).toBeNull();
  });
});

describe("parseLastStatement", () => {
  it("parses year,number text", () => {
    expect(parseLastStatement("2024,7\n")).toEqual({ year: 2024, number: 7, raw: "2024,7" });
  });
  it("parses JSON", () => {
    expect(parseLastStatement('{"year":2024,"id":12}')).toMatchObject({ year: 2024, number: 12 });
  });
  it("returns raw text when the format is unknown", () => {
    expect(parseLastStatement("something else")).toEqual({ year: null, number: null, raw: "something else" });
  });
});
