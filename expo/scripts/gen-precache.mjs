// Fills in the service worker's precache list from the export that was
// actually produced, and runs after `expo export` for that reason.
//
// The list has to be generated rather than hand-written, because a
// hand-written one drifts silently and in exactly the direction that hurts:
// every asset you forget is one that loads fine at your desk and 404s at
// 35,000 feet. Deriving it from `dist/` makes the failure mode a build error
// instead of a dead app on a plane. (The `<link rel="manifest">` that lived
// only in a runtime `<Head>` is the same bug caught late; see public/index.html.)
//
// The cache name is a content hash of everything precached, so a new build
// always installs into a fresh cache and the old one is dropped on activate.
// Nobody has to remember to bump a version constant.
//
// What is deliberately NOT precached: pdf.min.mjs and pdf.worker.min.mjs, 1.7 MB
// between them for a viewer most sessions never open. They fall to the runtime
// cache-first branch instead, so they stick after the first PDF you open.
//
// KaTeX's font tail is excluded for the same reason and by the same mechanism —
// see SHELL_FONTS below.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");

/** Directories swept into the shell. Every file under one belongs there, with a
 *  single exception carved out below: KaTeX's font tail. */
const TREES = ["_expo", "katex", "assets"];
/** Individually-named root files. `index.html` is precached as "/" instead —
 *  that is the URL the SPA fallback asks the cache for. */
const FILES = ["favicon.svg", "manifest.json"];

/** The KaTeX faces that ride in the install shell. The other fourteen are still
 *  built and served, and cached the first time a page needs one — in sw.js's
 *  VENDOR_CACHE, which survives every build that doesn't change the vendored
 *  files (see VENDOR below). This constant only decides which are fetched
 *  *eagerly*, before the app is usable offline.
 *
 *  Why these two families: rendering every math-bearing event in one real
 *  archive (264 of them) through the export's own `katexStyleFor()` — the same
 *  stylesheet-derived family resolution the HTML export uses to decide what to
 *  inline — put KaTeX_Main in 100% of them and KaTeX_Math in 92.8%. The next
 *  family, KaTeX_AMS, appeared in 9.1%; Fraktur, Script and Typewriter in none.
 *  The order-of-magnitude gap between 92.8% and 9.1% is the whole argument: the
 *  first two are what math *is*, the rest is a tail, and a tail is exactly what
 *  the runtime cache-first branch is for.
 *
 *  Families, not individual faces, because that is the unit the export resolves
 *  at. Main-Bold and Main-BoldItalic (42 K of the 115 K kept here) may well be
 *  unused, but telling would take a font-weight/font-style cascade this build
 *  step has no business growing, and inventing a second, shakier resolver beside
 *  the one src/math.ts already ships is how the two come to disagree.
 *
 *  The cost, stated plainly because it is a real trade and not a free win: on a
 *  device that is offline from a cold install and has never yet loaded a page
 *  with math on it, an excluded face renders as fallback glyphs. That is the
 *  35,000-feet failure this whole file exists to prevent, so it is worth being
 *  exact about what it looks like — the miss is per glyph, not per document. An
 *  equation still lays out correctly in Main and Math; what degrades is the one
 *  oversized delimiter or the one AMS symbol. Excluding all twenty would be the
 *  pile of overlapping glyphs, which is why this set is not empty.
 *
 *  The second win is not bytes. `cache.addAll` is atomic, so every precached URL
 *  is another chance for the whole install to fail and retry on a bad link;
 *  fourteen fewer requests makes the install likelier to complete at all. */
const SHELL_FONTS = [
  "KaTeX_Main-Regular.woff2",
  "KaTeX_Main-Bold.woff2",
  "KaTeX_Main-Italic.woff2",
  "KaTeX_Main-BoldItalic.woff2",
  "KaTeX_Math-Italic.woff2",
  "KaTeX_Math-BoldItalic.woff2",
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** KaTeX font files are the one place a tree is swept selectively. Every other
 *  file under TREES belongs in the shell by virtue of being there. */
function isExcludedFont(full) {
  const rel = relative(dist, full).split(sep).join("/");
  const m = /^katex\/fonts\/(.+)$/.exec(rel);
  return m !== null && !SHELL_FONTS.includes(m[1]);
}

const files = [];
for (const tree of TREES) {
  try {
    files.push(...walk(join(dist, tree)).filter((f) => !isExcludedFont(f)));
  } catch {
    // A tree that isn't in this export simply contributes nothing.
  }
}
// A named keep-set is precisely the hand-maintained list this file's header
// warns drifts silently, and it drifts on a KaTeX upgrade that renames a face:
// the name stops matching, the face quietly leaves the shell, and nothing says
// so until someone opens an equation on a plane. Fail the build instead.
const shipped = new Set(
  files.map((f) => relative(dist, f).split(sep).join("/")).filter((r) => r.startsWith("katex/fonts/")),
);
const missing = SHELL_FONTS.filter((f) => !shipped.has(`katex/fonts/${f}`));
if (missing.length && statSync(join(dist, "katex"), { throwIfNoEntry: false })) {
  throw new Error(
    `SHELL_FONTS names ${missing.join(", ")}, which this export does not contain.\n` +
      `KaTeX was probably upgraded; reconcile the list in scripts/gen-precache.mjs\n` +
      `against expo/public/katex/fonts/ rather than letting the face silently\n` +
      `drop out of the install shell.`,
  );
}
for (const f of FILES) {
  const full = join(dist, f);
  if (statSync(full, { throwIfNoEntry: false })) files.push(full);
}

// "/" stands in for index.html, and leads the list so the shell is the first
// thing fetched during install.
const urls = ["/", ...files.map((f) => "/" + relative(dist, f).split(sep).join("/"))].sort(
  (a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)),
);

// Hash contents, not just names: the hashed `_expo` filenames already change
// with their content, but index.html, the katex CSS and the manifest do not.
// In sorted order, so the same export hashes the same on every filesystem —
// `readdirSync` order is not a promise.
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hash = createHash("sha256");
hash.update(readFileSync(join(dist, "index.html")));
for (const f of [...files].sort(byPath)) hash.update(readFileSync(f));
const version = hash.digest("hex").slice(0, 12);

/** What sw.js fetches on demand into VENDOR_CACHE: the whole KaTeX tree and
 *  pdf.js. That cache is named for these files' contents alone, so it outlives
 *  every build that leaves them unchanged — which is nearly every build — and a
 *  KaTeX or pdf.js upgrade renames it, retiring the old files together. Names
 *  are hashed with contents, so a rename is a new cache too. */
const VENDOR = ["katex", "pdf.min.mjs", "pdf.worker.min.mjs"];
const vendorFiles = [];
for (const v of VENDOR) {
  const full = join(dist, v);
  const st = statSync(full, { throwIfNoEntry: false });
  if (!st) continue;
  vendorFiles.push(...(st.isDirectory() ? walk(full) : [full]));
}
const vendorHash = createHash("sha256");
for (const f of vendorFiles.sort(byPath)) {
  vendorHash.update(relative(dist, f).split(sep).join("/"));
  vendorHash.update(readFileSync(f));
}
const vendorVersion = vendorHash.digest("hex").slice(0, 12);

const swPath = join(dist, "sw.js");
const source = readFileSync(swPath, "utf8");

function fill(text, marker, value) {
  const line = new RegExp(`^.*${marker}.*$`, "m");
  if (!line.test(text)) throw new Error(`sw.js is missing its ${marker} marker`);
  return text.replace(line, value);
}

let filled = fill(source, "__BRANE_CACHE_NAME__", `const CACHE_NAME = "brane-${version}";`);
filled = fill(filled, "__BRANE_PRECACHE__", `const PRECACHE = ${JSON.stringify(urls, null, 2)};`);
filled = fill(filled, "__BRANE_VENDOR_CACHE__", `const VENDOR_CACHE = "brane-vendor-${vendorVersion}";`);
writeFileSync(swPath, filled);

const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(
  `precache brane-${version}: ${urls.length} urls, ${(bytes / 1024 / 1024).toFixed(1)} MB; ` +
    `vendor brane-vendor-${vendorVersion}: ${vendorFiles.length} files -> dist/sw.js`,
);
