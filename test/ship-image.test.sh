#!/bin/sh
# Tests scripts/ship-image.sh against shim docker, ssh and gzip commands on
# PATH. Nothing is built and ssh is never run.
#
# Usage: npm run test:scripts
#    or: SHIP_SH="bash --posix" sh test/ship-image.test.sh (the shell that
#        runs the script; default sh)
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
real_gzip=$(command -v gzip)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

local_id=sha256:$(printf '%064d' 1)
other_id=sha256:$(printf '%064d' 2)

mkdir "$work/bin"
cat >"$work/bin/docker" <<'EOF'
#!/bin/sh
echo "$*" >>"$SHIM_LOG/docker.log"
case $1 in
  buildx)
    [ -n "${SHIM_BUILDX:-}" ] || exit 1
    [ "$2" = version ] && exit 0
    echo "buildx build output"
    ;;
  build)
    [ -z "${SHIM_BUILD_FAIL:-}" ] || exit 5
    echo "build output"
    ;;
  image) echo "$SHIM_LOCAL_ID" ;;
  save)
    [ -z "${SHIM_SAVE_FAIL:-}" ] || exit 3
    if [ -n "${SHIM_SAVE_BIG:-}" ]; then
      yes "image bytes" | head -c 20000000
    else
      echo "image bytes"
    fi
    ;;
  *) exit 64 ;;
esac
EOF
cat >"$work/bin/ssh" <<'EOF'
#!/bin/sh
{
  for arg; do printf '[%s]' "$arg"; done
  echo
} >>"$SHIM_LOG/ssh.log"
eval "cmd=\${$#}"
case $cmd in
  *' version '*)
    [ -z "${SHIM_PREFLIGHT_FAIL:-}" ] || exit 255
    echo "29.0.0"
    ;;
  *' load')
    # Exits successfully without reading, so only the writers see EPIPE.
    [ -z "${SHIM_LOAD_EARLY:-}" ] || exit 0
    cat >"$SHIM_LOG/payload"
    [ -z "${SHIM_LOAD_FAIL:-}" ] || exit 255
    echo "Loaded image: from load"
    ;;
  *' image inspect '*)
    [ -z "${SHIM_INSPECT_FAIL:-}" ] || exit 1
    echo "${SHIM_REMOTE_ID:-$SHIM_LOCAL_ID}"
    ;;
  *) exit 64 ;;
esac
EOF
cat >"$work/bin/gzip" <<EOF
#!/bin/sh
[ -z "\${SHIM_GZIP_FAIL:-}" ] || exit 4
exec $real_gzip "\$@"
EOF
# Stands in for sudo in DOCKER="sudo -n docker".
cat >"$work/bin/sudo" <<'EOF'
#!/bin/sh
echo "$*" >>"$SHIM_LOG/sudo.log"
[ "$1" = -n ] && shift
exec "$@"
EOF
chmod +x "$work/bin/docker" "$work/bin/ssh" "$work/bin/gzip" "$work/bin/sudo"

# A throwaway clean repository holding the script and a package.json.
repo=$work/repo
mkdir -p "$repo/scripts"
cp "$root/scripts/ship-image.sh" "$repo/scripts/"
echo '{ "version": "1.2.3" }' >"$repo/package.json"
git -C "$repo" init -q
git -C "$repo" add .
git -C "$repo" -c user.name=test -c user.email=test@example.invalid commit -qm init
sha=$(git -C "$repo" rev-parse --short HEAD)
tag=fio-mcp:1.2.3-$sha

failures=0
case_name=

knobs='DRY_RUN DOCKER FIO_MCP_SSH_HOST FIO_MCP_REMOTE_DOCKER SHIM_BUILDX SHIM_BUILD_FAIL SHIM_SAVE_FAIL SHIM_SAVE_BIG SHIM_GZIP_FAIL SHIM_LOAD_FAIL SHIM_LOAD_EARLY SHIM_PREFLIGHT_FAIL SHIM_INSPECT_FAIL SHIM_REMOTE_ID'
# shellcheck disable=SC2086 # word list on purpose
unset $knobs
ship_sh=${SHIP_SH:-sh}

# [KNOB=value...] ship [args...]: runs the script with fresh shim logs and
# sets $status. Knobs are passed explicitly and cleared afterwards, because
# shells differ on whether assignments before a function call persist.
ship() {
  rm -rf "$work/log"
  mkdir "$work/log"
  : >"$work/log/docker.log"
  status=0
  # shellcheck disable=SC2086 # SHIP_SH may be "bash --posix"
  env PATH="$work/bin:$PATH" SHIM_LOG="$work/log" SHIM_LOCAL_ID="$local_id" \
    DRY_RUN="${DRY_RUN:-}" DOCKER="${DOCKER:-}" FIO_MCP_SSH_HOST="${FIO_MCP_SSH_HOST:-}" FIO_MCP_REMOTE_DOCKER="${FIO_MCP_REMOTE_DOCKER:-}" \
    SHIM_BUILDX="${SHIM_BUILDX:-}" SHIM_BUILD_FAIL="${SHIM_BUILD_FAIL:-}" SHIM_SAVE_FAIL="${SHIM_SAVE_FAIL:-}" \
    SHIM_SAVE_BIG="${SHIM_SAVE_BIG:-}" SHIM_GZIP_FAIL="${SHIM_GZIP_FAIL:-}" SHIM_LOAD_FAIL="${SHIM_LOAD_FAIL:-}" \
    SHIM_LOAD_EARLY="${SHIM_LOAD_EARLY:-}" SHIM_PREFLIGHT_FAIL="${SHIM_PREFLIGHT_FAIL:-}" \
    SHIM_INSPECT_FAIL="${SHIM_INSPECT_FAIL:-}" SHIM_REMOTE_ID="${SHIM_REMOTE_ID:-}" \
    $ship_sh "$repo/scripts/ship-image.sh" "$@" >"$work/out" 2>"$work/err" || status=$?
  # shellcheck disable=SC2086
  unset $knobs
}

fail() {
  echo "FAIL: $case_name: $1" >&2
  sed 's/^/  stderr: /' "$work/err" >&2
  failures=$((failures + 1))
}

expect_status() {
  [ "$status" -eq "$1" ] || fail "exit status $status, expected $1"
}

expect_failure() {
  [ "$status" -ne 0 ] || fail "exited 0, expected a failure"
  [ ! -s "$work/out" ] || fail "stdout not empty: $(cat "$work/out")"
}

expect_stdout_result() {
  printf 'tag=%s\nimage_id=%s\n' "$tag" "$local_id" >"$work/expected"
  cmp -s "$work/expected" "$work/out" || fail "stdout was: $(cat "$work/out")"
}

expect_ssh_call() {
  grep -Fqx -- "$1" "$work/log/ssh.log" 2>/dev/null || fail "no ssh call $1"
}

expect_err() {
  grep -Fq -- "$1" "$work/err" || fail "stderr lacks '$1'"
}

case_name="ships compressed to the default host"
ship
expect_status 0
expect_stdout_result
grep -Fqx "build --platform linux/amd64 --tag $tag --tag fio-mcp:1.2.3 ." "$work/log/docker.log" ||
  fail "build call: $(cat "$work/log/docker.log")"
expect_ssh_call "[-o][BatchMode=yes][nas][command -v gunzip >/dev/null && sudo -n docker version --format '{{.Server.Version}}']"
expect_ssh_call "[-o][BatchMode=yes][nas][gunzip | sudo -n docker load]"
expect_ssh_call "[-o][BatchMode=yes][nas][sudo -n docker image inspect --format '{{.Id}}' $tag]"
[ "$(wc -l <"$work/log/ssh.log")" -eq 3 ] || fail "expected 3 ssh calls: $(cat "$work/log/ssh.log")"
[ "$("$real_gzip" -dc "$work/log/payload")" = "image bytes" ] || fail "payload is not the gzipped image"
expect_err "build output"
expect_err "Loaded image: from load"

case_name="honours FIO_MCP_SSH_HOST, FIO_MCP_REMOTE_DOCKER and --no-compress"
FIO_MCP_SSH_HOST=docker-host FIO_MCP_REMOTE_DOCKER=docker ship --no-compress
expect_status 0
expect_stdout_result
expect_ssh_call "[-o][BatchMode=yes][docker-host][docker version --format '{{.Server.Version}}']"
expect_ssh_call "[-o][BatchMode=yes][docker-host][docker load]"
expect_ssh_call "[-o][BatchMode=yes][docker-host][docker image inspect --format '{{.Id}}' $tag]"
[ "$(cat "$work/log/payload")" = "image bytes" ] || fail "payload is not the raw image"

case_name="builds with buildx when it is installed"
SHIM_BUILDX=1 ship
expect_status 0
grep -Fqx "buildx build --platform linux/amd64 --tag $tag --tag fio-mcp:1.2.3 --load ." "$work/log/docker.log" ||
  fail "buildx call: $(cat "$work/log/docker.log")"

case_name="runs every local docker call through DOCKER"
DOCKER="sudo -n docker" ship
expect_status 0
expect_stdout_result
[ "$(wc -l <"$work/log/sudo.log")" -eq "$(wc -l <"$work/log/docker.log")" ] ||
  fail "docker calls bypassed DOCKER: $(cat "$work/log/sudo.log")"
grep -Fqx -- "-n docker save $tag" "$work/log/sudo.log" || fail "save did not use DOCKER"

case_name="fails when the build fails"
SHIM_BUILD_FAIL=1 ship
expect_failure
[ ! -e "$work/log/ssh.log" ] || fail "ssh was called"

case_name="fails when the remote end closes the stream early"
SHIM_SAVE_BIG=1 SHIM_LOAD_EARLY=1 ship
expect_failure
expect_err "shipping $tag to nas failed"

case_name="fails when the remote image cannot be inspected"
SHIM_INSPECT_FAIL=1 ship
expect_failure
expect_err "cannot inspect $tag on nas"

case_name="fails when the remote image ID differs"
SHIM_REMOTE_ID=$other_id ship
expect_failure
expect_err "has image ID '$other_id'"

case_name="fails when docker save fails"
SHIM_SAVE_FAIL=1 ship
expect_failure
expect_err "docker save exited with status 3"

case_name="fails when gzip fails"
SHIM_GZIP_FAIL=1 ship
expect_failure
expect_err "gzip exited with status 4"

case_name="fails when ssh or docker load fails"
SHIM_LOAD_FAIL=1 ship
expect_failure
expect_err "ssh exited with status 255"
if grep -Fq 'image inspect' "$work/log/ssh.log"; then fail "inspected after a failed load"; fi

case_name="fails before streaming when the preflight fails"
SHIM_PREFLIGHT_FAIL=1 ship
expect_failure
if grep -Fq ' load]' "$work/log/ssh.log"; then fail "streamed after a failed preflight"; fi

case_name="--dry-run builds but never calls ssh"
ship --dry-run
expect_status 0
expect_stdout_result
[ ! -e "$work/log/ssh.log" ] || fail "ssh was called: $(cat "$work/log/ssh.log")"
grep -q '^build ' "$work/log/docker.log" || fail "did not build"

case_name="DRY_RUN=1 never calls ssh"
DRY_RUN=1 ship
expect_status 0
expect_stdout_result
[ ! -e "$work/log/ssh.log" ] || fail "ssh was called: $(cat "$work/log/ssh.log")"

case_name="refuses a dirty tree"
echo dirty >"$repo/untracked"
ship
rm "$repo/untracked"
expect_status 1
expect_err "uncommitted or untracked"
[ ! -s "$work/log/docker.log" ] || fail "docker was called: $(cat "$work/log/docker.log")"
[ ! -e "$work/log/ssh.log" ] || fail "ssh was called"

case_name="rejects unknown arguments and option-like hosts"
ship --push
expect_status 2
FIO_MCP_SSH_HOST=-oProxyCommand=x ship
expect_status 2
[ ! -e "$work/log/ssh.log" ] || fail "ssh was called"

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "ship-image tests passed"
