# fio-mcp: MCP server for FIO Bank, Streamable HTTP on port 3000 by default.
# Build: docker build --platform linux/amd64 -t fio-mcp .
# HTTP mode requires FIO_MCP_PUBLIC_URL (the https origin clients use) and
# FIO_MCP_ADMIN_PASSWORD_HASH_FILE (from `docker run --rm -it <image> hash-password`);
# it refuses to start without them unless FIO_MCP_ALLOW_UNAUTHENTICATED=true.
# The base images are pinned by digest; bump NODE_IMAGE and BUN_IMAGE
# deliberately. Bun only installs dependencies and builds; the server runs on
# Node and the final image has no Bun.

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG BUN_IMAGE=oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE} AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Patches TypeScript with the Effect language service, then builds dist/.
RUN bun run prepare

FROM ${NODE_IMAGE} AS deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    FIO_MCP_TRANSPORT=http \
    FIO_DB_PATH=/data/fio.sqlite
WORKDIR /app
RUN mkdir /data \
 && chmod 1777 /data
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Runs as any UID (Compose `user:`); nothing is written outside /data, so the
# root filesystem can be read-only.
USER node
VOLUME /data
EXPOSE 3000
# Probes the configured bind address (loopback for the wildcard ones).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const h = (process.env.FIO_MCP_HOST || '').trim() || '0.0.0.0'; const host = h === '0.0.0.0' ? '127.0.0.1' : h === '::' ? '[::1]' : h.includes(':') ? `[${h}]` : h; fetch(`http://${host}:${(process.env.FIO_MCP_PORT || '').trim() || 3000}/healthz`, { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# `docker run <image>` serves; `docker run <image> backup /data/backup.sqlite`
# (or `docker exec <container> node dist/main.js backup ...`) runs a backup.
# OAuth admin: `docker exec <container> node dist/main.js clients list`,
# `... clients revoke <id>`, `... tokens revoke-all`.
ENTRYPOINT ["node", "/app/dist/main.js"]
