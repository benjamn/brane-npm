// Vendors pdf.js into `public/` for PdfView, which imports it at runtime from
// a same-origin URL so metro never folds it into the main bundle (see the
// comment at the top of components/PdfView.web.tsx).
//
// It is the *legacy* build, not `build/`. pdf.js's modern build calls
// JavaScript that browsers are still shipping — `Map.prototype.
// getOrInsertComputed`, the TC39 upsert proposal, for one — with no fallback,
// so on a browser without it `page.render` throws and every page stays a
// blank canvas. The legacy build is the same code with core-js polyfills,
// in the worker too, for about 60 KB more over both files, fetched only when
// a PDF is opened.
//
// Run `npm run sync:pdfjs` after upgrading the pdfjs-dist dependency. The
// output is committed, so a plain checkout builds without running this.

import { createRequire } from "node:module";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkg = dirname(require.resolve("pdfjs-dist/package.json"));
const build = join(pkg, "legacy", "build");
const out = join(dirname(dirname(fileURLToPath(import.meta.url))), "public");

const files = ["pdf.min.mjs", "pdf.worker.min.mjs"];
for (const f of files) copyFileSync(join(build, f), join(out, f));

console.log(`pdfjs-dist ${require("pdfjs-dist/package.json").version} (legacy): ${files.join(" + ")} -> public/`);
