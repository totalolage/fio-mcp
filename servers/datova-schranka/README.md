# datova-schranka

ISDS (Czech data box, datová schránka) SOAP client on Effect, for the future datova-schranka MCP server. The official v3.11 WSDL/XSD it follows are in `wsdl/`.

## Client (`src/isds/`)

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
