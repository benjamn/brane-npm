import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram } from "../diagram/parse.js";
import { renderDiagram, diagnoseDiagram } from "../diagram/index.js";
import { layoutDiagram } from "../diagram/layout.js";
import { measureEdgeLabel } from "../diagram/metrics.js";
import { diagnoseMarkdown } from "../markdown-diagnostics.js";

// Regressions from the review of #500 (claude-91m90xgn:5). Each of these was a
// real defect in the first draft, reproduced by execution before it was fixed.
// They are gathered here rather than scattered so that the shape of what went
// wrong stays legible: three of the seven were *silent* — a plausible, wrong
// diagram, or a wrong warning — which is the failure mode the whole
// draw-or-fall-back design exists to avoid.

const ok = (src: string) => {
  const r = parseDiagram(src);
  assert.equal(r.ok, true, `expected a parse, got ${r.ok ? "" : r.refusal.message}`);
  return r.ok ? r.ir : (undefined as never);
};

describe("a hostile line cannot stall the daemon", () => {
  // The labelled-link patterns were `-{2,}\s+(.+?)\s+-{2,}>`: three overlapping
  // quantifiers over whitespace, cubic in the run length. `A -- <N spaces> x`
  // measured 17/30/195/1542 ms at N=250/500/1000/2000 — 8× per doubling. It
  // reached the daemon through `diagnoseMarkdown`, which runs on *every*
  // narration containing a mermaid fence, so any agent could have wedged the
  // daemon by narrating. `MAX_SOURCE_BYTES` was no defence: it bounds n while
  // the cost is n³.
  it("parses a long whitespace run in linear time", () => {
    const timeAt = (n: number) => {
      const src = `flowchart TD\n A -- ${" ".repeat(n)}x`;
      const t = process.hrtime.bigint();
      parseDiagram(src);
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    timeAt(200); // warm
    const small = Math.max(timeAt(250), 0.05);
    const large = timeAt(1500);
    // Cubic would be ~216× here. Generous bound: this is a complexity assertion,
    // not a benchmark, and CI machines are noisy.
    assert.ok(large < small * 30 + 50,
      `6× the input took ${large.toFixed(1)}ms against ${small.toFixed(1)}ms — superlinear`);
  });

  it("refuses an absurdly long line outright", () => {
    const r = diagnoseDiagram(`flowchart TD\n A[${"x".repeat(3000)}] --> B`);
    assert.equal(r?.kind, "unsupported");
    assert.match(r!.message, /line is over/);
  });

  it("stays fast on a whole fence of hostile lines", () => {
    const src = "flowchart TD\n" + `A -- ${" ".repeat(400)}x\n`.repeat(40);
    const t = process.hrtime.bigint();
    parseDiagram(src);
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 500);
  });
});

describe("a link form never silently loses a node", () => {
  // Both of these drew a plausible, wrong diagram with no warning — the worst
  // available outcome, since the reader cannot tell and the author is not told.
  it("chains dotted links instead of spanning them", () => {
    // Was: one edge A → C labelled `-> B -`, with B gone entirely.
    const ir = ok("flowchart TD\n A -.-> B -.-> C");
    assert.equal(ir.nodes.length, 3);
    assert.deepEqual(ir.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "B->C"]);
    assert.deepEqual(ir.edges.map((e) => e.label), [undefined, undefined]);
  });

  it("reads `---` as an open link, not as a labelled-link opener", () => {
    // Was: one edge A → C labelled `B`. Three dashes is an open link; the
    // inline-label opener is exactly two.
    const ir = ok("flowchart TD\n A --- B --> C");
    assert.equal(ir.nodes.length, 3);
    assert.deepEqual(ir.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "B->C"]);
    assert.deepEqual(ir.edges.map((e) => e.line), ["solid", "solid"]);
    assert.deepEqual(ir.edges.map((e) => e.arrow), ["open", "arrow"]);
  });

  it("still reads a genuine inline label", () => {
    const ir = ok("flowchart TD\n A -- x --> B -- y --> C");
    assert.deepEqual(ir.edges.map((e) => e.label), ["x", "y"]);
  });

  it("allows `>` inside a dotted label, which the archive needs", () => {
    // The lattice diagram writes `-. "All<String, true> ⇒ ⊥" .->`. A first
    // attempt at the fix above excluded `>` from every inline label and broke
    // it — which is why the dotted form excludes `.` instead, and only forbids
    // `-`/`>` as the *first* character.
    const ir = ok('flowchart TD\n STR -. "All<String, true> ⇒ ⊥" .-> BOT');
    assert.equal(ir.edges[0].label, "All<String, true> ⇒ ⊥");
    assert.equal(ir.edges[0].line, "dotted");
  });
});

describe("`classDef` is applied, not merely parsed", () => {
  // Was: parsed into the IR, carried through layout, and never read — so
  // `classDef hot fill:#f00` produced no `#f00` anywhere, while the same
  // colour via `style` worked. The original test asserted the IR and stopped
  // one layer short of the thing that matters.
  it("paints a class through to the SVG", () => {
    const svg = renderDiagram("flowchart TD\n A --> B\n classDef hot fill:#f00\n class A hot")!.svg;
    assert.ok(svg.includes("#f00"), "the class colour never reached the output");
  });

  it("paints the inline `:::` form too", () => {
    const svg = renderDiagram("flowchart TD\n A:::hot --> B\n classDef hot fill:#0f0")!.svg;
    assert.ok(svg.includes("#0f0"));
  });

  it("lets an explicit `style` win over a class, as mermaid does", () => {
    const ir = ok("flowchart TD\n A --> B\n classDef hot fill:#f00\n class A hot\n style A fill:#00f");
    const placed = layoutDiagram(ir);
    assert.equal(placed.nodes.find((n) => n.id === "A")!.style?.fill, "#00f");
  });

  it("merges several classes in declaration order", () => {
    const ir = ok([
      "flowchart TD", " A --> B",
      " classDef one fill:#f00,stroke:#111", " classDef two fill:#0f0",
      " class A one", " class A two",
    ].join("\n"));
    const style = layoutDiagram(ir).nodes.find((n) => n.id === "A")!.style!;
    assert.equal(style.fill, "#0f0", "the later class wins");
    assert.equal(style.stroke, "#111", "the earlier class still contributes");
  });
});

describe("a diagram that will not draw always says so", () => {
  // `C --> S` where S is a subgraph is legal mermaid; dagre throws on it, and
  // the throw was swallowed into a silent fallback. The operator saw source,
  // the author got no warning, and `strict: true` did not refuse — which is
  // exactly the invariant the warnings exist to uphold.
  it("refuses an edge whose endpoint is a subgraph, with a reason", () => {
    const src = "flowchart TD\n subgraph S[Group]\n  A --> B\n end\n C --> S";
    const r = diagnoseDiagram(src);
    assert.equal(r?.kind, "unsupported");
    assert.match(r!.message, /subgraph/);
    assert.equal(renderDiagram(src), null);
  });

  it("warns for everything it refuses, and refuses everything it cannot draw", () => {
    // The invariant itself, over a spread of inputs: `diagnoseDiagram` and
    // `renderDiagram` must never disagree about whether a diagram appears.
    const cases = [
      "flowchart TD\n A --> B",
      "flowchart TD\n subgraph S\n A --> B\n end\n C --> S",
      "gantt\n title X",
      "flowchart TD\n A --> @@@",
      "flowchart TD\n A --> B\n click A cb",
      "flowchart TD\n A --> A",
      "flowchart LR\n A[x] --> B{y} --> C((z))",
      "stateDiagram-v2\n [*] --> A",
    ];
    for (const src of cases) {
      const refused = diagnoseDiagram(src) !== null;
      const drew = renderDiagram(src) !== null;
      assert.equal(refused, !drew, `disagreement on ${JSON.stringify(src)}`);
    }
  });
});

describe("the fence finder is the markdown parse, not a pattern", () => {
  const bad = "gantt\n title X";
  const warns = (md: string) =>
    diagnoseMarkdown(md).some((w) => w.kind.startsWith("diagram_"));

  it("says nothing about a mermaid fence quoted inside a longer fence", () => {
    // Which is how an agent documents this feature — as the narrations that
    // produced it do. A regex scanner warned about a diagram that was never
    // going to be drawn in the first place.
    assert.equal(warns("````\n```mermaid\n" + bad + "\n```\n````"), false);
  });

  it("warns about one inside a blockquote, which does render", () => {
    assert.equal(warns("> ```mermaid\n> gantt\n>  title X\n> ```"), true);
  });

  it("warns about one inside a list item", () => {
    assert.equal(warns("- item\n\n  ```mermaid\n  gantt\n   title X\n  ```"), true);
  });

  it("says nothing about an indented code block that merely looks like one", () => {
    assert.equal(warns("    ```mermaid\n    " + bad + "\n    ```"), false);
  });

  it("does not pay for a parse when there is no mermaid at all", () => {
    const md = "ordinary prose ".repeat(500);
    const t = process.hrtime.bigint();
    diagnoseMarkdown(md);
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 50);
  });
});

describe("headers and comments follow mermaid, not the first draft", () => {
  it("accepts a trailing semicolon on the header", () => {
    // `graph TD;` — a common habit in the absorbed ChatGPT history. Statements
    // stripped a trailing `;`, but the header was tested against the raw line.
    assert.equal(ok("graph TD;\n A --> B").edges.length, 1);
  });

  it("defaults a bare `flowchart` to TB, as mermaid does", () => {
    assert.equal(ok("flowchart\n A --> B").direction, "TB");
  });

  it("treats `%%` as a comment only at the start of a line", () => {
    assert.deepEqual(ok("flowchart TD\n A[100%% done] --> B").nodes[0].lines, ["100%% done"]);
    assert.equal(ok("flowchart TD\n %% note\n A --> B").edges.length, 1);
  });
});

describe("a self-loop stays inside the canvas", () => {
  // The loop bows above its node, and on a top-rank node that meant negative
  // coordinates — outside `viewBox="0 0 …"`, so the loop was simply invisible.
  it("keeps every drawn point within the reported viewBox", () => {
    for (const src of ["flowchart TD\n A --> A\n A --> B", "flowchart LR\n A --> A\n A --> B"]) {
      const placed = layoutDiagram(ok(src));
      for (const e of placed.edges) {
        for (const p of e.points) {
          assert.ok(p.x >= 0 && p.y >= 0, `${src}: point ${p.x},${p.y} is outside the canvas`);
          assert.ok(p.x <= placed.width && p.y <= placed.height,
            `${src}: point ${p.x},${p.y} exceeds ${placed.width}x${placed.height}`);
        }
      }
    }
  });

  it("keeps the nodes inside it too, after any shift", () => {
    const placed = layoutDiagram(ok("flowchart TD\n A --> A\n A --> B"));
    for (const n of placed.nodes) {
      assert.ok(n.x - n.width / 2 >= 0 && n.y - n.height / 2 >= 0,
        `${n.id} at ${n.x},${n.y} hangs off the canvas`);
    }
  });
});

describe("a subgraph gets a box around its actual members", () => {
  // Found while checking the theming fix on a real render: a node introduced
  // by an edge and *then* listed inside a `subgraph` never joined it, because
  // membership was claimed only when a node was created. The cluster came out
  // empty, dagre left its geometry undefined, and the renderer drew a title
  // floating in the corner with no box.
  it("claims a node listed inside a subgraph after it was already used", () => {
    const ir = ok("flowchart TD\n V --> E\n subgraph S[out]\n  V\n  E\n end");
    assert.deepEqual(ir.subgraphs[0].nodes, ["V", "E"]);
    const c = layoutDiagram(ir).clusters[0];
    assert.ok(c, "the cluster survived layout");
    assert.ok(c.width > 0 && c.height > 0, "and has real geometry");
  });

  it("still claims a node on first mention inside", () => {
    const ir = ok("flowchart TD\n A --> B\n subgraph S[Group]\n  C --> D\n end\n B --> C");
    assert.deepEqual(ir.subgraphs[0].nodes, ["C", "D"]);
  });

  it("never emits a cluster without finite geometry", () => {
    for (const src of [
      "flowchart TD\n subgraph S[empty]\n end\n A --> B",
      "flowchart TD\n V --> E\n subgraph S[out]\n  V\n end",
    ]) {
      for (const c of layoutDiagram(ok(src)).clusters) {
        assert.ok([c.x, c.y, c.width, c.height].every(Number.isFinite), src);
      }
    }
  });
});

describe("an edge label's chip fits its text", () => {
  // The chip was sized as `length × 0.55em` while layout reserved space with
  // `measureEdgeLabel`. The two agreed for ASCII and nowhere else, so a Greek
  // or CJK label hung out of its own background.
  it("uses the same measurement layout reserved space with", () => {
    const wide = renderDiagram("flowchart TD\n A -->|字字字字| B")!.svg;
    const narrow = renderDiagram("flowchart TD\n A -->|iiii| B")!.svg;
    const chip = (svg: string) =>
      Number(/<rect x="[-\d.]+" y="[-\d.]+" width="([\d.]+)"[^>]*rx="3"/.exec(svg)?.[1] ?? 0);
    assert.ok(chip(wide) > chip(narrow),
      "a full-width label must get a wider chip than a narrow one");
  });
});

describe("a subgraph title wider than its members", () => {
  // dagre sizes a cluster from its members and never sees the title, which is
  // centred on the box; a long title hung past x = 0, where the operator could
  // neither see nor scroll to it (claude-myl5ez9e:24). The members still set
  // the box's width; the title wraps to it and the box grows upward to hold
  // the extra lines (claude-myl5ez9e:46).
  const title = "apollographql/connector-factory (private, public after the gates)";
  for (const dir of ["TD", "LR"]) {
    it(`wraps inside its box and stays inside the drawing (${dir})`, () => {
      const src = `flowchart ${dir}\n subgraph P["${title}"]\n  A[canon] --> B[out]\n end\n B -. copy .-> C[elsewhere]`;
      const ir = ok(src);
      const free = layoutDiagram(ok(`flowchart ${dir}\n subgraph P[x]\n  A[canon] --> B[out]\n end\n B -. copy .-> C[elsewhere]`));
      const placed = layoutDiagram(ir);
      const c = placed.clusters[0];
      assert.ok(measureEdgeLabel([c.titleRuns]).width > c.width, "the title is wider than its box, or this tests nothing");
      assert.equal(c.width, free.clusters[0].width, "the members, not the title, set the box's width");
      assert.ok(c.titleLines.length > 1, "so it wraps");
      const text = (l: { text: string }[]) => l.map((r) => r.text).join("");
      assert.equal(c.titleLines.map(text).join(" "), title, "every word survives, in order");
      for (const line of c.titleLines) {
        // A single word wider than the box can't wrap; it overhangs, and the
        // bounds keep it in view (the case below).
        if (/\s/.test(text(line))) assert.ok(measureEdgeLabel([line]).width <= c.width, `line fits its box: ${text(line)}`);
      }
      const extra = (c.titleLines.length - 1) * 12 * 1.35;
      assert.ok(Math.abs(c.height - (free.clusters[0].height + extra)) < 0.01, "and the box grew a line per extra line");
      assert.ok(c.y - c.height / 2 >= 0, `box top ${c.y - c.height / 2} is inside the drawing`);
      const members = placed.nodes.filter((n) => n.id === "A" || n.id === "B");
      const top = c.y - c.height / 2 + 15 + extra; // the last title baseline
      for (const n of members) assert.ok(n.y - n.height / 2 > top, `${n.id} sits below the title`);
    });
  }

  it("keeps a word too long to wrap inside the drawing", () => {
    const placed = layoutDiagram(ok(`flowchart TD\n subgraph P["${"x".repeat(80)}"]\n  A\n end`));
    const c = placed.clusters[0];
    const { width } = measureEdgeLabel(c.titleLines);
    assert.ok(width > c.width, "the word overhangs its box");
    assert.ok(c.x - width / 2 >= 0 && c.x + width / 2 <= placed.width, "but not the drawing");
  });
});
