// Vendors KaTeX's stylesheet and fonts into `public/`, the same way
// `pdf.min.mjs` is vendored for PdfView — metro bundles a CSS *import* but
// never copies the `url(fonts/…)` assets that stylesheet points at, so a
// bundled katex.min.css renders math in fallback glyphs. Serving both from
// `public/` sidesteps metro entirely and keeps KaTeX's own relative font paths
// correct, since the layout under `public/katex/` mirrors `katex/dist/`.
//
// Only woff2 is carried across: KaTeX lists woff and ttf after it for browsers
// that predate 2016, and shipping them would triple the size for files nothing
// will ever request. The `src` lines are rewritten to match, so the vendored
// CSS has no dangling references.
//
// Run `npm run sync:katex` after upgrading the katex dependency. The output is
// committed, so a plain checkout builds without running this.

import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dist = join(dirname(require.resolve("katex/package.json")), "dist");
const out = join(dirname(dirname(fileURLToPath(import.meta.url))), "public", "katex");

mkdirSync(join(out, "fonts"), { recursive: true });

const css = readFileSync(join(dist, "katex.min.css"), "utf8").replace(
  /src:[^;}]*/g,
  (src) => {
    const woff2 = src.match(/url\(([^)]*\.woff2)\)/);
    return woff2 ? `src:url(${woff2[1]}) format("woff2")` : src;
  },
);
writeFileSync(join(out, "katex.min.css"), css);

const fonts = readdirSync(join(dist, "fonts")).filter((f) => f.endsWith(".woff2"));
for (const f of fonts) copyFileSync(join(dist, "fonts", f), join(out, "fonts", f));

console.log(`katex ${require("katex/package.json").version}: katex.min.css + ${fonts.length} woff2 -> public/katex/`);
