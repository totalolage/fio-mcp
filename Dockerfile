# fio-mcp: MCP server for FIO Bank, Streamable HTTP on port 3000 by default.
# Build: docker build --platform linux/amd64 -t fio-mcp .
# The base image is pinned by digest; bump NODE_IMAGE deliberately.

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Patches TypeScript with the Effect language service, then builds dist/.
RUN npm run prepare

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    FIO_MCP_TRANSPORT=http \
    FIO_DB_PATH=/data/fio.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && rm -rf /root/.npm /tmp/* \
 && mkdir /data \
 && chmod 1777 /data
COPY --from=build /app/dist ./dist
# Runs as any UID (Compose `user:`); nothing is written outside /data, so the
# root filesystem can be read-only.
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.FIO_MCP_PORT || 3000}/healthz`, { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# `docker run <image>` serves; `docker run <image> backup /data/backup.sqlite`
# (or `docker exec <container> node dist/main.js backup ...`) runs a backup.
ENTRYPOINT ["node", "/app/dist/main.js"]
