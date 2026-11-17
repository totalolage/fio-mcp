# mcps

A Bun workspace of [MCP](https://modelcontextprotocol.io) servers written with [Effect](https://effect.website), and the core they share.

| Path | Package | What it is |
|---|---|---|
| [`servers/fio`](servers/fio) | `fio-mcp` | MCP server for FIO Bank's REST API. Setup, configuration, deployment and its development notes: [servers/fio/README.md](servers/fio/README.md). |
| [`packages/core`](packages/core) | `@mcps/core` (private) | Server-neutral parts: stdio and HTTP transports, OAuth, the admin shell and grant handling. Servers inject their own resources, scopes and pages. It must not import a server; the `core-import-boundary` lint rule enforces that. |

The root holds what every workspace shares: `package.json` (workspaces, scripts, dev tools), one `bun.lock`, `bunfig.toml` (install policy), `tsconfig.base.json`, `vitest.config.ts`, `biome.json` with the Grit rules in `lint/`, and `scripts/ship-image.sh`.

## Development

Requires Node.js 22.13 or newer and [Bun](https://bun.com) 1.4.2. Clone the repository and run everything from its root:

```sh
git clone https://github.com/totalolage/mcps.git && cd mcps
bun install              # installs all workspaces, patches TypeScript for Effect diagnostics, builds dist/
bun run build            # tsc -b: packages/core, then servers/fio
bun run typecheck        # tsc with Effect diagnostics
bun run lint             # Biome and the Grit rules in lint/
bun run test             # vitest over every workspace's test/
bun run check            # typecheck, lint and test
bun run generate:check   # the generated FIO client matches openapi/
bun run test:scripts     # tests scripts/ship-image.sh (stand-in docker and ssh) and the core boundary lint rule
```

## Images and CI

Each server has its own Dockerfile and builds from the repository root, e.g. `docker build -f servers/fio/Dockerfile .`. `bun run ship:image` builds the fio-mcp image and streams it to a docker host over ssh; no registry is involved (see [Shipping the image](servers/fio/README.md#shipping-the-image-to-your-server)). The script only ships fio-mcp for now; another server needs it to take the server as an argument, or a script of its own.

[CI](.github/workflows/ci.yml) runs the checks on pull requests and pushes to `main`. Each server has a job that runs when its own directory changes, and every job runs when `packages/core` or the shared root tooling changes. CI never builds or ships an image.
