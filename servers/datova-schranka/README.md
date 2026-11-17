# datova-schranka

MCP server for Czech data boxes (datová schránka, ISDS). It serves MCP Streamable HTTP at `/mcp` and is its own OAuth authorization server, like fio-mcp. There is no stdio transport and no unauthenticated mode: `DATOVA_SCHRANKA_TRANSPORT`, `DATOVA_SCHRANKA_ALLOW_UNAUTHENTICATED` and `DATOVA_SCHRANKA_ALLOW_UNAUTHENTICATED_ON_NETWORK` are refused at startup if set.

You add any number of data boxes at `/admin`, each with a system certificate (PKCS#12 and passphrase) or a username and password. The server encrypts the credentials with the data key and stores them in its SQLite database. An MCP client gets access to the boxes you pick on the consent page. Every tool call is written to the audit log, which `/admin` shows.

The official v3.11 WSDL/XSD the ISDS client follows are in `wsdl/`.

## Scopes and delivery consent

- `isds:read`: list received messages, read envelopes and state changes, download messages and their attachments, list sent messages, read delivery info.
- `isds:send`: send messages from a box.

**Listing received messages delivers them.** The list call logs in to the box, and ISDS treats every eligible received message as delivered by login (event EV13). Delivery starts the legal deadlines that run from it. Filters and limits on the call do not narrow this: one list delivers every eligible message in the box, including ones the response leaves out. Downloads and envelope reads do not deliver, but ISDS refuses them for a message that was not delivered yet.

So a grant that includes `isds:read` needs a ticked checkbox on the consent page that states this. Without it the authorization fails. The audit log records the grant, the boxes, the time and the version of the consent wording. If you want to keep messages undelivered until you open them yourself, do not use this server with that box.

## Configuration

All variables start with `DATOVA_SCHRANKA_`. Secrets are read from files; the variables name the paths. An unset or blank optional variable means the default. A config error names the variable, never its value.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATOVA_SCHRANKA_PUBLIC_URL` | required | The https origin clients use. OAuth issuer; the MCP resource is this plus `/mcp`. |
| `DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE` | required | File with the admin password hash from `hash-password`. |
| `DATOVA_SCHRANKA_DATA_KEY_FILE` | required | File with the 32-byte key that encrypts the box credentials: 64 hex digits or base64. |
| `DATOVA_SCHRANKA_ADMIN_TOTP_SECRET_FILE` | unset | File with a base32 TOTP secret from `totp-init`. When set, admin sign-in also asks for a code. |
| `DATOVA_SCHRANKA_HOST` | `0.0.0.0` | HTTP bind address. |
| `DATOVA_SCHRANKA_PORT` | `3000` | HTTP port. |
| `DATOVA_SCHRANKA_ALLOWED_HOSTS` | empty | Accepted Host header values. Empty accepts any. |
| `DATOVA_SCHRANKA_ALLOWED_ORIGINS` | empty | Exact Origin header values accepted on `/mcp`. |
| `DATOVA_SCHRANKA_TRUSTED_PROXIES` | empty | IPs or CIDR networks of reverse proxies whose `X-Forwarded-For` is believed. Empty trusts none. |
| `DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS` | unset | Client networks allowed to reach `/admin` and the sign-in pages. Unset allows all; if set, it must name at least one network. |
| `DATOVA_SCHRANKA_ADMIN_PORT` | unset | Port of a second listener that alone serves `/admin`. Unset: no second listener. Must differ from the main port. |
| `DATOVA_SCHRANKA_ADMIN_HOST` | `127.0.0.1` | Bind address of the admin listener. Only valid with `ADMIN_PORT`. |
| `DATOVA_SCHRANKA_DB_PATH` | `$XDG_DATA_HOME/datova-schranka/datova-schranka.sqlite`, else `$HOME/.local/share/datova-schranka/datova-schranka.sqlite` | SQLite database. The image sets `/data/datova-schranka.sqlite`. |
| `DATOVA_SCHRANKA_DATA_DIR` | `zfo/` next to the database | Directory for the signed ZFO files of downloaded messages. The image sets `/data/zfo`. |
| `DATOVA_SCHRANKA_ISDS_ENVIRONMENT` | `production` | `production` or `test` (the public test service at `datovka-test.gov.cz`). |
| `DATOVA_SCHRANKA_ISDS_REQUEST_TIMEOUT_MS` | `60000` | Timeout of one ISDS request, at least 1000. |
| `DATOVA_SCHRANKA_ATTACHMENT_INLINE_MAX_BYTES` | `10485760` (10 MiB) | Largest attachment returned inline to the client. Larger ones are skipped with a note. |
| `DATOVA_SCHRANKA_RESPONSE_INLINE_MAX_BYTES` | `26214400` (25 MiB) | Most attachment bytes returned inline by one download, all attachments together. |
| `DATOVA_SCHRANKA_APPROVAL_NONCE_TTL_MINUTES` | `15` | How long a send approval nonce stays valid. |
| `DATOVA_SCHRANKA_PENDING_TTL_HOURS` | `168` | How long a filing waits for approval before it expires. |

`GET /healthz` answers without authentication and never calls ISDS. The OAuth endpoints are the same as fio-mcp's: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/login`, `/consent`, `/token` and `/revoke`.

## Environment and data key binding

The first start writes the ISDS environment and a check value sealed with the data key into the database. Later starts refuse to run when:

- `DATOVA_SCHRANKA_ISDS_ENVIRONMENT` differs from the one the database was created with. A database and its ZFO directory belong to one environment. To switch, start with a new volume.
- the data key cannot open the check value ("data key does not match this database"). Nothing can recover the box credentials without the original key. Keep a copy of the key apart from the database backups. If the key is lost, start with a new database and add the boxes again.

## Storage

Everything lives in the database and the ZFO directory, both in `/data` in the image.

- Sealed with the data key: box credentials (PKCS#12, passphrases, passwords), send approval nonces and the payloads of pending filings.
- Plaintext at rest: the signed ZFO files of downloaded messages, and filing previews (envelope, attachment names, sizes and hashes). Whoever can read the volume can read these. Encrypt the volume if that matters.
- The server never deletes ZFO files. Remove old ones from `DATOVA_SCHRANKA_DATA_DIR` by hand.
- `audit purge --before YYYY-MM-DD` deletes audit rows of days (UTC) before the date and keeps at least the last 365 days. It deletes audit rows only, no messages or ZFO files.
- `backup <dest>` copies the database while the server runs. It does not copy the ZFO files; copy `DATOVA_SCHRANKA_DATA_DIR` yourself.

## Setup

1. Create the admin password hash. On a terminal `hash-password` asks twice without echo; a piped password is read once. Minimum 12 characters. Only the hash goes to standard output. With Docker, pipe the password with `-i` and without `-t`, or the prompts end up in the file:

   ```bash
   mkdir -p secrets data
   IFS= read -rs -p 'Admin password: ' pw && echo
   printf '%s\n' "$pw" | docker run --rm -i datova-schranka hash-password > secrets/admin_hash; unset pw
   ```

2. Create the data key:

   ```bash
   openssl rand -hex 32 > secrets/data_key
   chmod 0400 secrets/admin_hash secrets/data_key
   ```

3. Optional: `docker run --rm datova-schranka totp-init > secrets/totp_secret` prints a TOTP secret and its `otpauth://` URI and stores nothing. Load the URI into an authenticator app, keep only the secret line in the file, and set `DATOVA_SCHRANKA_ADMIN_TOTP_SECRET_FILE`.
4. Start the server (see [Container](#container)) and add the boxes at `https://<host>/admin`. Adding a box calls ISDS once to show the box ID and owner. A box added under the other ISDS environment is not loaded.

## Container

Build at the repository root:

```bash
docker build --platform linux/amd64 -f servers/datova-schranka/Dockerfile -t datova-schranka .
```

The image has Node, the production dependencies and the compiled `dist/` of datova-schranka and `@mcps/core`. It has no Bun, no fio-mcp code and none of fio-mcp's dependencies. It serves on port 3000, keeps its data in the `/data` volume and runs as any UID. Nothing is written outside `/data`, so the root filesystem can be read-only. `HEALTHCHECK` fetches `/healthz` with Node.

```bash
docker run -d --name datova-schranka \
  --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1:3000:3000 \
  -e DATOVA_SCHRANKA_PUBLIC_URL=https://datova-schranka.example.org \
  -e DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE=/run/secrets/admin_hash \
  -e DATOVA_SCHRANKA_DATA_KEY_FILE=/run/secrets/data_key \
  -v "$PWD/data:/data" \
  -v "$PWD/secrets:/run/secrets:ro" \
  datova-schranka
```

`--user` makes the container run as the owner of `data/` and `secrets/`; without it the user is `node` (UID 1000), and both directories must be readable by it, `data/` also writable. The CLI runs in the container: `docker exec datova-schranka node dist/main.js clients list`.

## Keeping /admin off the public internet

`/admin` and the sign-in pages decide who can add boxes and approve access to them. Keep them off the public internet:

- `DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS=10.0.0.0/8,192.168.0.0/16` limits `/admin` and the sign-in pages to those client networks. Behind a reverse proxy, set `DATOVA_SCHRANKA_TRUSTED_PROXIES` too, or every request has the proxy's address.
- Or set `DATOVA_SCHRANKA_ADMIN_PORT`: a second listener then alone serves `/admin`, on `DATOVA_SCHRANKA_ADMIN_HOST` (`127.0.0.1` by default). Inside a container, loopback is reachable only from the container itself. To reach it from the host, set `DATOVA_SCHRANKA_ADMIN_HOST=0.0.0.0` and publish the port on the host's loopback, for example `-p 127.0.0.1:3001:3001` with `DATOVA_SCHRANKA_ADMIN_PORT=3001`, and use an SSH tunnel from elsewhere.

## Production

1. Pick `DATOVA_SCHRANKA_ISDS_ENVIRONMENT` before the first start; the database is bound to it.
2. Generate the password hash and the data key as in [Setup](#setup). Store a copy of the data key apart from the backups. Set up TOTP.
3. Terminate TLS at a reverse proxy. Set `DATOVA_SCHRANKA_PUBLIC_URL` to the https origin, `DATOVA_SCHRANKA_ALLOWED_HOSTS` to the host names clients use, and `DATOVA_SCHRANKA_TRUSTED_PROXIES` to the proxy's address.
4. Restrict `/admin` with `DATOVA_SCHRANKA_ADMIN_ALLOWED_CIDRS` or a separate `DATOVA_SCHRANKA_ADMIN_PORT`.
5. Run read-only, as a non-root UID, with no capabilities, and mount `/data` on a volume that only that UID can read. Encrypt it if the ZFO files must not be readable at rest.
6. Add the boxes at `/admin` and check the box ID and owner it shows.
7. Back up with `backup <dest>` plus a copy of the ZFO directory. Purge old audit rows with `audit purge` and old ZFO files by hand when you want them gone.

## CLI

```text
datova-schranka [serve]              serve MCP over HTTP with OAuth
datova-schranka backup <dest>        copy the database to <dest> (not the ZFO files)
datova-schranka hash-password        read the admin password (no echo), print its hash
datova-schranka totp-init            print a new admin TOTP secret and its otpauth:// URI (stores nothing)
datova-schranka clients list         list registered OAuth clients
datova-schranka clients revoke <id>  remove a client and revoke its tokens
datova-schranka tokens revoke-all    revoke every OAuth grant
datova-schranka reset-admin-password [--set]
                                     drop the password set at /admin (the hash file applies again),
                                     or with --set store a new one read like hash-password
datova-schranka audit purge --before YYYY-MM-DD
                                     delete audit rows of days (UTC) before the date (kept 365 days at least)
```

Outside Docker, after `bun install` and `bun run --cwd servers/datova-schranka build`, run `bun run --cwd servers/datova-schranka start` or `node servers/datova-schranka/dist/main.js <command>`.

## ISDS client (`src/isds/`)

- `IsdsTransport.layer(config)`: Node `https` transport. Credentials are either `IsdsCredentials.SystemCertificate({ pkcs12, passphrase })`, for the direct system-certificate route `https://ws1c.datovka[-test].gov.cz/cert/DS/…` with a TLS client certificate, or `IsdsCredentials.Password({ username, password })`, for HTTP Basic on `https://ws1.datovka[-test].gov.cz/DS/…`. The server certificate is always verified, and TLS 1.2+ is required. One client serves one data box.
- `IsdsClient.Default` (requires `IsdsTransport`): `ping`, `getOwnerInfo`, `listSentMessages`, `listReceivedMessagesAndDeliver`, `getMessageStateChanges`, `downloadMessageEnvelope`, `downloadMessage`, `downloadSignedMessage` (raw ZFO bytes), `getDeliveryInfo`, `createMessage`, `findDataBoxes`, `checkDataBox`, `reconcileSentMessage`.
- **`listReceivedMessagesAndDeliver` legally delivers** every eligible received message (event EV13). Downloads and envelope reads do not deliver. They fail with status 1222 until the list has run.
- `createMessage` has no idempotency key. On `IsdsTimeoutError` with `requestSent: true` the outcome is unknown: call `reconcileSentMessage`. It returns `Found`, `NotFound` (best effort) or `Ambiguous`. Only then decide whether to resend.
- Errors are tagged (`src/isds/errors.ts`): transport/TLS, timeout, auth (401/403), maintenance (503), other HTTP status, SOAP fault, invalid response, invalid request, message too large, and `IsdsStatusError`. `IsdsStatusError` carries a classification: `Transient` (3006/3008/3009/3013, retryable), `NotDelivered` (1222), `Blocked` (3022, never retry), `AttachmentRejected` (1214), `WrongService` (1281), `BoxNotFound` (5001) or `Other`.
- Not implemented: VoDZ large messages (over 20 MB fail with `IsdsMessageTooLarge`), signed sent-message downloads, and ZFO/CMS signature verification.

## Checks

The root `bun run check` typechecks, lints and tests this package with the rest of the workspace. To run only this package's checks, from the repository root:

```sh
node_modules/.bin/tsc -p servers/datova-schranka/tsconfig.json --noEmit
node_modules/.bin/biome check servers/datova-schranka
node_modules/.bin/vitest run servers/datova-schranka
```

The transport tests generate a throwaway CA and certificates with the `openssl` CLI.

## Live test (opt-in, public test environment only)

`test/isds/live.test.ts` is skipped unless `ISDS_LIVE_TEST=true`. It always targets `datovka-test.gov.cz`. `scripts/isds-live-test.sh` reads credentials from the Secret Service keyring (`secret-tool`, service `mcps-isds-test`) and passes them to the test as `/dev/fd` pipes. Nothing is written to disk.

```sh
servers/datova-schranka/scripts/isds-live-test.sh                       # password route
servers/datova-schranka/scripts/isds-live-test.sh --route certificate   # system certificate
servers/datova-schranka/scripts/isds-live-test.sh --allow-delivery      # + received list and downloads
```

Keyring accounts:
- password route: `username`, `password` (pick another account with `--password-account`)
- certificate route: `pkcs12-base64`, `pkcs12-passphrase`

By default it runs only DummyOperation, GetOwnerInfoFromLogin and GetListOfSentMessages. `--allow-delivery` adds GetListOfReceivedMessages, which delivers, and downloads the newest received message. CreateMessage is never run. The run stops after the first auth, credentials or transport failure, so a wrong password is tried only once.
