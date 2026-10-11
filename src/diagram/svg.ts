/** SVG emission.
 *
 *  Three rules the rest of this file exists to keep:
 *
 *  **Nothing from the fence reaches the output as markup.** Labels are
 *  escaped into text nodes. The markup mermaid allows in a label — `<br/>`,
 *  `<b>`/`<i>` and their kin, and markdown strings — was parsed into lines of
 *  styled runs (`label.ts`), and becomes `<tspan>`s here whose attributes this
 *  file writes itself — parsed, never forwarded. Style declarations were filtered
 *  to a known property set with a value charset that excludes `url(`.
 *
 *  **No `<style>` element.** An inline SVG's `<style>` is *document*-global:
 *  a `text { font-family: … }` rule inside one diagram restyles every other
 *  inline SVG on the page, and brane renders many per screen. Everything here
 *  is a presentation attribute, and theming rides on CSS custom properties
 *  whose fallbacks are brane's own dark palette, so the page can retheme
 *  without us shipping a selector and the common case needs no declaration.
 *
 *  **Ids are per-diagram.** Two diagrams in one conversation would otherwise
 *  share `url(#arrow)` and the second would take the first's marker.
 */

import type { Placed, PlacedEdge, PlacedNode, Point } from "./layout.js";
import {
  FONT_SIZE, LABEL_FONT_SIZE, LINE_HEIGHT, MONO_FAMILY, TABLE_GAP, measureEdgeLabel, tableColumns, tableWidth,
} from "./metrics.js";
import { isTable, slotsOf, type LabelLine, type RunLine, type TableBlock, type TextRun } from "./label.js";

export interface SvgOptions {
  /** Resolve a node's label to a link, or null to leave it as text. This is
   *  where brane's own grammars reach inside a diagram — a node labelled with
   *  a narrative id becomes as tappable as the same characters in prose. */
  hrefFor?: (label: string) => string | null;
  /** Stable suffix for element ids. */
  idSuffix: string;
  /** Emit the edge highlight layer (see `edgeHighlight`). Only a host whose
   *  stylesheet reveals it (`DIAGRAM_EDGE_HIGHLIGHT_CSS`) should ask: without
   *  that rule the layer is invisible, but its groups still take focus and
   *  pointer hits. The export and the app both do. */
  edgeHighlight?: boolean;
}

const ESC: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** Colours resolve from the page, and **the fallbacks are dark**.
 *
 *  The custom properties are the extension point, but a fallback is what
 *  actually renders until something defines one — and the first draft shipped
 *  light-mode fallbacks that nothing overrode. Both of brane's targets are
 *  dark (the app's `#121214`, the export's `#000`), so every diagram drew
 *  `#33373d` lines on near-black and the subgraph title was unreadable. For a
 *  change whose subject is the arrows, that is the first thing anyone sees.
 *
 *  Defaulting to the palette brane actually has, rather than to the palette a
 *  standalone white page would want, means the common case needs no
 *  declaration anywhere and a light host can still override. */
const C = {
  line: "var(--brane-diagram-line, #b8bcc4)",
  nodeFill: "var(--brane-diagram-node-fill, #262a33)",
  nodeStroke: "var(--brane-diagram-node-stroke, #9370db)",
  text: "var(--brane-diagram-text, #e6e6e6)",
  clusterFill: "var(--brane-diagram-cluster-fill, rgba(147,112,219,0.10))",
  clusterStroke: "var(--brane-diagram-cluster-stroke, rgba(147,112,219,0.55))",
  /** Behind an edge label, so the line does not run through the text. Matches
   *  the bubble it sits on rather than being hard-coded white. */
  labelBg: "var(--brane-diagram-label-bg, #1c1c1e)",
  /** An edge picked out by hover or tap, and its label with it. */
  highlight: "var(--brane-diagram-highlight, #ffd866)",
};

const HEAD_LEN = 10;
const HEAD_W = 8;

/** d3-shape's `curveBasis`, ported so this module adds no dependency.
 *
 *  A uniform cubic B-spline. It is what mermaid fits and — after a comparison
 *  against clamped Hermite, catmull-rom and monotone — the one that keeps an
 *  edge to a single calm sweep. Its terminal points are duplicated, so the
 *  curve does reach both ends exactly; the tilt it used to arrive at was
 *  never the curve's fault but the attachment point's (see `layout.ts`). */
export function basisPath(pts: Point[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${r(pts[0].x)},${r(pts[0].y)}`;
  if (pts.length === 2) {
    return `M${r(pts[0].x)},${r(pts[0].y)}L${r(pts[1].x)},${r(pts[1].y)}`;
  }
  const out: string[] = [];
  let x0 = NaN, y0 = NaN, x1 = NaN, y1 = NaN, n = 0;
  const seg = (x: number, y: number) =>
    out.push(
      `C${r((2 * x0 + x1) / 3)},${r((2 * y0 + y1) / 3)}` +
      `,${r((x0 + 2 * x1) / 3)},${r((y0 + 2 * y1) / 3)}` +
      `,${r((x0 + 4 * x1 + x) / 6)},${r((y0 + 4 * y1 + y) / 6)}`,
    );
  for (const p of pts) {
    switch (n) {
      case 0: n = 1; out.push(`M${r(p.x)},${r(p.y)}`); break;
      case 1: n = 2; break;
      case 2: n = 3; out.push(`L${r((5 * x0 + x1) / 6)},${r((5 * y0 + y1) / 6)}`); seg(p.x, p.y); break;
      default: seg(p.x, p.y); break;
    }
    x0 = x1; x1 = p.x;
    y0 = y1; y1 = p.y;
  }
  if (n === 3) seg(x1, y1);
  if (n === 2 || n === 3) out.push(`L${r(x1)},${r(y1)}`);
  return out.join("");
}

const r = (v: number) => Math.round(v * 100) / 100;

function nodeShapePath(n: PlacedNode): string {
  const hx = n.width / 2, hy = n.height / 2;
  const l = r(n.x - hx), t = r(n.y - hy), w = r(n.width), h = r(n.height);
  const fill = n.style?.fill ?? C.nodeFill;
  const stroke = n.style?.stroke ?? C.nodeStroke;
  const sw = n.style?.["stroke-width"] ?? "1.5";
  const dash = n.style?.["stroke-dasharray"];
  const common =
    ` fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${esc(sw)}"` +
    (dash ? ` stroke-dasharray="${esc(dash)}"` : "");

  switch (n.shape) {
    case "circle":
      return `<ellipse cx="${r(n.x)}" cy="${r(n.y)}" rx="${r(hx)}" ry="${r(hy)}"${common}/>`;
    case "diamond":
      return `<polygon points="${r(n.x)},${t} ${r(n.x + hx)},${r(n.y)} ${r(n.x)},${r(n.y + hy)} ${r(n.x - hx)},${r(n.y)}"${common}/>`;
    case "hexagon": {
      const k = Math.min(hx * 0.3, 14);
      return `<polygon points="${r(n.x - hx + k)},${t} ${r(n.x + hx - k)},${t} ${r(n.x + hx)},${r(n.y)} ${r(n.x + hx - k)},${r(n.y + hy)} ${r(n.x - hx + k)},${r(n.y + hy)} ${r(n.x - hx)},${r(n.y)}"${common}/>`;
    }
    case "asymmetric": {
      const k = Math.min(hx * 0.35, 16);
      return `<polygon points="${l},${t} ${r(n.x + hx)},${t} ${r(n.x + hx)},${r(n.y + hy)} ${l},${r(n.y + hy)} ${r(n.x - hx + k)},${r(n.y)}"${common}/>`;
    }
    case "cylinder": {
      const ry = Math.min(hy * 0.34, 10);
      return (
        `<path d="M${l},${r(n.y - hy + ry)}` +
        `a${r(hx)},${r(ry)} 0 0 1 ${w},0` +
        `v${r(n.height - ry * 2)}` +
        `a${r(hx)},${r(ry)} 0 0 1 ${r(-w)},0z"${common}/>` +
        `<path d="M${l},${r(n.y - hy + ry)}a${r(hx)},${r(ry)} 0 0 0 ${w},0" fill="none" stroke="${esc(stroke)}" stroke-width="${esc(sw)}"/>`
      );
    }
    case "subroutine": {
      const k = Math.min(hx * 0.16, 9);
      return (
        `<rect x="${l}" y="${t}" width="${w}" height="${h}" rx="3"${common}/>` +
        `<path d="M${r(n.x - hx + k)},${t}v${h}M${r(n.x + hx - k)},${t}v${h}" fill="none" stroke="${esc(stroke)}" stroke-width="${esc(sw)}"/>`
      );
    }
    case "stadium":
      return `<rect x="${l}" y="${t}" width="${w}" height="${h}" rx="${r(hy)}"${common}/>`;
    case "round":
      return `<rect x="${l}" y="${t}" width="${w}" height="${h}" rx="11"${common}/>`;
    case "rect":
    default:
      return `<rect x="${l}" y="${t}" width="${w}" height="${h}" rx="4"${common}/>`;
  }
}

/** One run's text, wrapped in a `<tspan>` only when it is styled, so an
 *  unstyled label draws byte-for-byte as it did before runs existed. */
function runSpan(run: TextRun): string {
  let attrs = "";
  if (run.bold) attrs += ` font-weight="bold"`;
  if (run.italic) attrs += ` font-style="italic"`;
  if (run.code) attrs += ` font-family="${MONO_FAMILY}"`;
  const deco = [run.underline && "underline", run.strike && "line-through"].filter(Boolean).join(" ");
  if (deco) attrs += ` text-decoration="${deco}"`;
  return attrs ? `<tspan${attrs}>${esc(run.text)}</tspan>` : esc(run.text);
}

const lineContent = (line: RunLine) => line.map(runSpan).join("");

/** Stacked lines centred on `y0`: the first `dy` lifts the block by half its
 *  height, each later one steps down a line. */
function lineTspans(lines: RunLine[], x: number, fontSize: number): string {
  const first = -((lines.length - 1) / 2) * fontSize * LINE_HEIGHT;
  return lines
    .map((ln, i) =>
      `<tspan x="${r(x)}" dy="${i === 0 ? r(first) : r(fontSize * LINE_HEIGHT)}">${lineContent(ln)}</tspan>`)
    .join("");
}

/** A subgraph title's lines, hanging down from the first baseline. */
function titleTspans(lines: RunLine[], x: number): string {
  if (lines.length === 1) return lineContent(lines[0]);
  return lines
    .map((ln, i) =>
      `<tspan x="${r(x)}" dy="${i === 0 ? 0 : r(LABEL_FONT_SIZE * LINE_HEIGHT)}">${lineContent(ln)}</tspan>`)
    .join("");
}

const FONT_FAMILY = "system-ui, -apple-system, Segoe UI, sans-serif";

function nodeText(n: PlacedNode, opts: SvgOptions): string {
  const color = n.style?.color ?? C.text;
  const text = n.runs.some(isTable)
    ? slottedText(n.runs, n.x, n.y, color)
    : `<text x="${r(n.x)}" y="${r(n.y + FONT_SIZE * 0.35)}" text-anchor="middle"` +
      ` font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}"` +
      ` fill="${esc(color)}">${lineTspans(n.runs as RunLine[], n.x, FONT_SIZE)}</text>`;

  const href = opts.hrefFor?.(n.lines.join(" "));
  return href ? `<a href="${esc(href)}">${text}</a>` : text;
}

function edgePath(e: PlacedEdge, id: string, hl = false): string {
  const d = basisPath(hl ? trimForHeads(e) : e.points);
  const dash = e.line === "dotted" ? ` stroke-dasharray="5 4"` : "";
  const width = (e.line === "thick" ? 3 : 1.7) + (hl ? 1.3 : 0);
  const m = hl ? "ah-hl" : "ah";
  const end = e.arrow === "open" ? "" : ` marker-end="url(#${m}-${id})"`;
  const start = e.arrow === "biarrow" ? ` marker-start="url(#${m}-start-${id})"` : "";
  return (
    `<path d="${d}" fill="none" stroke="${hl ? C.highlight : C.line}" stroke-width="${width}"` +
    `${dash} stroke-linecap="round"${start}${end}/>`
  );
}

/** A highlighted edge's points, stopped short of each arrowhead.
 *
 *  The base line runs to the arrowhead's tip, under the head, and at 1.7px
 *  that is invisible. The highlight is 3px, and running it under the point
 *  blunted the tip. So an end that carries a head is pulled back one head
 *  length along its last segment, and the highlight's markers are anchored
 *  at their base (`refX` 0 at the end, `HEAD_LEN` at the start), which puts
 *  the tip back exactly where the base line's is. The basis curve leaves its
 *  last point along the last segment, so moving that point along the same
 *  segment keeps the head's angle.
 *
 *  An end with no head is left alone: it runs on into the box, and the box,
 *  painted above the highlight layer, covers it. */
function trimForHeads(e: PlacedEdge): Point[] {
  const pts = e.points.slice();
  const pull = (at: number, toward: number) => {
    const a = pts[at], b = pts[toward];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) return;
    // A segment shorter than a head can't give one up whole; keep a sliver so
    // the curve still has a direction to end in.
    const k = Math.min(HEAD_LEN, len - 0.5) / len;
    if (k > 0) pts[at] = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  };
  if (pts.length < 2) return pts;
  if (e.arrow !== "open") pull(pts.length - 1, pts.length - 2);
  if (e.arrow === "biarrow") pull(0, 1);
  return pts;
}

function edgeLabel(e: PlacedEdge, hl = false): string {
  if (!e.label || !e.labelPos) return "";
  const { x, y } = e.labelPos;
  const runs = e.labelRuns ?? [[{ text: e.label }]];
  // The same measurement layout reserved space with. Sizing the chip as
  // `length × 0.55em` instead agreed with it only for ASCII, and left Greek or
  // CJK text hanging out of its own background.
  const w = measureEdgeLabel(runs).width;
  // One line keeps its old geometry exactly; each extra line grows the chip
  // by a line height, centred on the same point.
  const extra = (runs.length - 1) * LABEL_FONT_SIZE * LINE_HEIGHT;
  const body = runs.length === 1
    ? lineContent(runs[0])
    : lineTspans(runs, x, LABEL_FONT_SIZE);
  return (
    `<rect x="${r(x - w / 2)}" y="${r(y - LABEL_FONT_SIZE * 0.8 - extra / 2)}" width="${r(w)}"` +
    ` height="${r(LABEL_FONT_SIZE * 1.6 + extra)}" rx="3" fill="${C.labelBg}"` +
    `${hl ? ` stroke="${C.highlight}" stroke-width="1.3"` : ""}/>` +
    `<text x="${r(x)}" y="${r(y + LABEL_FONT_SIZE * 0.34)}" text-anchor="middle"` +
    ` font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="${LABEL_FONT_SIZE}"` +
    ` fill="${hl ? C.highlight : C.text}">${body}</text>`
  );
}

/** Half the width of the invisible stroke that catches a pointer or a tap.
 *  A 1.7px line is too thin to hit with a finger; much wider and neighbouring
 *  arrows' strokes overlap, and the later one wins every tap between them. */
const HIT_HALF_WIDTH = 5;

/** One edge, again, above every other edge: the way a reader tells which
 *  arrow a label belongs to where several cross.
 *
 *  The base drawing paints in layers (every path, then every label, then
 *  every node), and that order is what keeps labels above lines and boxes
 *  above both. Grouping each path with its own label would let a later path
 *  paint over an earlier label, so the pair is drawn a second time here, in
 *  a layer of its own, between the labels and the nodes. Above the labels so
 *  nothing else crosses it; below the nodes so the boxes cover its ends, as
 *  they do the base line's. Painted over them, the highlight's heavier
 *  stroke and round cap tipped over the box edge it leaves from. Below them
 *  also means a box, not an edge's hit stroke, catches a tap on the box.
 *
 *  It is revealed by CSS alone (`:hover`, and `:focus` for a tap, which is
 *  why the group takes `tabindex`), so the export stays scriptless. Hidden is
 *  an `opacity` *attribute*, not a rule, so a page without the stylesheet
 *  shows nothing extra.
 *
 *  Each edge gets up to two of these, one per way to pick it. `line` is
 *  caught by an invisible stroke along the path; `label` by the label's
 *  chip. All the `label` groups paint after all the `line` groups, because a
 *  label is the thing a reader taps to ask "which arrow is this?", and in a
 *  single layer a later edge's stroke covered an earlier edge's label. (In
 *  WebKit, tapping every label and line of three real diagrams: 16 of 72
 *  taps picked the wrong edge with one layer.) */
function edgeHighlight(e: PlacedEdge, id: string, by: "line" | "label"): string {
  if (by === "label" && (!e.label || !e.labelPos)) return "";
  const hit = by === "line"
    ? `<path d="${basisPath(e.points)}" fill="none" stroke="transparent"` +
      ` stroke-width="${HIT_HALF_WIDTH * 2}" stroke-linecap="butt" pointer-events="stroke"/>`
    : "";
  // Only the hit stroke and the chip should catch a pointer: the copy of the
  // line under a `label` group would otherwise reach along the whole path.
  const copy = by === "line"
    ? edgePath(e, id, true) + edgeLabel(e, true)
    : `<g pointer-events="none">${edgePath(e, id, true)}</g>` + edgeLabel(e, true);
  const aria = e.label ? ` aria-label="${esc(e.label)}"` : "";
  return `<g class="brane-diagram-edge-hl" tabindex="0" opacity="0"${aria}>${hit}${copy}</g>`;
}

export function renderSvg(placed: Placed, opts: SvgOptions): string {
  const id = opts.idSuffix;
  const defs =
    `<defs>` +
    `<marker id="ah-${id}" markerUnits="userSpaceOnUse" markerWidth="${HEAD_LEN}"` +
    ` markerHeight="${HEAD_W}" refX="${HEAD_LEN}" refY="${HEAD_W / 2}" orient="auto">` +
    `<path d="M0,0L${HEAD_LEN},${HEAD_W / 2}L0,${HEAD_W}z" fill="${C.line}"/></marker>` +
    `<marker id="ah-start-${id}" markerUnits="userSpaceOnUse" markerWidth="${HEAD_LEN}"` +
    ` markerHeight="${HEAD_W}" refX="0" refY="${HEAD_W / 2}" orient="auto">` +
    `<path d="M${HEAD_LEN},0L0,${HEAD_W / 2}L${HEAD_LEN},${HEAD_W}z" fill="${C.line}"/></marker>` +
    (opts.edgeHighlight
      // Anchored at the head's base, not its tip: the highlighted line stops
      // short of the tip (`trimForHeads`), and the head makes up the rest.
      ? `<marker id="ah-hl-${id}" markerUnits="userSpaceOnUse" markerWidth="${HEAD_LEN}"` +
        ` markerHeight="${HEAD_W}" refX="0" refY="${HEAD_W / 2}" orient="auto">` +
        `<path d="M0,0L${HEAD_LEN},${HEAD_W / 2}L0,${HEAD_W}z" fill="${C.highlight}"/></marker>` +
        `<marker id="ah-hl-start-${id}" markerUnits="userSpaceOnUse" markerWidth="${HEAD_LEN}"` +
        ` markerHeight="${HEAD_W}" refX="${HEAD_LEN}" refY="${HEAD_W / 2}" orient="auto">` +
        `<path d="M${HEAD_LEN},0L0,${HEAD_W / 2}L${HEAD_LEN},${HEAD_W}z" fill="${C.highlight}"/></marker>`
      : "") +
    `</defs>`;

  const clusters = placed.clusters
    .map((c) =>
      `<rect x="${r(c.x - c.width / 2)}" y="${r(c.y - c.height / 2)}" width="${r(c.width)}"` +
      ` height="${r(c.height)}" rx="6" fill="${C.clusterFill}" stroke="${C.clusterStroke}"` +
      ` stroke-width="1" stroke-dasharray="4 3"/>` +
      `<text x="${r(c.x)}" y="${r(c.y - c.height / 2 + 15)}" text-anchor="middle"` +
      ` font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="${LABEL_FONT_SIZE}"` +
      ` fill="${C.text}" opacity="0.75">${titleTspans(c.titleLines, c.x)}</text>`)
    .join("");

  const edges = placed.edges.map((e) => edgePath(e, id)).join("");
  const labels = placed.edges.map((e) => edgeLabel(e)).join("");
  const nodes = placed.nodes.map((n) => nodeShapePath(n) + nodeText(n, opts)).join("");
  const highlights = opts.edgeHighlight
    ? placed.edges.map((e) => edgeHighlight(e, id, "line")).join("") +
      placed.edges.map((e) => edgeHighlight(e, id, "label")).join("")
    : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="brane-diagram"` +
    ` viewBox="0 0 ${placed.width} ${placed.height}"` +
    ` width="${placed.width}" height="${placed.height}" role="img">` +
    defs + clusters + edges + labels + highlights + nodes +
    `</svg>`
  );
}

/** A label holding a table. One `<text>` per line or cell, each on its own
 *  baseline: a cell has to start at its column's edge, and the centred
 *  `dy`-stacked `<tspan>`s every other label uses can't say that. The slot
 *  baselines are the same ones that stack would have produced, so a table
 *  sits in a label exactly where its rows' worth of lines would. */
function slottedText(lines: LabelLine[], cx: number, cy: number, color: string): string {
  const total = lines.reduce((k, l) => k + slotsOf(l), 0);
  const step = FONT_SIZE * LINE_HEIGHT;
  const baseline = (slot: number) => cy + FONT_SIZE * 0.35 + (slot - (total - 1) / 2) * step;
  const at = (x: number, y: number, anchor: string, body: string) =>
    `<text x="${r(x)}" y="${r(y)}" text-anchor="${anchor}">${body}</text>`;

  let slot = 0;
  let out = "";
  for (const line of lines) {
    if (!isTable(line)) {
      out += at(cx, baseline(slot++), "middle", lineContent(line));
      continue;
    }
    out += tableText(line, cx, slot, baseline);
    slot += slotsOf(line);
  }
  return `<g font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${esc(color)}">${out}</g>`;

  function tableText(t: TableBlock, x0: number, first: number, base: (s: number) => number): string {
    const cols = tableColumns(t, FONT_SIZE);
    const left = x0 - tableWidth(t, FONT_SIZE) / 2;
    const starts = cols.map((_, i) => left + cols.slice(0, i).reduce((a, w) => a + w + TABLE_GAP, 0));
    const cell = (cells: RunLine[], y: number) => cells.map((c, i) => {
      if (!c.length) return "";
      const a = t.align[i];
      const [x, anchor] = a === "center" ? [starts[i] + cols[i] / 2, "middle"]
        : a === "right" ? [starts[i] + cols[i], "end"]
        : [starts[i], "start"];
      return at(x, y, anchor, lineContent(c));
    }).join("");
    // The rule sits halfway between the header's line box and the first
    // row's, overhanging the outer cells by half a gap, as a table's border
    // would.
    const ruleY = base(first) - FONT_SIZE * 0.35 + step / 2;
    const half = TABLE_GAP / 2;
    const width = tableWidth(t, FONT_SIZE);
    const rule = t.rows.length
      ? `<path d="M${r(left - half)},${r(ruleY)}h${r(width + TABLE_GAP)}" stroke="${C.line}" stroke-width="1" opacity="0.6" fill="none"/>`
      : "";
    return cell(t.header, base(first)) + rule + t.rows.map((row, k) => cell(row, base(first + 1 + k))).join("");
  }
}
