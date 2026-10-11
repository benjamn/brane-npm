import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// With `output: "single"`, expo/public/index.html is the HTML that ships and
// the runtime <Head> in app/_layout.tsx lands only after the bundle executes.
// When the two disagreed about the viewport, a link opened on iOS was laid out
// twice, mid-load, and could stick with the header behind the address bar
// until a reload. The other half of that bug was #root: `height: 100%` plus
// safe-area padding under `content-box` made it taller than the page, which
// gave <body> something to scroll. Neither is visible on a desktop browser or
// with zero insets, so the source is what gets checked.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
// Source the tarball doesn't ship; skip from an install (`brane doctor`).
const sourceMissing = !existsSync(join(repoRoot, "expo", "public", "index.html"));
const skip = sourceMissing ? "expo source not shipped" : false;

const viewportOf = (src: string, file: string) => {
  const m = src.match(/<meta\s+name="viewport"\s+content="([^"]+)"/);
  assert.ok(m, `${file} should declare a viewport`);
  return m[1];
};

// Every `#root { … }` block that sets safe-area padding must also be border-box.
const paddedRootRules = (src: string) =>
  [...src.matchAll(/#root\s*\{([^}]*)\}/g)].map((m) => m[1]).filter((body) => body.includes("safe-area-inset"));

describe("the first paint is laid out under the viewport the app keeps", () => {
  test("public/index.html and the runtime <Head> declare the same viewport", { skip }, () => {
    const served = viewportOf(read("expo/public/index.html"), "public/index.html");
    const runtime = viewportOf(read("expo/app/_layout.tsx"), "app/_layout.tsx");
    assert.equal(served, runtime);
    assert.match(served, /viewport-fit=cover/);
  });

  for (const file of ["expo/public/index.html", "expo/app/_layout.tsx"]) {
    test(`${file}: a safe-area-padded #root is border-box`, { skip }, () => {
      const rules = paddedRootRules(read(file));
      assert.ok(rules.length > 0, `${file} should pad #root by the safe-area insets`);
      for (const body of rules) assert.match(body, /box-sizing:\s*border-box/);
    });
  }
});

// #root's height is the visible area (expo/lib/noPan.ts sets --brane-vvh), so
// a bottom bar rides the keyboard. The runtime <Head> copy lands after the
// served one and wins, so a copy still saying `height: 100%` silently undid it
// (claude-3j4583pl:149).
describe("#root height follows the visible area", () => {
  for (const file of ["expo/public/index.html", "expo/app/_layout.tsx"]) {
    test(`${file}: every #root height is var(--brane-vvh, …)`, { skip }, () => {
      const heights = [...read(file).matchAll(/#root\s*\{([^}]*)\}/g)]
        .map((m) => /(?:^|;|\s)height:\s*([^;]+)/.exec(m[1])?.[1]?.trim())
        .filter((h): h is string => !!h);
      const own = file.endsWith("_layout.tsx") ? heights : heights.slice(1); // index.html's first block is Expo's reset
      assert.ok(own.length > 0, `${file} should size #root`);
      for (const h of own) assert.match(h, /^var\(--brane-vvh/, `${file}: #root height is ${h}`);
    });
  }
});
