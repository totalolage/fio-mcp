#!/bin/sh
# Builds the linux/amd64 image from a clean checkout, pushes it as
# <image>:<package.json version> and <image>:<short git sha>, and prints the
# pushed digest for pinning in Compose.
#
# Usage: npm run publish:image -- ghcr.io/<owner>/fio-mcp
#    or: FIO_MCP_IMAGE=ghcr.io/<owner>/fio-mcp npm run publish:image
# Log in first: docker login ghcr.io (a token with write:packages).
set -eu

image=${1:-${FIO_MCP_IMAGE:-}}
if [ -z "$image" ]; then
  echo "error: no image given; pass it as the first argument or set FIO_MCP_IMAGE (e.g. ghcr.io/<owner>/fio-mcp)" >&2
  exit 2
fi
case $image in
  *@* | *[!a-z0-9._/:-]*)
    echo "error: '$image' is not a repository reference (lowercase, no digest)" >&2
    exit 2
    ;;
esac
case ${image##*/} in
  *:*)
    echo "error: '$image' includes a tag; tags come from package.json and git" >&2
    exit 2
    ;;
esac

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "error: the working tree has uncommitted or untracked files; commit or remove them first" >&2
  git status --short --untracked-files=all >&2
  exit 1
fi

if ! docker buildx version >/dev/null 2>&1; then
  echo "error: docker buildx is not available" >&2
  exit 1
fi

version=$(node -p "require('./package.json').version")
sha=$(git rev-parse --short HEAD)
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT

docker buildx build \
  --platform linux/amd64 \
  --tag "$image:$version" \
  --tag "$image:$sha" \
  --metadata-file "$metadata" \
  --push \
  .

digest=$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))['containerimage.digest']" "$metadata")
echo "pushed $image:$version and $image:$sha"
echo "$image@$digest"
