#!/bin/sh
# Builds a server's linux/amd64 image from a clean checkout, tags it
# <name>:<version>-<short git sha> and <name>:<version>, where name and
# version come from servers/<server>/package.json (fio: fio-mcp), and
# streams it to a docker host over ssh (docker save | gzip | ssh ... docker
# load). No registry is involved. Before shipping (and in a dry run) it
# checks that the image has no redis packages and that its compiled modules
# other than main.js load. Afterwards it checks that the remote image ID
# matches the local one.
#
# Usage: bun run ship:image -- [--server <server>] [--dry-run] [--no-compress]
#
# --server picks the directory under servers/ to build from its Dockerfile
# (default: fio), e.g. --server datova-schranka.
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
server=fio
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry_run=1 ;;
    --no-compress) compress= ;;
    --server)
      if [ $# -lt 2 ]; then
        echo "error: --server needs a server name" >&2
        exit 2
      fi
      server=$2
      shift
      ;;
    --server=*) server=${1#--server=} ;;
    *)
      echo "error: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
  shift
done
case $server in
  '' | [!a-z0-9]* | *[!a-z0-9-]*)
    echo "error: server '$server' is not a directory name under servers/" >&2
    exit 2
    ;;
esac

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

# The server's workspace manifest names the image and carries the version;
# the root package.json is the private workspace root.
manifest=servers/$server/package.json
if [ ! -f "$manifest" ]; then
  echo "error: no server '$server': $manifest does not exist" >&2
  exit 2
fi
# A missing field prints as '' instead of 'undefined', so the checks below
# reject it.
image=$(node -p "require('./$manifest').name ?? ''")
version=$(node -p "require('./$manifest').version ?? ''")
sha=$(git rev-parse --short HEAD)
case $image in
  '' | [!a-z0-9]* | *[!a-z0-9] | *[!a-z0-9._-]* | *[._-][._]*)
    echo "error: $manifest name '$image' is not usable as a docker image name" >&2
    exit 2
    ;;
esac
case $version in
  '' | [!0-9A-Za-z]* | *[!0-9A-Za-z._-]*)
    echo "error: $manifest version '$version' is not usable in a docker tag" >&2
    exit 2
    ;;
esac
tag=$image:$version-$sha

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
    --file "servers/$server/Dockerfile" \
    --tag "$tag" \
    --tag "$image:$version" \
    --load \
    . >&2
else
  echo "docker buildx is not available; building with docker build" >&2
  docker build \
    --platform linux/amd64 \
    --file "servers/$server/Dockerfile" \
    --tag "$tag" \
    --tag "$image:$version" \
    . >&2
fi

id=$(docker image inspect --format '{{.Id}}' "$tag")
if ! printf '%s\n' "$id" | grep -Eqx 'sha256:[0-9a-f]{64}'; then
  echo "error: unexpected local image ID for $tag: '$id'" >&2
  exit 1
fi

# The unused redis peer of @effect/platform-node must not reach the image
# (the Dockerfile's deps stage installs with --omit=peer).
if ! docker run --rm --network none --entrypoint sh "$tag" \
  -c 'test ! -e /app/node_modules/redis && test ! -e /app/node_modules/@redis' >&2; then
  echo "error: $tag contains node_modules/redis or node_modules/@redis" >&2
  exit 1
fi
# Every compiled module except the entrypoint, in the server's dist and in
# the core workspace's, must still resolve without the omitted peers.
# main.js is left out because importing it starts the server.
if ! docker run --rm --network none --entrypoint node "$tag" --input-type=module \
  -e 'for (const d of ["/app/dist", "/app/packages/core/dist"]) for (const f of (await import("node:fs")).readdirSync(d, { recursive: true })) if (f.endsWith(".js") && !(d === "/app/dist" && f === "main.js")) await import(`${d}/${f}`);' >&2; then
  echo "error: $tag cannot load its modules; a dependency is missing from node_modules" >&2
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
