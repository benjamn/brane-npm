import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram } from "../diagram/parse.js";
import { layoutDiagram } from "../diagram/layout.js";
import { renderDiagram, diagnoseDiagram } from "../diagram/index.js";
import { MARKDOWN_WRAP_WIDTH, parseLabel, wrapRuns, type LabelLine, type RunLine } from "../diagram/label.js";

/** A label line that the test knows is text, not a table. */
const line = (l: LabelLine): RunLine => {
  assert.ok(Array.isArray(l), "expected a line of runs, got a table");
  return l as RunLine;
};
import { FONT_SIZE, measureNode, runWidth, textWidth } from "../diagram/metrics.js";
import { diagnoseMarkdown } from "../markdown-diagnostics.js";

// Styled text in diagram labels. Mermaid has two label grammars, and before
// this brane read only `<br/>` from either: an agent on another daemon tried
// `<b>`, then a markdown string ``"`**Plan**`"``, then a `font-weight`
// classDef, and drew literal tags, then literal backticks and asterisks, then
// nothing, with a clean `narrate` receipt each time (claude-cdouqlgt:12–:24).

const ok = (src: string) => {
  const r = parseDiagram(src);
  assert.equal(r.ok, true, `expected a parse, got ${r.ok ? "" : r.refusal.message}`);
  return r.ok ? r.ir : (undefined as never);
};

describe("markdown strings", () => {
  it("draws **bold** and *italic*, not the asterisks and backticks", () => {
    const ir = ok('flowchart TD\n A["`**Plan** mixin, *maybe*`"] --> B');
    assert.deepEqual(ir.nodes[0].lines, ["Plan mixin, maybe"]);
    assert.deepEqual(ir.nodes[0].runs, [[
      { text: "Plan", bold: true },
      { text: " mixin, " },
      { text: "maybe", italic: true },
    ]]);
    assert.deepEqual(ir.literal, []);
  });

  it("spans lines, and each source line is a drawn line", () => {
    const ir = ok([
      "flowchart TD",
      '  Plan["`**Plan**',
      "  inspectable before it runs`\"]",
      "  Plan --> Intent",
    ].join("\n"));
    assert.deepEqual(ir.nodes[0].lines, ["Plan", "inspectable before it runs"]);
    assert.equal(line(ir.nodes[0].runs[0])[0].bold, true);
    assert.deepEqual(ir.edges.map((e) => `${e.from}->${e.to}`), ["Plan->Intent"]);
  });

  it("parses the fence that started this exactly as it was written", () => {
    // claude-cdouqlgt:14, abridged: multi-line markdown strings with bold
    // heads, chained and dotted edges, and a classDef.
    const ir = ok([
      "flowchart TD",
      '  Plan["`**Plan**',
      '  inspectable before it runs`"]',
      "",
      '  Intent["`**IntentPlan**',
      "  declare(intent)",
      '  planner picks the operations`"]',
      '  Effect["`**EffectPlan** mixin',
      '  ordering, idempotency, rollback`"]',
      "",
      "  Plan --> Intent",
      "  Plan -.-> Effect",
      "  classDef proposed stroke-dasharray: 5 5",
      "  class Effect proposed",
    ].join("\n"));
    assert.deepEqual(ir.nodes.map((n) => n.id), ["Plan", "Intent", "Effect"]);
    assert.deepEqual(ir.literal, []);
    for (const n of ir.nodes) {
      assert.equal(line(n.runs[0])[0].bold, true, `${n.id} has a bold head`);
      assert.ok(!n.lines.some((l) => /[`*]/.test(l)), `${n.id} draws no markup characters`);
    }
    // Wrapped at mermaid's width: "planner picks the operations" is two lines.
    assert.deepEqual(ir.nodes[1].lines, ["IntentPlan", "declare(intent)", "planner picks the", "operations"]);
  });

  it("refuses an unclosed markdown string, naming the line it opened on", () => {
    const r = parseDiagram('flowchart TD\n A --> B\n C["`never\n closed\n D --> E');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.refusal.kind, "parse_error");
    assert.equal(!r.ok && r.refusal.line, 3);
  });

  it("honours inline <b> and <br> inside a markdown string", () => {
    const { runs } = parseLabel('"`a <b>b</b><br>c`"');
    assert.deepEqual(runs, [[{ text: "a " }, { text: "b", bold: true }], [{ text: "c" }]]);
  });

  it("draws inline code in a monospace run", () => {
    const { runs, literal } = parseLabel('"`call `watch()` first`"');
    assert.deepEqual(runs, [[{ text: "call " }, { text: "watch()", code: true }, { text: " first" }]]);
    assert.deepEqual(literal, []);
  });

  it("draws a link as its text, and says it is not followed", () => {
    const { lines, literal } = parseLabel('"`see [the doc](https://x.test)`"');
    assert.deepEqual(lines, ["see the doc"]);
    assert.equal(literal.length, 1);
  });

  it("works in edge labels and subgraph titles", () => {
    const ir = ok([
      "flowchart LR",
      '  subgraph S["`**Stage** one`"]',
      "    A",
      "  end",
      '  A -->|"`**yes**`"| B',
    ].join("\n"));
    assert.equal(ir.subgraphs[0].title, "Stage one");
    assert.deepEqual(ir.subgraphs[0].titleRuns, [{ text: "Stage", bold: true }, { text: " one" }]);
    assert.equal(ir.edges[0].label, "yes");
    assert.deepEqual(ir.edges[0].labelRuns, [[{ text: "yes", bold: true }]]);
  });
});

describe("plain labels", () => {
  it("draws <b>, <i>, <code>, <u> and <s> the way mermaid's HTML labels do", () => {
    const { runs, literal } = parseLabel("<b>B</b> <i>I</i> <code>C</code> <u>U</u> <s>S</s>");
    assert.deepEqual(runs, [[
      { text: "B", bold: true }, { text: " " },
      { text: "I", italic: true }, { text: " " },
      { text: "C", code: true }, { text: " " },
      { text: "U", underline: true }, { text: " " },
      { text: "S", strike: true },
    ]]);
    assert.deepEqual(literal, []);
  });

  it("keeps nesting straight and lets a stray closer close nothing", () => {
    assert.deepEqual(parseLabel("<b><b>x</b> y</b> z").runs, [[{ text: "x y", bold: true }, { text: " z" }]]);
    assert.deepEqual(parseLabel("a</b> b").runs, [[{ text: "a b" }]]);
  });

  it("still splits on <br/> and drops blank lines, as before", () => {
    assert.deepEqual(parseLabel("one<br/>two<br><br/>three").lines, ["one", "two", "three"]);
  });

  it("leaves **x** literal, as mermaid does, and says how to style it", () => {
    const ir = ok("flowchart TD\n A[**Plan** mixin] --> B");
    assert.deepEqual(ir.nodes[0].lines, ["**Plan** mixin"]);
    assert.equal(ir.literal.length, 1);
    assert.match(ir.literal[0].message, /markdown string/);
    assert.equal(ir.literal[0].line, 2);
  });

  it("shows an unknown tag as text, reported once per tag name", () => {
    const { lines, literal } = parseLabel("<span>q</span>");
    assert.deepEqual(lines, ["<span>q</span>"]);
    assert.equal(literal.length, 1);
  });

  it("never wraps", () => {
    const long = "word ".repeat(40).trim();
    assert.equal(parseLabel(long).lines.length, 1);
  });
});

describe("font-weight and font-style in style and classDef", () => {
  it("bolds the whole label, and measures it bold", () => {
    const plain = layoutDiagram(ok("flowchart TD\n A[Weighty label]"));
    const bold = layoutDiagram(ok("flowchart TD\n A[Weighty label]\n classDef key font-weight:bold\n class A key"));
    assert.equal(line(bold.nodes[0].runs[0])[0].bold, true);
    assert.ok(bold.nodes[0].width > plain.nodes[0].width, "a bold label gets a wider box");
  });

  it("drops a value the property cannot take", () => {
    const ir = ok("flowchart TD\n A\n style A font-weight:heavy,font-style:italic");
    assert.deepEqual(ir.nodes[0].style, { "font-style": "italic" });
  });
});

describe("measurement", () => {
  it("uses Helvetica-Bold's own widths, not a stretch", () => {
    const w = (text: string, bold: boolean) => runWidth({ text, bold }, 1000);
    assert.equal(w("r", false), 333);
    assert.equal(w("r", true), 389);
    assert.equal(w("W", true), w("W", false)); // 944 in both faces
    assert.equal(runWidth({ text: "abc" }, FONT_SIZE), textWidth("abc", FONT_SIZE));
  });

  it("gives code a monospace advance", () => {
    assert.equal(runWidth({ text: "iiii", code: true }, 1000), runWidth({ text: "MMMM", code: true }, 1000));
  });

  it("measures a node by its runs", () => {
    const plain = measureNode([[{ text: "Standing mandate" }]]);
    const bold = measureNode([[{ text: "Standing mandate", bold: true }]]);
    assert.ok(bold.width > plain.width);
    assert.deepEqual(measureNode(["Standing mandate"]), plain);
  });

  it("wraps at word boundaries and never breaks a word", () => {
    const lines = wrapRuns([{ text: "a ".repeat(60) + "x".repeat(80) }], MARKDOWN_WRAP_WIDTH);
    for (const l of lines.slice(0, -1)) {
      assert.ok(l.reduce((s, r) => s + runWidth(r, FONT_SIZE), 0) <= MARKDOWN_WRAP_WIDTH);
    }
    assert.equal(lines[lines.length - 1][0].text, "x".repeat(80));
  });

  it("keeps a run boundary inside a word from becoming a break", () => {
    const lines = wrapRuns([{ text: "Plan", bold: true }, { text: "s and more" }], 10_000);
    assert.deepEqual(lines, [[{ text: "Plan", bold: true }, { text: "s and more" }]]);
  });
});

describe("SVG", () => {
  it("draws a bold run as a bold tspan", () => {
    const svg = renderDiagram('flowchart TD\n A["`**Plan** mixin`"]')!.svg;
    assert.match(svg, /<tspan font-weight="bold">Plan<\/tspan> mixin/);
    assert.doesNotMatch(svg, /\*\*|`/);
  });

  it("draws an unstyled label exactly as it did before runs", () => {
    const svg = renderDiagram("flowchart TD\n A[Plain]")!.svg;
    assert.match(svg, /<tspan x="[\d.]+" dy="0">Plain<\/tspan>/);
  });

  it("escapes markup in every grammar", () => {
    for (const label of ['"`**<script>x</script>**`"', "<b><script>x</script></b>", "<img src=x onerror=y>"]) {
      const svg = renderDiagram(`flowchart TD\n A[${label}]`)!.svg;
      assert.doesNotMatch(svg, /<script|<img/, label);
    }
  });

  it("stacks a multi-line edge label inside one chip", () => {
    const svg = renderDiagram("flowchart TD\n A -->|one<br/>two| B")!.svg;
    assert.match(svg, />one<\/tspan><tspan x="[\d.]+" dy="[\d.]+">two</);
  });
});

describe("narrate warns iff label markup shows as typed", () => {
  const fence = (body: string) => "```mermaid\n" + body + "\n```";

  it("warns on **x** in a plain label, with the source line", () => {
    const ds = diagnoseMarkdown(fence("flowchart TD\n A[**Plan**] --> B"));
    assert.deepEqual(ds.map((d) => d.kind), ["diagram_label_literal"]);
    assert.equal(ds[0].line, 3);
    assert.equal(ds[0].fallback, "A[**Plan**] --> B");
  });

  it("is silent when everything draws", () => {
    const ds = diagnoseMarkdown(fence('flowchart TD\n A["`**Plan**`"] --> B[<b>Query</b><br/>plan]'));
    assert.deepEqual(ds, []);
  });

  it("does not let a literal note make a diagram a refusal", () => {
    assert.equal(diagnoseDiagram("flowchart TD\n A[**x**] --> B"), null);
  });
});

describe("label parsing stays linear on hostile input", () => {
  const time = (src: string) => {
    const t = process.hrtime.bigint();
    parseDiagram(src);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };

  it("an unclosed markdown string followed by many lines", () => {
    assert.ok(time('flowchart TD\n A["`x\n' + "y\n".repeat(5000)) < 500);
  });

  it("a label full of half-tags and asterisks", () => {
    const label = "<b ".repeat(300) + "**a".repeat(150) + "`b".repeat(150);
    assert.ok(time(`flowchart TD\n A[${label}]`) < 500);
  });
});

describe("tables in node labels", () => {
  // Brane-only: mermaid shows "Unsupported markdown: table" here. Allowed by
  // the dialect rule because the fence is still valid mermaid, and because
  // the drawing is static SVG made on the daemon, so the HTML export carries
  // no rendering logic for it (claude-uwaj0umf:33).
  const TABLE = [
    "flowchart LR",
    '  K["`**Plan kinds**',
    "  | kind | input | standing |",
    "  |:---|:---:|---:|",
    "  | QueryPlan | operation | no |",
    "  | WatchPlan | *intent* | **yes** |",
    "",
    '  the spine`"]',
  ].join("\n");

  const tableOf = (l: LabelLine) => {
    assert.ok(!Array.isArray(l), "expected a table");
    return l as Exclude<LabelLine, RunLine>;
  };

  it("parses a GFM table into a bold header, rows and alignment", () => {
    const ir = ok(TABLE);
    const runs = ir.nodes[0].runs;
    assert.equal(runs.length, 3);
    const t = tableOf(runs[1]);
    assert.deepEqual(t.align, ["left", "center", "right"]);
    assert.deepEqual(t.header, [[{ text: "kind", bold: true }], [{ text: "input", bold: true }], [{ text: "standing", bold: true }]]);
    assert.deepEqual(t.rows[1], [[{ text: "WatchPlan" }], [{ text: "intent", italic: true }], [{ text: "yes", bold: true }]]);
    assert.deepEqual(ir.nodes[0].lines, [
      "Plan kinds", "kind | input | standing", "QueryPlan | operation | no", "WatchPlan | intent | yes", "the spine",
    ]);
    assert.deepEqual(ir.literal, []);
  });

  it("pads a short row and drops extra cells, as GFM does", () => {
    const t = tableOf(parseLabel('"`| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |`"', { tables: true }).runs[0]);
    assert.deepEqual(t.rows, [[[{ text: "1" }], []], [[{ text: "1" }], [{ text: "2" }]]]);
  });

  it("sizes the node to the columns and to every row", () => {
    const placed = layoutDiagram(ok(TABLE));
    const node = placed.nodes[0];
    assert.ok(node.height >= 5 * FONT_SIZE * 1.35, "five line slots: title, header, two rows, trailer");
    const flat = measureNode(["kind | input | standing"]);
    assert.ok(node.width > flat.width, "the gaps between columns cost more than ` | `");
  });

  it("draws cells at their column's edge, and a rule under the header", () => {
    const svg = renderDiagram(TABLE)!.svg;
    assert.match(svg, /text-anchor="end"><tspan font-weight="bold">standing<\/tspan>/);
    assert.match(svg, /text-anchor="middle"><tspan font-weight="bold">input<\/tspan>/);
    assert.match(svg, /text-anchor="start">QueryPlan</);
    assert.match(svg, /<path d="M[\d.]+,[\d.]+h[\d.]+" stroke="[^"]+" stroke-width="1" opacity="0.6"/);
  });

  it("bolds the cells too when the node is bold", () => {
    const placed = layoutDiagram(ok(TABLE + "\n  style K font-weight:bold"));
    const t = tableOf(placed.nodes[0].runs[1]);
    assert.ok(t.rows.flat(2).every((r) => r.bold));
  });

  it("shows a table in an edge label as its source, and says so", () => {
    const ir = ok('flowchart LR\n A -->|"`| a | b |\n|---|---|\n| 1 | 2 |`"| B');
    assert.equal(ir.edges[0].label, "| a | b | |---|---| | 1 | 2 |");
    assert.equal(ir.literal.length, 1);
    assert.match(ir.literal[0].message, /only in node labels/);
  });
});

describe("plain-label details", () => {
  it("does not warn about ** inside <code>, where it is meant literally", () => {
    const { runs, literal } = parseLabel("<code>**x**</code>");
    assert.deepEqual(runs, [[{ text: "**x**", code: true }]]);
    assert.deepEqual(literal, []);
  });

  it("decodes character references, as mermaid's HTML labels do", () => {
    assert.deepEqual(parseLabel("x &lt; y &amp;&amp; a &#x2192; b &rarr; c").lines, ["x < y && a → b → c"]);
    assert.deepEqual(parseLabel("&bogus; &#0; &#xD800;").lines, ["&bogus; &#0; &#xD800;"]);
  });

  it("never reads a decoded < as a tag", () => {
    const { runs } = parseLabel("&lt;b&gt;not bold&lt;/b&gt;");
    assert.deepEqual(runs, [[{ text: "<b>not bold</b>" }]]);
  });
});
