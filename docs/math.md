# Math Rendering

LaTeX in narrative markdown renders through **KaTeX**, in the app and in the HTML export alike. The two call the *same* `renderMathHtml()` in `src/shared/markdown-math.ts`, which is what makes an export a snapshot of the live view rather than a lookalike of it — the export contains no script, so all rendering happens ahead of time.

| Piece | Where | Does |
|---|---|---|
| `renderMathHtml()` | `src/shared/markdown-math.ts` | The one KaTeX call. `htmlAndMathml`; unparseable LaTeX falls back to the literal source, not KaTeX's red error markup |
| `prepareMathMarkdown()` | `src/shared/markdown-math.ts` | Pre-parse normalization, run by both sides before micromark/mdast |
| `mathHtmlExtension()`, `katexStyleFor()` | `src/math.ts` | Export only: micromark hookup, and the inlined stylesheet |
| `public/katex/` | `expo/` | The app's stylesheet + woff2, vendored by `npm run sync:katex` |
| `diagnoseMarkdown()` | `src/markdown-diagnostics.ts` | The same pipeline run to *report* rather than render — see [Rendering Warnings](rendering-warnings.md) |

**Every delimiter an LLM might reach for.** Which one a model writes is house style, not a standard, and the difference is stark: across the 42,521 events this was built against, `\(…\)` appears 1576 times and `\[…\]` 351 — all from absorbed ChatGPT history — against 578 single-dollar runs, which are mostly Claude's. A `$`-only reader would leave two thirds of the corpus as prose. `prepareMathMarkdown` normalizes the lot into the `$` forms before parsing, so one syntax reaches both renderers:

| Written | Becomes | Renders |
|---|---|---|
| `$x$` | unchanged | inline |
| `$$x$$` alone on a line | fenced `$$` | display |
| `\(x\)` | `$x$` | inline |
| `\[x\]` alone on a line | fenced `$$` | display |
| ` ```math ` fence | fenced `$$` | display |
| ` ```latex ` fence | unchanged | source listing, as intended |

Unlike `$`, the TeX pairs are unambiguous and need no guard — nothing in ordinary prose looks like them (0 false positives across all 1576). KaTeX also gets a `\*` → `*` macro: that isn't TeX, it's a model escaping an asterisk so markdown won't read emphasis and leaving the escape inside the math. It accounts for 13 of the 18 equations in the archive KaTeX would otherwise reject.

Two more things are less obvious than they look:

**`$` is mostly not a delimiter.** Narratives are full of prices, shell variables and awk fields, and `micromark-extension-math` is more permissive than Pandoc — it reads `$10k–$500k` as math over `10k–`. `prepareMathMarkdown` escapes the openers that fail a Pandoc-style guard (no space just inside a delimiter, no digit after the closer, no `${…}`, no raw `"`) before parsing, since the extension offers no veto once it has tokenized. It also promotes a one-line `$$…$$` paragraph to the fenced form, which is the only shape the extension renders in display mode. Both sides must run it or exports stop matching the app.

**Fonts don't come along by themselves.** KaTeX lays its span tree out entirely in CSS and needs its woff2 faces; without them math is a pile of overlapping glyphs. The export inlines only the families the document reaches for (~166 KB of base64 for an equation-dense narrative, nothing at all for one with no math), derived from the stylesheet so a KaTeX upgrade can't silently drop a face. The app can't inline per document, so it serves `public/katex/` — vendored the way `pdf.min.mjs` already is, because metro bundles a CSS *import* but never copies the `url(fonts/…)` it points at. The `<link>` lives in **`public/index.html`**, which is the real HTML template; `app/+html.tsx` is kept in step but is not what ships.

`src/shared/markdown-math.ts` is also the first shared module to import an npm package. Metro resolves a module's dependencies from its own directory and `src/shared` sits outside the expo project root, so `metro.config.js` maps `katex` explicitly — the next shared module with a bare import will need the same.
