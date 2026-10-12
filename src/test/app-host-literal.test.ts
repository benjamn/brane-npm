import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The app carries no host of its own. "Isolated" is `location.host` against
// the connection's host; where a daemon's bundle hops out to is what the
// daemon reports (`app_domain` in GET /api/status); `brane meld` reads the
// same config. So any brane host spelled out in the app or in `src/shared/`
// is a dependency creeping back in, and this is what keeps it out. A literal
// in a comment is an example, not a dependency, so comments are stripped
// before the scan. The one legitimate literal is the absolute `og:image`
// URL in the HTML template, which docs/link-previews.md explains.
//
// This reads *source*, which the npm tarball does not carry, so it skips when
// the source is absent rather than failing `brane doctor` on every install.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN = ["src/shared", "expo/app", "expo/lib", "expo/components"];
const ALLOWED = new Set(["expo/app/+html.tsx"]);
const HOST = /\borganelle\.dev\b/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("the app names no brane host", () => {
  it("has no organelle.dev literal in src/shared or the app, outside comments and the og:image tag", (t) => {
    if (!SCAN.every((d) => existsSync(join(root, d)))) return t.skip("source is not present (an installed package)");
    const offenders: string[] = [];
    for (const dir of SCAN) {
      for (const file of files(join(root, dir))) {
        const rel = relative(root, file);
        if (ALLOWED.has(rel)) continue;
        const code = withoutComments(readFileSync(file, "utf-8"));
        code.split("\n").forEach((line, i) => {
          if (HOST.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    assert.deepEqual(offenders, [], "a host literal outside a comment:\n" + offenders.join("\n"));
  });
});
