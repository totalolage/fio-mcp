/**
 * Core stays app-neutral: nothing under packages/core imports from outside
 * the package or names a specific server. A server builds on core, never
 * the other way round.
 *
 * Scans packages/core/src, packages/core/test and packages/core/package.json
 * for import specifiers that leave the package (relative paths escaping it,
 * absolute paths, any other workspace package, anything under servers/) and
 * for the first server's name in any spelling (its env prefix, scopes, table
 * names). Workspace packages are read from the root manifest's `workspaces`
 * globs, so a new server is covered without editing this file. The name is
 * assembled below so this file does not contain it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CORE_ROOT, "..", "..");
const CORE_PACKAGE = "@mcps/core";
const SCANNED_DIRS = ["src", "test"];
const SCANNED_FILES = ["package.json"];

const APP_NAME = ["f", "i", "o"].join("");
/** The app's name anywhere: `<name>-mcp`, `<NAME>_`, `<name>:read`, `<name>_mcp_migrations`, prose. */
const APP_TOKEN = new RegExp(APP_NAME, "i");

/** Import/export/require/dynamic-import specifiers, one per match; may span lines. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]sx?|json)$/.test(entry) ? [path] : [];
  });

const readManifest = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/** Names of every workspace package except core, from the root manifest's `workspaces` globs (`dir/*` or `dir`). */
function otherWorkspacePackages(): ReadonlySet<string> {
  const globs = (readManifest(join(REPO_ROOT, "package.json")).workspaces ?? []) as ReadonlyArray<string>;
  const dirs = globs.flatMap((glob) => {
    if (!glob.endsWith("/*")) return [join(REPO_ROOT, glob)];
    const parent = join(REPO_ROOT, glob.slice(0, -2));
    return readdirSync(parent).map((entry) => join(parent, entry));
  });
  const names = dirs.flatMap((dir) => {
    const manifest = join(dir, "package.json");
    if (!statSync(dir).isDirectory() || !existsSync(manifest)) return [];
    const name = readManifest(manifest).name;
    return typeof name === "string" && name !== CORE_PACKAGE ? [name] : [];
  });
  return new Set(names);
}

const WORKSPACE_PACKAGES = otherWorkspacePackages();

/** The package a bare specifier names: `@scope/name` or `name`. */
const packageOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

const insideCore = (path: string) => path === CORE_ROOT || path.startsWith(`${CORE_ROOT}${sep}`);

/** Why `specifier` (imported by `file`) leaves core, or undefined when it stays inside. */
export function foreignSpecifier(
  file: string,
  specifier: string,
  workspacePackages: ReadonlySet<string> = WORKSPACE_PACKAGES,
): string | undefined {
  if (specifier.startsWith(".")) {
    return insideCore(resolve(dirname(file), specifier)) ? undefined : "relative import outside packages/core";
  }
  if (specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier)) return "absolute import path";
  if (/(^|[\\/])servers[\\/]/.test(specifier)) return "import from servers/";
  if (workspacePackages.has(packageOf(specifier))) return "import from another workspace package";
  if (specifier.startsWith("@mcps/") && packageOf(specifier) !== CORE_PACKAGE) return "import from another workspace package";
  if (APP_TOKEN.test(specifier)) return "import naming an app";
  return undefined;
}

/** Every offence in `text` (the contents of `file`), as `path:line: reason`, in line order. */
export function offences(
  file: string,
  text: string,
  workspacePackages: ReadonlySet<string> = WORKSPACE_PACKAGES,
): ReadonlyArray<string> {
  const where = relative(CORE_ROOT, file);
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length;
  const found: Array<readonly [number, string]> = [];
  text.split("\n").forEach((line, index) => {
    if (APP_TOKEN.test(line)) found.push([index + 1, `names an app: ${line.trim().slice(0, 120)}`]);
  });
  // Over the whole text, so a specifier on the line after `from` or `import(` is still seen.
  for (const match of text.matchAll(SPECIFIER)) {
    const reason = foreignSpecifier(file, match[1] ?? "", workspacePackages);
    if (reason !== undefined) found.push([lineAt(match.index + match[0].length), `${reason}: ${match[1]}`]);
  }
  return found.sort(([a], [b]) => a - b).map(([line, what]) => `${where}:${line}: ${what}`);
}

/** Dependency specs in package.json that point outside the package (file:/link:/portal:/workspace:, workspace packages). */
function foreignDependencies(manifest: string): ReadonlyArray<string> {
  const parsed = readManifest(manifest);
  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  return fields.flatMap((field) =>
    Object.entries((parsed[field] ?? {}) as Record<string, string>).flatMap(([name, spec]) =>
      (name.startsWith("@mcps/") && name !== CORE_PACKAGE) ||
      WORKSPACE_PACKAGES.has(name) ||
      /^(file|link|portal|workspace):/.test(spec) ||
      APP_TOKEN.test(name)
        ? [`package.json: ${field}.${name} (${spec}) is outside core`]
        : [],
    ),
  );
}

describe("core boundary", () => {
  it("imports nothing from outside packages/core and names no app", () => {
    const files = [
      ...SCANNED_DIRS.flatMap((dir) => sourceFiles(join(CORE_ROOT, dir))),
      ...SCANNED_FILES.map((file) => join(CORE_ROOT, file)),
    ];
    assert.isAbove(files.length, 10, "the scan found the core sources");
    assert.isAbove(WORKSPACE_PACKAGES.size, 0, "the scan found the other workspace packages");
    const found = [
      ...files.flatMap((file) => offences(file, readFileSync(file, "utf8"))),
      ...foreignDependencies(join(CORE_ROOT, "package.json")),
    ];
    assert.deepStrictEqual(found, []);
  });

  it("recognizes each kind of offence", () => {
    const file = join(CORE_ROOT, "src", "transport", "example.ts");
    const name = APP_NAME;
    // Spelled through variables so the scan of this file does not match them.
    const from = "from";
    const load = "import";
    assert.deepStrictEqual(
      [
        `import { a } ${from} "../../../../servers/${name}/src/accounts.js";`,
        `import { a } ${from} "../../../other/x.js";`,
        `import { a } ${from} "${name}-mcp/accounts.js";`,
        `export * ${from} "@mcps/${name}";`,
        `const m = await ${load}("/abs/path.js");`,
        `const env = "${name.toUpperCase()}_MCP_PORT";`,
        `const scope = "${name}:read";`,
      ].map((line) => offences(file, line).length),
      [2, 1, 2, 2, 1, 1, 1],
    );
    assert.deepStrictEqual(
      offences(file, `import { a } ${from} "../resources.js";\nimport { Effect } ${from} "effect";\nimport { b } ${from} "@mcps/core/x.js";`),
      [],
    );
  });

  it("sees specifiers on the line after `from` or `import(`", () => {
    const file = join(CORE_ROOT, "src", "transport", "example.ts");
    const from = "from";
    const load = "import";
    assert.deepStrictEqual(offences(file, `import {\n  a,\n} ${from}\n  "../../../other/x.js";`), [
      "src/transport/example.ts:4: relative import outside packages/core: ../../../other/x.js",
    ]);
    assert.deepStrictEqual(offences(file, `const m = await ${load}(\n  "../../../other/y.js"\n);`), [
      "src/transport/example.ts:2: relative import outside packages/core: ../../../other/y.js",
    ]);
  });

  it("treats every other workspace package as foreign, scoped or not", () => {
    const file = join(CORE_ROOT, "src", "transport", "example.ts");
    const from = "from";
    const workspace = new Set(["box-server", "@acme/box-server"]);
    assert.deepStrictEqual(
      [
        `import { a } ${from} "box-server/dist/app.js";`,
        `import { a } ${from} "@acme/box-server";`,
        `import { a } ${from} "box-server-utils";`,
        `import { a } ${from} "@mcps/core/resources.js";`,
      ].map((line) => offences(file, line, workspace).length),
      [1, 1, 0, 0],
    );
  });
});
