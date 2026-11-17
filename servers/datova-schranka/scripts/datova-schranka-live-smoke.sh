#!/usr/bin/env bash
# Runs test/e2e/live.test.ts: the composed datova-schranka HTTP app, in-process, against the ISDS
# PUBLIC TEST environment (datovka-test.gov.cz). The box is added through the admin action with
# credentials from the Secret Service keyring (service "mcps-isds-test"). Credentials reach the
# test only as /dev/fd pipes (process substitution); this script never writes them to a file,
# prints, logs or passes them in argv. The app under test stores the box's credentials sealed with
# a throwaway data key in a temp database; TMPDIR points at a private tmpfs directory (under
# XDG_RUNTIME_DIR, else /dev/shm) that this script removes on exit, interrupt or termination, so
# that database never reaches a persistent disk even if the test dies before its own cleanup.
#
# Usage: servers/datova-schranka/scripts/datova-schranka-live-smoke.sh [--route password|certificate]
#
#   --route password (default)  keyring accounts "username" and "password".
#   --route certificate         keyring accounts "pkcs12-base64" (decoded in a pipe) and
#                               "pkcs12-passphrase".
#
# The test calls list_received_messages, which DELIVERS the box's received messages (no legal
# effect in the test environment). It never sends a message.
set -euo pipefail

route=password
while [[ $# -gt 0 ]]; do
  case "$1" in
    --route)
      [[ $# -ge 2 ]] || { echo "--route needs a value" >&2; exit 2; }
      route="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$route" in
  password) accounts=(username password) ;;
  certificate) accounts=(pkcs12-base64 pkcs12-passphrase) ;;
  *) echo "--route must be password or certificate" >&2; exit 2 ;;
esac

secret() {
  secret-tool lookup service mcps-isds-test account "$1"
}

for account in "${accounts[@]}"; do
  if ! secret "$account" >/dev/null; then
    echo "keyring entry service=mcps-isds-test account=$account is missing" >&2
    exit 1
  fi
done

runtime_dir="${XDG_RUNTIME_DIR:-/dev/shm}"
[[ -d "$runtime_dir" ]] || { echo "no tmpfs directory: set XDG_RUNTIME_DIR" >&2; exit 1; }
scratch="$(mktemp -d "$runtime_dir/datova-schranka-live-smoke.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export TMPDIR="$scratch"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

# Worker threads share the process's file descriptors, so the /dev/fd pipes stay readable;
# forked workers would not inherit them.
vitest=(node_modules/.bin/vitest run --pool=threads --maxWorkers=1 --silent=false
  --reporter=verbose servers/datova-schranka/test/e2e/live.test.ts)

export DS_LIVE_SMOKE=true DS_LIVE_SMOKE_ROUTE="$route"
if [[ "$route" == password ]]; then
  DS_LIVE_SMOKE_USERNAME_FILE=<(secret username) \
  DS_LIVE_SMOKE_PASSWORD_FILE=<(secret password) \
    "${vitest[@]}"
else
  DS_LIVE_SMOKE_PKCS12_FILE=<(secret pkcs12-base64 | base64 -d) \
  DS_LIVE_SMOKE_PKCS12_PASSPHRASE_FILE=<(secret pkcs12-passphrase) \
    "${vitest[@]}"
fi
