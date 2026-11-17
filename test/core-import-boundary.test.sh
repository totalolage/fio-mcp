#!/bin/sh
# Tests lint/core-import-boundary.grit: Biome runs with this repository's
# biome.json and lint/ rules over fixture files in a throwaway repository.
# Every import marked `// bad` must get the boundary diagnostic and nothing
# else may. A plugin that fails to load (or silently disables itself)
# reports nothing, so it fails here too.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
biome=$root/node_modules/.bin/biome
[ -x "$biome" ] || { echo "error: $biome is missing; run bun install" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$root/biome.json" "$work/"
cp -R "$root/lint" "$work/lint"
git -C "$work" init -q

fixture() {
  mkdir -p "$work/$(dirname "$1")"
  cat >"$work/$1"
}

# Depth 0: the package root itself.
fixture packages/core/root.ts <<'EOF'
import "../servers-x/a.js"; // bad
import "./src/a.js"; // ok
EOF

# Depth 1.
fixture packages/core/src/a.ts <<'EOF'
import "fio-mcp"; // bad
import "fio-mcp/dist/main.js"; // bad
import "../../servers/fio/src/main.js"; // bad
import "../../vitest.config.js"; // bad
export * from "../../package.json"; // bad
export const lazy = () => import("fio-mcp/x.js"); // bad
export const old = () => require("fio-mcp"); // bad
import "../package.json"; // ok
import "./b.js"; // ok
import "effect/Effect"; // ok
import "@mcps/core/transport/http.js"; // ok
EOF

fixture packages/core/test/a.test.ts <<'EOF'
import "../src/a.js"; // ok
import "../../../servers/fio/src/main.js"; // bad
import "../../package.json"; // bad
EOF

# Depth 2.
fixture packages/core/src/a/b.ts <<'EOF'
import "../../package.json"; // ok
import "../../../package.json"; // bad
EOF

# Depth 7: src plus six directories.
fixture packages/core/src/1/2/3/4/5/6/x.ts <<'EOF'
import "../../../../../../../package.json"; // ok
import "../../../../../../../../package.json"; // bad
EOF

# Depth 11, the deepest exact branch.
fixture packages/core/src/1/2/3/4/5/6/7/8/9/10/x.ts <<'EOF'
import "../../../../../../../../../../../package.json"; // ok
import "../../../../../../../../../../../../package.json"; // bad
EOF

# Depth 12 and deeper: climbing 13 or more levels is always rejected.
fixture packages/core/src/1/2/3/4/5/6/7/8/9/10/11/x.ts <<'EOF'
import "../../../../../../../../../../../../package.json"; // ok
import "../../../../../../../../../../../../../package.json"; // bad
import "fio-mcp"; // bad
EOF

# Servers may import anything, including core through relative paths.
fixture servers/fio/src/s.ts <<'EOF'
import "fio-mcp"; // ok
import "../../../packages/core/src/a.js"; // ok
EOF

(cd "$work" && "$biome" lint --max-diagnostics=1000 packages servers >"$work/lint.out" 2>&1) || :

# Diagnostic headers look like `path:line:col plugin ━━━`; the message follows.
awk '
  /^[^ ]+\.ts:[0-9]+:[0-9]+ plugin/ { split($1, at, ":"); loc = at[1] ":" at[2]; next }
  /server-neutral/ && loc != "" { print loc; loc = "" }
' "$work/lint.out" | sort -u >"$work/actual"
(cd "$work" && grep -rn --include='*.ts' '// bad$' packages servers | cut -d: -f1,2 | sort -u) >"$work/expected"

if ! [ -s "$work/expected" ] || ! cmp -s "$work/expected" "$work/actual"; then
  echo "FAIL core-import-boundary: diagnostics differ from the // bad markers (< expected, > actual)" >&2
  diff "$work/expected" "$work/actual" >&2 || :
  grep -E 'errored|Failed|plugin' "$work/lint.out" | head -n 5 >&2 || :
  exit 1
fi
echo "core-import-boundary tests passed ($(wc -l <"$work/expected" | tr -d ' ') rejected imports)"
