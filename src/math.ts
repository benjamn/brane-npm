/** Server-side math: the micromark hookup for the HTML export, and the
 *  self-contained stylesheet that makes the export stand on its own.
 *
 *  The rendering itself lives in `shared/markdown-math.ts`, because the web app
 *  runs the identical call. What's here is the two things only the export
 *  needs: a micromark HTML extension, and KaTeX's fonts turned into bytes the
 *  file carries with it.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HtmlExtension } from "micromark-util-types";
import { renderMathHtml } from "./shared/markdown-math.js";

const require = createRequire(import.meta.url);
const KATEX_DIST = join(dirname(require.resolve("katex/package.json")), "dist");

/** micromark HTML extension for math.
 *
 *  Structurally this is `micromark-extension-math`'s own `mathHtml()`, with one
 *  substitution: unparseable LaTeX comes back as the literal source rather than
 *  as KaTeX's red error markup (see `renderMathHtml`). Running our own also
 *  keeps the export and the app on one renderer call with one set of options,
 *  which is the property the whole design rests on.
 *
 *  `onError` is how `diagnoseMarkdown` collects those failures instead of
 *  letting them pass silently. It rides on the extension rather than on a
 *  parallel scan for the same reason the substitution above exists: a warning
 *  fires only for a run this exact parse decided was math, so it can never
 *  disagree with what the reader will see.
 */
export function mathHtmlExtension(
  onError?: (message: string, fallback: string) => void,
): HtmlExtension {
  return {
    enter: {
      mathFlow(this: any) {
        this.lineEndingIfNeeded();
        this.tag('<div class="math math-display">');
      },
      mathFlowFenceMeta(this: any) {
        this.buffer();
      },
      mathText(this: any) {
        this.tag('<span class="math math-inline">');
        this.buffer();
      },
    },
    exit: {
      mathFlow(this: any) {
        const value = this.resume();
        this.tag(renderMathHtml(value.replace(/(?:\r?\n|\r)$/, ""), true, onError));
        this.tag("</div>");
        this.setData("mathFlowOpen");
        this.setData("slurpOneLineEnding");
      },
      mathFlowFence(this: any) {
        if (!this.getData("mathFlowOpen")) {
          this.setData("mathFlowOpen", true);
          this.setData("slurpOneLineEnding", true);
          this.buffer();
        }
      },
      mathFlowFenceMeta(this: any) {
        this.resume();
      },
      mathFlowValue(this: any, token: unknown) {
        this.raw(this.sliceSerialize(token));
      },
      mathText(this: any) {
        const value = this.resume();
        this.tag(renderMathHtml(value, false, onError));
        this.tag("</span>");
      },
      mathTextData(this: any, token: unknown) {
        this.raw(this.sliceSerialize(token));
      },
    },
  } as HtmlExtension;
}

interface FontFace {
  block: string;
  family: string;
  woff2: string;
}

let cachedCss: string | null = null;
function katexCss(): string {
  if (cachedCss === null) cachedCss = readFileSync(join(KATEX_DIST, "katex.min.css"), "utf8");
  return cachedCss;
}

/** Every `@font-face` in KaTeX's stylesheet, with the woff2 it points at.
 *  KaTeX ships woff and ttf alongside for ancient browsers; a data URI only
 *  needs the one format, and woff2 is both the smallest and universally
 *  supported by anything that would open one of these files. */
function fontFaces(css: string): FontFace[] {
  const faces: FontFace[] = [];
  for (const m of css.matchAll(/@font-face\{[^}]*\}/g)) {
    const block = m[0];
    const family = block.match(/font-family\s*:\s*['"]?(KaTeX_[A-Za-z0-9]+)/)?.[1];
    const woff2 = block.match(/url\(([^)]*\.woff2)\)/)?.[1].replace(/["']/g, "");
    if (family && woff2) faces.push({ block, family, woff2 });
  }
  return faces;
}

/** Which KaTeX font families a rendered document actually reaches for.
 *
 *  Derived from the stylesheet rather than hardcoded, so it can't drift when
 *  KaTeX is upgraded: collect every rule that sets a `KaTeX_*` family — the
 *  `font:` shorthand on `.katex` counts, which is how KaTeX_Main gets in — and
 *  keep the family if any of that rule's selectors has all its classes present
 *  in the document. */
function familiesUsed(css: string, html: string): Set<string> {
  const present = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) present.add(c);
  }
  const used = new Set<string>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const family = m[2].match(/font(?:-family)?\s*:[^;]*?(KaTeX_[A-Za-z0-9]+)/)?.[1];
    if (!family || used.has(family)) continue;
    for (const selector of m[1].split(",")) {
      const classes = [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((x) => x[1]);
      if (classes.length && classes.every((c) => present.has(c))) {
        used.add(family);
        break;
      }
    }
  }
  return used;
}

const fontDataUris = new Map<string, string>();
function fontDataUri(relPath: string): string {
  let uri = fontDataUris.get(relPath);
  if (uri === undefined) {
    const buf = readFileSync(join(KATEX_DIST, relPath));
    uri = `data:font/woff2;base64,${buf.toString("base64")}`;
    fontDataUris.set(relPath, uri);
  }
  return uri;
}

/** A `<style>` block that renders `html`'s math with no network and no JS, or
 *  null when the document contains no math at all.
 *
 *  KaTeX's span layout needs its stylesheet *and* its fonts, and a single-file
 *  export can only carry a font as base64 — so the whole point here is to carry
 *  as few as possible. Inlining all twenty faces costs ~338 KB; restricting to
 *  the families the document actually reaches for typically lands near 166 KB,
 *  and a narrative with no math pays nothing because we never get past the
 *  first line.
 *
 *  The alternative — emitting MathML and letting the reader's browser find a
 *  math font — is smaller still, but it renders differently on every OS. These
 *  files get handed to people whose machines we don't control, so the fonts
 *  ride along.
 */
export function katexStyleFor(html: string): string | null {
  if (!html.includes("katex")) return null;
  const css = katexCss();
  const used = familiesUsed(css, html);
  if (used.size === 0) return null;

  let out = css;
  for (const face of fontFaces(css)) {
    if (!used.has(face.family)) {
      out = out.replace(face.block, "");
      continue;
    }
    out = out.replace(
      face.block,
      face.block.replace(/src\s*:[^;}]*/, `src:url(${fontDataUri(face.woff2)}) format("woff2")`),
    );
  }
  return `<style>\n${out}\n</style>`;
}
