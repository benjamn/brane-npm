/** LaTeX math, shared by the web app and the daemon's HTML export.
 *
 *  Both sides hand the *same* LaTeX to the *same* `katex.renderToString`, so an
 *  exported narrative isn't an approximation of the live view — it is that view
 *  with the renderer run ahead of time. That only holds if the decision of
 *  *whether* a `$…$` run is math is shared too — and how a source is normalized
 *  before parsing — which is what `prepareMathMarkdown` below is for. If the two
 *  sides disagreed, exports would quietly stop matching what the operator saw.
 */

import katex from "katex";

/** Delimiters, for the literal fallbacks below. */
const TEXT_DELIM = "$";
const FLOW_DELIM = "$$";
/** A blank line: where a paragraph, and so any code span inside it, ends. */
const BLANK_LINE = /\n[ \t]*\r?\n/g;
/** What may precede a `$$` that still opens a math flow fence: indentation,
 *  blockquote and list markers — the container prefixes micromark strips. */
const FLOW_PREFIX = /^(?:[ \t]*(?:>|[-*+]|\d+[.)]))*[ \t]*$/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render one run of LaTeX to standalone HTML.
 *
 *  `htmlAndMathml` is KaTeX's default and worth its extra bytes: the visible
 *  layout is the span tree, and the MathML riding alongside it is what screen
 *  readers actually read.
 *
 *  Anything KaTeX can't parse falls back to the literal source with its
 *  delimiters restored, rather than to KaTeX's red error markup. A run that
 *  reached here and failed was almost certainly never math — some prose that
 *  slipped past the guard — so showing it as the author typed it is both the
 *  honest rendering and the unobtrusive one.
 */
export function renderMathHtml(
  value: string,
  displayMode: boolean,
  onError?: (message: string, fallback: string) => void,
): string {
  try {
    return katex.renderToString(value, {
      displayMode,
      output: "htmlAndMathml",
      throwOnError: true,
      // Warn-don't-fail on LaTeX-incompatible input: agents write Unicode
      // straight into math mode (`$σ → 0$`) and KaTeX renders it fine.
      strict: false,
      trust: false,
      // `\*` is not a TeX control sequence; it's a model escaping an asterisk
      // so markdown won't read it as emphasis, then leaving the escape inside
      // the math where it no longer means anything. It accounts for half the
      // otherwise-unparseable equations in the absorbed archive.
      macros: { "\\*": "*" },
    });
  } catch (err) {
    const d = displayMode ? FLOW_DELIM : TEXT_DELIM;
    const fallback = d + value + d;
    // The fallback *is* the diagnostic. Whether a parse failure matters depends
    // entirely on whether the literal source still reads — `$E = mc^2$` does, a
    // `pmatrix` does not — so a caller collecting these gets the exact text the
    // operator will see, not just the parser's complaint about it.
    onError?.(katexMessage(err), fallback);
    return escapeHtml(fallback);
  }
}

/** KaTeX's own complaint, minus the prefix it repeats on every one, and minus
 *  the combining underline it draws through the offending characters — which
 *  reads as an underline in a browser and as mojibake anywhere a plain string
 *  ends up. The message still names the position in words. */
function katexMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^KaTeX parse error:\s*/, "").replace(/\u0332/g, "");
}

/** Something in a source that will not render the way it was written.
 *
 *  `prepareMathMarkdown` already decides every one of these while normalizing —
 *  which run is math, which delimiter has no partner — and then throws the
 *  reasoning away. Reporting it instead is what lets the writer of a narration
 *  find out, at the moment of writing, that their equation is about to appear
 *  as prose. `index` is an offset into the *original* source, so a caller can
 *  turn it into a line number the author will recognize.
 */
export type MathSourceIssue =
  | { kind: "dollar_escaped"; content: string; after: string; index: number }
  | { kind: "tex_unmatched"; open: string; reason: string; index: number }
  | { kind: "display_unclosed"; index: number }
  | { kind: "fence_unclosed"; fence: string; index: number };

/** Is this `$…$` run plausibly math?
 *
 *  `content` is the text between the delimiters, `after` the single character
 *  that follows the closing one (empty at end of input).
 */
export function isMathContent(content: string, after: string): boolean {
  return mathContentRejection(content, after) === null;
}

/** Why this run is *not* math, phrased for the author, or null if it is.
 *
 *  The first three rules are Pandoc's, and they carry most of the weight — in
 *  particular "no digit after the closer", which is what saves `$10k–$500k`
 *  from being read as math over `10k–`. The last two are ours, for the two
 *  things agents write that Pandoc never had to worry about: shell parameter
 *  expansion (`${curcontext%:*:*}`) and quoted snippets pasted outside a code
 *  span (`awk '{print $1, $9}'`). Real math contains no raw double quote.
 *
 *  The decision and the *explanation* of the decision live in one function on
 *  purpose: an author told "a space sits just inside the delimiters" can fix
 *  it, where one told only "not math" is left guessing which guard fired — and
 *  a second copy of these rules written to phrase them would drift from the
 *  copy that enforces them.
 */
export function mathContentRejection(content: string, after: string): string | null {
  if (content.length === 0) return "the delimiters enclose nothing";
  if (/^\s|\s$/.test(content)) return "a space sits just inside the delimiters";
  if (/^[0-9]/.test(after)) return "a digit follows the closing `$`, which reads as currency";
  if (content.startsWith("{")) return "it opens with `{`, which reads as shell parameter expansion";
  if (content.includes('"')) return "it contains a double quote, which math never does";
  return null;
}

/** Index of the `$` that closes a text-math run opened just before `from`, or
 *  -1. Mirrors what micromark-extension-math will accept: escapes don't close,
 *  and a run doesn't survive a blank line. */
function findTextMathClose(md: string, from: number): number {
  for (let j = from; j < md.length; j++) {
    const c = md[j];
    if (c === "\\") { j++; continue; }
    if (c === "\n" && md[j + 1] === "\n") return -1;
    if (c === "$") return j;
  }
  return -1;
}

/** A fence opening at `i` (a line start): up to three spaces, then three or
 *  more backticks or tildes. Returns the fence run, or null. */
function matchFenceOpen(md: string, i: number): string | null {
  const line = md.slice(i, md.indexOf("\n", i) === -1 ? undefined : md.indexOf("\n", i));
  const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
  return m ? m[1] : null;
}

/** End index (exclusive) of the fenced block opened at `i` with `fence` —
 *  the closing fence line, or end of input if it never closes. */
function findFenceClose(md: string, i: number, fence: string): number {
  const marker = fence[0];
  let j = md.indexOf("\n", i);
  if (j === -1) return md.length;
  j += 1;
  while (j < md.length) {
    const lineEnd = md.indexOf("\n", j);
    const line = md.slice(j, lineEnd === -1 ? md.length : lineEnd);
    if (new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) {
      return lineEnd === -1 ? md.length : lineEnd + 1;
    }
    if (lineEnd === -1) return md.length;
    j = lineEnd + 1;
  }
  return md.length;
}

/** Did the block `findFenceClose` returned actually end at a closing fence?
 *  It returns end-of-input both for a fence that never closes and for one that
 *  closes on the final line, so the block itself is what tells them apart. An
 *  unclosed fence is worth reporting because its damage isn't local: every
 *  paragraph after it becomes code. */
function hasClosingFence(block: string, fence: string): boolean {
  return new RegExp(`\\n {0,3}[${fence[0]}]{${fence.length},}[ \\t]*\\r?\\n?$`).test(block);
}

type TexDelimiter =
  | { ok: true; value: string; display: boolean; end: number }
  | { ok: false; reason: string };

/** `\(…\)` or `\[…\]` opening at `i`, or null.
 *
 *  TeX's other delimiter pair, and the one OpenAI-family models reach for by
 *  default — markdown would otherwise eat both halves as escaped brackets and
 *  leave the LaTeX as prose. Unlike `$`, these are unambiguous: nothing else in
 *  ordinary writing looks like them, so they need no guard. */
function matchTexDelimiter(md: string, i: number): TexDelimiter | null {
  const open = md.slice(i, i + 2);
  const display = open === "\\[";
  if (!display && open !== "\\(") return null;
  const close = display ? "\\]" : "\\)";
  const at = md.indexOf(close, i + 2);
  // Past this point the author has plainly asked for math, so a failure comes
  // back with its reason rather than as a bare null: the caller renders it as
  // prose either way, but only a reason can be reported to whoever wrote it.
  if (at === -1) return { ok: false, reason: `\`${open}\` is never closed by \`${close}\`` };
  const value = md.slice(i + 2, at);
  if (!value.trim()) return { ok: false, reason: `\`${open}${close}\` encloses nothing` };
  // A `$` inside would collide with the delimiters we rewrite to. Vanishingly
  // rare in math; leaving such a run alone beats mangling it.
  if (value.includes("$")) return { ok: false, reason: "it contains a `$`, which would collide with the `$` delimiters this rewrites to" };
  // An inline run that swallows a blank line is a runaway, not an equation.
  if (!display && /\n\s*\n/.test(value)) return { ok: false, reason: "an inline run spanning a blank line is a runaway, not an equation" };
  return { ok: true, value, display, end: at + 2 };
}

/** A ```math fence, rewritten to `$$…$$`.
 *
 *  GitHub renders that fence as display math, and models that have learned its
 *  flavour of markdown emit it. A ```latex fence is left alone: that one is
 *  almost always showing the source rather than asking for it to be set. */
function matchMathFence(block: string, fence: string): string | null {
  const firstLineEnd = block.indexOf("\n");
  if (firstLineEnd === -1) return null;
  const info = block.slice(0, firstLineEnd).trimStart().slice(fence.length).trim();
  if (info.toLowerCase() !== "math") return null;
  const marker = fence[0] === "`" ? "`" : "~";
  const body = block
    .slice(firstLineEnd + 1)
    .replace(new RegExp(`\\n? {0,3}${marker}{${fence.length},}[ \\t]*\\n?$`), "");
  if (!body.trim()) return null;
  return `${FLOW_DELIM}\n${body.trim()}\n${FLOW_DELIM}\n`;
}

/** Normalize a markdown source so both renderers read its math the same way.
 *
 *  Two passes in one scan, because both have to respect the same code regions.
 *
 *  **Escaping dollars that aren't delimiters.**
 *  This runs *before* the markdown is parsed, which is what lets one function
 *  serve both renderers: micromark-extension-math is more permissive than
 *  Pandoc (it will happily eat `$10k–$500k`), and it exposes no hook for
 *  vetoing a run once tokenized. Escaping up front sidesteps that entirely —
 *  and `\$` renders as a plain `$`, so the reader sees exactly what was typed.
 *
 *  Only the *opening* delimiter is escaped; scanning then resumes inside the
 *  rejected run, so its closing `$` gets its own fair hearing as the opener of
 *  the next candidate. That's what makes a chain like `$5 and $10 and $x$`
 *  come out right.
 *
 *  Regions markdown already protects are skipped rather than guarded: fenced
 *  blocks, code spans, backslash escapes, `$$…$$` display math (nobody writes
 *  a doubled dollar for currency), and lines indented far enough to be code.
 *  Skipping is the safe direction — the worst case is micromark's permissive
 *  default, where escaping inside a code span would print a literal backslash.
 *
 *  **Promoting one-line display math.** micromark-extension-math only treats
 *  `$$` as a display *fence*, so `$$x$$` alone on a line parses as inline math
 *  with doubled delimiters — centered-block intent, inline rendering, and no
 *  `\displaystyle` sizing. That one-line form is how agents actually write
 *  display math, so a paragraph that is nothing but `$$…$$` is rewritten into
 *  the fenced form the extension wants.
 */
export function prepareMathMarkdown(md: string, onIssue?: (issue: MathSourceIssue) => void): string {
  let out = "";
  let i = 0;
  // Indented code is a *block*, not a line: only its first line follows a blank
  // one, so a per-line test lets everything after the first line back in. That
  // is how ASCII art drawn in dollar signs got its `$` escaped and its `$$$$`
  // runs read as empty display math.
  let inIndentedCode = false;
  while (i < md.length) {
    const atLineStart = i === 0 || md[i - 1] === "\n";

    if (atLineStart) {
      const lineEnd = md.indexOf("\n", i);
      const line = md.slice(i, lineEnd === -1 ? md.length : lineEnd);
      const blank = line.trim() === "";
      const indented = /^(?: {4}|\t)/.test(line);
      const prevLineStart = i === 0 ? 0 : md.lastIndexOf("\n", i - 2) + 1;
      const afterBlank = i === 0 || md.slice(prevLineStart, i - 1).trim() === "";

      if (inIndentedCode ? blank || indented : indented && afterBlank) {
        inIndentedCode = true;
        const end = lineEnd === -1 ? md.length : lineEnd + 1;
        out += md.slice(i, end);
        i = end;
        continue;
      }
      inIndentedCode = false;

      const fence = matchFenceOpen(md, i);
      if (fence) {
        const end = findFenceClose(md, i, fence);
        const block = md.slice(i, end);
        if (onIssue && !hasClosingFence(block, fence)) onIssue({ kind: "fence_unclosed", fence, index: i });
        out += matchMathFence(block, fence) ?? block;
        i = end;
        continue;
      }
    }

    const ch = md[i];

    if (ch === "\\") {
      const tex = matchTexDelimiter(md, i);
      if (tex?.ok) {
        // Rewritten into the `$` forms rather than tokenized separately, so
        // everything downstream — both renderers included — sees one syntax.
        if (!tex.display) {
          // Trimmed, because whitespace is insignificant inside TeX delimiters
          // but decisive inside dollars: `\( i \)` is idiomatic and common,
          // and `$ i $` is exactly what the guard above throws out.
          out += `${TEXT_DELIM}${tex.value.trim()}${TEXT_DELIM}`;
        } else {
          const lineStart = md.lastIndexOf("\n", i) + 1;
          const prefix = md.slice(lineStart, i);
          const lineEnd = md.indexOf("\n", tex.end);
          const trailing = md.slice(tex.end, lineEnd === -1 ? md.length : lineEnd);
          // An opener that ends its own line: every interior line already
          // carries whatever prefix its block needs — the `> ` of a blockquote,
          // a list's indent — so swap the delimiters where they stand and touch
          // nothing else. Re-trimming and re-wrapping here is what dropped
          // blockquoted equations into a `$$` fence's info string, where
          // micromark discards them without a word.
          if (/^[ \t>]*$/.test(prefix) && /^[ \t]*\r?\n/.test(tex.value)) {
            out += `${FLOW_DELIM}${tex.value}${FLOW_DELIM}`;
          } else if (/^[ \t]*$/.test(prefix) && trailing.trim() === "") {
            // The prefix rides along on the lines we invent. Without it a
            // `\[…\]` sitting three spaces deep in a numbered list opens its
            // fence inside the item and closes it at column 0, which ends the
            // list and leaves the fence hanging.
            out += `${FLOW_DELIM}\n${prefix}${tex.value.trim()}\n${prefix}${FLOW_DELIM}`;
          } else {
            // Mid-sentence, or under a prefix a fence can't survive. Inline
            // display math renders in place and can't corrupt the block.
            out += `${FLOW_DELIM}${tex.value.trim()}${FLOW_DELIM}`;
          }
        }
        i = tex.end;
        continue;
      }
      if (tex) onIssue?.({ kind: "tex_unmatched", open: md.slice(i, i + 2), reason: tex.reason, index: i });
      out += md.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === "`") {
      let n = 0;
      while (md[i + n] === "`") n++;
      const run = "`".repeat(n);
      // A code span closes on a backtick run of exactly the same length — and
      // never past the end of its paragraph. A stray ``` in prose once hunted
      // for its partner across ninety lines and swallowed a real fence opener
      // on the way, leaving every dollar inside the region unguarded.
      BLANK_LINE.lastIndex = i;
      const paragraphEnd = BLANK_LINE.exec(md)?.index ?? md.length;
      let j = i + n;
      let close = -1;
      while (j < paragraphEnd) {
        const next = md.indexOf(run, j);
        if (next === -1 || next >= paragraphEnd) break;
        let k = 0;
        while (md[next + run.length + k] === "`") k++;
        if (k === 0 && md[next - 1] !== "`") { close = next; break; }
        j = next + run.length + k;
      }
      const end = close === -1 ? i + n : close + n;
      out += md.slice(i, end);
      i = end;
      continue;
    }

    if (ch === "$") {
      if (md.startsWith(FLOW_DELIM, i)) {
        // `$$$` is how people write "expensive", and the extension agrees: a
        // run of three or more is literal unless a run of the same length
        // closes it, which nobody writes. Leave it be.
        if (md[i + 2] === "$") {
          let n = 2;
          while (md[i + n] === "$") n++;
          out += md.slice(i, i + n);
          i += n;
          continue;
        }
        const close = md.indexOf(FLOW_DELIM, i + 2);
        const end = close === -1 ? i + 2 : close + 2;
        // An unclosed `$$` only swallows what follows when it opens a line
        // (a math *flow* fence, possibly under a list or quote prefix); in
        // the middle of a sentence it is two literal dollars.
        if (close === -1 && FLOW_PREFIX.test(md.slice(md.lastIndexOf("\n", i) + 1, i))) {
          onIssue?.({ kind: "display_unclosed", index: i });
        }
        if (close !== -1) {
          const content = md.slice(i + 2, close);
          const lineStart = md.lastIndexOf("\n", i) + 1;
          const lineEnd = md.indexOf("\n", end);
          const trailing = md.slice(end, lineEnd === -1 ? md.length : lineEnd);
          // `$$x$$` with nothing else on its line: the author meant a display
          // block, so give the extension the fence it recognizes.
          if (
            !content.includes("\n") &&
            content.trim() !== "" &&
            md.slice(lineStart, i).trim() === "" &&
            trailing.trim() === ""
          ) {
            out += `${FLOW_DELIM}\n${content.trim()}\n${FLOW_DELIM}`;
            i = end;
            continue;
          }
        }
        out += md.slice(i, end);
        i = end;
        continue;
      }
      const close = findTextMathClose(md, i + 1);
      if (close !== -1) {
        const content = md.slice(i + 1, close);
        if (isMathContent(content, md[close + 1] ?? "")) {
          out += md.slice(i, close + 1);
          i = close + 1;
          continue;
        }
        onIssue?.({ kind: "dollar_escaped", content, after: md[close + 1] ?? "", index: i });
        out += "\\$";
        i += 1;
        continue;
      }
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** The CSS that makes a display-math block behave, shared by the app and the
 *  export for the same reason `renderMathHtml` is: a downloaded narrative has
 *  to be the live view, not a lookalike of it. The export writes this into its
 *  one `<style>`; the app injects it from `Markdown.tsx`. Neither may keep a
 *  private copy.
 *
 *  KaTeX gives display math no way to wrap — `.katex-display > .katex` is
 *  `white-space: nowrap`, and TeX has no line-breaking for display mode at all
 *  — so an equation wider than its container must scroll. `overflow-x: auto`
 *  alone does not achieve that, which is the bug this fixes:
 *
 *  **`min-width: max-content` is the load-bearing rule.** Left alone, that
 *  inner block is exactly the container's width with its content overflowing
 *  it *centered* — and centered overflow spills both ways, with the left spill
 *  unreachable, since `scrollWidth` doesn't count it. A wide equation is then
 *  clipped at *both* ends with nothing to scroll to, and — worse than being
 *  cut off — it looks whole. A truncated BBP formula doesn't equal π, but it
 *  renders as though it does (`claude-yklrrp1n:16`). Sized to its own content
 *  the block overflows rightward only, which is the direction a scroller can
 *  actually reach. Below the container's width nothing changes: `width: auto`
 *  still wins, so short equations stay centered.
 *
 *  **The mask is the overflow hint**, and it dissolves the equation itself
 *  rather than washing anything over it: a mask makes the element's own paint
 *  transparent, so what comes through at a faded edge is whatever the block
 *  sits on — the bubble, in its own color, without this code having to know
 *  what that color is.
 *
 *  What the mask cannot do on its own is know *when* to fade, and an edge that
 *  fades with nothing beyond it lies as badly as one that clips. So the two
 *  fade widths are registered custom properties animated on a **scroll
 *  timeline over the block itself** — which is a measurement the browser is
 *  already making. `animation-range` puts each animation in the first and last
 *  32px of travel, and `both` holds the endpoints in between, so the left edge
 *  fades in as soon as you move off the start and the right edge is *crisp
 *  once you reach the end*. A block with nothing to scroll has no timeline at
 *  all — inactive, so the initial `0px` widths stand and no edge fades.
 *
 *  No script, which is what lets the export have this too. Where scroll-driven
 *  animations aren't supported the base style is what remains: a scroller with
 *  both edges sharp. The equation still scrolls; it just stops advertising it.
 */
export const MATH_BLOCK_CSS = `
@property --math-fade-start { syntax: "<length>"; inherits: false; initial-value: 0px; }
@property --math-fade-end { syntax: "<length>"; inherits: false; initial-value: 0px; }
@keyframes brane-math-fade-start { from { --math-fade-start: 0px; } to { --math-fade-start: 28px; } }
@keyframes brane-math-fade-end { from { --math-fade-end: 28px; } to { --math-fade-end: 0px; } }
.math-display {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 0;
  /* A horizontal pan that runs out of equation shouldn't turn into the
     browser's back-navigation swipe. (The app's tab-swipe is a touch handler
     rather than scroll chaining, so that one needs the JS pan guard too.) */
  overscroll-behavior-x: contain;
  mask-image: linear-gradient(
    to right,
    rgba(0, 0, 0, 0) 0,
    rgba(0, 0, 0, 1) var(--math-fade-start),
    rgba(0, 0, 0, 1) calc(100% - var(--math-fade-end)),
    rgba(0, 0, 0, 0) 100%
  );
  animation: brane-math-fade-start linear both, brane-math-fade-end linear both;
  animation-timeline: scroll(self x), scroll(self x);
  animation-range: 0 32px, calc(100% - 32px) 100%;
}
.math-display > .katex-display > .katex { min-width: max-content; }
.math-inline { overflow-wrap: normal; }
`;
