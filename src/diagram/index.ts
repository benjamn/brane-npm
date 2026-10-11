/** ```mermaid source → SVG, or a refusal.
 *
 *  The one entry point, and deliberately the *same* one for both targets: the
 *  app fetches it through `POST /api/diagram`, the HTML export calls it
 *  directly in its fence loop. That is the "one renderer, two targets" rule
 *  the KaTeX path already follows — an export is a snapshot of the live view
 *  rather than a lookalike of it.
 *
 *  Unlike KaTeX it runs only on the daemon. Inline math is ubiquitous and
 *  light, so it is worth bundling; diagrams are rare and heavy, like the
 *  syntax highlighting that already lives behind `POST /api/highlight`.
 *
 *  `null` is the fallback signal, and both call sites already handle it: the
 *  export substitutes only non-null results, and the app's code view renders
 *  plain when its fetch comes back empty. So a refused diagram is the
 *  highlighted code block a mermaid fence renders as today — no new path.
 */

import { createHash } from "node:crypto";
import { parseDiagram } from "./parse.js";
import { layoutDiagram } from "./layout.js";
import { renderSvg } from "./svg.js";
import type { DiagramIR, DiagramRefusal, LabelNote } from "./types.js";

export type { DiagramRefusal, LabelNote } from "./types.js";
export { parseLabel, wrapRuns, MARKDOWN_WRAP_WIDTH } from "./label.js";
export { parseDiagram } from "./parse.js";
export { layoutDiagram, projectAttachment, faceOffset } from "./layout.js";
export { basisPath, renderSvg, esc } from "./svg.js";
export { textWidth, charWidth, runWidth, measureNode, measureEdgeLabel } from "./metrics.js";

export interface DiagramResult {
  svg: string;
  /** Node labels, so the caller can index them as text rather than leaving a
   *  fence to be indexed as source. */
  labels: string[];
}

export interface RenderOptions {
  /** Resolve a node label to a link — where `markdown-nids`, mentions and
   *  protocol links reach inside a diagram. */
  hrefFor?: (label: string) => string | null;
  /** Add the hover/tap edge highlight layer. The export and `/api/diagram`
   *  ask for it, and their pages carry `DIAGRAM_EDGE_HIGHLIGHT_CSS`. */
  edgeHighlight?: boolean;
}

/** A source larger than this is not a diagram anyone will read, and layout is
 *  synchronous on the daemon's only thread. */
export const MAX_SOURCE_BYTES = 24_000;
/** Likewise: dagre is O(V·E)-ish and a pathological graph must not stall the
 *  daemon. Both bounds refuse rather than truncate. */
export const MAX_NODES = 300;
export const MAX_EDGES = 600;

/** Parse once, and check the bounds against the result. `diagnoseDiagram` and
 *  `renderDiagram` both need exactly this, and calling the former from the
 *  latter parsed the same source twice on the rendering path. */
function parseWithin(source: string):
  { ok: true; ir: DiagramIR } | { ok: false; refusal: DiagramRefusal } {
  if (source.length > MAX_SOURCE_BYTES) {
    return { ok: false, refusal: { kind: "unsupported", message: `diagram source is over ${MAX_SOURCE_BYTES} bytes` } };
  }
  const parsed = parseDiagram(source);
  if (!parsed.ok) return { ok: false, refusal: parsed.refusal };
  if (parsed.ir.nodes.length > MAX_NODES) {
    return { ok: false, refusal: { kind: "unsupported", message: `diagram has more than ${MAX_NODES} nodes` } };
  }
  if (parsed.ir.edges.length > MAX_EDGES) {
    return { ok: false, refusal: { kind: "unsupported", message: `diagram has more than ${MAX_EDGES} edges` } };
  }
  return { ok: true, ir: parsed.ir };
}

export function diagnoseDiagram(source: string): DiagramRefusal | null {
  return inspectDiagram(source).refusal;
}

/** Everything `narrate` reports about one fence, from one parse: whether it
 *  draws at all, and if it does, which label markup draws as typed. */
export function inspectDiagram(source: string): { refusal: DiagramRefusal | null; literal: LabelNote[] } {
  const checked = parseWithin(source);
  return checked.ok
    ? { refusal: null, literal: checked.ir.literal }
    : { refusal: checked.refusal, literal: [] };
}

export function renderDiagram(source: string, opts: RenderOptions = {}): DiagramResult | null {
  const parsed = parseWithin(source);
  if (!parsed.ok) return null;
  try {
    const placed = layoutDiagram(parsed.ir);
    if (!Number.isFinite(placed.width) || !Number.isFinite(placed.height) ||
        placed.width <= 0 || placed.height <= 0) {
      return null;
    }
    const idSuffix = createHash("sha256").update(source).digest("hex").slice(0, 8);
    return {
      svg: renderSvg(placed, { hrefFor: opts.hrefFor, idSuffix, edgeHighlight: opts.edgeHighlight }),
      labels: parsed.ir.nodes.map((n) => n.lines.join(" ")),
    };
  } catch {
    // dagre throws on graph shapes it cannot rank. A thrown layout is a
    // fallback, never a 500 — the reader still gets the source.
    return null;
  }
}
