/** Layout: dagre for placement and routing, plus the one thing dagre gets
 *  wrong for our purposes — where an edge attaches to its node.
 *
 *  **Face projection.** dagre picks an edge's terminal point by intersecting
 *  the node's box with the chord from the node's *centre* to the first bend.
 *  That chord is diagonal, so every edge is handed a diagonal start and the
 *  arrowhead arrives tilted, whatever curve is fitted afterwards. Measured on
 *  the LIVE loop diagram, `Listen → Interpret` attaches at x=128 while the
 *  edge is heading for x=156: 28px of lean, baked in before rendering.
 *
 *  Projecting the bend onto the face instead — clamped to the face's extent,
 *  held off the corners — drops mean arrival angle from 31.4° to 8.7° while
 *  leaving the curve untouched, so the calm single-sweep shape of `curveBasis`
 *  survives exactly. Every alternative tried (clamped-tangent Hermite, basis
 *  with normal stubs, a straight terminal segment) bought the same squareness
 *  with extra inflections, and inflections are what read as "busy".
 *
 *  Self-loops are not given to dagre at all: it returns a degenerate path with
 *  duplicate points that doubles back outside the node. They are synthesised,
 *  and everything about them has to be too — including the two things dagre
 *  would otherwise have done for free. Their **label** needs a position of its
 *  own (the first draft left `labelPos` undefined and the renderer dropped the
 *  label, silently: a Rule 30 state graph rendered with all 24 arrows and
 *  none of the three loop labels that told the vacuum from the two stripe
 *  phases). And their **space** has to be reserved, because dagre cannot avoid
 *  what it never saw: the node is handed to dagre inflated by the bow and its
 *  chip, so no other edge's label is routed into the loop.
 *
 *  A diagram that draws but drops part of itself is a class the `warnings`
 *  contract cannot reach by construction — the operator sees no source, so
 *  there is no fallback to report. The only defence is not to drop anything.
 */

import dagre from "@dagrejs/dagre";
import type { DiagramIR, NodeShape } from "./types.js";
import { LABEL_FONT_SIZE, LINE_HEIGHT, measureEdgeLabel, measureNode } from "./metrics.js";
import { isTable, wrapRuns, type LabelLine, type RunLine } from "./label.js";

export interface Point { x: number; y: number }

export interface PlacedNode {
  id: string;
  lines: string[];
  /** Styled lines, with the node's own `font-weight` / `font-style` already
   *  folded in, so what was measured is what is drawn. */
  runs: LabelLine[];
  shape: NodeShape;
  classes: string[];
  style?: Record<string, string>;
  x: number; y: number; width: number; height: number;
}

export interface PlacedEdge {
  from: string; to: string;
  points: Point[];
  label?: string;
  labelRuns?: RunLine[];
  labelPos?: Point;
  arrow: "arrow" | "biarrow" | "open";
  line: "solid" | "dotted" | "thick";
  selfLoop: boolean;
}

export interface PlacedCluster {
  id: string; title: string; titleRuns: RunLine;
  /** The title wrapped to the box; the box has already grown to hold it. */
  titleLines: RunLine[];
  x: number; y: number; width: number; height: number;
}

export interface Placed {
  width: number; height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  clusters: PlacedCluster[];
}

const NODE_SEP = 46;
const RANK_SEP = 52;
const MARGIN = 14;
/** A subgraph title wraps to its box less this on each side, and never to
 *  less than the floor, so a one-node box can't stack it a word per line. */
const TITLE_PAD = 14;
const TITLE_MIN_WRAP = 120;
/** How far an attachment is held off a corner, so an edge never appears to
 *  hang from the very tip of a box. */
const CORNER_INSET = 7;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Half-extent of a shape along the face normal, at lateral offset `u` from
 *  the centre. `half` is the half-size along the normal, `halfLat` along the
 *  face. A box is flat; a circle and a diamond are not, and attaching an edge
 *  at a box's offset would leave it floating beside a diamond's slope. */
export function faceOffset(
  shape: NodeShape, half: number, halfLat: number, u: number,
): number {
  const t = halfLat === 0 ? 0 : Math.abs(u) / halfLat;
  switch (shape) {
    case "circle":
      return half * Math.sqrt(Math.max(0, 1 - t * t));
    case "diamond":
      return half * Math.max(0, 1 - t);
    case "hexagon":
      // Flat across the middle 70%, then sloping to the points. Clamped at
      // zero: `t` exceeds 1 whenever a bend sits outside the node's lateral
      // extent, and an unclamped slope would return a negative half-extent —
      // an attachment on the *far* side of the centre from its own face.
      return t <= 0.7 ? half : Math.max(0, half * (1 - (t - 0.7) / 0.3));
    case "round":
    case "stadium":
    case "cylinder":
    case "subroutine":
    case "asymmetric":
    case "rect":
    default:
      return half;
  }
}

/** Which face of `n` the point `p` faces, as an outward unit normal.
 *
 *  Decided by direction, not by distance to the nearest face line. The first
 *  draft took the nearest face, which is the same answer for a point *on* the
 *  box — every point dagre returned, then. A loop-bearing node now hands
 *  dagre a taller box, so an edge into its top arrives well above the drawn
 *  face, and from up there the *side* face lines are the nearer ones: the
 *  edge attached at a corner of the wrong face, seven pixels down. */
function faceNormal(n: PlacedNode, p: Point, rankFaces?: "vertical" | "horizontal"): Point {
  const dx = p.x - n.x, dy = p.y - n.y;
  const hx = Math.max(n.width / 2, 1e-6), hy = Math.max(n.height / 2, 1e-6);
  if (rankFaces === "vertical") return { x: 0, y: dy < 0 ? -1 : 1 };
  if (rankFaces === "horizontal") return { x: dx < 0 ? -1 : 1, y: 0 };
  if (Math.abs(dy) / hy >= Math.abs(dx) / hx) {
    return { x: 0, y: dy < 0 ? -1 : 1 };
  }
  return { x: dx < 0 ? -1 : 1, y: 0 };
}

/** The B5 attachment: slide the terminal point along its face until it lines
 *  up under the bend the edge is actually heading for. */
export function projectAttachment(
  n: PlacedNode, p: Point, toward: Point,
  /** Pin the edge to the node's rank-facing sides. Set for a node with
   *  self-loops, whose cross-axis faces belong to the loops: dagre gives it a
   *  box widened on both sides, so an edge arriving at a shallow angle meets
   *  that box's rank face well outside the drawn node, where the nearest
   *  drawn face would otherwise be the loop's. */
  rankFaces?: "vertical" | "horizontal",
): Point {
  const normal = faceNormal(n, p, rankFaces);
  const hx = n.width / 2, hy = n.height / 2;
  if (normal.y !== 0) {
    const limit = Math.max(0, hx - CORNER_INSET);
    const u = clamp(toward.x - n.x, -limit, limit);
    return { x: n.x + u, y: n.y + normal.y * faceOffset(n.shape, hy, hx, u) };
  }
  const limit = Math.max(0, hy - CORNER_INSET);
  const u = clamp(toward.y - n.y, -limit, limit);
  return { x: n.x + normal.x * faceOffset(n.shape, hx, hy, u), y: n.y + u };
}

/** How far the innermost self-loop's bow *reaches* from the face. The two
 *  deep control points sit further out — `curveBasis` does not pass through
 *  them — so geometry here is in terms of the reach, and the control depth is
 *  derived: `controlDepth(reach)`. With the face-level points either side (or
 *  the sweep knots, a few pixels off the face), the middle B-spline segment
 *  peaks at t = ½ with weights 1/48, 23/48, 23/48, 1/48, so the drawn apex is
 *  23/24 of the control depth. #504 used 5/6, which overshot by 15% of the
 *  reach: harmless on one loop (the label gap absorbed it), but in a stack the
 *  reach grows with the chips inside, and an outer arc ran through its own
 *  label. The innermost bow keeps its 26px control depth. */
const APEX = 23 / 24;
const controlDepth = (reach: number) => reach / APEX;
const LOOP_REACH = 26 * APEX;
/** Gap between a bow's apex and its chip. */
const LOOP_LABEL_GAP = 3;
/** A second loop on the same node bows outside the first one's chip: reach
 *  grows by the chip plus a gap plus this much clear. Two loops used to draw
 *  the same bow twice, and would have stacked their chips as well. */
const LOOP_STACK_CLEAR = 6;

function loopChip(label: RunLine[] | undefined): { width: number; height: number } {
  return label?.some((l) => l.length) ? measureEdgeLabel(label) : { width: 0, height: 0 };
}

/** Which way a node's self-loops bow: off a *cross-axis* face, one that no
 *  rank edge uses. Dagre gives every edge `minlen` 1, so an edge always
 *  arrives from the rank above or below (TD/BT) — from the left or right
 *  (LR/RL) — and ends on that rank-facing side. #504 put the loop there too,
 *  on the top face in TD, and reserved room along the rank axis, which moved
 *  the neighbours away but not the edges: every edge into that face crossed
 *  the reserved band exactly where the loop's label sat, and read as carrying
 *  it. On the Rule 30 board, the diagram self-loop labels were built for,
 *  101's label sat on the 110→101 edge. A cross-axis face is graphviz's
 *  convention for the same reason. */
type LoopSide = "right" | "bottom";
const loopSideFor = (horizontal: boolean): LoopSide => (horizontal ? "bottom" : "right");

/** A chip's extent along the bow's outward direction — the size that stacks
 *  when a node has several loops. #504 always used `height`, which is only
 *  right for a bow that points up or down; beside the node, chips stack by
 *  width, and two loops with a wider first label overlapped. */
const outward = (side: LoopSide, chip: { width: number; height: number }) =>
  side === "right" ? chip.width : chip.height;

/** Reach of the `index`th loop on a node whose earlier loops carry `chips`. */
function loopReach(side: LoopSide, chips: Array<{ width: number; height: number }>, index: number): number {
  let reach = LOOP_REACH;
  for (let k = 0; k < index; k++) {
    const extent = outward(side, chips[k]);
    reach += (extent ? extent + LOOP_LABEL_GAP : 0) + LOOP_STACK_CLEAR;
  }
  return reach;
}

/** Where a bow's legs leave the face, measured from the node's centre line. */
const bowLeg = (side: LoopSide, n: { width: number; height: number }) =>
  side === "right" ? Math.min(n.height / 2 * 0.6, 12) : Math.min(n.width / 2 * 0.5, 16);

/** How far across its outward direction the `index`th bow's control points
 *  sit, from the node's centre line. Normally the legs flare 0.35 R past
 *  where they leave the face. An outer bow of a stack must also clear every
 *  chip inside it — its legs run past them on the way out — and beside a
 *  node that is a chip's height, but below one it is a chip's *width*, which
 *  can be far wider than the node. The 5/4 is the control polygon's slack:
 *  `curveBasis` stays inside it. */
function bowFlare(
  side: LoopSide, n: { width: number; height: number }, reach: number,
  inner: Array<{ width: number; height: number }>,
): number {
  let flare = bowLeg(side, n) + controlDepth(reach) * 0.35;
  for (const chip of inner) {
    const across = side === "right" ? chip.height : chip.width;
    if (across) flare = Math.max(flare, (across / 2 + LOOP_LABEL_GAP + LOOP_STACK_CLEAR) * 5 / 4);
  }
  return flare;
}

/** Every loop's flare on one node, each at least a stack-clearance outside
 *  the one before. Sized by the chips alone, two outer bows around the same
 *  wide inner chip took the same flare and drew one pair of sides between
 *  them, so which bottom belonged to which label was a guess. */
function bowFlares(
  side: LoopSide, n: { width: number; height: number },
  chips: Array<{ width: number; height: number }>,
): number[] {
  const out: number[] = [];
  chips.forEach((_, k) => {
    const own = bowFlare(side, n, loopReach(side, chips, k), chips.slice(0, k));
    out.push(k === 0 ? own : Math.max(own, out[k - 1] + LOOP_STACK_CLEAR));
  });
  return out;
}

/** A self-loop dagre never sees: a bow off a cross-axis face (see LoopSide),
 *  with its label just past the apex. `reach` is where the drawn curve gets
 *  to. */
function selfLoopPoints(
  n: PlacedNode, side: LoopSide, reach: number, chip: { width: number; height: number },
  flare: number,
): { points: Point[]; labelPos?: Point } {
  const hx = n.width / 2, hy = n.height / 2;
  const leg = bowLeg(side, n);
  // An outer bow whose inner chips are wider than its legs' flare turns
  // outward at once — a knot just off the face — so its legs are already past
  // those chips' edges by the time they reach the chips' depth. Its deep
  // corners are doubled, so the B-spline hugs the rectangle rather than
  // cutting the corner diagonally across the chip inside it; with the middle
  // segment's four points then all at one depth, the drawn apex is that depth
  // exactly, not 23/24 of it.
  const sweep = flare > leg + controlDepth(reach) * 0.35 + 1e-9;
  const R = sweep ? reach : controlDepth(reach);
  // Built in the bow's own frame — `u` out from the face, `v` along it — and
  // mapped onto the side, so the two sides can't drift apart.
  const frame: Array<[number, number]> = sweep
    ? [[0, -leg], [LOOP_LABEL_GAP, -flare], [R, -flare], [R, -flare], [R, flare], [R, flare], [LOOP_LABEL_GAP, flare], [0, leg]]
    : [[0, -leg], [R, -flare], [R, flare], [0, leg]];
  if (side === "right") {
    return {
      points: frame.map(([u, v]) => ({ x: n.x + hx + u, y: n.y + v })),
      labelPos: chip.width
        ? { x: n.x + hx + reach + LOOP_LABEL_GAP + chip.width / 2, y: n.y }
        : undefined,
    };
  }
  return {
    points: frame.map(([u, v]) => ({ x: n.x - v, y: n.y + hy + u })),
    labelPos: chip.width
      ? { x: n.x, y: n.y + hy + reach + LOOP_LABEL_GAP + chip.height / 2 }
      : undefined,
  };
}

/** The box dagre is given for a node with self-loops: the measured node grown
 *  by the outermost loop's reach and chip on the loop's side — and, because
 *  dagre centres a node in its box, by the same on the opposite side — and,
 *  along the rank axis, to the widest bow flare or chip if that is larger
 *  than the node. The first growth is on the cross axis, where `nodesep`
 *  already spaces nodes and no rank edge runs; the second is usually nothing
 *  for a single loop. #504 grew only the outward size, and a chip wider than
 *  its node reached into the next node of the rank.
 *
 *  The trade, measured over 400 random graphs per direction against #504's
 *  layout: a TD/BT diagram's height — the chat bubble's — drops (mean 421 →
 *  326 px), and an LR/RL diagram's grows (180 → 254 px), because its loops
 *  now hang below the node instead of beside it. LR/RL grows in exchange for
 *  its labels no longer sitting on rank edges; #505's scroller carries the
 *  width either way. */
function loopBox(
  loops: Array<{ labelRuns?: RunLine[] }>, side: LoopSide, width: number, height: number,
): { width: number; height: number } {
  if (loops.length === 0) return { width, height };
  const chips = loops.map((e) => loopChip(e.labelRuns));
  const flares = bowFlares(side, { width, height }, chips);
  let reserve = 0, across = side === "right" ? height : width;
  chips.forEach((chip, k) => {
    const reach = loopReach(side, chips, k);
    const extent = outward(side, chip);
    reserve = Math.max(reserve, reach + (extent ? LOOP_LABEL_GAP + extent : 0));
    const chipAcross = side === "right" ? chip.height : chip.width;
    across = Math.max(across, 2 * flares[k], chipAcross);
  });
  return side === "right"
    ? { width: width + 2 * reserve, height: across }
    : { width: across, height: height + 2 * reserve };
}

/** Where an edge attached at `end` on a loop-bearing node crosses the face of
 *  dagre's inflated box, level with `end` — on the side the edge comes from.
 *  Null when that box is no larger than the node along the rank axis, where
 *  the knot would sit on the attachment itself. */
function rankKnot(
  n: PlacedNode, box: { width: number; height: number }, end: Point, from: Point, horizontal: boolean,
): Point | null {
  if (horizontal) {
    const half = box.width / 2;
    if (half - n.width / 2 < 0.5) return null;
    return { x: n.x + (from.x < n.x ? -half : half), y: end.y };
  }
  const half = box.height / 2;
  if (half - n.height / 2 < 0.5) return null;
  return { x: end.x, y: n.y + (from.y < n.y ? -half : half) };
}

export function layoutDiagram(ir: DiagramIR): Placed {
  const g = new dagre.graphlib.Graph({ multigraph: true, compound: true });
  g.setGraph({
    rankdir: ir.direction,
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    marginx: MARGIN,
    marginy: MARGIN,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const horizontal = ir.direction === "LR" || ir.direction === "RL";
  const side = loopSideFor(horizontal);
  const loops = ir.edges.filter((e) => e.from === e.to);
  const linked = ir.edges.filter((e) => e.from !== e.to);
  const loopsOf = new Map<string, typeof loops>();
  for (const e of loops) loopsOf.set(e.from, [...(loopsOf.get(e.from) ?? []), e]);

  const byId = new Map<string, PlacedNode>();
  for (const n of ir.nodes) {
    // `classDef`/`class`/`:::` resolved here rather than left in the IR. The
    // first draft parsed them, carried them through, and never read them: a
    // `classDef hot fill:#f00` produced no `#f00` anywhere, while the same
    // colour via `style` worked. Classes apply in declaration order and an
    // inline `style` wins over all of them, which is mermaid's precedence.
    const style = n.classes.reduce<Record<string, string>>(
      (acc, c) => Object.assign(acc, ir.classDefs[c] ?? {}),
      {},
    );
    Object.assign(style, n.style ?? {});
    const runs = withFontStyle(n.runs, style);
    const { width, height } = measureNode(runs);
    const placed: PlacedNode = {
      id: n.id, lines: n.lines, runs, shape: n.shape, classes: n.classes,
      style: Object.keys(style).length ? style : undefined,
      x: 0, y: 0, width, height,
    };
    byId.set(n.id, placed);
    // The drawn node keeps its measured size; only dagre's idea of it grows.
    // `projectAttachment` snaps every edge end back onto the measured face.
    g.setNode(n.id, loopBox(loopsOf.get(n.id) ?? [], side, width, height));
  }

  for (const sg of ir.subgraphs) {
    g.setNode(sg.id, { label: sg.title, clusterLabelPos: "top" });
    for (const id of sg.nodes) if (byId.has(id)) g.setParent(id, sg.id);
  }

  linked.forEach((e, i) => {
    const attrs: Record<string, unknown> = {};
    if (e.label && e.labelRuns) {
      const m = measureEdgeLabel(e.labelRuns);
      attrs.width = m.width;
      attrs.height = m.height;
      attrs.labelpos = "c";
    }
    g.setEdge(e.from, e.to, attrs, `e${i}`);
  });

  dagre.layout(g);

  for (const [id, placed] of byId) {
    const n = g.node(id);
    if (!n) continue;
    placed.x = n.x;
    placed.y = n.y;
  }

  const edges: PlacedEdge[] = linked.map((e, i) => {
    const d = g.edge({ v: e.from, w: e.to, name: `e${i}` }) as
      { points: Point[]; x?: number; y?: number } | undefined;
    const raw = (d?.points ?? []).map((p) => ({ x: p.x, y: p.y }));
    const src = byId.get(e.from), dst = byId.get(e.to);
    const points = raw.map((p) => ({ ...p }));
    if (points.length >= 2 && src && dst) {
      const rankFaces = (id: string) => (loopsOf.has(id) ? (horizontal ? "horizontal" : "vertical") : undefined);
      points[0] = projectAttachment(src, points[0], points[1], rankFaces(e.from));
      points[points.length - 1] =
        projectAttachment(dst, points[points.length - 1], points[points.length - 2], rankFaces(e.to));
      // On a loop-bearing node, dagre ended the edge on the box it was given,
      // which is wider than the drawn node, and the attachment above pulls the
      // end back onto the drawn face. The leg between them ran diagonally —
      // through the loop's label, when the label was wider than the node
      // (LR fan-in: claude-w6c1k8h4:7). A knot where the edge meets dagre's
      // box, level with the attachment, makes the last leg run straight along
      // the rank axis inside the node's own band, which no chip enters.
      if (loopsOf.has(e.to)) {
        const k = rankKnot(dst, g.node(e.to), points[points.length - 1], points[points.length - 2], horizontal);
        if (k) points.splice(points.length - 1, 0, k);
      }
      if (loopsOf.has(e.from)) {
        const k = rankKnot(src, g.node(e.from), points[0], points[1], horizontal);
        if (k) points.splice(1, 0, k);
      }
    }
    return {
      from: e.from, to: e.to, points,
      label: e.label, labelRuns: e.labelRuns,
      labelPos: d?.x !== undefined && d?.y !== undefined ? { x: d.x, y: d.y } : undefined,
      arrow: e.arrow, line: e.line, selfLoop: false,
    };
  });

  for (const [id, own] of loopsOf) {
    const n = byId.get(id);
    if (!n) continue;
    const chips = own.map((e) => loopChip(e.labelRuns));
    const flares = bowFlares(side, n, chips);
    own.forEach((e, k) => {
      const reach = loopReach(side, chips, k);
      const flare = flares[k];
      const { points, labelPos } = selfLoopPoints(n, side, reach, chips[k], flare);
      edges.push({
        from: e.from, to: e.to, points,
        label: e.label, labelRuns: e.labelRuns, labelPos,
        arrow: e.arrow, line: e.line, selfLoop: true,
      });
    });
  }

  const clusters: PlacedCluster[] = ir.subgraphs.flatMap((sg) => {
    const c = g.node(sg.id) as { x: number; y: number; width: number; height: number } | undefined;
    // An empty or unsized cluster is dropped rather than drawn: dagre leaves
    // its geometry undefined, and emitting that produced `width="NaN"` and a
    // title floating away from its own members.
    if (!c || ![c.x, c.y, c.width, c.height].every(Number.isFinite)) return [];
    if (c.width <= 0 || c.height <= 0) return [];
    // The members size the box and the title fits what they leave: it wraps
    // to the box's width, and the box grows upward a line for each line past
    // the one dagre left room for. Upward is into the rank or node gap above,
    // which nothing reserved, so a title of many lines can reach a neighbour
    // there; a title is rarely more than a few words.
    const titleLines = wrapRuns(sg.titleRuns, Math.max(c.width - 2 * TITLE_PAD, TITLE_MIN_WRAP), LABEL_FONT_SIZE);
    const grow = (titleLines.length - 1) * LABEL_FONT_SIZE * LINE_HEIGHT;
    return [{
      id: sg.id, title: sg.title, titleRuns: sg.titleRuns, titleLines,
      x: c.x, y: c.y - grow / 2, width: c.width, height: c.height + grow,
    }];
  });

  const graph = g.graph() as { width?: number; height?: number };
  // A synthesised self-loop bows outside whatever dagre measured — and on a
  // top-rank node it bows *above* the origin, which the first draft clipped
  // because it only ever grew the maximum. So take the union in both
  // directions and shift everything back into view. The union covers the
  // label chips too, by their rect and not their centre: a chip is wider than
  // the point it hangs on, and on a right-hand node a loop's chip sits past
  // `graph.width`, where only the maximum side would notice.
  let minX = 0, minY = 0;
  let maxX = graph.width ?? 0, maxY = graph.height ?? 0;
  for (const e of edges) {
    for (const p of e.points) {
      minX = Math.min(minX, p.x - MARGIN);
      minY = Math.min(minY, p.y - MARGIN);
      maxX = Math.max(maxX, p.x + MARGIN);
      maxY = Math.max(maxY, p.y + MARGIN);
    }
    if (e.label && e.labelPos) {
      const { width, height } = measureEdgeLabel(e.labelRuns ?? e.label);
      minX = Math.min(minX, e.labelPos.x - width / 2 - MARGIN);
      minY = Math.min(minY, e.labelPos.y - height / 2 - MARGIN);
      maxX = Math.max(maxX, e.labelPos.x + width / 2 + MARGIN);
      maxY = Math.max(maxY, e.labelPos.y + height / 2 + MARGIN);
    }
  }
  // dagre never sees a cluster's title or the growth that holds it: a box
  // grown upward can rise past y = 0, and a title wider than its box (one
  // word too long, or a box under the wrap floor) past x = 0, where no scroll
  // reaches. Both join the union like an edge label does.
  for (const c of clusters) {
    const { width } = measureEdgeLabel(c.titleLines);
    minX = Math.min(minX, c.x - width / 2 - MARGIN);
    maxX = Math.max(maxX, c.x + width / 2 + MARGIN);
    minY = Math.min(minY, c.y - c.height / 2 - MARGIN);
  }
  if (minX < 0 || minY < 0) {
    const dx = -Math.min(0, minX), dy = -Math.min(0, minY);
    for (const n of byId.values()) { n.x += dx; n.y += dy; }
    for (const c of clusters) { c.x += dx; c.y += dy; }
    for (const e of edges) {
      for (const p of e.points) { p.x += dx; p.y += dy; }
      if (e.labelPos) { e.labelPos.x += dx; e.labelPos.y += dy; }
    }
    maxX += dx;
    maxY += dy;
  }
  return { width: Math.ceil(maxX), height: Math.ceil(maxY), nodes: [...byId.values()], edges, clusters };
}

/** A node-wide `font-weight` / `font-style` (from `style` or a `classDef`) as
 *  run flags. Folding it in here rather than setting it on the `<text>` means
 *  the box is measured in the weight it is drawn in, and a run the label
 *  already made bold stays bold. */
function withFontStyle(runs: LabelLine[], style: Record<string, string>): LabelLine[] {
  const w = style["font-weight"]?.toLowerCase();
  const bold = w === "bold" || w === "bolder" || (!!w && /^[6-9]00$/.test(w));
  const italic = /^(italic|oblique)$/i.test(style["font-style"] ?? "");
  if (!bold && !italic) return runs;
  const restyle = (line: RunLine): RunLine => line.map((r) => ({
    ...r, ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}),
  }));
  return runs.map((line) => (isTable(line)
    ? { ...line, header: line.header.map(restyle), rows: line.rows.map((row) => row.map(restyle)) }
    : restyle(line)));
}
