/** Parser for the flowchart subset brane renders.
 *
 *  Scope is empirical. Across every ```mermaid fence in the archive — 21
 *  diagrams, 316 lines, home brane plus the absorbed ChatGPT and organelle
 *  branes — the census was:
 *
 *    headers    flowchart TD 9 · graph TD 8 · flowchart LR 3 · stateDiagram-v2 1
 *    arrows     --> 131 · <--> 9 · zero -.->, ==>, ---, ~~~
 *    shapes     [rect] 125 · (round) 9 · [(cyl)] 5 · {diamond} 4 · >asym] 4 · [[sub]] 1
 *    also       subgraph 10 · & fan-out 13 · <br/> 15 · classDef/class 3+3 · style 2 · %%
 *    absent     click, linkStyle, and every diagram type but flowchart
 *
 *  So: flowcharts, and everything else refuses. A refusal is not a failure —
 *  it renders as the highlighted code block a mermaid fence already produces,
 *  and `narrate` reports it so the author learns the diagram did not draw.
 *
 *  The dotted and thick link forms are parsed although the census counted
 *  none: they cost one alternation here and one dash array in the renderer,
 *  and refusing them would be a worse first impression than drawing them.
 *  That turned out to be the right call for a reason better than taste — run
 *  against the archive, this parser found a `-. "…" .->` the census's
 *  arrow-shape grep had missed, because it only looked for bare arrows.
 *
 *  Current standing against the archive: 20 of 21 draw. The one refusal is
 *  the `stateDiagram-v2`, which is a later increment rather than a defect.
 */

import type {
  ArrowKind, Direction, DiagramEdge, DiagramIR, DiagramNode, DiagramRefusal,
  LabelNote, LineKind, NodeShape, Subgraph,
} from "./types.js";
import { type ParsedLabel, parseLabel, plainLabel, textLines } from "./label.js";

export type ParseResult =
  | { ok: true; ir: DiagramIR }
  | { ok: false; refusal: DiagramRefusal };

/** A header, with two tolerances mermaid has and the first draft did not:
 *  a trailing `;` (statements strip one, but the header was tested raw, so
 *  `graph TD;` — a common habit in the absorbed ChatGPT history — was
 *  refused), and an absent direction, which mermaid defaults to TB. */
const HEADER = /^\s*(flowchart|graph)(?:\s+(TB|TD|LR|RL|BT))?\s*;?\s*$/i;
/** Diagram types brane recognises by name, so the refusal can say which. */
const OTHER_TYPES =
  /^\s*(sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|gantt|pie|gitGraph|journey|timeline|mindmap|quadrantChart|xychart(?:-beta)?|requirementDiagram|C4Context|sankey(?:-beta)?|block(?:-beta)?)\b/i;

/** Openers longest-first: `[[` must beat `[`, `((` must beat `(`. */
const SHAPES: Array<[string, string, NodeShape]> = [
  ["([", "])", "stadium"],
  ["[[", "]]", "subroutine"],
  ["[(", ")]", "cylinder"],
  ["((", "))", "circle"],
  ["{{", "}}", "hexagon"],
  ["[", "]", "rect"],
  ["(", ")", "round"],
  ["{", "}", "diamond"],
  [">", "]", "asymmetric"],
];

/** The inline-label link forms: `A -- text --> B`, `A -. text .-> B`,
 *  `A == text ==> B`. Tried before the bare forms, and safe there because each
 *  requires whitespace where the bare form requires more dashes.
 *
 *  The census found no `-- text -->`, which is why the spec left these out —
 *  but running the parser over the archive turned up a `-. "…" .->` in a
 *  lattice diagram, so the census undercounted rather than the form being
 *  unused.
 *
 *  Two properties of the label group are load-bearing, and the obvious
 *  `\s+(.+?)\s+` has neither.
 *
 *  **It cannot match whitespace at either end.** `\s+(.+?)\s+` makes the
 *  boundary between the padding and the label ambiguous at every position, and
 *  with three such quantifiers the cost is cubic in the run length: on
 *  `A -- <N spaces> x` this measured 17 ms at N=250, 30 ms at 500, 195 ms at
 *  1000 and 1542 ms at 2000 — a clean 8× per doubling. `MAX_SOURCE_BYTES`
 *  is no defence, since it bounds *n* while the cost is n³. It mattered
 *  because `diagnoseMarkdown` runs on **every narration containing a mermaid
 *  fence**, so this was a daemon-wide stall reachable by narrating.
 *  `[^\s](?:[^]*?[^\s])?` anchors both ends on a non-space and removes the
 *  ambiguity outright.
 *
 *  **It cannot contain the link's own punctuation.** `(.+?)` is lazy but will
 *  still cross a whole link to reach a later terminator, so `A -.-> B -.-> C`
 *  matched one edge `A → C` labelled `-> B -` and dropped B — a plausible,
 *  wrong diagram drawn in silence, which is worse than a refusal.
 *
 *  What each form excludes differs, and the archive is why. A solid label
 *  cannot contain `>`, since that is what stops `A -- x --> B -- y --> C`
 *  spanning two links. A *dotted* label may — the lattice diagram's
 *  `-. "All<String, true> ⇒ ⊥" .->` needs it — so it excludes `.` instead,
 *  which is the dotted closer's own distinguishing character, and additionally
 *  forbids a leading `-` or `>`, which is what declines the `-.->` in
 *  `A -.-> B -.-> C` before the label ever begins.
 *
 *  The cost is that a dotted label containing a literal `.` is not read. The
 *  archive has none, and the failure is a refusal — source plus a warning —
 *  rather than a wrong picture, which is the trade this whole module makes.
 *
 *  **The opener is exactly two dashes**, as in mermaid, not `-{2,}`. Three is
 *  an open link, so a greedy opener read `A --- B --> C` as one edge `A → C`
 *  labelled `B`, losing a node in silence the same way. With `--`, the `-` in
 *  `--- B` cannot be the required whitespace and the form declines, leaving
 *  the bare `---` to match as the open link it is.
 */
const LABELLED_ARROWS: Array<[RegExp, ArrowKind, LineKind]> = [
  [/^<--[ \t]+([^\s>][^>]*[^\s>]|[^\s>])[ \t]+-{2,}>/, "biarrow", "solid"],
  [/^-\.[ \t]*([^\s.>-][^.]*[^\s.]|[^\s.>-])[ \t]*\.-*->/, "arrow", "dotted"],
  [/^==[ \t]+([^\s>][^>]*[^\s>]|[^\s>])[ \t]+={2,}>/, "arrow", "thick"],
  [/^--[ \t]+([^\s>][^>]*[^\s>]|[^\s>])[ \t]+-{2,}>/, "arrow", "solid"],
];

/** A line longer than this is refused unparsed.
 *
 *  Belt to the braces above: the patterns are linear now, but a parser on the
 *  `narrate` path should not depend on every future regex staying that way,
 *  and no diagram anyone reads has a 2,000-character line. */
const MAX_LINE_LENGTH = 2000;

const ARROWS: Array<[RegExp, ArrowKind, LineKind]> = [
  [/^<-{2,}>/, "biarrow", "solid"],
  [/^<=+>/, "biarrow", "thick"],
  [/^-\.-*->/, "arrow", "dotted"],
  [/^={2,}>/, "arrow", "thick"],
  [/^-{2,}>/, "arrow", "solid"],
  [/^-{3,}/, "open", "solid"],
];

/** A node id. Hyphens are legal in one — `claude-0qjv4nny` is the shape brane
 *  cares about most — but a naive `[\w-]*` eats the arrow in `A-->B`, which
 *  agents write without spaces. Requiring a word character *after* each hyphen
 *  stops the id at the first `--` while still admitting the hyphenated form. */
const ID = /^[A-Za-z_]\w*(?:-[A-Za-z0-9_]+)*/;

/** Style properties worth honouring, and the only ones let through. An
 *  arbitrary CSS property from a fence is markup we did not write. */
const SAFE_STYLE = new Set([
  "fill", "stroke", "stroke-width", "stroke-dasharray", "color",
  // The weight and slant of a node's whole label. Dropped in silence before,
  // which is how `classDef key font-weight:bold` drew nothing and said nothing
  // (claude-cdouqlgt:24).
  "font-weight", "font-style",
]);
/** Values are colours, lengths and keywords — never `url(...)`, never a
 *  semicolon that could close the declaration and open another. */
const SAFE_VALUE = /^[#\w\s.,%()-]{1,64}$/;

function parseStyleBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of body.split(/[,;]/)) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!SAFE_STYLE.has(prop)) continue;
    if (!SAFE_VALUE.test(value) || /url\s*\(/i.test(value)) continue;
    if (FONT_VALUES[prop] && !FONT_VALUES[prop].test(value)) continue;
    out[prop] = value;
  }
  return out;
}

/** Values each font property may take. `SAFE_VALUE` alone would pass any
 *  word, and a word the SVG doesn't know is one the browser ignores — better
 *  dropped here, where the drop is the documented behaviour. */
const FONT_VALUES: Record<string, RegExp> = {
  "font-weight": /^(normal|bold|bolder|lighter|[1-9]00)$/i,
  "font-style": /^(normal|italic|oblique)$/i,
};

interface Cursor { s: string; i: number }

const peek = (c: Cursor) => c.s.slice(c.i);
function skipWs(c: Cursor) { while (c.i < c.s.length && /\s/.test(c.s[c.i])) c.i++; }

/** The end of a label that starts at `from`, given its closing delimiter.
 *
 *  Quoting is why this is not `indexOf`. A quoted label may contain the
 *  delimiter that would otherwise end it, and the corpus does it twice: a node
 *  `ARR["Array[…]"]` whose text holds a `]`, and an edge label
 *  `-->|"P(C|A,B)"|` whose text holds a `|` — a conditional probability, where
 *  the bar is the notation. Scanning to the first delimiter truncates both and
 *  then fails on the remainder.
 *
 *  Returns the index of the closer, or -1. */
function findClose(s: string, from: number, close: string): number {
  const q = s[from];
  if (q === '"' || q === "'" || q === "`") {
    const endQuote = s.indexOf(q, from + 1);
    if (endQuote >= 0) {
      const after = s.indexOf(close, endQuote + 1);
      // Only the run between the quote and the closer may be whitespace; a
      // quote that isn't actually wrapping the whole label falls through to
      // the plain scan below.
      if (after >= 0 && !s.slice(endQuote + 1, after).trim()) return after;
    }
  }
  return s.indexOf(close, from);
}

/** One node reference, with its inline shape and label if it carries them. */
interface NodeRef { id: string; label?: ParsedLabel; shape?: NodeShape; classes?: string[] }

function readNodeRef(c: Cursor): NodeRef | null {
  skipWs(c);
  const m = ID.exec(peek(c));
  if (!m) return null;
  const id = m[0];
  c.i += id.length;

  let label: ParsedLabel | undefined;
  let shape: NodeShape | undefined;
  for (const [open, close, kind] of SHAPES) {
    if (!peek(c).startsWith(open)) continue;
    const end = findClose(c.s, c.i + open.length, close);
    if (end < 0) continue;
    // Tables are a node's alone; a subgraph title read through here has them
    // flattened below.
    label = parseLabel(c.s.slice(c.i + open.length, end), { tables: true });
    shape = kind;
    c.i = end + close.length;
    break;
  }

  // `A:::className` — the inline form of `class A className`.
  const classes: string[] = [];
  while (peek(c).startsWith(":::")) {
    c.i += 3;
    const cm = ID.exec(peek(c));
    if (!cm) break;
    classes.push(cm[0]);
    c.i += cm[0].length;
  }
  return { id, label, shape, classes: classes.length ? classes : undefined };
}

function readArrow(c: Cursor): { arrow: ArrowKind; line: LineKind; label?: ParsedLabel } | null {
  skipWs(c);
  for (const [re, arrow, line] of LABELLED_ARROWS) {
    const m = re.exec(peek(c));
    if (!m) continue;
    c.i += m[0].length;
    return { arrow, line, label: parseLabel(m[1]) };
  }
  for (const [re, arrow, line] of ARROWS) {
    const m = re.exec(peek(c));
    if (!m) continue;
    c.i += m[0].length;
    let label: ParsedLabel | undefined;
    if (peek(c).startsWith("|")) {
      const end = findClose(c.s, c.i + 1, "|");
      if (end < 0) return null;
      label = parseLabel(c.s.slice(c.i + 1, end));
      c.i = end + 1;
    }
    return { arrow, line, label };
  }
  return null;
}

export function parseDiagram(source: string): ParseResult {
  const rawLines = source.replace(/\r\n?/g, "\n").split("\n");

  let direction: Direction | null = null;
  let headerAt = -1;
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].trim();
    if (!t || t.startsWith("%%")) continue;
    const h = HEADER.exec(t);
    if (h) {
      const d = (h[2] ?? "TB").toUpperCase();
      direction = (d === "TD" ? "TB" : d) as Direction;
      headerAt = i;
      break;
    }
    const other = OTHER_TYPES.exec(t);
    return {
      ok: false,
      refusal: other
        ? { kind: "unsupported", message: `${other[1]} diagrams are not rendered yet`, line: i + 1 }
        : { kind: "parse_error", message: `expected a \`flowchart\` or \`graph\` header, found \`${t.slice(0, 40)}\``, line: i + 1 },
    };
  }
  if (direction === null) {
    return { ok: false, refusal: { kind: "parse_error", message: "no diagram header" } };
  }

  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  const subgraphs: Subgraph[] = [];
  const classDefs: Record<string, Record<string, string>> = {};
  const stack: Subgraph[] = [];
  const literal: LabelNote[] = [];
  let lineNo = 0;
  /** A label's literal-markup notes, attributed to the statement it is in. */
  const noted = (label: ParsedLabel | undefined): ParsedLabel | undefined => {
    for (const message of label?.literal ?? []) literal.push({ message, line: lineNo });
    return label;
  };

  // A node belongs to the subgraph it is *mentioned inside*, whether or not
  // that is where it first appeared. Claiming only on creation meant the
  // common `subgraph S` / bare member-list form — where the nodes were already
  // introduced by an edge above — produced an empty cluster, which dagre then
  // sized as nothing and the renderer drew as a floating title.
  const claimed = new Set<string>();
  const joinCurrent = (id: string) => {
    if (!stack.length || claimed.has(id)) return;
    stack[stack.length - 1].nodes.push(id);
    claimed.add(id);
  };
  const touch = (id: string): DiagramNode => {
    let n = nodes.get(id);
    if (!n) {
      const l = plainLabel(id);
      n = { id, lines: l.lines, runs: l.runs, shape: "rect", classes: [] };
      nodes.set(id, n);
    }
    joinCurrent(id);
    return n;
  };
  const apply = (ref: NodeRef) => {
    const n = touch(ref.id);
    if (noted(ref.label)) { n.lines = ref.label!.lines; n.runs = ref.label!.runs; }
    if (ref.shape) n.shape = ref.shape;
    if (ref.classes) n.classes.push(...ref.classes);
    return n;
  };

  for (let i = headerAt + 1; i < rawLines.length; i++) {
    lineNo = i + 1;
    // A trailing `;` is optional statement punctuation in mermaid.
    // `%%` opens a comment only at the start of a line — mermaid's own rule.
    // Stripping it anywhere broke any label containing one, e.g. `A[100%% done]`.
    let line = rawLines[i];
    if (line.length > MAX_LINE_LENGTH) {
      return { ok: false, refusal: { kind: "unsupported", message: `line is over ${MAX_LINE_LENGTH} characters`, line: lineNo } };
    }
    // A markdown string may span lines — its newlines are its line breaks —
    // so a statement runs on until every ``"` `` it opened is closed. The
    // joined statement is held to the same length bound as a line, which is
    // what keeps the patterns below linear-bounded on it.
    if (!/^\s*%%/.test(line)) {
      while (opensMarkdownString(line)) {
        if (++i >= rawLines.length) {
          return { ok: false, refusal: { kind: "parse_error", message: "a markdown string (`\"`…`\"`) is never closed", line: lineNo } };
        }
        line += "\n" + rawLines[i];
        if (line.length > MAX_LINE_LENGTH) {
          return { ok: false, refusal: { kind: "unsupported", message: `statement is over ${MAX_LINE_LENGTH} characters`, line: lineNo } };
        }
      }
    }
    const text = (/^\s*%%/.test(line) ? "" : line).replace(/;\s*$/, "").trim();
    if (!text) continue;

    if (/^end$/i.test(text)) {
      if (!stack.length) {
        return { ok: false, refusal: { kind: "parse_error", message: "`end` without `subgraph`", line: lineNo } };
      }
      subgraphs.push(stack.pop()!);
      continue;
    }

    let m: RegExpExecArray | null;

    if ((m = /^subgraph\s+([\s\S]*)$/i.exec(text))) {
      const rest = m[1].trim();
      const ref = readNodeRef({ s: rest, i: 0 });
      // `subgraph id[Title]`, `subgraph id`, or `subgraph "Free text"`.
      const isIdForm = ref && ref.id.length > 0 && /^[A-Za-z_][\w-]*(\[|\(|\{|$)/.test(rest);
      const id = isIdForm ? ref!.id : `sg${subgraphs.length + stack.length}`;
      // A title is drawn on one line, so a multi-line label joins with spaces.
      const label = noted(isIdForm ? (ref!.label ?? plainLabel(ref!.id)) : parseLabel(rest))!;
      const titleRuns = textLines(label.runs).flatMap((l, k) => (k ? [{ text: " " }, ...l] : l));
      stack.push({ id, title: label.lines.join(" "), titleRuns, nodes: [] });
      continue;
    }

    if (/^direction\s+/i.test(text)) continue; // per-subgraph direction: ignored, not refused

    if ((m = /^classDef\s+([\w,-]+)\s+(.*)$/i.exec(text))) {
      const decl = parseStyleBody(m[2]);
      for (const name of m[1].split(",")) classDefs[name.trim()] = decl;
      continue;
    }

    if ((m = /^class\s+([\w,\s-]+)\s+([\w-]+)$/i.exec(text))) {
      for (const id of m[1].split(",")) {
        const t = id.trim();
        if (t) touch(t).classes.push(m[2]);
      }
      continue;
    }

    if ((m = /^style\s+([\w-]+)\s+(.*)$/i.exec(text))) {
      const n = touch(m[1]);
      n.style = { ...(n.style ?? {}), ...parseStyleBody(m[2]) };
      continue;
    }

    if (/^(click|linkStyle|linkstyle)\b/i.test(text)) {
      return {
        ok: false,
        refusal: { kind: "unsupported", message: `\`${text.split(/\s/)[0]}\` is not supported`, line: lineNo },
      };
    }

    // Statement: a group of nodes, then zero or more (arrow, group) pairs.
    const c: Cursor = { s: text, i: 0 };
    let group: DiagramNode[] = [];
    let ref = readNodeRef(c);
    if (!ref) {
      return { ok: false, refusal: { kind: "parse_error", message: `cannot read \`${text.slice(0, 40)}\``, line: lineNo } };
    }
    group.push(apply(ref));
    skipWs(c);
    while (peek(c).startsWith("&")) {
      c.i += 1;
      const r = readNodeRef(c);
      if (!r) {
        return { ok: false, refusal: { kind: "parse_error", message: "`&` with no node after it", line: lineNo } };
      }
      group.push(apply(r));
      skipWs(c);
    }

    while (c.i < text.length) {
      const arr = readArrow(c);
      noted(arr?.label);
      if (!arr) {
        return { ok: false, refusal: { kind: "parse_error", message: `cannot read \`${peek(c).slice(0, 24)}\``, line: lineNo } };
      }
      const next: DiagramNode[] = [];
      const r0 = readNodeRef(c);
      if (!r0) {
        return { ok: false, refusal: { kind: "parse_error", message: "an arrow with no node after it", line: lineNo } };
      }
      next.push(apply(r0));
      skipWs(c);
      while (peek(c).startsWith("&")) {
        c.i += 1;
        const r = readNodeRef(c);
        if (!r) {
          return { ok: false, refusal: { kind: "parse_error", message: "`&` with no node after it", line: lineNo } };
        }
        next.push(apply(r));
        skipWs(c);
      }
      // `A & B --> C & D` is the cross product, which is what mermaid does.
      for (const a of group) {
        for (const b of next) {
          edges.push({
            from: a.id, to: b.id,
            label: arr.label?.lines.join(" "), labelRuns: arr.label && textLines(arr.label.runs),
            arrow: arr.arrow, line: arr.line,
          });
        }
      }
      group = next;
      skipWs(c);
    }
  }

  if (stack.length) {
    return { ok: false, refusal: { kind: "parse_error", message: "`subgraph` with no `end`" } };
  }

  // An edge to or from a subgraph id is legal mermaid and dagre cannot rank it
  // — it throws, which `renderDiagram` caught and turned into a silent
  // fallback: source shown, no warning, `strict: true` not refusing. Refusing
  // here instead is what keeps "warns iff the operator sees source" true.
  const clusterIds = new Set(subgraphs.map((sg) => sg.id));
  for (const e of edges) {
    for (const end of [e.from, e.to]) {
      if (clusterIds.has(end)) {
        return {
          ok: false,
          refusal: {
            kind: "unsupported",
            message: `\`${end}\` is a subgraph, and an edge to a subgraph is not drawn yet`,
          },
        };
      }
    }
  }
  if (nodes.size === 0) {
    return { ok: false, refusal: { kind: "parse_error", message: "no nodes" } };
  }

  return { ok: true, ir: { direction, nodes: [...nodes.values()], edges, subgraphs, classDefs, literal } };
}

/** Whether `s` leaves a markdown string open: a ``"` `` with no ``` `" ```
 *  after it. One linear pass; a markdown string cannot contain either quote
 *  character, so the first closer is its closer. */
export function opensMarkdownString(s: string): boolean {
  let open = false;
  for (let i = 0; i < s.length - 1; i++) {
    if (!open && s[i] === '"' && s[i + 1] === "`") { open = true; i++; }
    else if (open && s[i] === "`" && s[i + 1] === '"') { open = false; i++; }
  }
  return open;
}
