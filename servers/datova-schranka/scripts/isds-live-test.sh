#!/usr/bin/env bash
# Runs test/isds/live.test.ts against the ISDS PUBLIC TEST environment (datovka-test.gov.cz)
# with credentials from the Secret Service keyring (service "mcps-isds-test"). Credentials are
# passed as /dev/fd pipes (process substitution) and never written to disk, printed or logged.
#
# Usage: servers/datova-schranka/scripts/isds-live-test.sh [--route password|certificate]
#          [--password-account <keyring account>] [--allow-delivery]
#
#   --route password (default)  HTTP Basic on https://ws1.datovka-test.gov.cz/DS/...,
#                               keyring accounts "username" and "password" (or --password-account).
#   --route certificate         system certificate on https://ws1c.datovka-test.gov.cz/cert/DS/...,
#                               keyring accounts "pkcs12-base64" and "pkcs12-passphrase".
#   --allow-delivery            also runs GetListOfReceivedMessages, which DELIVERS received
#                               messages (no legal effect in the test environment), and downloads
#                               the newest one. CreateMessage is never run.
set -euo pipefail

route=password
password_account=password
allow_delivery=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --route) route="$2"; shift 2 ;;
    --password-account) password_account="$2"; shift 2 ;;
    --allow-delivery) allow_delivery=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

secret() {
  secret-tool lookup service mcps-isds-test account "$1"
}

for account in $([[ "$route" == certificate ]] && echo "pkcs12-base64 pkcs12-passphrase" || echo "username $password_account"); do
  if ! secret "$account" >/dev/null; then
    echo "keyring entry service=mcps-isds-test account=$account is missing" >&2
    exit 1
  fi
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

# Worker threads share the process's file descriptors, so the /dev/fd pipes stay readable;
# forked workers would not inherit them.
vitest=(node_modules/.bin/vitest run --config servers/datova-schranka/vitest.config.ts
  --pool=threads --maxWorkers=1 --silent=false --reporter=verbose test/isds/live.test.ts)

export ISDS_LIVE_TEST=true ISDS_LIVE_TEST_ROUTE="$route" ISDS_TEST_ALLOW_DELIVERY="$allow_delivery"
case "$route" in
  password)
    ISDS_TEST_USERNAME_FILE=<(secret username) \
    ISDS_TEST_PASSWORD_FILE=<(secret "$password_account") \
      "${vitest[@]}"
    ;;
  certificate)
    ISDS_TEST_PKCS12_BASE64_FILE=<(secret pkcs12-base64) \
    ISDS_TEST_PKCS12_PASSPHRASE_FILE=<(secret pkcs12-passphrase) \
      "${vitest[@]}"
    ;;
  *) echo "--route must be password or certificate" >&2; exit 2 ;;
esac
