<img src="assets/icon.svg" width="64" height="64" alt="">

# fio-mcp

An [MCP](https://modelcontextprotocol.io) server for [FIO Bank](https://www.fio.cz)'s REST API ("API Bankovnictví"). Its tools read transactions and statements, and prepare and upload payment orders, which still have to be signed in Internetbanking. Every tool is listed whatever the FIO tokens may do; if a token isn't allowed to do something, the tool answers "You don't have permissions to do that." Over HTTP with OAuth, a client sees only the tools and accounts it was granted.

FIO allows one request per token every 30 seconds. To keep interactive use fast, the server keeps a local SQLite cache of your transactions and answers searches and summaries from it without calling FIO.

The API reference this server is built against is in [docs/fio-api.md](docs/fio-api.md) (summarised from FIO's PDF, version 1.9 of 16 October 2025). The machine-readable version is [openapi/fio-api.yaml](openapi/fio-api.yaml).

## Requirements

- Node.js 22.13 or newer (24 LTS recommended; the cache uses the built-in `node:sqlite`)
- One or more FIO API tokens, created in Internetbanking under **Nastavení → API**

## Install and build

```sh
npm install          # also patches TypeScript for Effect diagnostics and builds dist/
npm run build        # compiles to dist/
npm test
```

Run it with `node dist/main.js` or, once installed as a package, `npx fio-mcp`. By default it speaks MCP over stdio and logs only to stderr. See [HTTP transport and OAuth](#http-transport-and-oauth) for running it as a network service.

| Command | What it does |
|---|---|
| `fio-mcp` | Serve MCP (`FIO_MCP_TRANSPORT=stdio` or `http`). |
| `fio-mcp backup <dest>` | Write a consistent copy of the database (see [Backup](#backup)). |
| `fio-mcp hash-password` | Read the admin password from the terminal (no echo) or stdin and print its scrypt hash. |
| `fio-mcp clients list` / `clients revoke <id>` | List or revoke registered OAuth clients. |
| `fio-mcp tokens revoke-all` | Revoke every OAuth grant. |

## Configuration

Everything is set through environment variables. The FIO secrets (`FIO_TOKEN`, `FIO_ACCOUNTS`) can instead be read from a file named by the same variable with a `_FILE` suffix, for example `FIO_TOKEN_FILE=/run/secrets/fio_token`; the admin password hash is always read from `FIO_MCP_ADMIN_PASSWORD_HASH_FILE`. A trailing newline in the file is ignored. Setting both a variable and its `_FILE` twin is an error.

### One account

| Variable | Required | Meaning |
|---|---|---|
| `FIO_TOKEN` | yes | The API token (FIO issues 64 characters; at least 32 letters, digits, `.`, `_`, `~` or `-` are required). |
| `FIO_ACCOUNT_NAME` | no | Name shown to the model. Trimmed; 1–64 Unicode code points with no control, format (such as U+200B or U+202E) or line separator characters. Default `default`. |
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

Names are trimmed and must be 1–64 Unicode code points with no control, format (Unicode `Cc`, `Cf`, such as zero-width or bidi characters) or line separator characters. Other printable Unicode, including spaces and diacritics, is allowed. Names must be unique ignoring case after trimming. Setting both `FIO_TOKEN` and `FIO_ACCOUNTS` is an error.

### Tuning

| Variable | Default | Meaning |
|---|---|---|
| `FIO_RATE_LIMIT_INTERVAL_MS` | `30000` | Minimum gap between requests with the same token. Values below `30000` (FIO's limit) are rejected at startup. |
| `FIO_MAX_WAIT_MS` | `25000` | Longest a tool call may wait for the rate limiter before failing with "retry after N s". |
| `FIO_REQUEST_TIMEOUT_MS` | `20000` | HTTP timeout per request, including reading the response. |
| `FIO_API_BASE_URL` | `https://fioapi.fio.cz/v1/rest` | API base URL. Change it only for testing. |

### Cache

| Variable | Default | Meaning |
|---|---|---|
| `FIO_CACHE_ENABLED` | `true` | `false` turns the local cache off: no database file, cache tools answer that the cache is disabled, `get_transactions` always asks FIO. |
| `FIO_DB_PATH` | `$XDG_DATA_HOME/fio-mcp/fio.sqlite`, else `~/.local/share/fio-mcp/fio.sqlite` (the Docker image sets `/data/fio.sqlite`) | SQLite database. The directory is created `0700`, the file `0600`. |
| `FIO_SYNC_ON_STARTUP` | `true` | Sync in the background at startup, including the backfill (see [Backfill](#backfill-and-history-older-than-90-days)). |
| `FIO_SYNC_INTERVAL_MINUTES` | `0` (off) | Repeat the incremental sync this often; at least `5`. |
| `FIO_BACKFILL_FROM` | `2000-01-01` | First day the backfill asks for. FIO serves what the account has. |
| `FIO_SYNC_OVERLAP_DAYS` | `10` | Days before the newest cached day that each incremental sync downloads again, to pick up late bookings. |
| `FIO_CACHE_MAX_AGE_MINUTES` | `60` | A cached day downloaded less than this long ago counts as fresh for `get_transactions`. |

### HTTP transport

| Variable | Default | Meaning |
|---|---|---|
| `FIO_MCP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `FIO_MCP_HOST` | `0.0.0.0` | HTTP bind address. |
| `FIO_MCP_PORT` | `3000` | HTTP port. |
| `FIO_MCP_PUBLIC_URL` | none; **required in HTTP mode** | The https origin clients use, without a path (e.g. `https://fio.home.arpa`). It is the OAuth issuer, and tokens are valid only for `<origin>/mcp`. It is never derived from `Host` or `X-Forwarded-*`. |
| `FIO_MCP_ADMIN_PASSWORD_HASH_FILE` | none; **required in HTTP mode** | File containing the admin password's scrypt hash, from `fio-mcp hash-password`. |
| `FIO_MCP_ALLOW_UNAUTHENTICATED` | `false` | `true` runs HTTP mode without OAuth: every caller gets full access, and a security warning is logged at startup. Only for a trusted test setup. |
| `FIO_MCP_ALLOWED_HOSTS` | any | Comma-separated `Host` values accepted (DNS-rebinding defence); an entry without a port matches any port. Include the public host. |
| `FIO_MCP_ALLOWED_ORIGINS` | none | Browser `Origin` values accepted on `/mcp`. Requests without `Origin` (ordinary MCP clients) are always accepted. |
| `FIO_MCP_TRUSTED_PROXIES` | none | Comma-separated IP addresses or CIDR networks (e.g. `172.18.0.5` or `172.18.0.0/16`) of reverse proxies in front of fio-mcp. Only for requests from these addresses, the client address for sign-in throttling is taken from `X-Forwarded-For` (the rightmost address that is not itself a trusted proxy). It is never used for URLs, the issuer or the resource. Empty trusts no one. |

In HTTP mode the OAuth tables live in the same SQLite file as the cache, so `FIO_DB_PATH` is needed even with `FIO_CACHE_ENABLED=false`.

Configuration errors name the variable, field, or file path, never its value.

### Example MCP client config (stdio)

Claude Desktop (`claude_desktop_config.json`) or any client that uses the same format:

```json
{
  "mcpServers": {
    "fio": {
      "command": "node",
      "args": ["/path/to/fio-mcp/dist/main.js"],
      "env": {
        "FIO_TOKEN": "your-64-character-token"
      }
    }
  }
}
```

## Permissions

FIO tokens have one of two levels, chosen when the token is created:

- **Sledování účtu**: read-only account monitoring.
- **Sledování účtu a zadávání platebních a inkasních příkazů**: monitoring plus entering payment and collection orders.

The API has no endpoint that reports a token's level, so the server doesn't try to find out, and a token's level never hides a tool. When FIO refuses a call because the token may not do it, the tool returns an error that starts with:

> You don't have permissions to do that.

It is followed by one line saying what FIO answered and, for payments, which token level is needed. That message is used for:

| FIO's answer | Call |
|---|---|
| HTTP 401 or 403 | any |
| HTTP 500 (FIO's code for a missing or inactive token, and the likely answer to a read-only token trying to upload) | payment upload |
| Upload rejected with a batch-level message that mentions the token or API **and** denies a right (e.g. "Token does not have permission…", "Token nemá oprávnění…") | payment upload |

FIO does not document what a read-only token gets back on upload, so this is a best guess. Other errors keep their own messages. On reads, HTTP 500 is reported as "token does not exist or is inactive". Ordinary validation failures and content restrictions (e.g. "payments to this country are not permitted") come back as a normal rejected result. With several accounts, every tool that acts on an account takes an `account` argument whose enum lists the configured account names (over HTTP, only the granted ones; see [Connecting a client](#connecting-a-client)). Tool inputs are strict: unknown arguments are rejected.

## Tools

| Tool | What it does |
|---|---|
| `get_server_status` | Account names (never tokens), account numbers and currencies where known, and each token's rate-limit state. No network call. |

### Reading from FIO (works with any token)

| Tool | Endpoint | Notes |
|---|---|---|
| `get_transactions` | `periods` | Movements between two dates, normalised JSON (named fields instead of `columnN`). `source`: `auto` (default) answers from the cache when the whole range is cached and current, otherwise asks FIO and stores the result; `fio` always asks FIO; `cache` never does. The result says which (`source`) and, from the cache, how fresh it is (`freshness`). Read-only. |
| `get_statement` | `by-id` | Official statement by year and number. Read-only. |
| `get_new_transactions` | `last` | Movements since the last download. **Not read-only**: a non-empty result moves the token's server-side download marker, which also affects other programs using the same token. |
| `set_download_marker` | `set-last-id` / `set-last-date` | Moves that marker by movement ID or date. Changes bank-side state but moves no money. |
| `get_last_statement` | `lastStatement` | Year and number of the latest statement. FIO does not document the response format, so the raw text is included. |
| `export_transactions` | `periods` / `by-id` / `merchant` | Raw text export: `csv`, `gpc`, `html`, `json`, `ofx`, `xml`. Statements also support `sta` (MT940), `cba_xml`, and `sba_xml`; merchant card transactions support `xml` and `csv`. PDF is not offered. |

Data older than 90 days is only served after the account owner unlocks full history for the token in Internetbanking (HTTP 422 otherwise). A download of more than 50,000 movements fails with HTTP 413. Statements fetched by `get_statement` and `get_new_transactions` are also stored in the cache.

### From the local cache (never call FIO)

| Tool | What it does |
|---|---|
| `search_transactions` | Filter cached movements by date range, amount range (absolute), direction (`in`/`out`), counterparty (name or account, substring), text in the message, comment or user identification, VS/KS/SS, type and currency. Paged (`limit` up to 1000, `offset`, `order`). Returns the rows, the total and `freshness`. |
| `summarize_transactions` | Totals by `month`, `counterparty` or `type`, always split by currency: count, income, expense, net (exact to the cent). Same filters. |
| `get_cache_status` | Per account: whether the cache is verified for its token, covered date ranges, last sync, row count, last known balance and its date, the running sync job, and whether history is limited to 90 days (with the unlock steps). |
| `sync_transactions` | Starts (or joins) a background sync for an account: `mode=incremental` (default), `mode=backfill` (optionally `from` a date), or `refresh: {from, to}` to re-download days that are already cached. Waits up to `FIO_MAX_WAIT_MS` and returns the job status. This one does call FIO, at background priority. |

Every answer from the cache includes `freshness`: the covered ranges in the requested period, the last successful sync, the oldest download among the days returned, whether history is limited, and `complete` (every requested day is cached).

### Payments (need a token with the payment-order level; over HTTP, also `fio:payments`)

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
- Payment tools are listed whatever the token's level (over HTTP, only to clients granted `fio:payments`), but FIO refuses uploads from a read-only token. Give the server a read-only token unless you need payments.
- `submit_payment_orders` requires `confirm: true` and is annotated destructive, so MCP clients that ask before destructive actions will ask. Have the model show you `preview_payment_orders` output first.
- Validation covers formats, lengths, and enums from the PDF and `importIB.xsd`: account and bank-code patterns, symbols, dates, 2-decimal amounts, BIC, IBAN checksum, the XSD's country list (`country_type`), payment-reason codes, and fee codes. FIO's character-set classes (for example "no diacritics" in euro beneficiary names) are described in the tool schema but not enforced locally. FIO rejects such a batch with a validation error instead of creating it.
- If the outcome is uncertain, the server says so instead of reporting a rejection. That covers a timeout or network failure after the request was sent, an unexpected HTTP status, an unparseable response, or a response with a missing status or an error status alongside a batch ID. Check pending batches in Internetbanking before submitting again, or the orders may be duplicated. A failure before anything was sent (rate limit, invalid input) is reported as certain.
- Amounts must be exact to the cent, from 0.01 up to 999,999,999,999.99.
- The payer account is fixed by the token's account: the configured `accountNumber`, or the number read from a downloaded statement.

## Rate limiting

FIO allows **one request per token every 30 seconds**, for any operation, and answers HTTP 409 otherwise.

- Each token has one dispatcher with two FIFO queues. Tool calls (interactive) go before cache sync requests (background), so a long backfill never sits ahead of your question. Request starts are at least `FIO_RATE_LIMIT_INTERVAL_MS` apart. Accounts that share a token share the dispatcher, and so do all MCP sessions of one server process.
- Steady tool calls cannot starve sync. The next sync request in line takes the next slot once 2 tool calls have started ahead of it or it has waited two intervals (60 s by default), whichever comes first. Both count from its arrival or the previous sync request's start, whichever is later, so with the default interval it starts within about 90 s unless a 409 blocks the token. A tool call whose slot it takes gets the slot after, or fails fast if that is past its budget.
- A tool call that would wait longer than `FIO_MAX_WAIT_MS` (default 25 s) for its slot fails immediately with `Rate limited: … Retry after N s.` This keeps calls below typical MCP client timeouts (about 60 s). Background sync requests wait as long as needed.
- On HTTP 409 (another program used the token), the token is treated as busy for a full interval. Calls already queued are pushed back too, and any whose budget that exceeds fail fast. The call that got the 409 is retried once **if the extra wait still fits in `FIO_MAX_WAIT_MS`**. With the defaults (30 s interval, 25 s budget) the retry does not fit, so the call fails fast with a retry-after hint. Raise `FIO_MAX_WAIT_MS` above 30000 if your client tolerates longer calls and you want the automatic retry. A second 409 always fails.
- `get_server_status` shows each account's next free slot and queue lengths.

## Local transaction cache

FIO allows one request per token every 30 seconds, so fio-mcp keeps a local SQLite copy of your movements and answers `search_transactions`, `summarize_transactions`, `get_cache_status` and most `get_transactions` calls from it.

- **Only date ranges.** The cache downloads with `/periods` and never uses `/last`, so it never moves the download marker that `get_new_transactions` and other programs rely on.
- **Bound to the account, not the name.** Cached data belongs to the bank account (account number and bank code) that FIO reported for the token that downloaded it. If you point an account name at a different token or account, the old data is not shown for it; the cache answers "not verified for this token yet" until a sync confirms the account.
- **Upserts.** Movements are stored by FIO's movement ID; downloading a day again updates late-booked or changed movements. Only a refresh deletes: it removes movements that FIO no longer lists for the days it re-downloaded.
- **Whole responses only.** A response with a movement that lacks its ID or date is not stored at all, and its days stay uncached, so the cache never claims a day it holds only part of. A sync stops with that error in `lastError`; `get_transactions` answers from FIO.
- **Background priority.** Sync requests yield to tool calls in the rate limiter, up to a starvation bound (see [Rate limiting](#rate-limiting)), and never fail for lack of a slot: they wait.

### Sync

- **Startup** (`FIO_SYNC_ON_STARTUP=true`, the default): a background job per token, which never delays MCP initialisation. It first runs the backfill for any day from `FIO_BACKFILL_FROM` to today that is not cached yet, including history that was refused earlier, and then the incremental sync.
- **Incremental:** downloads from `FIO_SYNC_OVERLAP_DAYS` before the newest cached day up to today. With nothing cached it runs the backfill instead.
- **Periodic:** `FIO_SYNC_INTERVAL_MINUTES` repeats the incremental sync. Each run is one request per token (30 s of that token's budget). With an interval of 15 minutes that is 96 requests a day, and a tool call arriving while a sync request is running waits up to 30 s for its slot. In stdio mode the process usually lives only as long as the client session, so the startup sync is enough; in HTTP mode an interval of 30–60 minutes is a reasonable choice.
- **On demand:** `sync_transactions`.
- **Refresh:** `sync_transactions` with `refresh: {"from": "2025-01-01", "to": "2025-03-31"}` re-downloads those days even where they are cached (backfill skips cached days), at background priority and with the same 413 splitting as the backfill. Changed movements are updated, and movements FIO no longer lists for a downloaded day are deleted, because a date-range download is FIO's complete list for those days. Days after today are ignored. Days older than 90 days need a history unlock first; without one FIO refuses them and they are listed as `blocked`. A later backfill downloads them again but deletes nothing, so after the unlock run the same refresh again. A movement FIO moved to another day appears there only once that day is downloaded too, so refresh both dates. An interrupted refresh finishes before the next sync job does anything else, including the startup sync. Days another kind of job left pending are only updated, never pruned, unless they are in a requested refresh range. A refresh interrupted before upgrading to this version resumes as an update-only sync; rerun `sync_transactions` with `refresh` to prune removed movements.

### Backfill and history older than 90 days

The first sync asks FIO for everything from `FIO_BACKFILL_FROM` (default 2000-01-01) to today in one request. If that would be more than 50,000 movements (HTTP 413) the range is split in halves, newest first, until each part fits; at 30 s per request a long history takes a few minutes. Progress is saved after every request, so a restart continues where it stopped (`get_cache_status` shows the job).

FIO serves movements older than 90 days only for 10 minutes after the account owner authorizes it (HTTP 422 otherwise). When that happens the cache downloads the last 90 days instead, remembers which older ranges were refused, and reports `historyLimited` in `get_cache_status` and in every `freshness`. To fill in the older history:

1. Sign in to FIO Internetbanking, open **Nastavení → API**, select this token, and authorize access to the full history (SMS or push).
2. Within 10 minutes, either call `sync_transactions` with `mode=backfill`, or restart the server (with `FIO_SYNC_ON_STARTUP=true` the startup sync retries the refused history first, newest first).

Each request takes 30 s, so about 20 chunks fit in one unlock; a large history may need a second unlock. A range refused again simply stays refused until the next attempt.

### When `get_transactions` uses the cache

With `source=auto` (the default) the answer comes from the cache only when every day of the requested range is cached and each day is either *settled* (downloaded at least `FIO_SYNC_OVERLAP_DAYS` after it, so late bookings are in) or *fresh* (downloaded within `FIO_CACHE_MAX_AGE_MINUTES`). Otherwise the server asks FIO and stores the result. A cached answer has no opening/closing balance for the range (FIO only reports those for an actual download); it reports the last known balance and its date instead.

Movements older than the overlap window are assumed final. If FIO changes or cancels an old movement, refresh that period (`sync_transactions` with `refresh: {"from": "<first day>", "to": "<last day>"}`); a backfill skips days that are already cached.

### Backup

The cache is not fully reproducible: history older than 90 days needs a fresh Internetbanking authorization to download again. Back it up with:

```sh
fio-mcp backup /path/to/fio-backup.sqlite          # or: node dist/main.js backup …
docker exec <container> node dist/main.js backup /data/fio-backup-$(date +%F).sqlite
```

This uses SQLite `VACUUM INTO`, which writes a consistent copy while the server is running. The destination must not exist and is created readable only by its owner. Do not copy `fio.sqlite` directly while the server runs: in WAL mode the recent changes live in `fio.sqlite-wal`, and a plain copy can be inconsistent. If you prefer the `sqlite3` shell, `sqlite3 /data/fio.sqlite ".backup /data/fio-backup.sqlite"` is also safe. To restore, stop the server and replace `fio.sqlite` (and remove any `fio.sqlite-wal` / `fio.sqlite-shm`) with the backup.

## Errors

Every expected failure is a typed error in the Effect error channel, never a thrown exception. The tool result is an MCP error (`isError: true`) whose text is the error's message:

| Error | When |
|---|---|
| `RateLimited` | No rate-limit slot within `FIO_MAX_WAIT_MS`, or HTTP 409 twice. Says when to retry. |
| `PermissionDenied` | See [Permissions](#permissions). Starts with "You don't have permissions to do that." |
| `TokenRejected` | HTTP 500 on a read: token missing, expired, revoked, or not yet active. |
| `FioBadRequest` | HTTP 404: FIO rejected the request parameters. |
| `TooManyItems` | HTTP 413: more than 50,000 movements. Narrow the range. |
| `HistoryAuthorizationRequired` | HTTP 422: data older than 90 days without the history unlock. |
| `FioServerError` | Any other HTTP status. |
| `FioTransportError` | Network failure or timeout; records whether the request was sent. |
| `FioResponseError` | A 2xx response that is not what the API documents (bad JSON, wrong shape, too large). |
| `XmlParseError` | The payment import response is not valid XML. |
| `UploadOutcomeUnknown` | A payment upload failed after it may have reached FIO; tells you to check Internetbanking. |
| `InvalidInput` | Arguments that pass the schema but don't make sense together, or a missing payer account number. |
| `CacheError` | The local SQLite cache failed; details go to the server log. |
| `ConfigError` | Startup only: invalid configuration, naming the variable but never its value. |

OAuth endpoints use the same approach: each failure is a tagged error mapped to its RFC error code (`invalid_request`, `invalid_client`, `invalid_grant`, `invalid_target`, `invalid_scope`, `unsupported_grant_type`, `access_denied`, `invalid_token`, …) and HTTP status.

HTTP 409 is a `TokenBusy` error inside the server that the rate limiter always turns into a retry or `RateLimited`.

## Security

- Tokens are `Redacted` values from configuration to the moment a request is built, so they never show up in logs, errors, or tool results by accident.
- As a second line of defence, every tool result is redacted, and so is everything the server writes to the MCP channel (stdio frames and HTTP response bodies) and to the log. Response excerpts in error messages are redacted before they are truncated, so a cut can't leave part of a token behind. Tokens are limited to URL-safe characters, so redaction can never cut through JSON or SSE framing.
- Logs go to stderr only. In stdio mode stdout carries nothing but MCP messages.
- Configuration errors name the bad variable, field, or path but never echo its value.

## HTTP transport and OAuth

With `FIO_MCP_TRANSPORT=http` the server speaks MCP Streamable HTTP at `/mcp` (POST; GET and DELETE for sessions) on plain HTTP; terminate TLS at a reverse proxy. All sessions share one process: one rate limiter per FIO token and one database. `GET /healthz` answers `{"status":"ok"}` without authentication or the Host check and never calls FIO.

HTTP mode is protected by OAuth, with fio-mcp as its own authorization server (MCP authorization specification, revision 2026-07-28). It makes no outbound requests and uses no external identity provider. MCP clients discover it from the 401 on `/mcp`, register themselves, and send you to a sign-in page. stdio needs no authentication.

### Setup

1. Create the admin password hash. On a terminal it asks twice and does not echo; a piped password is read once. Minimum 12 characters. Only the hash goes to standard output; prompts and errors go to standard error. With Docker, pipe the password in with `-i` and leave out `-t`: a TTY merges both streams, so the prompts would land in the file and fio-mcp would reject it. In Bash:

   ```bash
   IFS= read -rs -p 'Admin password: ' pw && echo
   printf '%s\n' "$pw" | docker run --rm -i <image> hash-password > admin.hash; unset pw
   # or, outside Docker: fio-mcp hash-password > admin.hash
   ```

2. Set `FIO_MCP_PUBLIC_URL` and `FIO_MCP_ADMIN_PASSWORD_HASH_FILE` (see [HTTP transport](#http-transport)). Without both, HTTP mode refuses to start.

### Connecting a client

Add `https://<host>/mcp` (for example `https://fio.home.arpa/mcp`) as a remote MCP server in your client. The client opens the sign-in page; enter the admin password, then choose on the consent page, which shows the client's name and redirect URI:

- **Scopes.** `fio:read` covers every reading tool, the cache tools, sync, and the download marker. `fio:payments` additionally allows `preview_payment_orders` and `submit_payment_orders`.
- **Accounts** the client may use.

A grant covers the accounts behind the chosen FIO tokens, not their names. Renaming an account keeps its grants; giving an old name to another token does not pass the grant on. Replacing an account's token (FIO tokens expire within 180 days) removes that account from existing grants: its calls are refused until you reconnect the client and select it again. Accounts configured with the same token are the same FIO account, so a grant for one covers them all. Grants made before this rule (by name) were revoked on upgrade; reconnect those clients.

HTTP sessions list only what the grant allows; stdio lists everything. Without `fio:payments` the payment tools are not listed, the `account` enum names only the granted accounts, and when a grant covers no configured account (for example after its token was replaced) the tools that take an account are not listed either. `get_server_status` and `get_cache_status` show only granted accounts. The list is for discovery: every call is still checked, and a call outside the grant, including one to a tool that is not listed, answers "You don't have permissions to do that." To widen a grant, remove and re-add the server in the client.

### How it works

| Path | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | Protected Resource Metadata (RFC 9728) |
| `/.well-known/oauth-authorization-server` | Authorization Server Metadata (RFC 8414) |
| `/register` | Dynamic Client Registration (RFC 7591), public clients only |
| `/authorize` | Authorization code with PKCE (S256 required) and resource indicator (RFC 8707) |
| `/login`, `/consent` | Sign-in and consent pages |
| `/token` | Code exchange and refresh |
| `/revoke` | Token revocation (RFC 7009) |
| `/mcp` | MCP; `Authorization: Bearer <access token>`. Without a valid token: 401 with `WWW-Authenticate: Bearer resource_metadata="<public url>/.well-known/oauth-protected-resource/mcp", scope="fio:read"`, with no `error` when `Authorization` is missing or empty, `, error="invalid_request"` when it is not a Bearer token, and `, error="invalid_token"` for a token that is unknown, expired, revoked or issued for another resource |

- **Clients** register without a secret. Redirect URIs must be https, or http on a loopback address (`127.0.0.1`, `[::1]`, `localhost`) on any port; they must match exactly except for the loopback port. Client ID metadata documents are not supported, because the server never fetches URLs. At most 100 clients and 20 registrations per hour; a client that never completes a sign-in is removed after an hour, and one without a live grant 24 hours after its last use.
- **Tokens** are random and stored only as SHA-256 hashes. Authorization codes are single-use and live 60 s; access tokens 1 hour; refresh tokens 30 days, rotated on every use. Reusing an old refresh token or an authorization code revokes the whole grant. Tokens are bound to the audience `<public url>/mcp`, and every token request, refresh included, must name it as `resource`.
- **MCP sessions** are bound to the grant that opened them; another grant presenting the session id gets 404. Each grant may hold 32 sessions and the server 1,000. When full, a session unused for an hour is ended (its id then answers 404) to make room; otherwise new sessions are refused (429 for the grant, 503 for the server).
- **Limits on /mcp:** request bodies up to 1 MiB (413 beyond; a 100-order payment import is about 100 KB), initialize requests up to 64 KiB, and 16 requests in progress per grant (429).
- **Sign-in** compares the password against the scrypt hash in constant time, one check at a time across all clients; a sign-in that arrives during a check gets 429 instead of waiting, so a flood cannot stack scrypt's memory. Each check needs about 128 MiB of scrypt workspace with the `hash-password` defaults (N=2^17, r=8, p=1; hashes needing more than 256 MiB are refused), and the container peaked at about 256 MiB during one. The trade-off: sign-ins from many addresses can keep the check busy and delay yours. After 5 failures from a client address, attempts wait 1, 2, 4 and 8 s; the 10th consecutive failure locks the address out for 15 minutes. An address may start 20 sign-ins per 10 minutes (429). Up to 100 sign-ins in progress and 20 signed-in sessions are kept; starting sign-ins never ends a signed-in one, and a flood through one client displaces that client's own sign-ins first. Behind a reverse proxy, set `FIO_MCP_TRUSTED_PROXIES`, or every browser shares the proxy's address: one person's failed logins lock everyone out, and 20 sign-ins block new ones for everyone for 10 minutes. Logs record counts only.
- **Pages** use a short-lived, server-side, signed cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, 10 minutes), a CSRF token on every form, an Origin check, and strict headers (CSP with `frame-ancestors 'none'`, `no-store`).

### Administration

```sh
docker exec <container> node dist/main.js clients list
docker exec <container> node dist/main.js clients revoke <client_id>
docker exec <container> node dist/main.js tokens revoke-all
```

### Reverse proxy

Forward the whole host, or at least `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/login`, `/consent`, `/token`, `/revoke`, and optionally `/healthz`. TLS must terminate at the proxy, because the sign-in cookie is `Secure`. If `FIO_MCP_ALLOWED_HOSTS` is set, it must include the public host.

Set `FIO_MCP_TRUSTED_PROXIES` to the proxy's address as fio-mcp sees it:

- **Traefik connects through a published port** (Docker NAT): on the TrueNAS setup above, connections arrive from the gateway of fio-mcp's Docker network, not from Traefik's container (`docker network inspect <network> --format '{{(index .IPAM.Config 0).Gateway}}'`). `172.16.0.0/12` covers the 172.17.0.0/16 to 172.31.0.0/16 networks that Docker hands out first from its default address pools, so it keeps working when the network is recreated with another subnet (later networks come from its 192.168 pool). Whether the source address is rewritten depends on Docker's proxy and masquerading settings, so check the gateway and your setup. Trade-off: any container on those networks can choose its own throttling key.
- **Traefik shares a Docker network with fio-mcp** and connects to the container directly: use Traefik's container address on that network (`docker inspect <traefik> --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'`). Give it a static address, or trust the network's subnet (`docker network inspect <network> --format '{{(index .IPAM.Config 0).Subnet}}'`); then any container on that network can choose its own throttling key, so prefer a network shared only by Traefik and fio-mcp.

Traefik appends the client's address to `X-Forwarded-For`; addresses a client adds itself sit further left and are ignored.

## Container and NAS deployment

The [Dockerfile](Dockerfile) builds from a clean clone with only `docker build .` (multi-stage, Node 24 LTS pinned by digest, linux/amd64). The runtime image has production dependencies and `dist/` only, serves HTTP on port 3000, and keeps its database in `/data`:

- Defaults: `FIO_MCP_TRANSPORT=http`, `FIO_DB_PATH=/data/fio.sqlite`.
- Runs as any non-root UID with a read-only root filesystem, no capabilities and `no-new-privileges`. Nothing is written outside `/data`, including SQLite's temporary data (`temp_store=MEMORY`) and its WAL files.
- `HEALTHCHECK` fetches `/healthz` on localhost with Node (no curl needed).
- `ENTRYPOINT ["node", "/app/dist/main.js"]`, so `docker exec <container> node dist/main.js <command>` runs the CLI.

Pass secrets as files. TrueNAS mounts them under `/run/secrets` (root:10000, mode 0440), so add the container user to group 10000. Example Compose service (TrueNAS Custom App), with Traefik connecting through the published port:

```yaml
services:
  fio-mcp:
    image: fio-mcp:<version>-<sha>                     # the tag= line printed by npm run ship:image
    pull_policy: never                                 # loaded over ssh, never pulled from a registry
    user: "568:568"
    group_add: ["10000"]
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 512m                                    # a sign-in or hash-password peaks at about 256 MiB
    ports:
      - "3000:3000"                                    # Traefik connects through this published port
    environment:
      FIO_TOKEN_FILE: /run/secrets/fio_token          # or FIO_ACCOUNTS_FILE
      FIO_MCP_PUBLIC_URL: https://fio.home.arpa
      FIO_MCP_ADMIN_PASSWORD_HASH_FILE: /run/secrets/fio_mcp_admin_hash
      FIO_MCP_ALLOWED_HOSTS: fio.home.arpa
      FIO_MCP_TRUSTED_PROXIES: 172.16.0.0/12             # Docker bridge gateways (Traefik via the published port)
      FIO_SYNC_INTERVAL_MINUTES: "60"
    volumes:
      - /mnt/<pool>/fio-mcp:/data                       # writable by the container user
      - /path/to/secrets:/run/secrets:ro
```

The container has no Traefik labels: Traefik's Docker provider would route to the container's own address, not to the published port. Route through Traefik's file provider instead:

```yaml
http:
  routers:
    fio-mcp:
      rule: Host(`fio.home.arpa`)
      tls: {}
      service: fio-mcp
  services:
    fio-mcp:
      loadBalancer:
        servers:
          - url: http://<nas-address>:3000   # the published port
```

To connect over a shared Docker network instead, drop `ports`, put Traefik's Docker-provider labels (`traefik.enable`, the router rule and `traefik.http.services.fio-mcp.loadbalancer.server.port: "3000"`) on the service, and set `FIO_MCP_TRUSTED_PROXIES` to Traefik's address on that network (see [Reverse proxy](#reverse-proxy)).

To fill in history older than 90 days after an Internetbanking unlock, restart the container within the 10-minute window; the startup sync retries the refused history first. See [Backfill](#backfill-and-history-older-than-90-days).

### Shipping the image to your server

Images never go through a registry. [scripts/ship-image.sh](scripts/ship-image.sh) builds the image on your machine and streams it to the docker host over ssh (`docker save | gzip | ssh <host> "sudo -n docker load"`). Docker load reads gzip-compressed tar input directly. There is no CI.

Prerequisites:

- A key-based ssh host alias for the server in `~/.ssh/config`. ssh runs with `BatchMode=yes`, so it never prompts: the key must load from the config or your ssh agent, and the host key must already be in `known_hosts`.

  ```
  Host nas
    HostName <server-address>
    User <user>
    IdentityFile ~/.ssh/<key>
  ```

- On the server, that user can run docker without a password prompt, e.g. through passwordless sudo (`sudo -n docker version` works over `ssh nas`).
- `gzip` locally, or pass `--no-compress`.

From a clean checkout (no uncommitted or untracked files):

```sh
npm run ship:image
```

It builds linux/amd64, tags `fio-mcp:<package version>-<short git sha>` and `fio-mcp:<package version>` (no registry prefix), checks that ssh and the remote docker work, ships the image, and checks that the server reports the same image ID as the local build. It refuses to run on a dirty tree. Progress goes to stderr; stdout gets two lines (run `npm run --silent ship:image` to keep npm's own banner out of stdout):

```
tag=fio-mcp:0.2.0-1a2b3c4
image_id=sha256:<64 hex digits>
```

Put the `tag=` value in the Compose `image:` (with `pull_policy: never`, so the server never looks for it in a registry), and compare `image_id=` with `docker image inspect --format '{{.Id}}' <tag>` on the server to verify what a deployment runs.

The ID check assumes both docker daemons use the same image store: the classic store reports the image's config digest, the containerd image store its manifest digest, so the IDs differ between the two even for the same image.

Settings:

| Variable / flag | Default | Effect |
| --- | --- | --- |
| `FIO_MCP_SSH_HOST` | `nas` | ssh destination, usually the host alias above |
| `FIO_MCP_REMOTE_DOCKER` | `sudo -n docker` | docker command on the server |
| `DOCKER` | `docker` | local docker command, e.g. `DOCKER="sudo -n docker"` where docker needs sudo |
| `--no-compress` | off | stream the image uncompressed (no local gzip needed) |
| `--dry-run` or `DRY_RUN=1` | off | build and tag locally and print the two lines, without contacting the server |

It builds with `docker buildx` when that is installed and falls back to `docker build --platform linux/amd64` otherwise. To try the build without touching the server:

```sh
DOCKER="sudo -n docker" npm run ship:image -- --dry-run
```

`npm run test:scripts` tests the script against stand-in `docker` and `ssh` commands.

## Development

The server is written with [Effect](https://effect.website) 4. Services are `Context.Service` classes with static layers, expected failures are `Schema.TaggedError` classes, tool parameters are Effect Schemas, and the MCP server is Effect's own (`effect/ai` `McpServer`), so there is no zod and the MCP SDK is only a test dependency.

```sh
npm run typecheck    # tsc with Effect diagnostics
npm run lint         # Biome, including the Effect rules in lint/*.grit
npm test             # vitest + @effect/vitest
npm run check        # all three
```

### Effect diagnostics in tsc

`npm install` runs `prepare`, which calls `effect-tsgo patch --typescript --no-oxlint` (from `@effect/tsgo`, as in deskohub). It patches the TypeScript 7 compiler so `tsc` also reports the Effect language-service diagnostics configured in `tsconfig.json`'s `@effect/language-service` plugin block. Floating Effects, unhandled errors or requirements, `any`/`unknown` in error channels, global `fetch`, `try/catch` inside generators and similar are errors, and warnings fail the build too. If `npm run typecheck` stops reporting `effect(...)` diagnostics, run `npx effect-tsgo patch --typescript --no-oxlint` again. Editors need the same patched TypeScript or the Effect language-service extension.

### Lint rules

Biome runs its recommended rules (with `noExplicitAny` and `noConsole` as errors) plus Grit plugins in `lint/`:

| Rule | Forbids in `src/` |
|---|---|
| `no-throw-in-effect-modules` | `throw`: model failures as tagged errors |
| `no-promise-in-effect-modules` | `new Promise` and `await`: use Effect values |
| `no-direct-effect-runs` | `Effect.run*` outside `src/main.ts` |
| `no-direct-process-env` | `process.env`: read configuration through Effect `Config` |
| `prefer-effect-fn` | arrow functions that only wrap `Effect.gen`: use `Effect.fn` |

### OpenAPI spec and the generated client

FIO's REST API is described in [openapi/fio-api.yaml](openapi/fio-api.yaml) (OpenAPI 3.1, written from FIO's PDF v1.9; see docs/fio-api.md). `src/generated/effect.gen.ts` is generated from it with `@effect/openapi-generator` and committed, as in deskohub; never edit it by hand.

1. Edit `openapi/fio-api.yaml`.
2. Run `npm run generate` (`scripts/generate-fio-client.ts`, run by Node's TypeScript type stripping).
3. Commit the spec and the regenerated file together. `npm run generate:check` regenerates and fails on any difference.

The generator only decodes JSON success bodies. Operations that FioApi reads as raw text (CSV, XML, OFX, raw JSON, the import response) carry `x-raw-body: true`; the script turns their success bodies into binary in a temporary copy of the spec before generating, and refuses unmarked non-JSON success bodies. `src/fio-api.ts` wraps the generated `make()` in the `FioApi` service: base URL, the token (unwrapped from `Redacted` only to build the request), the rate limiter, the request timeout including the body, a 64 MiB response limit, no redirects, no tracing of FIO URLs, and the mapping of every HTTP status and client failure to the tagged errors above.

### Layout

```
src/
  main.ts               entry point (bin): serve, `backup <dest>`
  app.ts                layer composition: services, tools, background sync, transports
  config.ts             AppConfig from the environment and *_FILE secrets
  errors.ts             tagged errors and HTTP status mapping
  redaction.ts          Redactor service and the redacting stderr logger
  rate-limiter.ts       per-token dispatcher with interactive and background queues
  accounts.ts           configured accounts, token fingerprints, learned payer details
  fio-api.ts            FioApi service: interface and adapter on the generated client
  generated/            generated OpenAPI client (do not edit)
  statement.ts          JSON statement normalisation
  payments.ts           payment order Schemas and the import XML builder
  fio-countries.ts      country codes from the XSD's country_type enumeration
  import-response.ts    import response parser
  cache/                SQLite database, migrations, store, sync engine, Transactions service
  mcp/                  tool definitions and handlers (FIO tools, cache tools)
  transport/            stdio and HTTP transports, auth seam, frame redaction, grant-filtered tools/list
openapi/fio-api.yaml    FIO REST API spec
scripts/                client generator, image ship script
lint/                   Biome Grit rules
test/                   vitest + @effect/vitest suites
```

Tests mock HTTP and make no network calls.

## Known limitations

- The response body of `lastStatement` and the read-only upload response are undocumented. The parsing and classification above are best effort.
- Only the Fio XML import format is used. ABO and SEPA `pain.001`/`pain.008` uploads are not exposed.
- Every OAuth client sees all configured account names in the tool schemas, whatever accounts its grant covers. Names are not secrets; calls for other accounts are refused.
- A call without the needed scope answers the tool error "You don't have permissions to do that." instead of HTTP 403 `insufficient_scope` (MCP authorization's step-up flow). To widen a grant, remove and re-add the server in the client.
- MCP authorization 2026-07-28 prefers Client ID Metadata Documents; fio-mcp supports only Dynamic Client Registration because it never fetches URLs.
- Effect's MCP server always sends all four tool annotation hints, so tools that previously omitted `destructiveHint`/`idempotentHint` now state them explicitly (with the same meaning).
