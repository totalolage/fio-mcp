<img src="assets/icon.svg" width="64" height="64" alt="">

# fio-mcp

An [MCP](https://modelcontextprotocol.io) server for [FIO Bank](https://www.fio.cz)'s REST API ("API Bankovnictví"). It exposes every tool: reading transactions and statements, and preparing and uploading payment orders, which still have to be signed in Internetbanking. If a token isn't allowed to do something, the tool answers "You don't have permissions to do that."

The API reference this server is built against is in [docs/fio-api.md](docs/fio-api.md) (summarised from FIO's PDF, version 1.9 of 16 October 2025).

## Requirements

- Node.js 20 or newer
- One or more FIO API tokens, created in Internetbanking under **Nastavení → API**

## Install and build

```sh
npm install
npm run build        # compiles to dist/
npm test             # unit and in-memory MCP integration tests
npm run typecheck
```

Run it with `node dist/index.js` or, once installed as a package, `npx fio-mcp`. The server speaks MCP over stdio and logs only to stderr.

## Configuration

Everything is set through environment variables.

### One account

| Variable | Required | Meaning |
|---|---|---|
| `FIO_TOKEN` | yes | The 64-character API token. |
| `FIO_ACCOUNT_NAME` | no | Name shown to the model. Default `default`. |
| `FIO_ACCOUNT_NUMBER` | no | Your FIO account number without bank code (e.g. `2400222222`). Used as the payer for payment orders. If unset, the server reads it from the first statement it downloads. |
| `FIO_ACCOUNT_CURRENCY` | no | Account currency (e.g. `CZK`). Default currency for payment orders. Also learned from statements. |

### Several accounts

FIO issues one token per account. To use several, set `FIO_ACCOUNTS` to a JSON array instead of `FIO_TOKEN`:

```json
[
  { "name": "personal", "token": "…" },
  { "name": "business", "token": "…", "accountNumber": "2400222222", "currency": "CZK" }
]
```

`name` must be 1–32 letters, digits, `_` or `-`, and unique. Setting both `FIO_TOKEN` and `FIO_ACCOUNTS` is an error.

### Tuning

| Variable | Default | Meaning |
|---|---|---|
| `FIO_RATE_LIMIT_INTERVAL_MS` | `30000` | Minimum gap between requests with the same token. Values below `30000` (FIO's limit) are rejected at startup. |
| `FIO_MAX_WAIT_MS` | `25000` | Longest a tool call may wait for the rate limiter before failing with "retry after N s". |
| `FIO_REQUEST_TIMEOUT_MS` | `20000` | HTTP timeout per request. |
| `FIO_API_BASE_URL` | `https://fioapi.fio.cz/v1/rest` | API base URL. Change it only for testing. |

### Example MCP client config

Claude Desktop (`claude_desktop_config.json`) or any client that uses the same format:

```json
{
  "mcpServers": {
    "fio": {
      "command": "node",
      "args": ["/path/to/fio-mcp/dist/index.js"],
      "env": {
        "FIO_TOKEN": "your-64-character-token"
      }
    }
  }
}
```

Several accounts:

```json
{
  "mcpServers": {
    "fio": {
      "command": "npx",
      "args": ["-y", "fio-mcp"],
      "env": {
        "FIO_ACCOUNTS": "[{\"name\":\"personal\",\"token\":\"…\"},{\"name\":\"business\",\"token\":\"…\",\"accountNumber\":\"2400222222\"}]"
      }
    }
  }
}
```

## Permissions

FIO tokens have one of two levels, chosen when the token is created:

- **Sledování účtu**: read-only account monitoring.
- **Sledování účtu a zadávání platebních a inkasních příkazů**: monitoring plus entering payment and collection orders.

The API has no endpoint that reports a token's level, so the server doesn't try to find out. Every tool is always listed. When FIO refuses a call because the token may not do it, the tool returns an error that starts with:

> You don't have permissions to do that.

It is followed by one line saying what FIO answered and, for payments, which token level is needed. That message is used for:

| FIO's answer | Call |
|---|---|
| HTTP 401 or 403 | any |
| HTTP 500 (FIO's code for a missing or inactive token, and the likely answer to a read-only token trying to upload) | payment upload |
| Upload rejected with a batch-level message that mentions the token or API **and** denies a right (e.g. "Token does not have permission…", "Token nemá oprávnění…") | payment upload |

FIO does not document what a read-only token gets back on upload, so this is a best guess. Other errors keep their own messages. On reads, HTTP 500 is reported as "token does not exist or is inactive". Ordinary validation failures and content restrictions (e.g. "payments to this country are not permitted") come back as a normal rejected result. With several accounts, every tool takes an `account` argument listing all configured account names. Tool inputs are strict: unknown arguments are rejected.

## Tools

| Tool | What it does |
|---|---|
| `get_server_status` | Account names (never tokens), account numbers and currencies where known, and each token's rate-limit state. No network call. |

### Reading (works with any token)

| Tool | Endpoint | Notes |
|---|---|---|
| `get_transactions` | `periods` | Movements between two dates, normalised JSON (named fields instead of `columnN`). Read-only. |
| `get_statement` | `by-id` | Official statement by year and number. Read-only. |
| `get_new_transactions` | `last` | Movements since the last download. **Not read-only**: a non-empty result moves the token's server-side download marker, which also affects other programs using the same token. |
| `set_download_marker` | `set-last-id` / `set-last-date` | Moves that marker by movement ID or date. Changes bank-side state but moves no money. |
| `get_last_statement` | `lastStatement` | Year and number of the latest statement. FIO does not document the response format, so the raw text is included. |
| `export_transactions` | `periods` / `by-id` / `merchant` | Raw text export: `csv`, `gpc`, `html`, `json`, `ofx`, `xml`. Statements also support `sta` (MT940), `cba_xml`, and `sba_xml`; merchant card transactions support `xml` and `csv`. PDF is not offered. |

Data older than 90 days is only served after the account owner unlocks full history for the token in Internetbanking (HTTP 422 otherwise). A download of more than 50,000 movements fails with HTTP 413.

### Payments (need a token with the payment-order level)

| Tool | What it does |
|---|---|
| `preview_payment_orders` | Dry run. Validates the orders and returns the exact XML that would be uploaded, with per-currency totals. Sends nothing. |
| `submit_payment_orders` | Uploads the orders as one batch (Fio XML import) and returns FIO's parsed verdict, `outcome`: `accepted`, `rejected` (nothing created), or `unknown`. It also returns the batch ID, totals, and per-order messages. Requires `confirm: true`. Annotated `destructiveHint: true`. |

Both take `orders`: 1–100 orders, each one of:

- `domestic`: Czech payment (also for foreign-currency transfers between FIO accounts). `paymentType` is `standard`, `priority`, or `collection`. **`collection` is a direct-debit order that pulls money from the counterparty.**
- `euro`: SEPA/T2 payment to an IBAN (checksum-validated). `paymentType` is `standard`, `priority`, or `instant`.
- `foreign`: other foreign payments. BIC, beneficiary address, `remittanceInfo1`, `detailsOfCharges` (`OUR`, `BEN`, `SHA`), and `paymentReason` are required.

Orders are sent in the order FIO requires (domestic, euro, foreign), and all text is XML-escaped.

## Payment safety

- **Uploading does not pay anything by itself.** Per FIO's documentation, an imported batch must be signed by an authorized person in Internetbanking (SMS or Fio signature) before FIO processes it. Treat an upload as real anyway: it creates a pending batch in the bank.
- Payment tools are always listed, but FIO refuses uploads from a read-only token. Give the server a read-only token unless you need payments.
- `submit_payment_orders` requires `confirm: true` and is annotated destructive, so MCP clients that ask before destructive actions will ask. Have the model show you `preview_payment_orders` output first.
- Validation covers formats, lengths, and enums from the PDF and `importIB.xsd`: account and bank-code patterns, symbols, dates, 2-decimal amounts, BIC, IBAN checksum, the XSD's country list (`country_type`), payment-reason codes, and fee codes. FIO's character-set classes (for example "no diacritics" in euro beneficiary names) are described in the tool schema but not enforced locally. FIO rejects such a batch with a validation error instead of creating it.
- If the outcome is uncertain, the server says so instead of reporting a rejection. That covers a timeout or network failure during upload, an unexpected HTTP status, an unparseable response, or a response with a missing status or an error status alongside a batch ID. Check pending batches in Internetbanking before submitting again, or the orders may be duplicated.
- Amounts must be exact to the cent, from 0.01 up to 999,999,999,999.99.
- The payer account is fixed by the token's account: the configured `accountNumber`, or the number read from a downloaded statement.

## Rate limiting

FIO allows **one request per token every 30 seconds**, for any operation, and answers HTTP 409 otherwise.

- Each token has one serialized queue. Calls run in arrival order, at least `FIO_RATE_LIMIT_INTERVAL_MS` apart. Accounts that share a token share the queue.
- A call that would wait longer than `FIO_MAX_WAIT_MS` (default 25 s) for its slot fails immediately with `Rate limited: … Retry after N s.` This keeps calls below typical MCP client timeouts (about 60 s).
- On HTTP 409 (another program used the token), the token is treated as busy for a full interval. Calls already queued are pushed back too, and any whose budget that exceeds fail fast. The call that got the 409 is retried once **if the extra wait still fits in `FIO_MAX_WAIT_MS`**. With the defaults (30 s interval, 25 s budget) the retry does not fit, so the call fails fast with a retry-after hint. Raise `FIO_MAX_WAIT_MS` above 30000 if your client tolerates longer calls and you want the automatic retry. A second 409 always fails.
- `get_server_status` shows each account's next free slot.

## Security

- Tokens never appear in tool results or logs. They are redacted from error messages, response excerpts, and URLs (read tokens are part of the URL path).
- Logs go to stderr only. Stdout is the MCP channel.
- Config errors name the bad field but never echo its value. Configured tokens are registered for redaction before validation starts.

## Development

```
src/
  index.ts            stdio entry point (bin)
  config.ts           environment parsing
  server.ts           tool definitions and registration, permission-denied messages, status tool
  accounts.ts         configured accounts, their clients and rate limiters
  fio-client.ts       HTTP client for one token
  rate-limiter.ts     per-token serialized queue
  statement.ts        JSON statement normalisation
  payments.ts         order schemas and import XML builder
  fio-countries.ts    country codes from the XSD's country_type enumeration
  import-response.ts  import response parser
  redact.ts           token redaction and stderr logger
  errors.ts           error types and HTTP status mapping
test/                 vitest suites, including an in-memory MCP client/server test
```

Tests mock `fetch` and make no network calls.

## Known limitations

- The response body of `lastStatement` and the read-only upload response are undocumented. The parsing and classification above are best effort.
- Only the Fio XML import format is used. ABO and SEPA `pain.001`/`pain.008` uploads are not exposed.
