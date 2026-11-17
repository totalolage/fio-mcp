# datova-schranka: MCP server for Czech data boxes (ISDS), Streamable HTTP
# with OAuth on port 3000 by default. No stdio, no unauthenticated mode.
# Build from the repository root (the build context is the Bun workspace):
#   docker build --platform linux/amd64 -f servers/datova-schranka/Dockerfile -t datova-schranka .
# It requires DATOVA_SCHRANKA_PUBLIC_URL (the https origin clients use),
# DATOVA_SCHRANKA_ADMIN_PASSWORD_HASH_FILE (from `docker run --rm -it <image>
# hash-password`) and DATOVA_SCHRANKA_DATA_KEY_FILE (32 random bytes, see the
# README). The base images are pinned by digest; bump NODE_IMAGE and BUN_IMAGE
# deliberately, together with servers/fio/Dockerfile. Bun only installs
# dependencies and builds; the server runs on Node and the final image has no
# Bun.
# Each install stage copies the root workspace files and the manifests of the
# workspaces this image needs (datova-schranka and @mcps/core) at their
# repository paths, then installs with --filter datova-schranka: that
# workspace and the workspaces it depends on, but no other server's
# dependencies.

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG BUN_IMAGE=oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE} AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json ./packages/core/
COPY servers/datova-schranka/package.json ./servers/datova-schranka/
# --filter datova-schranka alone leaves out the root dev tools (TypeScript,
# the Effect language service) that the build needs; --filter ./ adds the
# root package.
RUN bun install --frozen-lockfile --ignore-scripts --filter datova-schranka --filter ./
COPY tsconfig.base.json ./
COPY packages/core/tsconfig.build.json ./packages/core/
COPY packages/core/src ./packages/core/src
COPY servers/datova-schranka/tsconfig.build.json ./servers/datova-schranka/
COPY servers/datova-schranka/src ./servers/datova-schranka/src
# Patches TypeScript with the Effect language service, as the root `prepare`
# does, then builds packages/core/dist/ and servers/datova-schranka/dist/.
# The root `build` script builds only Fio, so the workspace's own build runs.
RUN node_modules/.bin/effect-tsgo patch --typescript --no-oxlint \
 && bun run --cwd servers/datova-schranka build

FROM ${NODE_IMAGE} AS deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json ./packages/core/
COPY servers/datova-schranka/package.json ./servers/datova-schranka/
# --omit=peer keeps out redis and @redis/*, the peer of @effect/platform-node
# that only its NodeRedis module loads. The source imports platform-node
# subpaths, never the index that re-exports NodeRedis (biome.json enforces
# it). The peers the server needs (effect) are direct dependencies.
# --filter links the server's own workspace package as
# node_modules/datova-schranka; nothing imports it, so it is removed.
RUN bun install --frozen-lockfile --production --omit=peer --ignore-scripts --filter datova-schranka \
 && rm node_modules/datova-schranka

FROM ${NODE_IMAGE}
# DATA_DIR holds the signed ZFO files of downloaded messages.
ENV NODE_ENV=production \
    DATOVA_SCHRANKA_DB_PATH=/data/datova-schranka.sqlite \
    DATOVA_SCHRANKA_DATA_DIR=/data/zfo
WORKDIR /app
RUN mkdir /data \
 && chmod 1777 /data
COPY package.json ./
COPY packages/core/package.json ./packages/core/
COPY servers/datova-schranka/package.json ./servers/datova-schranka/
# Hoisted install: node_modules/@mcps/core links to ../../packages/core.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/servers/datova-schranka/dist ./servers/datova-schranka/dist
# Keeps /app/dist/main.js (the entrypoint, and `node dist/main.js` in
# `docker exec`) working. Node resolves imports from the link's target.
RUN ln -s servers/datova-schranka/dist dist
# Runs as any UID (Compose `user:`); nothing is written outside /data, so the
# root filesystem can be read-only.
USER node
VOLUME /data
EXPOSE 3000
# Probes the configured bind address (loopback for the wildcard ones).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const h = (process.env.DATOVA_SCHRANKA_HOST || '').trim() || '0.0.0.0'; const host = h === '0.0.0.0' ? '127.0.0.1' : h === '::' ? '[::1]' : h.includes(':') ? `[${h}]` : h; fetch(`http://${host}:${(process.env.DATOVA_SCHRANKA_PORT || '').trim() || 3000}/healthz`, { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# `docker run <image>` serves; `docker run <image> backup /data/backup.sqlite`
# (or `docker exec <container> node dist/main.js backup ...`) runs a backup of
# the database (not the ZFO files). Other admin commands: `hash-password`,
# `totp-init`, `clients list|revoke <id>`, `tokens revoke-all`,
# `reset-admin-password`, `audit purge --before YYYY-MM-DD`.
ENTRYPOINT ["node", "/app/dist/main.js"]
