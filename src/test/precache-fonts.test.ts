import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The service worker's KaTeX split, held to the stylesheet it serves.
//
// gen-precache.mjs precaches the faces of the two families nearly every
// equation uses and leaves the rest to sw.js's on-demand VENDOR_CACHE. Its own
// build-time guard catches a *kept* face disappearing. This catches the other
// direction: a KaTeX upgrade that adds a face to a kept family, which would
// silently land in the tail and render in fallback glyphs offline.
//
// Reads source, which the npm tarball doesn't ship, so an installed package
// skips rather than failing (`brane doctor` runs this suite).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = join(repoRoot, "expo", "public", "katex", "katex.min.css");
const GEN = join(repoRoot, "expo", "scripts", "gen-precache.mjs");
const SW = join(repoRoot, "expo", "public", "sw.js");
const skip = [CSS, GEN, SW].some((p) => !existsSync(p)) ? "expo source not shipped" : false;

/** family → the woff2 files its @font-face rules name. */
function faces(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const css = readFileSync(CSS, "utf8");
  // KaTeX writes some family names quoted (`font-family:"KaTeX_SansSerif"`);
  // an unquoted-only pattern skipped those rules, and a face added to a kept
  // family under a quoted name would have made "kept whole" pass vacuously.
  for (const m of css.matchAll(/@font-face\{[^}]*?font-family:"?([\w-]+)"?;[^}]*?url\(fonts\/([\w-]+\.woff2)\)/g)) {
    out.set(m[1], [...(out.get(m[1]) ?? []), m[2]]);
  }
  const rules = (css.match(/@font-face\{/g) ?? []).length;
  const parsed = [...out.values()].reduce((n, fs) => n + fs.length, 0);
  assert.equal(parsed, rules, "every @font-face rule was parsed — none skipped by the pattern");
  return out;
}

function shellFonts(): string[] {
  const block = /const SHELL_FONTS = \[([\s\S]*?)\];/.exec(readFileSync(GEN, "utf8"));
  assert.ok(block, "gen-precache.mjs declares SHELL_FONTS");
  return [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("the KaTeX precache split", () => {
  it("every kept face is one the stylesheet uses", { skip }, () => {
    const all = new Set([...faces().values()].flat());
    assert.ok(all.size > 0, "parsed the stylesheet's @font-face rules");
    for (const f of shellFonts()) assert.ok(all.has(f), `${f} is not in katex.min.css`);
  });

  it("a kept family is kept whole", { skip }, () => {
    const kept = new Set(shellFonts());
    const byFamily = faces();
    const families = new Set([...byFamily].filter(([, fs]) => fs.some((f) => kept.has(f))).map(([fam]) => fam));
    assert.deepEqual([...families].sort(), ["KaTeX_Main", "KaTeX_Math"]);
    for (const fam of families) {
      for (const f of byFamily.get(fam)!) assert.ok(kept.has(f), `${f} (${fam}) would fall to the on-demand tail`);
    }
  });

  it("an HTML answer to a static request is never cached", { skip }, () => {
    // The servers answer an unknown path with the SPA shell and a 200; kept
    // under a font's URL in VENDOR_CACHE, that would outlive every build.
    const sw = readFileSync(SW, "utf8");
    assert.match(sw, /response\.ok && !isShellFallback\(response\)/);
    assert.match(sw, /function isShellFallback[\s\S]*?text\/html/);
  });

  it("the on-demand tail lives in a cache activate keeps", { skip }, () => {
    const sw = readFileSync(SW, "utf8");
    assert.match(sw, /__BRANE_VENDOR_CACHE__/, "the generator fills VENDOR_CACHE");
    assert.match(sw, /k !== CACHE_NAME && k !== VENDOR_CACHE/, "activate spares the vendor cache");
    assert.match(sw, /isVendor\(url\.pathname\) \? VENDOR_CACHE : CACHE_NAME/, "on-demand vendored files are stored there");
  });
});
