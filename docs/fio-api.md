# FIO Bank REST API reference

This reference summarizes FIO Bank's **API Bankovnictví**, document version **1.9**, dated **16 October 2025** (60-page Czech PDF: [API_Bankovnictvi.pdf](https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf)). Page numbers below are PDF page numbers. The Czech names in quotes and XML/JSON element names are preserved as published.

## Transport and endpoints

The API uses HTTPS at `https://fioapi.fio.cz/v1/rest`. The PDF says the connection uses SSL with at least 128-bit encryption. `GET` retrieves account data and changes download markers; `POST` imports payment instructions. Read tokens appear in the URL path, while upload tokens are multipart fields. (PDF §1, §3, pp. 4–5.)

| Operation | Method and path | Parameters and result | Formats / behavior |
|---|---|---|---|
| Movements for a date range | `GET /periods/{token}/{from}/{to}/transactions.{format}` | `from`, `to`: `YYYY-MM-DD`. | Movement formats: `csv`, `gpc`, `html`, `json`, `ofx`, `xml` (Fio XML). (PDF §5, p. 7; format list p. 6.) |
| Official statement by year and statement number | `GET /by-id/{token}/{year}/{id}/transactions.{format}` | `year`: four-digit year; `id`: statement number. | Statement formats: `csv`, `gpc`, `html`, `json`, `ofx`, Fio `xml`, `pdf`, MT940/STA, `cba_xml` (ČBA XML), `sba_xml` (SBA XML). The example uses `cba_xml`. (PDF §5, pp. 6–7, 30, 35.) |
| Movements since last download | `GET /last/{token}/transactions.{format}` | Uses the token's server-side last-download marker. | Movement formats as above. A non-empty result advances the marker; see [marker semantics](#download-marker-zarážka). (PDF §5, p. 8.) |
| Set marker to last successfully downloaded movement ID | `GET /set-last-id/{token}/{id}/` | `id`: movement ID. | No response format is specified. This GET changes state. (PDF §5, p. 8.) |
| Set marker to last unsuccessfully downloaded date | `GET /set-last-date/{token}/{YYYY-MM-DD}/` | Date of the last day whose movements were not successfully downloaded. | No response format is specified. This GET changes state. (PDF §5, p. 8.) |
| Merchant POS / payment-gateway card transactions | `GET /merchant/{token}/{from}/{to}/transactions.{format}` | `from`, `to`: `YYYY-MM-DD`. Available to business-account clients using FIO POS terminals or the payment gateway. | Only `xml` and `csv`. (PDF §5, pp. 5, 8, 35–39.) |
| Number of latest created official statement | `GET /lastStatement/{token}/statement` | No other parameter. | The PDF identifies this as the lookup for the latest statement number, but does not specify the response body or its exact year/number representation. (PDF §5, pp. 8–9.) |
| Import payment instructions | `POST /import/` | `multipart/form-data`; fields and formats in [Payment import](#payment-import). | XML response; import file types: `abo`, `xml`, `pain001_xml`, `pain008_xml`. (PDF §6, pp. 40–41, 49, 52.) |

The PDF names MT940 as a statement format and says generated files use the `.STA` extension. It does not show a URL example for that format suffix; `sta` is the corresponding suffix commonly inferred from the extension. Date-range inclusivity and timezone interpretation are not specified. (PDF §5, pp. 6–7, 30.)

## Token and permission model

An account owner or person authorized on the account creates a 64-character unique token in Internetbanking under **Nastavení → API**. Token creation requires strong authorization (SMS or push); on accounts requiring multiple signers, all signers must authorize it. A new token becomes usable five minutes after authorization. (PDF §1–2, p. 4.)

The two permission settings are (PDF §2, p. 4):

- **“Sledování účtu”** — account monitoring; export/read data only.
- **“Sledování účtu a zadávání platebních a inkasních příkazů”** — account monitoring plus submitting payment and direct-debit instructions (import).

Each token is valid for one account; a separate token is required for each account. A token must have an expiry, no later than 180 days after creation. If automatic extension is selected, each Internetbanking or Smartbanking login extends validity to 180 days from that login. (PDF §2, p. 4.)

The PDF documents no API endpoint that reports a token's permission setting. It also documents no distinct response for attempting upload with a read-only token. The permission can be checked in Internetbanking's token settings; an MCP server cannot safely infer write permission from a documented read-only request. An upload probe is not side-effect free: a successful import creates a batch that awaits authorization. (PDF §2, p. 4; §6, pp. 40–41; §8, pp. 54–55.)

**Implementation implication (inference):** collect the token's permission out of band (for example, in server configuration confirmed against Internetbanking) and expose payment-import tools only when that setting says the token can submit payments. The API documentation provides no safe permission-introspection call.

## Export response structures

### JSON account statement

The documented JSON envelope is `accountStatement`, containing `info` and `transactionList.transaction`. In the examples, `transaction` is an array; each present column is an object `{ "value": ..., "name": "...", "id": N }`, and absent optional values are `null`. JSON field descriptions are in §5.3.1.6, p. 26; their Fio XML formats and required/optional flags are in §5.3.1.1, pp. 9–10; examples are pp. 27–29.

| `accountStatement.info` key | JSON value / source format | Meaning |
|---|---|---|
| `accountId` | string / `16n` | Account number. |
| `bankId` | string / 4 numeric characters | Bank code. |
| `currency` | string / `3!x` | Account currency, ISO 4217. |
| `iban` | string / `34x` | Account IBAN. |
| `bic` | string / `11x` | Account BIC. |
| `openingBalance` | number / `18d` | Balance at the start of the selected period. |
| `closingBalance` | number / `18d` | Balance at the end of the selected period. |
| `dateStart`, `dateEnd` | integer milliseconds in the examples; XML format `YYYY-MM-DD+GMT` | Selected period start and end. The JSON example's millisecond timestamps imply Unix epoch milliseconds. |
| `yearList` | integer or `null` / `4!n` | Selected statement year. |
| `idList` | integer or `null` / `3n` | Selected statement number. |
| `idFrom`, `idTo` | integer or `null` / `12n` | First and last movement IDs in the selection. |
| `idLastDownload` | integer or `null` / `12n` | ID of the last successfully downloaded movement. |

The PDF does not publish a separate JSON Schema or formal JSON types; the JSON types above follow the published examples and the corresponding Fio XML format table. (PDF pp. 9, 26–29.)

| Column key | JSON `name` (Czech) | JSON value / Fio XML format | Required? | Meaning |
|---|---|---|---|---|
| `column22` | `ID pohybu` | number / `12n` in XML | M | Unique movement ID. The JSON description says 10 numeric characters, while the XML table says `12n`; see [ambiguities](#open-questions--ambiguities). |
| `column0` | `Datum` | integer milliseconds in example / `YYYY-MM-DD+GMT` in XML | M | Movement date. |
| `column1` | `Objem` | number / `18d` | M | Signed amount received or sent. |
| `column14` | `Měna` | string / `3!x` | M | Movement currency, ISO 4217. |
| `column2` | `Protiúčet` | string / `255x` | O | Counterparty account. |
| `column10` | `Název protiúčtu` | string / `255i` | O | Counterparty name. |
| `column3` | `Kód banky` | string / `10x` | O | Counterparty bank code. |
| `column12` | `Název banky` | string / `255i` | O | Counterparty bank name. |
| `column4` | `KS` | string / `4n` | O | Constant symbol. |
| `column5` | `VS` | string / `10n` | O | Variable symbol. |
| `column6` | `SS` | string / `10n` | O | Specific symbol. |
| `column7` | `Uživatelská identifikace` | string / `255i` | O | User identification. |
| `column16` | `Zpráva pro příjemce` | string / `140i` | O | Message shown to payment recipient. |
| `column8` | `Typ` | string / `255i` | M | Operation type (the JSON table calls it `Typ pohybu`). |
| `column9` | `Provedl` | string / `50i` | O | Authorized person who entered the instruction. |
| `column18` | `Upřesnění` | string / `255i` | O | Additional movement information, usually amount and currency. |
| `column25` | `Komentář` | string / `255i` | O | Additional information/comment. |
| `column26` | `BIC` | string / `11x` | O | Counterparty bank BIC. |
| `column17` | `ID pokynu` | number / `12n` | O | Instruction ID; can repeat across movements. |
| `column27` | `Reference plátce` | string / `255i` | O | Payer reference agreed between payment participants. |

`M` is mandatory and `O` is optional. The PDF examples encode IDs and amounts as JSON numbers, text/symbols as strings, and nullable optional columns as `null`. Preserve leading zeroes in symbol fields. (PDF §§4, 5.3.1.1, 5.3.1.6, pp. 5, 10, 26–29.)

### Merchant/card transaction response

The XML response uses `<MerchantStatement><Info>...` and `<TransactionList><Transaction>...`. Fields are UTF-8. The PDF says this data is available to business clients using POS/payment-gateway services and offers XML and CSV. (PDF §5.3.2.1–.2, pp. 35–39.)

`Info` fields: `accountId` (M, `16n`), `bankId` (M, `4!n`), `currency` (M, `3!x`), `iban` (M, `34x`), `bic` (M, `11x`), `dateStart` and `dateEnd` (O, `YYYY-MM-DD+GMT`).

| XML transaction field | Required? | Format | Meaning |
|---|---|---|---|
| `operationId` | M | `12n` | Unique card-movement ID. |
| `orderId` | M | `12n` | Unique card-transaction instruction ID. |
| `date` | M | `YYYY-MM-DD+GMT` | Posting date. |
| `amount` | M | `18d` | Total transaction amount in the batch. |
| `note` | O | `50e` | Transaction note/details. |
| `branchName` | O | `50e` | Branch identifier. |
| `transactionId` | O | `12n` | Unique transaction identifier. |
| `deviceId` | O | `20e` | POS/payment-gateway device identifier. |
| `transactionDateTime` | O | date/time with GMT offset (example: `YYYY-MM-DDTHH:MM:SS+02:00`) | Transaction date/time. |
| `autorizationNumber` | O | `10x` | Authorization number (spelling as published). |
| `cardNumber` | O | `50e` | Masked card number. |
| `transactionAmount` | O | `18d` | Transaction amount. |
| `transactionCurrency` | O | `3!x` | Transaction currency, ISO 4217. |
| `type` | O | `12e` | `ON_US` (Fio card), `DOMESTIC` (Czech card), or `FOREIGN` (foreign card). |
| `cardIssuer` | O | `12x` | Card issuer/brand. |
| `totalFees` | O | `18d` | Total fees. |
| `fioFee` | O | `18d` | FIO fee. |
| `interchangeFee` | O | `18d` | Interchange fee. |
| `cardAsosiationFee` | O | `18d` | Card-association fee (spelling as published). |
| `flexibleCommission` | O | `18d` | Card-issuer fee. |
| `settlement` | O | `5x` | Whether the transaction is settled (`true`/`false`). |
| `settlementDate` | O | date with GMT offset | Settlement date. |
| `VS` | O | `20n` | Variable symbol entered during POS/e-commerce transaction. |

For merchant CSV, the PDF specifies UTF-8, semicolon-separated fields, newline-separated rows, and double-quote escaping for fields containing semicolons. (PDF §5.3.2.2, p. 38.)

## Download marker (`zarážka`)

`last` reads from the stored marker and automatically moves it to the latest returned movement ID or date **only if the response contains movements**. An empty result contains only basic account/header information and leaves the marker unchanged. Manual marker changes are described as exceptional, useful after processing errors or when retrieving information again: `set-last-id` sets the last successfully downloaded movement ID; `set-last-date` sets the last unsuccessfully downloaded day. (PDF §5, p. 8; JSON marker field §5.3.1.6, p. 26.)

The PDF permits reading movements in multiple formats, but recommends against downloading movements in different formats using the same token; if two formats are needed, it advises creating another token for the same account. (PDF §2, p. 4.)

## Limits and errors

| HTTP/error code | Documented meaning |
|---|---|
| `404 Not Found` | Bad request parameters in URL/query/import; server cannot answer correctly. (PDF §8, p. 54.) |
| `409 Conflict` | Token was used too soon: only one read or write per token in each 30-second interval, regardless of format. (PDF §8, p. 54.) |
| `500 Internal Server Error` | Token does not exist or is inactive; verify token correctness and validity in Internetbanking. This is not documented as a read-only/write-permission error. (PDF §8, p. 54.) |
| `413 Příliš mnoho položek` | Download request would return more than 50,000 movements. Reduce the date range or move the marker forward. (PDF §8, p. 55.) |
| `422` (PDF label: `Error: 422`) | Request includes data older than 90 days without strong authorization for historical access. (PDF §8, p. 55.) |

The minimum recommended interval is also stated as 30 seconds in §5 (p. 7); §8 (p. 54) makes the rule explicit as one read **or** write per token per 30 seconds. This is token-wide, not per endpoint or format.

For uploads, a file larger than 2 MB yields import `errorCode` 13 (not the download HTTP 413 limit). The PDF gives no maximum count of payment instructions per batch. Older-than-90-day data requires temporarily unlocking full history for the token in Internetbanking; after strong authorization, history is accessible for 10 minutes. (PDF §3, p. 4; §6, p. 40; §8, p. 55.)

The PDF also shows the body text `The server encoutered an internal error () that prevented it from fulfilling this request.` for an upload sent as a regular POST rather than as a multipart file attachment, but gives no HTTP status for it. An SSL `unable to get local issuer certificate` issue is a client trust-store/certificate failure, not a documented API status. (PDF §8, pp. 54–55.)

## Payment import

### HTTP request and formats

Import uses `POST https://fioapi.fio.cz/v1/rest/import/` with `multipart/form-data`. Required fields: `token` (64-character unique token), `type` (`abo`, `xml`, `pain001_xml`, or `pain008_xml`), and `file` (the file part must use the name `file` and include its original `filename` in `Content-Disposition`). Optional `lng`: `cs`, `sk`, or `en`, selecting response-label language. The API responds in XML. (PDF §6, p. 40.)

Fio XML uploads use the `importIB.xsd` schema linked by the PDF. Within one XML file, transaction types must appear in this order: domestic, euro, foreign; otherwise the file is rejected. (PDF §6, p. 41; schema: [importIB.xsd](https://www.fio.cz/schema/importIB.xsd).)

| Type | Formats and notes |
|---|---|
| `abo` | ABO import in CZK is for Czech banks; other currencies are allowed only within FIO (bank code 2010). Currency is determined by the sender account. EUR payments to Slovak banks are not supported this way. (PDF §6, p. 41.) |
| `xml` | FIO XML containing `DomesticTransaction`, `T2Transaction`, and/or `ForeignTransaction` under `<Import><Orders>`. XML examples declare UTF-8. (PDF §6, pp. 41–46.) |
| `pain001_xml` | SEPA credit transfer: pain.001.001.03 or .09; EUR only. `BIC` and `BICOrBEI` are optional if present in the applicable XSD format. (PDF §6.4, p. 49; schemas: [pain.001.001.03.xsd](https://www.fio.cz/schema/pain.001.001.03.xsd), [pain.001.001.09.xsd](https://www.fio.cz/schema/pain.001.001.09.xsd).) |
| `pain008_xml` | SEPA direct debit: pain.008.001.02. (PDF §6.4, p. 52; schema: [pain.008.001.02.xsd](https://www.fio.cz/schema/pain.008.001.02.xsd).) |

FIO XML field conventions from §4 (PDF pp. 5–6): `M` required, `O` optional, `C` conditional; `x` alphanumeric, `e` alphanumeric plus `, . / -` and space, `i` alphanumeric including diacritics plus `, . / -` and space, `n` numeric, `!` fixed length; `d` decimal with a dot and `D` decimal with a comma.

### Domestic payment: `DomesticTransaction`

FIO XML domestic payment elements (PDF §6.3.1, pp. 41–42):

| Element | M/O/C | Format | Meaning / allowed values |
|---|---:|---|---|
| `accountFrom` | M | `16n` | Payer account number. |
| `currency` | M | `3!x` | Payer-account currency, ISO 4217. |
| `amount` | M | `18d` | Payment amount. |
| `accountTo` | M | `6n-10n` | Payee/collection account number. |
| `bankCode` | M | `4!n` | Payee/collection bank code. |
| `ks` | O | `4n` | Constant symbol. |
| `vs` | O | `10n` | Variable symbol. |
| `ss` | O | `10n` | Specific symbol. |
| `date` | M | `YYYY-MM-DD` | Date. |
| `messageForRecipient` | O | `140i` | Message shown to recipient. |
| `comment` | O | `255i` | User's label. |
| `paymentReason` | O | `3!n` | Payment reason; see full code list below. |
| `paymentType` | O | `6!n` | `431001` standard; `431005` priority; `431022` collection instruction. |

### Euro payment: `T2Transaction`

FIO XML euro payment elements (PDF §6.3.2, pp. 42–43):

| Element | M/O/C | Format | Meaning / allowed values |
|---|---:|---|---|
| `accountFrom` | M | `16n` | Payer account number. |
| `currency` | M | `3!x` | Payer-account currency, ISO 4217; example `EUR`. |
| `amount` | M | `18d` | Payment amount. |
| `accountTo` | M | `34x` | Payee IBAN, ISO 13616. |
| `ks` | O | `4n` | Constant symbol. |
| `vs` | O | `10n` | Variable symbol. |
| `ss` | O | `10n` | Specific symbol. |
| `bic` | O | `11!x` | Payee bank BIC, ISO 9362. |
| `date` | M | `YYYY-MM-DD` | Date. |
| `comment` | O | `140e` | User's label. |
| `benefName` | M | `35e` | Beneficiary account holder. |
| `benefStreet` | O | `35x` | Beneficiary street. |
| `benefCity` | O | `35x` | Beneficiary city. |
| `benefCountry` | O | `3x` | Beneficiary country code; PDF lists country codes on pp. 43–45. |
| `remittanceInfo1` | O | `35x` | Recipient information line 1. |
| `remittanceInfo2` | O | `35x` | Recipient information line 2. |
| `remittanceInfo3` | O | `35x` | Recipient information line 3. |
| `paymentReason` | C | `3!n` | Required only for accounts at FIO's Slovak branch when payment exceeds EUR 50,000; use the code list below. |
| `paymentType` | O | `6!n` | `431008` standard; `431009` priority; `431018` instant. |

### Foreign payment: `ForeignTransaction`

FIO XML foreign payment elements (PDF §6.3.3, pp. 45–46):

| Element | M/O/C | Format | Meaning / allowed values |
|---|---:|---|---|
| `accountFrom` | M | `16n` | Payer account number. |
| `currency` | M | `3!x` | Payer-account currency, ISO 4217. |
| `amount` | M | `18d` | Payment amount. |
| `accountTo` | M | `34x` | Payee account number/IBAN. |
| `bic` | M | `11!x` | Payee bank BIC, ISO 9362. |
| `date` | M | `YYYY-MM-DD` | Date. |
| `comment` | O | `140e` | Additional information. |
| `benefName` | M | `35e` | Beneficiary account holder. |
| `benefStreet` | M | `35x` | Beneficiary street. |
| `benefCity` | M | `35x` | Beneficiary city. |
| `benefCountry` | M | `3x` | Beneficiary country code; PDF lists country codes on pp. 43–45. |
| `remittanceInfo1` | M | `35x` | Recipient information line 1. |
| `remittanceInfo2` | O | `35x` | Recipient information line 2. |
| `remittanceInfo3` | O | `35x` | Recipient information line 3. |
| `remittanceInfo4` | O | `35x` | Recipient information line 4. |
| `detailsOfCharges` | M | `6!n` | `470501` all charges paid by sender (`OUR`); `470502` all charges paid by recipient (`BEN`); `470503` each party pays its own (`SHA`). |
| `paymentReason` | M | `3!n` | Payment reason; see full code list below. |

### Payment-reason codes

The following are the values in the PDF's `Platební titul` list (§6.3.4, pp. 46–49). The Czech descriptions are retained as published.

| Code | Czech description |
|---:|---|
| 110 | Vývoz zboží |
| 112 | Finanční pronájem (leasing) – vývoz |
| 120 | Dovoz zboží |
| 122 | Finanční pronájem (leasing) – dovoz |
| 130 | Reexport |
| 132 | Zpracování |
| 135 | Opravy |
| 190 | Transakce z použití směnek a šeků |
| 195 | Časově neidentifikované platební tituly |
| 210 | Železniční nákladní – inkasa a platby spojené s přepravou zboží po železnici |
| 211 | Železniční osobní – inkasa a platby spojené s přepravou osob po železnici |
| 212 | Železniční ostatní |
| 213 | Námořní nákladní |
| 214 | Námořní osobní |
| 215 | Námořní ostatní |
| 216 | Vnitrozemská vodní nákladní |
| 217 | Vnitrozemská vodní osobní |
| 218 | Vnitrozemská vodní ostatní |
| 219 | Letecká nákladní |
| 220 | Letecká osobní |
| 221 | Letecká ostatní |
| 222 | Silniční nákladní |
| 223 | Silniční osobní |
| 224 | Silniční ostatní |
| 226 | Kombinovaná doprava |
| 233 | Kosmická doprava |
| 235 | Potrubní tranzit |
| 239 | Ostatní přepravní služby |
| 260 | Nákup cizí měny za hotovost |
| 262 | Nákup cizí měny s připsáním na účet fyzické osoby v Kč |
| 265 | Nákup cizí měny s připsáním na účet právnické osoby v Kč |
| 270 | Prodej cizí měny za hotovost |
| 272 | Prodej cizí měny s odepsáním z účtu fyzické osoby v Kč |
| 275 | Prodej cizí měny s odepsáním z účtu právnické osoby v Kč |
| 280 | Aktivní cestovní ruch |
| 282 | Pasivní cestovní ruch |
| 285 | Mimobankovní směnárny |
| 295 | Transakce z použití platebních karet |
| 310 | Poštovní služby |
| 311 | Kurýrní služby |
| 312 | Telekomunikační a radiokomunikační služby |
| 315 | Stavební a montážní práce v zahraničí |
| 318 | Stavební a montážní práce v tuzemsku |
| 320 | Ziskové operace se zbožím |
| 325 | Opravy |
| 326 | Pojištění zboží |
| 327 | Zajištění (pojišťoven) |
| 328 | Pomocné služby při pojištění |
| 330 | Ostatní pojištění |
| 332 | Životní a penzijní pojištění |
| 335 | Finanční služby |
| 340 | Reklama |
| 345 | Právní služby |
| 346 | Účetnické a auditorské služby |
| 347 | Poradenství v podnikání a řízení, služby v oblasti vytváření vztahu k veřejnosti – public relations |
| 348 | Nájemné |
| 352 | Pronájem strojů a zařízení |
| 355 | Výzkum a vývoj |
| 360 | Autorské honoráře, licenční poplatky |
| 361 | Ochranné známky, franšízy |
| 365 | Služby výpočetní techniky |
| 368 | Informační služby |
| 369 | Služby mezi podniky v rámci přímých investic |
| 370 | Diplomatická zastoupení České republiky v zahraničí |
| 372 | Zahraniční diplomatická zastoupení v České republice |
| 375 | Vládní příjmy a výdaje |
| 376 | Ostatní vládní příjmy a výdaje |
| 378 | Zprostředkovatelské služby |
| 380 | Ostatní služby obchodní povahy |
| 382 | Audiovizuální služby |
| 384 | Služby v oblasti vzdělávání |
| 385 | Služby v oblasti kultury, zábavy, sportu a rekreace |
| 386 | Služby v oblasti zdravotnictví a veterinární péče |
| 387 | Služby v oblasti zemědělství |
| 388 | Služby v oblasti odpadového hospodářství |
| 390 | Technické služby |
| 392 | Služby v oblasti těžebního průmyslu |
| 395 | Zastoupení českých firem v zahraničí |
| 397 | Zastoupení zahraničních firem v ČR |
| 410 | Převody pracovních příjmů u krátkodobého pobytu |
| 412 | Převody pracovních příjmů u dlouhodobého pobytu |
| 510 | Výnosy z přímých investic |
| 520 | Výnosy z portfoliových investic |
| 530 | Úroky – přímé investice |
| 532 | Úroky – portfoliové investice |
| 535 | Úroky z finančních a ostatních úvěrů |
| 538 | Úroky z obchodních úvěrů |
| 540 | Úroky z depozit |
| 550 | Důchody z půdy |
| 610 | Převody (nenávratné) – podpory, odškodnění, věna apod. |
| 612 | Dědictví a dary |
| 615 | Výživné |
| 618 | Penze |
| 620 | Příspěvky mezinárodním organizacím ze státního rozpočtu |
| 622 | Příspěvky mezinárodním organizacím mimo státní rozpočet |
| 625 | Převody v souvislosti s vystěhováním |
| 628 | Zahraniční pomoc |
| 630 | Dotace |
| 632 | Pokuty, penále |
| 635 | Daně a poplatky |
| 640 | Nákup a prodej vlastnických práv a nefinančních aktiv |
| 650 | Ostatní finanční převody |
| 652 | Příspěvky a výhry |
| 653 | Vklady a příspěvky do nadací a nadačních fondů |
| 725 | Finanční deriváty |
| 735 | Nákup a prodej nemovitostí v zahraničí |
| 740 | Poskytnuté úvěry krátkodobé účelové |
| 742 | Poskytnuté úvěry krátkodobé finanční (bez stanoveného účelu) |
| 745 | Poskytnuté úvěry střednědobé a dlouhodobé účelové |
| 748 | Poskytnuté úvěry střednědobé a dlouhodobé finanční (bez stanoveného účelu) |
| 750 | Vklady a výběry z vkladů promptních a krátkodobých |
| 752 | Dotace účtů |
| 755 | Vklady a výběry z vkladů střednědobých a dlouhodobých |
| 760 | Konverze, arbitráže a další operace |
| 762 | Řízení likvidity peněžních prostředků (cash-pooling, zero balancing) |
| 770 | Členské podíly v mezinárodních organizacích |
| 790 | Zajištění závazků cizozemce |
| 818 | Tuzemské portfoliové investice |
| 820 | Tuzemské dluhové cenné papíry krátkodobé |
| 822 | Tuzemské dluhové cenné papíry střednědobé a dlouhodobé |
| 825 | Finanční deriváty |
| 835 | Nákup a prodej nemovitostí v tuzemsku |
| 850 | Vklady a výběry z vkladů promptních a krátkodobých |
| 852 | Dotace účtů |
| 855 | Vklady a výběry z vkladů střednědobých a dlouhodobých |
| 862 | Řízení likvidity peněžních prostředků (cash-pooling, zero balancing) |
| 890 | Zajištění závazku tuzemce |
| 950 | Převody mezi tuzemci |
| 952 | Převody mezi cizozemci |

### Import response XML

The PDF's response table defines `errorCode`, `idInstruction`, `status`, `sumDebet`, and `sumCredit`; it points to `responseImportIB.xsd` for the full response schema. The linked schema additionally defines result-level messages and per-order details. (PDF §6, pp. 40–41; schema: [responseImportIB.xsd](https://www.fio.cz/schema/responseImportIB.xsd).)

```xml
<responseImport>
  <result>
    <errorCode>...</errorCode>
    <idInstruction>...</idInstruction>
    <status>...</status>
    <message>...</message>
    <sums>
      <sum id="...">
        <sumCredit>...</sumCredit>
        <sumDebet>...</sumDebet>
      </sum>
    </sums>
  </result>
  <ordersDetails>
    <detail id="...">
      <messages>
        <message status="..." errorCode="...">...</message>
      </messages>
    </detail>
  </ordersDetails>
</responseImport>
```

In the linked XSD, `<result>` is required; `errorCode` (`unsignedShort`) and `status` are required; `idInstruction` (`nonNegativeInteger`) and `message` may repeat; `sums` is optional and can contain repeated `<sum>` values whose `sumCredit` and `sumDebet` values are decimals with up to two fractional digits. `ordersDetails` is optional and contains zero or more `<detail>` values; each optional per-detail message has text and optional `status` and `errorCode` attributes. `status` values are `ok`, `error`, `warning`, and `fatal`.

| `errorCode` | Meaning in PDF |
|---:|---|
| 0 | OK; instruction was accepted. |
| 1 | Validation found errors. |
| 2 | Validation warnings; values are incorrectly filled. |
| 11 | Syntax error. |
| 12 | Empty import: no instructions in the file. |
| 13 | File too long: over 2 MB. |
| 14 | Empty file: contains no instructions. |

`status=ok` means accepted. `error` is a major instruction error and the batch is not accepted. `warning` means a value mismatch (for example, payment currency and account currency); instructions with warnings are accepted. `fatal` means a bank-system error; all instructions are rejected. Acceptance is not execution: the imported batch must subsequently be authorized by an authorized account holder (SMS or Fio signature) in Internetbanking; without that authorization the instructions are not processed. The PDF does not enumerate per-detail message codes. (PDF §6, pp. 40–41.)

## Encoding

The PDF explicitly specifies UTF-8 for Fio XML movements, JSON movements, HTML movements, merchant XML/CSV, and MT940/STA; CSV export is UTF-8. Fio XML and SEPA XML examples declare UTF-8. It does not state a separate global character-encoding rule for every upload format. (PDF §§5.3.1.1, 5.3.1.4–.7, 5.3.2, 6, pp. 9, 23, 25–26, 30, 35, 38, 41–53.)

## Open questions / ambiguities

- **Permission discovery:** no documented API endpoint reports token permissions, and the PDF does not say what status/body a read-only token receives on upload. There is no documented side-effect-free write-permission probe; a successful probe creates a batch. (PDF §§2, 6, 8.)
- **Token error distinction:** the documented HTTP 500 meaning is nonexistent or inactive token. The PDF does not say whether expired, not-yet-active, and other invalid-token cases differ, nor whether permission denial is mapped to 500. (PDF §8, p. 54.)
- **Statement lookup result:** `/lastStatement/{token}/statement` is documented, but its response body and exact statement year/number representation are absent. (PDF §5, pp. 8–9.)
- **Period boundaries:** the endpoint takes `YYYY-MM-DD` start and end dates, but the PDF does not say whether bounds are inclusive or how the timezone is selected. (PDF §5, p. 7.)
- **JSON schema:** the PDF provides field descriptions and examples, not a formal JSON Schema. It also conflicts on movement ID width: JSON table says 10 numeric characters (`column22`), while the Fio XML table says `12n`. (PDF §§5.3.1.1, 5.3.1.6, pp. 10, 26.)
- **HTTP failure coverage:** documented statuses are 404, 409, 500, 413, and 422. The PDF gives no separate status for read-only upload, malformed multipart bodies beyond the unlabelled server-error text, or individual order-message codes. It gives no maximum count of instructions per import batch. (PDF §§6, 8.)
- **Format suffix:** the PDF identifies statement MT940 and `.STA` output, but does not show its exact URL suffix; `sta` is inferred. It also does not give response bodies for successful marker-setting calls. (PDF §5, pp. 8, 30.)
- **Merchant CSV / export formats:** the PDF lists formats and describes CSV generally; detailed behavior for all non-JSON movement formats is outside this summary. See PDF §5.3 for format-specific serialization. (PDF pp. 15–39.)
