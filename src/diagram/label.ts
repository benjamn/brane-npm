/** Label text → styled lines.
 *
 *  Mermaid has two label grammars, and agents write both:
 *
 *  - **Plain** (`A[text]`, `A["text"]`). Mermaid's HTML labels honour a few
 *    tags in here — `<br/>`, `<b>`, `<i>` and their kin — and nothing else:
 *    `**x**` in a plain label is two asterisks on GitHub too.
 *  - **Markdown strings** (``A["`text`"]``, mermaid ≥10). The backticks inside
 *    the quotes are the marker, not over-quoting: `**bold**` and `*italic*`
 *    render, a newline in the source is a line break, and mermaid wraps long
 *    lines to a fixed width.
 *
 *  Before this module brane read only `<br/>` from either, so ``"`**Plan**`"``
 *  drew its backticks and asterisks as text (claude-cdouqlgt:19 on another
 *  daemon, where an agent tried three spellings of bold and got none).
 *
 *  **Nothing here builds markup.** A label becomes runs of plain text with
 *  flags, and `svg.ts` escapes each run into a `<tspan>` whose attributes it
 *  writes itself. A `<script>` in a label is text, exactly as before.
 *
 *  **One parse, never a second scanner.** A markdown string goes through
 *  `fromMarkdown`, the parser `markdown-diagnostics.ts` already uses, so what
 *  counts as bold here is what counts as bold everywhere else in brane. The
 *  plain grammar is a fixed set of tags, so a linear scanner over that set
 *  is its whole definition.
 *
 *  **Tables are brane's own.** A node's markdown string may hold a GFM table,
 *  which mermaid shows as "Unsupported markdown". Brane draws it as a grid,
 *  as static SVG, so the HTML export carries no logic for it. In an edge
 *  label or a subgraph title there is no box for a grid, so there a table
 *  shows as its source and is reported.
 *
 *  **What still shows as source is reported.** Each label returns `literal`:
 *  markup that will be drawn as the characters it is made of. `narrate`
 *  turns those into `diagram_label_literal` warnings, so an agent that writes
 *  `**x**` in a plain label learns to write a markdown string, instead of
 *  getting a clean receipt for a diagram showing asterisks.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { FONT_SIZE, runWidth } from "./metrics.js";

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  underline?: boolean;
}

/** One drawn line: its runs, in order. */
export type RunLine = TextRun[];

export type ColumnAlign = "left" | "center" | "right" | null;

/** A GFM table inside a node label. It occupies `1 + rows.length` line slots,
 *  and its columns share widths across rows — the one thing a stack of
 *  centred lines cannot express. Header cells arrive already bold, so the
 *  measurement and the drawing agree without either knowing it is a header. */
export interface TableBlock {
  table: true;
  align: ColumnAlign[];
  header: RunLine[];
  rows: RunLine[][];
}

/** What a label stacks vertically: a line of runs, or a table. */
export type LabelLine = RunLine | TableBlock;

export const isTable = (l: LabelLine): l is TableBlock => !Array.isArray(l);

/** Line slots a label line takes up. */
export const slotsOf = (l: LabelLine): number => (isTable(l) ? 1 + l.rows.length : 1);

/** A table as plain lines, for the places that can only hold text. */
export function tableText(t: TableBlock): string[] {
  return [t.header, ...t.rows].map((cells) => cells.map(lineText).join(" | "));
}

/** Label lines with every table flattened to text lines: for edge labels and
 *  subgraph titles, where a table is never drawn as one. */
export function textLines(lines: LabelLine[]): RunLine[] {
  return lines.flatMap((l) => (isTable(l) ? tableText(l).map((text) => [{ text }]) : [l]));
}

export interface ParsedLabel {
  /** Plain text per line slot: what links, search and the tests read. A
   *  table contributes one line per row, its cells joined by ` | `. */
  lines: string[];
  /** The same lines, styled, with tables kept as tables. */
  runs: LabelLine[];
  /** Markup that will be drawn literally, described for the author. */
  literal: string[];
}

/** Mermaid's `flowchart.wrappingWidth` (200px) at mermaid's 16px, scaled to
 *  brane's font size. Markdown strings wrap to it; plain labels never wrap,
 *  also as mermaid does. Scaled because it is the *em* width that decides
 *  where a line breaks: 200px at 14px would keep words together that GitHub
 *  splits (`planner picks the operations` is one line at 200px/14px and two
 *  on GitHub). */
export const MARKDOWN_WRAP_WIDTH = (200 * FONT_SIZE) / 16;

type Style = Omit<TextRun, "text">;

const TAGS: Record<string, keyof Style> = {
  b: "bold", strong: "bold",
  i: "italic", em: "italic",
  code: "code",
  s: "strike", del: "strike", strike: "strike",
  u: "underline",
};

/** Every tag-shaped token: `<b>`, `</em>`, `<br/>`, `<br />`, `<foo bar>`. */
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)\b[^<>]*?(\/?)>/g;

/** A markdown string: ``"`…`"``, quotes and backticks wrapping the whole. */
const MD_STRING = /^"`([\s\S]*)`"$/;

/** `**x**`, `__x__` and `` `x` `` in a plain label are drawn as typed, here
 *  and in mermaid. Worth saying, because the fix is one character pair away. */
const MARKDOWN_IN_PLAIN = /\*\*[^*\s][^*]*\*\*|__[^_\s][^_]*__|`[^`\s][^`]*`/;

export interface LabelOptions {
  /** Draw GFM tables in markdown strings. Node labels only: an edge label or
   *  a subgraph title has no box for a grid to sit in, so there a table shows
   *  as its source and is reported. */
  tables?: boolean;
}

export function parseLabel(raw: string, opts: LabelOptions = {}): ParsedLabel {
  const t = raw.trim();
  const md = MD_STRING.exec(t);
  return md ? parseMarkdownLabel(md[1], opts) : parsePlainLabel(t);
}

function plainLines(runs: LabelLine[]): string[] {
  return runs.flatMap((l) => (isTable(l) ? tableText(l) : [lineText(l)]));
}

/** A label that is just text — the node id, for one written without a label. */
export function plainLabel(text: string): ParsedLabel {
  return { lines: [text], runs: [[{ text }]], literal: [] };
}

// ── Plain labels ─────────────────────────────────────────────────────────────

function parsePlainLabel(raw: string): ParsedLabel {
  // One pair of wrapping quotes is label quoting, not text. The old splitter
  // stripped a backtick pair as well; kept, since dropping it would put
  // backticks into diagrams that drew without them yesterday.
  const s = raw.replace(/^(["'`])([\s\S]*)\1$/, "$2");
  const literal: string[] = [];
  const b = new LineBuilder();
  const style: Style = {};
  const depth: Partial<Record<keyof Style, number>> = {};
  const unknown = new Set<string>();

  let at = 0;
  for (const m of s.matchAll(TAG)) {
    b.text(decodeEntities(s.slice(at, m.index)), style);
    at = m.index! + m[0].length;
    const [, close, nameRaw, selfClose] = m;
    const name = nameRaw.toLowerCase();
    if (name === "br") { b.newline(); continue; }
    const flag = TAGS[name];
    if (!flag || selfClose) {
      b.text(m[0], style);
      // Once per tag name: `<span>…</span>` is one mistake, not two.
      if (!unknown.has(name)) {
        unknown.add(name);
        literal.push(`\`<${name}>\` is not a tag diagrams draw, so it shows as text`);
      }
      continue;
    }
    // Counted, so `<b><b>x</b> y</b>` keeps `y` bold, and a stray `</b>`
    // closes nothing rather than going negative.
    const d = (depth[flag] ?? 0) + (close ? -1 : 1);
    depth[flag] = Math.max(0, d);
    if (depth[flag]) style[flag] = true; else delete style[flag];
  }
  b.text(decodeEntities(s.slice(at)), style);

  const out = b.finish(/* dropBlank */ true);
  // Only text outside `<code>`: inside it, `**` is meant literally, and saying
  // otherwise was a false warning.
  const prose = out.runs.map((l) => (isTable(l) ? "" : l.filter((r) => !r.code).map((r) => r.text).join(""))).join("\n");
  const md = MARKDOWN_IN_PLAIN.exec(prose);
  if (md) {
    literal.push(
      `\`${md[0]}\` shows as typed in a plain label. To style it, make the label a markdown string: backticks just inside the quotes, as in \`A["\`**bold**\`"]\``,
    );
  }
  return { ...out, literal };
}

// ── Markdown strings ─────────────────────────────────────────────────────────

function parseMarkdownLabel(inner: string, opts: LabelOptions): ParsedLabel {
  // Continuation lines carry the diagram's indentation, which in markdown
  // would read as an indented code block. Mermaid dedents; trimming each line
  // is the same thing for text that is never meant to be indented.
  const src = inner.split("\n").map((l) => l.trim()).join("\n");
  const literal: string[] = [];
  // Swapped while a table cell is read, so the inline walk below fills the
  // cell rather than the label.
  let b = new LineBuilder();
  let tree: any;
  try {
    // The table extension is loaded whether or not tables are drawn: without
    // it a table parses as paragraphs of pipes, which draw as typed and could
    // not be reported, since nothing would know they were a table.
    tree = fromMarkdown(src, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] });
  } catch {
    b.text(src, {});
    return { ...b.finish(true), literal: ["the markdown string could not be parsed, so it shows as typed"] };
  }

  const sourceOf = (node: any): string => {
    const s = node?.position?.start?.offset, e = node?.position?.end?.offset;
    return typeof s === "number" && typeof e === "number" ? src.slice(s, e) : "";
  };

  const tagStyle: Style = {};
  const inline = (node: any, style: Style): void => {
    const eff = { ...style, ...tagStyle };
    switch (node.type) {
      case "text": b.text(node.value, eff); return;
      case "break": b.newline(); return;
      case "strong": for (const c of node.children) inline(c, { ...style, bold: true }); return;
      case "emphasis": for (const c of node.children) inline(c, { ...style, italic: true }); return;
      case "inlineCode": b.text(node.value, { ...eff, code: true }); return;
      case "html": {
        // Inline HTML arrives one tag per node. The tags plain labels honour
        // mean the same here; anything else is shown and reported.
        const m = /^<(\/?)([A-Za-z][A-Za-z0-9]*)\b[^<>]*?(\/?)>$/.exec(node.value);
        const name = m?.[2].toLowerCase();
        if (name === "br") { b.newline(); return; }
        const flag = name ? TAGS[name] : undefined;
        if (m && flag && !m[3]) {
          if (m[1]) delete tagStyle[flag]; else tagStyle[flag] = true;
          return;
        }
        b.text(node.value, eff);
        literal.push(`\`${clip(node.value)}\` is not something diagrams draw, so it shows as text`);
        return;
      }
      case "link": case "linkReference":
        for (const c of node.children ?? []) inline(c, style);
        literal.push(`links in diagram labels are drawn as their text and are not followed`);
        return;
      default: {
        const text = sourceOf(node);
        if (text) {
          b.text(text, eff);
          literal.push(`\`${clip(text)}\` is markdown diagrams do not draw, so it shows as typed`);
        }
      }
    }
  };

  const block = (node: any, prefix: string): void => {
    switch (node.type) {
      case "root": case "blockquote":
        node.children.forEach((c: any) => block(c, prefix));
        return;
      case "paragraph": case "heading":
        b.startBlock();
        if (prefix) b.text(prefix, {});
        for (const c of node.children) inline(c, node.type === "heading" ? { bold: true } : {});
        return;
      case "list":
        node.children.forEach((item: any, i: number) => {
          const marker = node.ordered ? `${(node.start ?? 1) + i}. ` : "• ";
          (item.children ?? []).forEach((c: any, j: number) => block(c, j === 0 ? marker : ""));
        });
        return;
      case "table": {
        if (!opts.tables) { literalBlock(node, "tables are drawn only in node labels, so this one"); return; }
        const cellRuns = (cell: any, header: boolean): RunLine => {
          const outer = b;
          b = new LineBuilder();
          for (const c of cell.children ?? []) inline(c, header ? { bold: true } : {});
          // A cell is one line: a `<br>` inside one becomes a space.
          const line = textLines(b.finish(true).runs).reduce<RunLine>(
            (acc, l, i) => (i ? [...acc, { text: " " }, ...l] : l), []);
          b = outer;
          return line;
        };
        const [head, ...body] = node.children ?? [];
        const width = head?.children?.length ?? 0;
        // GFM pads short rows with empty cells and drops extra ones.
        const row = (r: any, header: boolean) =>
          Array.from({ length: width }, (_, i) => (r.children?.[i] ? cellRuns(r.children[i], header) : []));
        b.startBlock();
        b.table({
          table: true,
          align: Array.from({ length: width }, (_, i) => node.align?.[i] ?? null),
          header: row(head, true),
          rows: body.map((r: any) => row(r, false)),
        });
        return;
      }
      case "code":
        b.startBlock();
        node.value.split("\n").forEach((l: string, i: number) => {
          if (i) b.newline();
          b.text(l, { code: true });
        });
        return;
      default:
        literalBlock(node);
    }
  };
  const literalBlock = (node: any, what?: string): void => {
    const text = sourceOf(node);
    if (!text) return;
    b.startBlock();
    b.text(text, {});
    literal.push(what
      ? `${what} shows as typed`
      : `\`${clip(text)}\` is markdown diagrams do not draw, so it shows as typed`);
  };
  block(tree, "");

  const out = b.finish(/* dropBlank */ true);
  const runs = out.runs.flatMap((line): LabelLine[] => (isTable(line) ? [line] : wrapRuns(line, MARKDOWN_WRAP_WIDTH)));
  return { lines: plainLines(runs), runs, literal };
}

// ── Lines ────────────────────────────────────────────────────────────────────

/** Accumulates runs into lines, merging adjacent runs of the same style and
 *  splitting text on its own newlines (a markdown soft break is a `\n` inside
 *  a text node, and in a markdown string it is a line break). */
class LineBuilder {
  private lines: LabelLine[] = [[]];
  private blocks = 0;

  text(s: string, style: Style): void {
    if (!s) return;
    s.split("\n").forEach((part, i) => {
      if (i) this.newline();
      if (part) this.push({ text: part, ...clean(style) });
    });
  }

  newline(): void { this.lines.push([]); }

  /** A new paragraph, heading or list item starts on its own line. */
  startBlock(): void {
    if (this.blocks++ > 0) this.newline();
  }

  /** A table takes the current line if it is empty, and nothing after it
   *  shares its slots. */
  table(t: TableBlock): void {
    const cur = this.lines[this.lines.length - 1];
    if (!isTable(cur) && cur.length === 0) this.lines[this.lines.length - 1] = t;
    else this.lines.push(t);
    this.newline();
  }

  private push(run: TextRun): void {
    let line = this.lines[this.lines.length - 1];
    if (isTable(line)) { line = []; this.lines.push(line); }
    const last = line[line.length - 1];
    if (last && sameStyle(last, run)) last.text += run.text;
    else line.push(run);
  }

  finish(dropBlank: boolean): Omit<ParsedLabel, "literal"> {
    let runs = this.lines.map((l) => (isTable(l) ? l : trimLine(l)));
    // `A<br/><br/>B` drew as two lines before, not three; an empty label
    // still draws as one empty line.
    if (dropBlank) {
      const kept = runs.filter((l) => isTable(l) || l.length > 0);
      runs = kept.length ? kept : [[]];
    }
    return { lines: plainLines(runs), runs };
  }
}

const FLAGS: Array<keyof Style> = ["bold", "italic", "code", "strike", "underline"];

function clean(style: Style): Style {
  const out: Style = {};
  for (const f of FLAGS) if (style[f]) out[f] = true;
  return out;
}

function sameStyle(a: TextRun, b: TextRun): boolean {
  return FLAGS.every((f) => !!a[f] === !!b[f]);
}

/** Leading and trailing whitespace of the *line*, not of each run: the space
 *  in `**Plan** mixin` belongs to the second run and must stay. */
function trimLine(line: RunLine): RunLine {
  const out = line.map((r) => ({ ...r }));
  while (out.length && !(out[0].text = out[0].text.replace(/^\s+/, ""))) out.shift();
  while (out.length && !(out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, ""))) out.pop();
  return out;
}

export function lineText(line: RunLine): string {
  return line.map((r) => r.text).join("");
}

/** Greedy word wrap of one line of runs to `max` px.
 *
 *  Words are split at spaces and never broken, so a word longer than the
 *  width overflows as it does in mermaid. A run boundary inside a word
 *  (`**Plan**s`) is not a break opportunity. */
export function wrapRuns(line: RunLine, max: number, fontSize = FONT_SIZE): RunLine[] {
  // Tokens: whitespace or a maximal non-space stretch, each possibly spanning
  // several runs.
  type Piece = { run: TextRun; space: boolean };
  const pieces: Piece[] = [];
  for (const r of line) {
    for (const m of r.text.matchAll(/\s+|\S+/g)) {
      pieces.push({ run: { ...r, text: m[0] }, space: /^\s/.test(m[0]) });
    }
  }
  const words: Piece[][] = [];
  for (const p of pieces) {
    const prev = words[words.length - 1];
    if (!prev || p.space || prev[0].space) words.push([p]);
    else prev.push(p);
  }

  const width = (ps: Piece[]) => ps.reduce((w, p) => w + runWidth(p.run, fontSize), 0);
  const out: Piece[][] = [[]];
  let w = 0;
  for (const word of words) {
    const cur = out[out.length - 1];
    if (word[0].space) {
      if (cur.length) { cur.push(...word); w += width(word); }
      continue;
    }
    const ww = width(word);
    if (cur.length && w + ww > max) {
      if (cur[cur.length - 1].space) cur.pop();
      out.push([...word]);
      w = ww;
    } else {
      cur.push(...word);
      w += ww;
    }
  }
  return out.map((ps) => {
    const merged: RunLine = [];
    for (const p of ps) {
      const last = merged[merged.length - 1];
      if (last && sameStyle(last, p.run)) last.text += p.run.text;
      else merged.push({ ...p.run });
    }
    return trimLine(merged);
  });
}

function clip(s: string, max = 40): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** The character references a label is likely to hold. Mermaid's HTML labels
 *  decode them, so `A[x &lt; y]` reads `x < y` there; brane drew the entity.
 *  Decoded after tags are scanned, so a decoded `<` is never read as one. */
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  ndash: "–", mdash: "—", hellip: "…", rarr: "→", larr: "←", harr: "↔",
  le: "≤", ge: "≥", ne: "≠", times: "×", middot: "·", bull: "•", deg: "°",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const cp = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}
