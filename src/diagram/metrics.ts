/** Text measurement without a browser.
 *
 *  Layout needs to know how wide a label is before there is anything to
 *  measure it with: the daemon has no DOM, and the whole reason brane does not
 *  ship mermaid is that mermaid needs one. So widths come from a table.
 *
 *  The table is Helvetica's own advance widths (units of 1/1000 em, from its
 *  AFM), which is what `system-ui` resolves to closely enough on every
 *  platform brane runs on. It is a real metric set, not an estimate, and it is
 *  exact for the ASCII that node labels are overwhelmingly made of.
 *
 *  **It cannot be ASCII-only.** One diagram in the archive is a Greek
 *  morphology state chart — `πραΰς`, `πραεῖσι(ν)` — and a table that fell back
 *  to a single constant for everything outside ASCII would lay it out as
 *  overlapping boxes. So non-ASCII resolves per Unicode block, with CJK and
 *  Hangul full-width, combining marks zero-width, and emoji wider than a
 *  letter. Approximate, but approximate in the right direction per script,
 *  which is what keeps a box from clipping its own text.
 */

/** Helvetica advance widths, 1/1000 em, for U+0020..U+007E. */
const ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Per-block widths for everything else, same units. Ordered, first match
 *  wins; `max` is inclusive. */
const BLOCKS: Array<{ min: number; max: number; w: number }> = [
  { min: 0x0300, max: 0x036f, w: 0 },      // combining diacriticals
  { min: 0x00a0, max: 0x024f, w: 556 },    // Latin-1 supplement, Latin Extended-A/B
  { min: 0x0370, max: 0x03ff, w: 600 },    // Greek
  { min: 0x0400, max: 0x04ff, w: 600 },    // Cyrillic
  { min: 0x0590, max: 0x05ff, w: 520 },    // Hebrew
  { min: 0x0600, max: 0x06ff, w: 520 },    // Arabic
  { min: 0x1f00, max: 0x1fff, w: 600 },    // Greek Extended — the morphology chart lives here
  { min: 0x2000, max: 0x206f, w: 400 },    // general punctuation
  { min: 0x2190, max: 0x21ff, w: 800 },    // arrows
  { min: 0x2200, max: 0x22ff, w: 700 },    // mathematical operators
  { min: 0x2500, max: 0x257f, w: 600 },    // box drawing
  { min: 0x2e80, max: 0x9fff, w: 1000 },   // CJK
  { min: 0xac00, max: 0xd7af, w: 1000 },   // Hangul
  { min: 0xf900, max: 0xfaff, w: 1000 },   // CJK compatibility
  { min: 0xff00, max: 0xff60, w: 1000 },   // fullwidth forms
  { min: 0x1f300, max: 0x1faff, w: 1200 }, // emoji
];

/** Anything unrecognised. A letter-ish default beats both 0 (text spills) and
 *  full width (boxes gape). */
const DEFAULT_WIDTH = 600;

export function charWidth(cp: number): number {
  if (cp >= 0x20 && cp <= 0x7e) return ASCII[cp - 0x20];
  if (cp === 0x09) return ASCII[0] * 4;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0;
  for (const b of BLOCKS) if (cp >= b.min && cp <= b.max) return b.w;
  return DEFAULT_WIDTH;
}

/** Width of `text` in px at `fontSize`. Iterates code points, so a surrogate
 *  pair counts once — an emoji measured as two halves is measured twice. */
export function textWidth(text: string, fontSize: number): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch.codePointAt(0)!);
  return (total / 1000) * fontSize;
}

/** Helvetica-Bold advance widths, 1/1000 em, for U+0020..U+007E — the bold
 *  face's own AFM, not a scale factor. Bold widens unevenly (`r` 333 → 389,
 *  `i` 222 → 278, `?` 556 → 611), so a uniform stretch would misjudge exactly
 *  the short labels where a box's padding is thinnest. */
const ASCII_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Outside ASCII, bold is regular plus this much: approximate, and on the
 *  wide side, which clips nothing. */
const BOLD_BLOCK_SCALE = 1.08;

/** Monospace advance: Menlo, SF Mono and Courier are all 600–602. Full-width
 *  scripts stay full width in a monospace face too. */
const MONO_WIDTH = 602;
export const MONO_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** A run as metrics sees it: text and the two flags that change advances.
 *  Italic is Helvetica-Oblique, whose advances are Helvetica's; strike and
 *  underline draw over the glyphs and add nothing. */
export interface MeasuredRun { text: string; bold?: boolean; code?: boolean }

export function runWidth(run: MeasuredRun, fontSize: number): number {
  if (!run.bold && !run.code) return textWidth(run.text, fontSize);
  let total = 0;
  for (const ch of run.text) {
    const cp = ch.codePointAt(0)!;
    const w = charWidth(cp);
    if (run.code) total += w === 0 ? 0 : w >= 1000 ? w : MONO_WIDTH;
    else total += cp >= 0x20 && cp <= 0x7e ? ASCII_BOLD[cp - 0x20] : w * BOLD_BLOCK_SCALE;
  }
  return (total / 1000) * fontSize;
}

/** A table as metrics sees it. Header cells carry their own `bold`. */
export interface MeasuredTable { table: true; header: MeasuredRun[][]; rows: MeasuredRun[][][] }

/** A label's lines: plain strings, styled runs, or tables. */
export type LabelLines = Array<string | MeasuredRun[] | MeasuredTable>;

/** Space between table columns, and how far a table's rule overhangs its
 *  outermost cells. */
export const TABLE_GAP = 16;

const cellsWidth = (cells: MeasuredRun[], fontSize: number) =>
  cells.reduce((w, r) => w + runWidth(r, fontSize), 0);

/** Each column's width: the widest cell in it, header included. */
export function tableColumns(t: MeasuredTable, fontSize: number): number[] {
  return t.header.map((_, i) =>
    Math.max(...[t.header, ...t.rows].map((row) => cellsWidth(row[i] ?? [], fontSize))));
}

export function tableWidth(t: MeasuredTable, fontSize: number): number {
  const cols = tableColumns(t, fontSize);
  return cols.reduce((a, b) => a + b, 0) + TABLE_GAP * Math.max(0, cols.length - 1);
}

function lineWidth(line: string | MeasuredRun[] | MeasuredTable, fontSize: number): number {
  if (typeof line === "string") return textWidth(line, fontSize);
  if (!Array.isArray(line)) return tableWidth(line, fontSize);
  return cellsWidth(line, fontSize);
}

/** Line slots: one per line, and a table's header plus each of its rows. */
export const lineSlots = (lines: LabelLines): number =>
  lines.reduce((n, l) => n + (typeof l === "string" || Array.isArray(l) ? 1 : 1 + l.rows.length), 0);

export const FONT_SIZE = 14;
export const LINE_HEIGHT = 1.35;
export const LABEL_FONT_SIZE = 12;

/** Padding inside a node box, and the floor on its size. */
const PAD_X = 18;
const PAD_Y = 11;
const MIN_W = 44;
const MIN_H = 34;

export function measureNode(lines: LabelLines): { width: number; height: number } {
  const w = Math.max(0, ...lines.map((l) => lineWidth(l, FONT_SIZE)));
  const h = Math.max(1, lineSlots(lines)) * FONT_SIZE * LINE_HEIGHT;
  return {
    width: Math.max(MIN_W, Math.ceil(w + PAD_X * 2)),
    height: Math.max(MIN_H, Math.ceil(h + PAD_Y * 2)),
  };
}

/** An edge label's chip. Multi-line since `<br/>` and markdown strings reach
 *  edge labels too; one line measures exactly as it always did. */
export function measureEdgeLabel(label: string | LabelLines): { width: number; height: number } {
  const lines = typeof label === "string" ? [label] : label;
  const w = Math.max(0, ...lines.map((l) => lineWidth(l, LABEL_FONT_SIZE)));
  return {
    width: Math.ceil(w + 10),
    height: Math.ceil(Math.max(1, lines.length) * LABEL_FONT_SIZE * LINE_HEIGHT + 4),
  };
}
