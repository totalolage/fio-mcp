#!/bin/sh
# Builds the linux/amd64 image from a clean checkout, tags it
# fio-mcp:<package.json version>-<short git sha> and fio-mcp:<version>, and
# streams it to a docker host over ssh (docker save | gzip | ssh ... docker
# load). No registry is involved. It then checks that the remote image ID
# matches the local one.
#
# Usage: npm run ship:image -- [--dry-run] [--no-compress]
#
# FIO_MCP_SSH_HOST       ssh destination, usually a host alias from
#                        ~/.ssh/config (default: nas). ssh runs with
#                        BatchMode=yes, so the key must come from the ssh
#                        config or agent; nothing prompts.
# FIO_MCP_REMOTE_DOCKER  docker command on that host (default: sudo -n docker).
# DOCKER                 local docker command, e.g. DOCKER="sudo -n docker".
# --dry-run (or DRY_RUN=1) builds and tags the image locally and prints what
# would be shipped, without contacting the host.
# --no-compress streams the image uncompressed (no local gzip needed).
#
# stdout gets only two lines, tag=<tag> and image_id=<id>; everything else
# goes to stderr.
set -eu

dry_run=
case ${DRY_RUN:-} in
  '' | 0) ;;
  *) dry_run=1 ;;
esac
compress=1
for arg; do
  case $arg in
    --dry-run) dry_run=1 ;;
    --no-compress) compress= ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      exit 2
      ;;
  esac
done

host=${FIO_MCP_SSH_HOST:-nas}
remote_docker=${FIO_MCP_REMOTE_DOCKER:-sudo -n docker}
case $host in
  '' | -*)
    echo "error: FIO_MCP_SSH_HOST '$host' is not an ssh destination" >&2
    exit 2
    ;;
esac
if [ -z "$remote_docker" ]; then
  echo "error: FIO_MCP_REMOTE_DOCKER is empty" >&2
  exit 2
fi

docker() {
  # shellcheck disable=SC2086 # split on purpose: DOCKER may be a prefix such as "sudo -n docker"
  command ${DOCKER:-docker} "$@"
}

remote() {
  ssh -o BatchMode=yes "$host" "$1"
}

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "error: the working tree has uncommitted or untracked files; commit or remove them first" >&2
  git status --short --untracked-files=all >&2
  exit 1
fi

if [ -n "$compress" ] && [ -z "$dry_run" ] && ! command -v gzip >/dev/null 2>&1; then
  echo "error: gzip is not installed; install it or pass --no-compress" >&2
  exit 2
fi

version=$(node -p "require('./package.json').version")
sha=$(git rev-parse --short HEAD)
case $version in
  '' | [!0-9A-Za-z]* | *[!0-9A-Za-z._-]*)
    echo "error: package.json version '$version' is not usable in a docker tag" >&2
    exit 2
    ;;
esac
tag=fio-mcp:$version-$sha

tmp=$(mktemp -d)
cleanup() {
  if [ -n "${tmp:-}" ]; then
    rm -rf "$tmp" || :
    tmp=
  fi
}
handle_signal() {
  signal_status=$1
  cleanup
  trap - EXIT
  exit "$signal_status"
}
trap cleanup EXIT
trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

# Build output goes to stderr: stdout is reserved for the result lines.
if docker buildx version >/dev/null 2>&1; then
  docker buildx build \
    --platform linux/amd64 \
    --tag "$tag" \
    --tag "fio-mcp:$version" \
    --load \
    . >&2
else
  echo "docker buildx is not available; building with docker build" >&2
  docker build \
    --platform linux/amd64 \
    --tag "$tag" \
    --tag "fio-mcp:$version" \
    . >&2
fi

id=$(docker image inspect --format '{{.Id}}' "$tag")
if ! printf '%s\n' "$id" | grep -Eqx 'sha256:[0-9a-f]{64}'; then
  echo "error: unexpected local image ID for $tag: '$id'" >&2
  exit 1
fi

if [ -n "$dry_run" ]; then
  echo "dry run: built $tag ($id); would ship it to $host and load it with '$remote_docker load'" >&2
  echo "tag=$tag"
  echo "image_id=$id"
  exit 0
fi

# Fail before streaming the image if ssh or the remote docker is unusable.
check=docker
preflight="$remote_docker version --format '{{.Server.Version}}'"
if ! remote "$preflight" >&2; then
  echo "error: cannot run $check on $host as '$remote_docker' over ssh; check the ssh host alias, the key, and passwordless sudo for docker" >&2
  exit 1
fi

# POSIX sh has no pipefail, so each stage records its own failure.
stage() {
  name=$1
  shift
  "$@" || echo "$name exited with status $?" >>"$tmp/failed"
}
echo "shipping $tag to $host" >&2
if [ -n "$compress" ]; then
  stage "docker save" docker save "$tag" |
    stage gzip gzip -c |
    stage ssh remote "$remote_docker load" >&2
else
  stage "docker save" docker save "$tag" |
    stage ssh remote "$remote_docker load" >&2
fi
if [ -s "$tmp/failed" ]; then
  echo "error: shipping $tag to $host failed:" >&2
  cat "$tmp/failed" >&2
  exit 1
fi

if ! remote_id=$(remote "$remote_docker image inspect --format '{{.Id}}' $tag"); then
  echo "error: cannot inspect $tag on $host" >&2
  exit 1
fi
if [ "$remote_id" != "$id" ]; then
  echo "error: $tag on $host has image ID '$remote_id', but the local image is $id" >&2
  echo "(the IDs also differ when one daemon uses the containerd image store and the other the classic one)" >&2
  exit 1
fi

echo "shipped $tag to $host" >&2
echo "tag=$tag"
echo "image_id=$id"
