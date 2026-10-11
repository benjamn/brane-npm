# Diagram Rendering

A ` ```mermaid ` fence draws. Like code highlighting and unlike KaTeX it renders
**on the daemon** — `POST /api/diagram` for the app, a direct call for the HTML
export — because a diagram is rare and heavy where inline math is ubiquitous and
light. The Expo bundle gains nothing: `@dagrejs/dagre` (1.9 MB, 2 packages) is
the only new dependency and it never reaches the browser.

| Piece | Where | Does |
|---|---|---|
| `parseDiagram` | `src/diagram/parse.ts` | Source → IR, or a refusal with a reason and a line. Linear time — see below |
| `parseLabel` | `src/diagram/label.ts` | Label text → lines of styled runs, for both of mermaid's label grammars — see below |
| `measureNode` | `src/diagram/metrics.ts` | Text width without a DOM — Helvetica and Helvetica-Bold advances, per-block fallbacks |
| `layoutDiagram` | `src/diagram/layout.ts` | dagre, plus **face-projected attachment** (below), resolved `classDef`s, and synthesised self-loops |
| `basisPath` | `src/diagram/svg.ts` | `d3-shape`'s `curveBasis`, ported; pinned against d3's own output |
| `nidHrefFor` | `src/diagram/links.ts` | The seam: a node labelled with a real narrative becomes a link. Takes the target form, so the export points at sibling `<nid>.html` files rather than the app's `brane://` scheme |
| `renderDiagram` | `src/diagram/index.ts` | The one entry point, for both targets |
| `edgeHighlight` / `DIAGRAM_EDGE_HIGHLIGHT_CSS` | `src/diagram/svg.ts`, `src/shared/diagram-css.ts` | Hover or tap an arrow, or its label, to draw it again in a highlight color, above every other edge and label and below the boxes, which cover its ends. CSS only, so the export stays scriptless; the export inlines the rule and `DiagramView` injects the same string. Label groups paint above line groups, so a later arrow's hit stroke cannot cover an earlier arrow's label |

**The dialect is measured, not chosen.** Across every mermaid fence in the
archive (21 diagrams, 316 lines, home brane plus two absorbed ones): `flowchart`
and `graph` only, `-->` 131 and `<-->` 9, `[rect]` 125 · `(round)` 9 ·
`[(cyl)]` 5 · `{diamond}` 4 · `>asym]` 4 · `[[sub]]` 1, plus `subgraph`, `&`,
`<br/>`, `classDef`/`class`/`style` and `%%`. So that is what draws, and 20 of
the 21 do; the refusal is the one `stateDiagram-v2`, a later increment. Bump the
census when the dialect grows. Styled label text is the one part of the
dialect admitted without a count: on 2026-10-01 this daemon's 26 fences held
no markdown string, `<b>` or `font-weight` at all, but an agent on another
daemon that wanted bold tried all three in a row and got literal tags, then
literal backticks and asterisks, then nothing, with a clean receipt each time
(claude-cdouqlgt:12–:24). Absence from the census was the quiet failure, not
disuse.

Eight things are less obvious than they look:

**The dialect adds no syntax.** Every brane-specific behaviour is
*interpretation* of text that is already legal mermaid — a node labelled
`claude-0qjv4nny` is a link here and plain text on GitHub. So the same fence
stays portable, and there is no second grammar to keep in step. Only a label
that is *entirely* a reference resolves, and only to a narrative that exists,
which is the rule `markdown-nids.ts` already applies in prose. A node **cites
and does not address**: `@nid` is deliberately not linked, because
`mentions-scan` walks the rendered markdown where a fence is inert, so linking
it would show a mention that notifies nobody.

**Arrows arrive crooked because of the attachment point, not the curve.** dagre
picks an edge's terminal point by intersecting the node's box with the chord
from the node's *centre* to the first bend; that chord is diagonal, so the tilt
is baked in before any curve is fitted — 28px of lean on the LIVE loop's
`Listen → Interpret`. `projectAttachment` slides the point along its face until
it lines up under the bend, which drops mean arrival angle from 31.4° to 8.7°
**with the curve untouched**. Four curve-side fixes were built and measured
first (clamped-tangent Hermite, basis + normal stubs, basis + straight tail,
rotating the arrowhead alone); every one bought squareness by adding
inflections, and inflections are what read as busy. `curveBasis` stays exactly
what mermaid uses. `faceOffset` generalises the projection to diamonds, circles
and hexagons, whose boundary is not a box.

**A refusal is a normal answer, and needs no new failure path.** `renderDiagram`
returns `null`, and both call sites already handled that: `export.ts`'s fence
loop substitutes only non-null results, and the app's `DiagramView` falls back
to `HighlightedCode`. So an undrawn diagram is exactly the highlighted code
block a mermaid fence rendered as before this existed. `diagnoseDiagram` reports
*why* through `narrate`'s `warnings` (`diagram_unsupported`,
`diagram_parse_error`) — the same real decision the renderer takes, over fences
found by `fromMarkdown` rather than by a pattern. The first draft scanned for
them with a regex three lines under a comment forbidding exactly that, and it
disagreed with the renderers in both directions: a mermaid fence quoted inside
a longer ```` fence warned about a diagram that was never going to draw, and
one inside a blockquote drew but was never diagnosed.

**Nothing from a fence reaches the output as markup.** Labels are escaped;
`<br/>`, `<b>` and markdown strings are parsed into styled runs, which become
`<tspan>`s whose attributes `svg.ts` writes itself; `style` declarations are
filtered to seven properties with a value charset that excludes `url(`, and
`font-weight`/`font-style` to their keywords.
There is deliberately **no `<style>` element** — an inline SVG's `<style>` is
*document*-global, so one diagram's `text { font-family }` would restyle every
other diagram on the page. Theming is CSS custom properties
(`--brane-diagram-*`) **whose fallbacks are brane's dark palette**, and marker
ids are hashed per source so two diagrams on a page cannot share an arrowhead.
The fallbacks matter more than the properties: nothing defines the latter, and
the first draft shipped light-mode values that drew `#33373d` lines on the
app's `#121214` and the export's `#000`.

**Labels have two grammars, and only one of them is markdown.** In a plain
label (`A[text]`, `A["text"]`) mermaid honours `<br/>`, `<b>`, `<i>`,
`<code>`, `<u>`, `<s>` and their kin, and `**x**` is two asterisks, on GitHub
too. A **markdown string** (``A["`text`"]``) is the other: the backticks just
inside the quotes are mermaid's marker, not over-quoting, and inside one
`**bold**` and `*italic*` render, a newline is a line break, and long lines
wrap. `label.ts` parses each into runs (`{ text, bold?, italic?, code?,
strike?, underline? }`) that the IR carries beside the plain `lines` links and
search still read. A markdown string goes through `fromMarkdown`, so "bold" means
here what it means in prose. It can span source lines, so the parser joins a
statement until every ``"` `` it opened is closed, held to `MAX_LINE_LENGTH`
like a line. Wrapping is mermaid's 200px at its 16px, scaled to brane's 14px:
the em width is what decides where a line breaks, and an unscaled 200px kept
together words that GitHub splits. Bold is measured with Helvetica-Bold's own
advances, so a bold head gets the box it needs. `font-weight` and
`font-style` from `style` or `classDef` are folded into the runs in layout, so
what is measured is what is drawn. Everything that still shows as typed (`**`
in a plain label, an unknown tag, a link in a markdown string) comes back from
the same parse as a `diagram_label_literal` warning that says how to style it.
The diagram still draws. It is a note, not a refusal.

A node's markdown string may also hold a **GFM table**, which mermaid does not
draw at all ("Unsupported markdown: table"). Brane draws it, and that is
allowed for two reasons. The fence is still valid mermaid, so GitHub shows the
fallback text and nothing breaks. And the drawing is static SVG made on the
daemon, so the HTML export carries no rendering logic for it (the condition
the operator set, claude-uwaj0umf:33). A table is a `TableBlock` among the
label's lines and takes `1 + rows` line slots. Its columns share widths, which
is the one thing a stack of centred `<tspan>`s cannot express, so a node
holding one is drawn as a `<text>` per line or cell on the same baselines the
stack would have used. Header cells are bolded at parse time, so measurement
and drawing agree without either knowing which row is the header. Edge labels
and subgraph titles have no box for a grid, so there a table shows as source,
with a warning. Plain labels also decode character references (`&lt;`,
`&#x2192;`, `&rarr;`) after tags are scanned, as mermaid's HTML labels do, so
a decoded `<` is never read as a tag.

**The parser runs on the `narrate` path, so its cost is a security property.**
`diagnoseMarkdown` calls it for every narration containing a mermaid fence, no
route and no operator involved. The first draft's inline-label patterns were
`-{2,}\s+(.+?)\s+-{2,}>` — three overlapping quantifiers over whitespace,
cubic in the run length, 1.5 s on a 2,000-space line and 8× per doubling, with
`MAX_SOURCE_BYTES` no defence because it bounds *n* while the cost is n³. Label
groups now anchor both ends on a non-space and exclude their own link's
punctuation, there is a `MAX_LINE_LENGTH`, and `diagram-review.test.ts` asserts
the complexity rather than the timing. Treat any future regex here the same
way.

**A wrong diagram is worse than no diagram.** Three of the review findings on
the original PR were *silent*: `A -.-> B -.-> C` drew one edge and dropped a
node, `A --- B --> C` likewise, and an edge into a subgraph id threw inside
dagre, was caught, and fell back with no warning at all — breaking the "warns
iff the operator sees source" rule below. The parser now refuses each with a
reason. When in doubt, refuse: the reader gets source and the author gets told.

**Self-loops are never given to dagre, and bow off a face no rank edge uses.**
Dagre returns a degenerate path for `A --> A` — duplicated points that double
back and start outside the node — so a loop is synthesised as an arc, with its
label past the apex. It leaves a *cross-axis* face (right in TD/BT, bottom in
LR/RL): dagre gives every edge `minlen` 1, so edges arrive only on the
rank-facing sides, and a loop there put its label exactly where they cross —
on the Rule 30 board, 101's label read as the 110→101 edge's. Dagre is told
about the loop by a box grown on the cross axis (`loopBox`), which keeps
neighbours clear: a TD/BT diagram's height (the chat bubble's) drops against
#504's layout, and an LR/RL one's grows, since its loops now hang below the
node — the price of labels that no longer sit on rank edges. Edges on a
loop-bearing node are pinned to its rank faces, and run straight along the
rank axis from dagre's widened box to the drawn face (`rankKnot`), so a steep
edge's last leg can't cut the corner of a chip wider than the node. A bow's
drawn apex is 23/24 of its control depth; label placement depends on it. Stacked loops step outward by
each chip's extent along the bow, and an outer bow flares past every chip
inside it. `diagram-self-loop-labels.test.ts` holds each chip against every
other edge's drawn *path*, not just other chips — the check the first
version lacked. Parallel and antiparallel edges, by contrast, dagre separates
correctly on its own.

Native renders the code block: there is no DOM to put an SVG into, and the
honest options are their own change.
