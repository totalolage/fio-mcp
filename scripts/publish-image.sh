#!/bin/sh
# Builds the linux/amd64 image from a clean checkout, pushes it as
# <image>:<package.json version> and <image>:<short git sha>, and prints the
# pushed digest for pinning in Compose.
#
# Usage: npm run publish:image -- [--dry-run] ghcr.io/<owner>/fio-mcp
#    or: FIO_MCP_IMAGE=ghcr.io/<owner>/fio-mcp npm run publish:image
# Log in first: docker login ghcr.io (a token with write:packages).
#
# DOCKER replaces the docker command, e.g. DOCKER="sudo -n docker".
# Builds with docker buildx when it is installed, otherwise with docker build.
# --dry-run (or DRY_RUN=1) builds and tags the image locally and pushes nothing.
set -eu

dry_run=
case ${DRY_RUN:-} in
  '' | 0) ;;
  *) dry_run=1 ;;
esac
image=
for arg; do
  case $arg in
    --dry-run) dry_run=1 ;;
    -*)
      echo "error: unknown option '$arg'" >&2
      exit 2
      ;;
    *)
      if [ -n "$image" ]; then
        echo "error: more than one image given" >&2
        exit 2
      fi
      image=$arg
      ;;
  esac
done
image=${image:-${FIO_MCP_IMAGE:-}}
if [ -z "$image" ]; then
  echo "error: no image given; pass it as an argument or set FIO_MCP_IMAGE (e.g. ghcr.io/<owner>/fio-mcp)" >&2
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

docker() {
  # shellcheck disable=SC2086 # split on purpose: DOCKER may be a prefix such as "sudo -n docker"
  command ${DOCKER:-docker} "$@"
}

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "error: the working tree has uncommitted or untracked files; commit or remove them first" >&2
  git status --short --untracked-files=all >&2
  exit 1
fi

if docker buildx version >/dev/null 2>&1; then
  buildx=1
else
  buildx=
fi

version=$(node -p "require('./package.json').version")
sha=$(git rev-parse --short HEAD)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "$buildx" ]; then
  if [ -n "$dry_run" ]; then output=--load; else output=--push; fi
  docker buildx build \
    --platform linux/amd64 \
    --tag "$image:$version" \
    --tag "$image:$sha" \
    --metadata-file "$tmp/metadata.json" \
    "$output" \
    .
else
  echo "docker buildx is not available; building with docker build" >&2
  docker build \
    --platform linux/amd64 \
    --tag "$image:$version" \
    --tag "$image:$sha" \
    .
fi

if [ -n "$dry_run" ]; then
  id=$(docker image inspect --format '{{.Id}}' "$image:$version")
  echo "dry run: built $id as $image:$version and $image:$sha; pushed nothing"
  echo "would push $image:$version and $image:$sha"
  exit 0
fi

if [ -n "$buildx" ]; then
  digest=$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))['containerimage.digest']" "$tmp/metadata.json")
else
  # The digest each push reports is the manifest the registry now serves for
  # that tag. RepoDigests is only a fallback: it can also hold digests from
  # earlier pushes, so it must name exactly one digest in this repository.
  digest=
  for tag in "$version" "$sha"; do
    if ! docker push "$image:$tag" >"$tmp/push.log" 2>&1; then
      cat "$tmp/push.log" >&2
      exit 1
    fi
    cat "$tmp/push.log"
    pushed=$(sed -n 's/^.*: digest: \(sha256:[0-9a-f]\{64\}\) size: [0-9]*$/\1/p' "$tmp/push.log" | tail -n 1)
    if [ -z "$pushed" ]; then
      pushed=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image:$tag" |
        while IFS= read -r ref; do
          case $ref in "$image@sha256:"*) echo "${ref#*@}" ;; esac
        done)
      if [ "${#pushed}" -ne 71 ] || ! printf '%s\n' "$pushed" | grep -Eqx 'sha256:[0-9a-f]{64}'; then
        echo "error: cannot tell which digest $image:$tag was pushed as; found: ${pushed:-none}" >&2
        exit 1
      fi
    fi
    if [ -n "$digest" ] && [ "$pushed" != "$digest" ]; then
      echo "error: $image:$version pushed as $digest but $image:$tag as $pushed" >&2
      exit 1
    fi
    digest=$pushed
  done
fi
echo "pushed $image:$version and $image:$sha"
echo "$image@$digest"
