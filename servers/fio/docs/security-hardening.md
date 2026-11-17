# Security hardening

This guide is for running fio-mcp as a network service (HTTP with OAuth) in front of real FIO accounts, payments included. It separates what the server enforces by itself from what the reverse proxy, the container and you have to do. The [README](../README.md) documents every setting; this guide says which ones to use and why.

**fio-mcp never executes a payment.** It uploads a batch, and FIO only queues it. Nothing is paid until an authorized person signs the batch in Internetbanking (SMS or Fio signature). Every other control in this guide sits in front of that signature, and none replaces it. See [The Internetbanking signature](#the-internetbanking-signature).

## What the server enforces

These hold whatever the deployment looks like, as long as the configuration below is in place.

| Control | Setting | What it does |
|---|---|---|
| OAuth on HTTP | `FIO_MCP_PUBLIC_URL`, `FIO_MCP_ADMIN_PASSWORD_HASH_FILE`, `FIO_MCP_DATA_KEY_FILE` | Without them HTTP mode does not start. The only way around it, `FIO_MCP_ALLOW_UNAUTHENTICATED=true`, needs a loopback `FIO_MCP_HOST` unless `FIO_MCP_ALLOW_UNAUTHENTICATED_ON_NETWORK=true`, and logs a `SECURITY WARNING`. |
| Encrypted FIO tokens | `FIO_MCP_DATA_KEY_FILE` | Tokens are stored only AES-256-GCM encrypted; a wrong key stops the start. |
| `Host` check | `FIO_MCP_ALLOWED_HOSTS` | Other `Host` values get 403 on the main and the admin listener (DNS rebinding). |
| Sign-in throttle | `FIO_MCP_TRUSTED_PROXIES` | Delays and a 15-minute lockout per client address, one scrypt check at a time ("Sign-in busy, try again." with 429 otherwise). Warns at startup when the list is empty, and at the first `X-Forwarded-For` from a peer it doesn't trust. |
| Network allowlist for the browser pages | `FIO_MCP_ADMIN_ALLOWED_CIDRS` | `/admin`, `/authorize`, `/login` and `/consent` answer 404 to other addresses. |
| Separate admin listener | `FIO_MCP_ADMIN_PORT`, `FIO_MCP_ADMIN_HOST` | Moves `/admin` off the main port. |
| Second factor | `FIO_MCP_ADMIN_TOTP_SECRET_FILE`, `fio-mcp totp-init` | A TOTP code at every sign-in and every approval of a held payment batch. |
| FIO address | `FIO_API_BASE_URL` | Only `https` on `fio.cz` or its subdomains; tokens can't be sent elsewhere by a stray setting. |
| Bank text marked as data | always on | Counterparty names, messages and other bank text reach the model inside nonce-tagged markers with a notice to ignore instructions in them. |
| No download-marker tools | `FIO_MCP_MARKER_TOOLS=disabled` | Removes `get_new_transactions` and `set_download_marker`. |
| Cache encryption | `FIO_CACHE_ENCRYPT=true` | Encrypts the cached counterparty details and free text with the data key. |
| One server per database | always on (cache or OAuth) | A lease in the database stops a second server on the same file. |
| Payments granted explicitly | consent page | The `fio:payments` box starts unticked. |
| Payment limits | `FIO_MCP_PAYMENT_MAX_PER_ORDER`, `_MAX_PER_DAY`, `_MAX_ORDERS_PER_DAY`, per grant | Per order, per day and orders per day; a batch over a limit is refused before upload. |
| Payee allowlist | per grant: `off`, `enforce`, `confirm` | Refuses unlisted payees, or holds every batch for your approval at `/admin/payments/pending`. |
| Idempotency | `idempotencyKey` on `submit_payment_orders` | A retried call never uploads the same batch twice. |
| Uncertain uploads | always on | Any 5xx or ambiguous answer is reported as "outcome unknown", with the advice to check Internetbanking first. |
| Audit log | `/admin/payments`, `fio-mcp payments purge` | Every submitted batch, with payees, amounts and outcome; kept at least 365 days. |

What the server can't do: it can't stop a reverse proxy from exposing the admin pages, it can't see where its secret files live or whether `/data` is encrypted, it can't stop two servers with different databases from sharing a token, and it can't tell whether the model took a payee from your request or from a bank message. That part is yours.

## Deployment

### Split public and restricted routes at the proxy

MCP clients need only a few paths. Your browser needs the rest, and only from your own networks.

| Public (from the internet) | Restricted (VPN or LAN only) |
|---|---|
| `/mcp` | `/admin` and everything below it |
| `POST /token`, `POST /register`, `POST /revoke`, and `OPTIONS` on them | `/authorize` |
| `GET /.well-known/oauth-protected-resource` | `/login` |
| `GET /.well-known/oauth-protected-resource/mcp` | `/consent` |
| `GET /.well-known/oauth-authorization-server` | |
| `/healthz` (optional) | |

The OAuth flow still works: the client sends your browser to `/authorize`, `/login` and `/consent`, and your browser is inside the allowlist.

With Traefik's file provider, use two routers on the same host. The public one lists the public paths; the restricted one catches everything else, at a lower priority, behind an `ipAllowList`:

```yaml
http:
  routers:
    fio-mcp-public:
      rule: Host(`fio.example.net`) && (Path(`/mcp`) || Path(`/token`) || Path(`/register`) || Path(`/revoke`) || Path(`/healthz`) || PathPrefix(`/.well-known/oauth-`))
      priority: 20
      middlewares: [fio-mcp-hsts]
      tls: {}
      service: fio-mcp
    fio-mcp-restricted:
      rule: Host(`fio.example.net`)
      priority: 10
      middlewares: [fio-mcp-vpn-only, fio-mcp-hsts]
      tls: {}
      service: fio-mcp
  middlewares:
    fio-mcp-vpn-only:
      ipAllowList:
        sourceRange: ["100.64.0.0/10", "192.168.1.0/24"]   # your Tailscale/VPN and LAN ranges
    fio-mcp-hsts:
      headers:
        stsSeconds: 31536000
  services:
    fio-mcp:
      loadBalancer:
        servers:
          - url: http://<nas-address>:3000
```

If Traefik itself sits behind another proxy or a load balancer, give `ipAllowList` an `ipStrategy` so it checks the real client address, not the hop in front of it.

TLS terminates at the proxy, with a valid certificate. fio-mcp speaks plain HTTP and its cookies are `Secure`, so the pages don't work without TLS.

Set `FIO_MCP_ADMIN_ALLOWED_CIDRS` to the same ranges. It is a second layer: if a proxy rule is ever wrong, fio-mcp still answers 404 to an outside address. It relies on `FIO_MCP_TRUSTED_PROXIES` being right, because behind a proxy the client address comes from `X-Forwarded-For`.

**Separate admin listener.** With `FIO_MCP_ADMIN_PORT` set, add a router for ``PathPrefix(`/admin`)`` to a second service on that port, with the same `ipAllowList`, at the same public origin (the admin forms check that the `Origin` is `FIO_MCP_PUBLIC_URL`). `FIO_MCP_ADMIN_HOST` defaults to `127.0.0.1`, which inside a container is reachable only from the container itself. Set it to `0.0.0.0` in the container and publish the admin port only to the address the proxy uses, or the proxy can't reach it.

Check from an outside address:

```sh
curl -i https://fio.example.net/admin        # 403 from the proxy (or 404 from fio-mcp)
curl -i https://fio.example.net/login        # 403 or 404
curl -i https://fio.example.net/mcp          # 401 with WWW-Authenticate: Bearer resource_metadata="…"
curl -i https://fio.example.net/.well-known/oauth-authorization-server   # 200
```

From the VPN, `https://fio.example.net/admin` shows the sign-in page.

### Environment and secret files

| Variable | Value |
|---|---|
| `FIO_MCP_TRANSPORT` | `http` (the image's default) |
| `FIO_MCP_PUBLIC_URL` | `https://<public host>`, an origin without path |
| `FIO_MCP_ADMIN_PASSWORD_HASH_FILE` | a file made with `printf '%s\n' "$pw" \| docker run --rm -i <image> hash-password` (see the README's [Setup](../README.md#setup)) |
| `FIO_MCP_DATA_KEY_FILE` | a file from `openssl rand -hex 32`, stored **outside** `/data` and its backups |
| `FIO_MCP_ALLOWED_HOSTS` | `<public host>` |
| `FIO_MCP_TRUSTED_PROXIES` | the proxy's exact address as fio-mcp sees it, or a network only the proxy and fio-mcp share (see the README's [Reverse proxy](../README.md#reverse-proxy)) |
| `FIO_MCP_ALLOWED_ORIGINS` | empty: MCP clients are not browsers, and empty refuses every request that carries a browser `Origin` |
| `FIO_MCP_ADMIN_ALLOWED_CIDRS` | your VPN and LAN ranges, as in the proxy |
| `FIO_MCP_ADMIN_TOTP_SECRET_FILE` | a file with the first line of `fio-mcp totp-init` |
| `FIO_MCP_MARKER_TOOLS` | `disabled` |
| `FIO_MCP_PAYMENT_MAX_PER_ORDER`, `FIO_MCP_PAYMENT_MAX_PER_DAY`, `FIO_MCP_PAYMENT_MAX_ORDERS_PER_DAY` | your ceilings, if the defaults (`CZK:50000,EUR:2000`, `CZK:100000,EUR:4000`, `20`) are too high |
| `FIO_SYNC_INTERVAL_MINUTES` | optional, for example `60` (default `0`, off; at least `5`) |

Mount the secret files read-only (TrueNAS uses `/run/secrets`) with mode 0440, readable by the container's group. Never put a FIO token in a Compose `environment:` value. Add the accounts at `/admin`. If you seed them once with `FIO_ACCOUNTS_FILE` or `FIO_TOKEN_FILE`, remove the variable after the first start and delete the file: the server ignores it from then on, warns about it at every start, and does not delete it for you.

A good start logs `accounts: N accounts loaded from the database` and none of these:

- `SECURITY WARNING: FIO_MCP_ALLOW_UNAUTHENTICATED=true. …`
- `FIO_MCP_TRUSTED_PROXIES is empty: …`
- `FIO_API_ALLOW_TEST_BASE_URL=true: …`
- `accounts: FIO_TOKEN / FIO_ACCOUNTS (or their _FILE variants) are set but ignored: …`

### Variables that must never be set

| Variable | Why |
|---|---|
| `FIO_MCP_ALLOW_UNAUTHENTICATED` | Opens `/mcp` to anyone, with payments. |
| `FIO_MCP_ALLOW_UNAUTHENTICATED_ON_NETWORK` | Tests only. |
| `FIO_API_BASE_URL` | The default is right. |
| `FIO_API_ALLOW_TEST_BASE_URL` | Tests only. |
| `FIO_TOKEN`, `FIO_ACCOUNTS`, `FIO_TOKEN_FILE`, `FIO_ACCOUNTS_FILE` | Only for one seeding start, as above. |

The server refuses the dangerous combinations on its own (unauthenticated mode with OAuth settings or on a network address, a base URL off `fio.cz`), but it can't know that a test setting doesn't belong in production. Check before each deployment, and after the first start:

```sh
#!/bin/sh
# usage: check-fio-env.sh <compose file> <container>
# Prints the names of forbidden variables, never their values. Exits 1 when one
# is set, 2 when the check can't run.
forbidden='FIO_MCP_ALLOW_UNAUTHENTICATED FIO_MCP_ALLOW_UNAUTHENTICATED_ON_NETWORK FIO_API_BASE_URL FIO_API_ALLOW_TEST_BASE_URL FIO_TOKEN FIO_TOKEN_FILE FIO_ACCOUNTS FIO_ACCOUNTS_FILE'
[ $# -eq 2 ] || { echo "usage: $0 <compose file> <container>" >&2; exit 2; }
compose=$(cat -- "$1") || { echo "cannot read $1" >&2; exit 2; }
env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$2") || { echo "cannot inspect $2" >&2; exit 2; }
status=0
for name in $forbidden; do
  if printf '%s\n' "$compose" | grep -qw -- "$name"; then echo "$1 names $name" >&2; status=1; fi
  if printf '%s\n' "$env" | grep -q -- "^$name="; then echo "$2 has $name in its environment" >&2; status=1; fi
done
exit $status
```

During the one seeding start the check fails on purpose.

### Container hardening and a single replica

In the Compose service (the README's [example](../README.md#container-and-nas-deployment) has all of it):

- `user: "<uid>:<gid>"`, not root (the image's default user is `node`).
- `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`.
- `mem_limit: 512m`. A sign-in needs about 128 MiB of scrypt workspace with the `hash-password` defaults, the server accepts hashes that need up to 256 MiB, and the container has peaked at about 256 MiB during one.
- `/data` as the only writable volume. The image writes nothing else, SQLite's temporary data included.
- Publish port 3000 only on the address the proxy connects to (for example `127.0.0.1:3000:3000` when the proxy runs on the host network), not on `0.0.0.0`. With the proxy on a shared Docker network, publish nothing.
- **Exactly one replica** per database and per set of tokens. FIO allows one request per token every 30 s and the rate limiter lives in the process, so two servers with one token trip FIO's limit. The [lease](../README.md#one-server-per-database) stops a second server on the same database file; it can't stop two servers with separate databases that use the same token.
- Build the image from a reviewed, clean commit with `bun run ship:image` and record the `tag=` and `image_id=` it prints.

Check:

```sh
docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapAdd}} {{.HostConfig.CapDrop}} {{.Config.User}}' fio-mcp
# true [] [ALL] 568:568
ss -ltnp | grep ':3000'     # only on the proxy-facing address
```

### Encrypted storage for /data, key kept apart

The database holds the encrypted tokens, the OAuth grants, the cached movements, the payment audit log (payees and amounts) and any held batches. Put `/data` on encrypted storage, for example an encrypted ZFS dataset on TrueNAS.

`FIO_CACHE_ENCRYPT=true` encrypts the cache's counterparty details and free text inside the file, but not dates, amounts or symbols, and not the payment audit log. Use it in addition to encrypted storage, or instead of it only if you accept that. It slows text and counterparty searches (see the README's [Encryption at rest](../README.md#encryption-at-rest)).

The encryption is only as good as the place the key lives:

- Keep `FIO_MCP_DATA_KEY_FILE`, the admin hash and the TOTP secret on a different dataset from `/data`, mode 0440 or stricter, readable only by the container's user or group. The server can't check this.
- Backups of `/data` must never contain the key file. A database backup holds only a check value derived from the key, never the key.

Check: the dataset reports encryption on; listing a backup archive shows no key file; `stat -c %a` on the key file prints `440` or less.

## Operations

### FIO tokens

- Create a **new** token for each account in Internetbanking (**Nastavení → API**), used only by fio-mcp. Another program on the same token shares its 30-second budget and, if it uses `/last`, its download marker.
- Choose the token's level on purpose: read-only (**Sledování účtu**) for accounts agents only read, payment orders as well for accounts where agents should prepare payments. Both are supported. Label each token in FIO, for example "fio-mcp payments 2026-11", and note its level in your records.
- Add it at `/admin` and press **Test token**. The test calls `lastStatement`, which is read-only and says nothing about the token's payment rights; check those in Internetbanking.
- FIO tokens expire within 180 days. Replace a token before then, and at once if the server or the data key may have been exposed: **Replace token** at `/admin`, then delete the old token in Internetbanking. Replacing a token removes that account from existing grants, so reconnect the clients that should keep it.

Check: `get_server_status` lists only the accounts you meant to add.

### Granting and reviewing clients

- On the consent page, check the redirect URI before you approve. The client name is whatever the client registered, so it proves nothing; approve only for a client you just started connecting yourself.
- Tick `fio:payments` only for an agent that should prepare payments, and only on the accounts it needs. Set its limits below the server's ceilings where you can, and choose `enforce` or `confirm` for the payee allowlist. `off` is for a grant you have decided to trust with any payee. Grants made before per-grant limits existed have none of their own (they follow the server's) and the allowlist off: open `/admin/clients` and set both.
- Give `fio:read` alone wherever an agent doesn't need payments.
- Once a month, review `/admin/clients` (remove clients you don't know, revoke grants nobody uses) and `/admin/payments` (every row should match something you asked for).

Check: `/admin/clients` lists only known clients, and every grant with `fio:payments` shows limits and an allowlist mode you chose.

### Admin password and second factor

- Use a random password of 20 characters or more, kept in a password manager and used nowhere else. The server enforces 12 to 1024 characters.
- Change it at `/admin/password`; recover it with `reset-admin-password` (see the README's [Admin password](../README.md#admin-password)).
- Turn on TOTP: `fio-mcp totp-init`, the first line into the `FIO_MCP_ADMIN_TOTP_SECRET_FILE` file, the second into your authenticator app (see the README's [Second factor](../README.md#second-factor-totp)). It then also guards the approval of held payment batches.

Check: a sign-in attempt from outside the VPN never reaches the sign-in page.

### Backups and restore tests

- Back up with `docker exec <container> node dist/main.js backup /data/backups/<date>.sqlite`. It uses SQLite `VACUUM INTO` while the server runs and creates the file with mode 0600; the destination must not exist yet.
- Copy the backup to encrypted storage.
- Keep **one** offline copy of the data key, away from the database backups. Without the key the stored tokens can't be decrypted; with it, any database copy reveals them.
- Test a restore every quarter on a scratch container: the backup as its database, the same key file, `FIO_SYNC_ON_STARTUP=false`, no published port. The log should show `accounts: N accounts loaded from the database`, and **Test token** should pass. The backup carries the live server's lease, so a copy restored within 90 s of being taken waits for it to go stale.

### Dependencies and images

Before each deployment:

- `bun install --frozen-lockfile --ignore-scripts`, so no install script runs, not even the project's own `prepare`. Then run that step by hand (`bunx effect-tsgo patch --typescript --no-oxlint && bun run build`, which patches TypeScript for the Effect diagnostics and builds `packages/core` and `servers/fio` into their `dist/` directories), followed by `bun run check` and `bun audit`. Deploy with no advisory in a production dependency, or with the exception written down. (Bun 1.4.2's `bun audit` has no flag to skip development dependencies; judge those by whether they reach the image.)
- On Node security releases, bump the digest-pinned `NODE_IMAGE` and `BUN_IMAGE` at the top of the `Dockerfile`.
- Keep `"trustedDependencies": []` in `package.json` and `minimumReleaseAge` in `bunfig.toml` as they are.
- Record the audit output and the commit of each deployed tag in your release notes.

### The Internetbanking signature

With agents allowed to submit, the signature is the one control that acts whatever the model believes. The bank-text markers, the limits, the allowlist, the idempotency key and the audit log only narrow what reaches it.

- Every imported batch must be signed in Internetbanking before FIO pays anything. Never turn on a FIO setting that would let API batches run without a signature, if FIO ever offers one.
- Before signing, check each pending batch's payee and amount against your own request and against its row at `/admin/payments`.
- Never sign a batch you didn't ask for.
- After an "outcome unknown" answer, check the pending batches (Platby → Příkazy k autorizaci) before anyone submits again.
- Once, with a payment-capable token, submit a small batch and confirm it shows up in Internetbanking as waiting for a signature and is not executed until you sign it. Note the date in your deployment notes.

The tool texts tell the model the same: the `submit_payment_orders` description says FIO only queues the batch, and an accepted upload's `nextStep` says an authorized person must sign it in Internetbanking. A test pins both.

### After a suspected compromise

1. **Revoke all** at `/admin/clients`, or `docker exec <container> node dist/main.js tokens revoke-all`.
2. Change the admin password, and make a new TOTP secret with `fio-mcp totp-init`.
3. Replace every FIO token (above) and delete the old ones in Internetbanking.
4. Decline anything at `/admin/payments/pending`, and check the pending batches in Internetbanking.
5. If the data key may have leaked, replace it. There is no re-encryption command: follow the README's [Token encryption](../README.md#token-encryption) steps and add the accounts again with the new tokens.

## Checklist

| Item | Section |
|---|---|
| Public and restricted routes split at the proxy, TLS with HSTS, `FIO_MCP_ADMIN_ALLOWED_CIDRS` set | [Split public and restricted routes](#split-public-and-restricted-routes-at-the-proxy) |
| Required variables and secret files; clean start log | [Environment and secret files](#environment-and-secret-files) |
| No forbidden variable in Compose or `docker inspect` | [Variables that must never be set](#variables-that-must-never-be-set) |
| Read-only, non-root, no capabilities, one replica, port bound to the proxy | [Container hardening](#container-hardening-and-a-single-replica) |
| `/data` encrypted, key file elsewhere and out of backups | [Encrypted storage](#encrypted-storage-for-data-key-kept-apart) |
| Dedicated FIO tokens with a deliberate level | [FIO tokens](#fio-tokens) |
| Consent checked, payment grants with limits and an allowlist mode, monthly review | [Granting and reviewing clients](#granting-and-reviewing-clients) |
| Random admin password, TOTP on | [Admin password and second factor](#admin-password-and-second-factor) |
| Backups, one offline key copy, quarterly restore test | [Backups and restore tests](#backups-and-restore-tests) |
| Audit before each deployment, pinned images | [Dependencies and images](#dependencies-and-images) |
| Every batch signed in Internetbanking after checking it | [The Internetbanking signature](#the-internetbanking-signature) |
