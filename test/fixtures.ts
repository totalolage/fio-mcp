import type { ServerConfig } from "../src/config.js";

export const READ_TOKEN = "rEaDtOkEnAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnopqr";
export const PAY_TOKEN = "pAyToKeNAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnopqrs";

/** First and third transactions of the PDF's period example (§5.3.1.6). */
export const STATEMENT_JSON = JSON.stringify({
  accountStatement: {
    info: {
      accountId: "2400222222",
      bankId: "2010",
      currency: "CZK",
      iban: "CZ7920100000002400222222",
      bic: "FIOBCZPPXXX",
      openingBalance: 195.0,
      closingBalance: 195.01,
      dateStart: 1340661600000,
      dateEnd: 1341007200000,
      yearList: null,
      idList: null,
      idFrom: 1148734530,
      idTo: 1149190193,
      idLastDownload: 1149190192,
    },
    transactionList: {
      transaction: [
        {
          column22: { value: 1148734530, name: "ID pohybu", id: 22 },
          column0: { value: 1340661600000, name: "Datum", id: 0 },
          column1: { value: 1.0, name: "Objem", id: 1 },
          column14: { value: "CZK", name: "Měna", id: 14 },
          column2: { value: "2900233333", name: "Protiúčet", id: 2 },
          column10: { value: "Pavel, Novák", name: "Název protiúčtu", id: 10 },
          column3: { value: "2010", name: "Kód banky", id: 3 },
          column12: { value: "Fio banka, a.s.", name: "Název banky", id: 12 },
          column4: { value: "0558", name: "KS", id: 4 },
          column5: null,
          column6: null,
          column7: { value: " ", name: "Uživatelská identifikace", id: 7 },
          column16: null,
          column8: { value: "Příjem převodem uvnitř banky", name: "Typ", id: 8 },
          column9: null,
          column18: null,
          column25: null,
          column26: null,
          column17: { value: 2105685816, name: "ID pokynu", id: 17 },
        },
        {
          column22: { value: 1149190193, name: "ID pohybu", id: 22 },
          column0: { value: "2012-06-30+0200", name: "Datum", id: 0 },
          column1: { value: 0.01, name: "Objem", id: 1 },
          column14: { value: "CZK", name: "Měna", id: 14 },
          column2: null,
          column10: null,
          column3: null,
          column12: null,
          column4: null,
          column5: { value: "0001", name: "VS", id: 5 },
          column6: null,
          column7: null,
          column16: null,
          column8: { value: "Připsaný úrok", name: "Typ", id: 8 },
          column9: null,
          column18: null,
          column25: null,
          column26: null,
          column17: { value: 2107642322, name: "ID pokynu", id: 17 },
        },
      ],
    },
  },
});

export const IMPORT_OK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<responseImport xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.fio.cz/schema/responseImportIB.xsd">
  <result>
    <errorCode>0</errorCode>
    <idInstruction>105545555</idInstruction>
    <status>ok</status>
    <sums>
      <sum id="CZK">
        <sumCredit>0</sumCredit>
        <sumDebet>100.00</sumDebet>
      </sum>
    </sums>
  </result>
  <ordersDetails>
    <detail id="1">
      <messages>
        <message status="ok" errorCode="0">OK</message>
      </messages>
    </detail>
  </ordersDetails>
</responseImport>`;

export const IMPORT_ERROR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<responseImport>
  <result>
    <errorCode>1</errorCode>
    <status>error</status>
    <message>Validation errors &amp; warnings</message>
  </result>
  <ordersDetails>
    <detail id="1">
      <messages>
        <message status="error" errorCode="1103">Account &lt;to&gt; is invalid</message>
        <message status="warning" errorCode="1200">Currency differs from account currency</message>
      </messages>
    </detail>
    <detail id="2">
      <messages>
        <message status="ok" errorCode="0">OK</message>
      </messages>
    </detail>
  </ordersDetails>
</responseImport>`;

export const IMPORT_PERMISSION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<responseImport>
  <result>
    <errorCode>11</errorCode>
    <status>fatal</status>
    <message>Token does not have permission to enter payment orders</message>
  </result>
</responseImport>`;

export function baseConfig(accounts: ServerConfig["accounts"]): ServerConfig {
  return {
    accounts,
    baseUrl: "https://fioapi.test/v1/rest",
    rateLimitIntervalMs: 0,
    maxWaitMs: 25_000,
    requestTimeoutMs: 5_000,
  };
}

export const readAccount = (name = "personal", token = READ_TOKEN) => ({
  name,
  token,
  permissions: new Set(["read"] as const),
});

export const payAccount = (name = "business", token = PAY_TOKEN, accountNumber: string | null = "2400222222") => ({
  name,
  token,
  permissions: new Set(["read", "payments"] as const),
  ...(accountNumber ? { accountNumber } : {}),
  currency: "CZK",
});
