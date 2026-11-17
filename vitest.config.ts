import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreSource = fileURLToPath(new URL("./packages/core/src/", import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against workspace sources, so they never need a prior build.
    alias: [{ find: /^@mcps\/core\/(.*)\.js$/, replacement: `${coreSource}$1.ts` }],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "servers/*/test/**/*.test.ts"],
    environment: "node",
  },
});
