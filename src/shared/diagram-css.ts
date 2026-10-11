/** The rule that makes a diagram's edge highlight layer visible.
 *
 *  `svg.ts` draws each edge a second time, on top, hidden by an `opacity`
 *  attribute (see `edgeHighlight` there). Hover an arrow or its label, or tap
 *  one (the group takes focus), and this reveals it. The SVG itself can't
 *  carry the rule: an inline SVG's `<style>` is document-global. So the
 *  export writes this string into its stylesheet and the app injects the same
 *  string, the arrangement `MATH_BLOCK_CSS` has, so the two cannot drift.
 *
 *  Any CSS rule outranks a presentation attribute, which is what lets one
 *  generic selector reveal any edge of any diagram. */
export const DIAGRAM_EDGE_HIGHLIGHT_CSS = `
.brane-diagram .brane-diagram-edge-hl { cursor: pointer; outline: none; }
.brane-diagram .brane-diagram-edge-hl:hover,
.brane-diagram .brane-diagram-edge-hl:focus { opacity: 1; }
`;
