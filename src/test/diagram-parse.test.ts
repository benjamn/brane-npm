import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram } from "../diagram/parse.js";

// The dialect brane renders was measured, not chosen: across every ```mermaid
// fence in the archive (21 diagrams, 316 lines, home brane plus two absorbed
// ones) it is flowcharts and nothing else — 131 `-->`, 9 `<-->`, zero `-.->`,
// `==>`, `---` or `~~~`; `[rect]` 125, `(round)` 9, `[(cyl)]` 5, `{diamond}` 4,
// `>asym]` 4, `[[sub]]` 1; `subgraph` 10, `&` 13, `<br/>` 15, classDef/class
// 3+3, style 2. One `stateDiagram-v2` is the only non-flowchart.
//
// The fixtures below are written to cover that census rather than lifted from
// it: the archive diagrams are the operator's own conversations, and a public
// repository is not the place for them.

function ok(src: string) {
  const r = parseDiagram(src);
  assert.equal(r.ok, true, `expected a parse, got ${r.ok ? "" : r.refusal.message}`);
  return r.ok ? r.ir : (undefined as never);
}
function refused(src: string) {
  const r = parseDiagram(src);
  assert.equal(r.ok, false, "expected a refusal");
  return r.ok ? (undefined as never) : r.refusal;
}

describe("headers", () => {
  for (const h of ["flowchart TD", "graph TD", "flowchart LR", "flowchart TB", "graph BT", "graph RL"]) {
    it(`accepts \`${h}\``, () => {
      assert.equal(ok(`${h}\n A --> B`).nodes.length, 2);
    });
  }

  it("normalises TD to TB, since they are the same direction spelled twice", () => {
    assert.equal(ok("flowchart TD\n A --> B").direction, "TB");
    assert.equal(ok("flowchart TB\n A --> B").direction, "TB");
  });

  it("names the diagram type it is refusing, so the author knows it was recognised", () => {
    for (const t of ["gantt", "sequenceDiagram", "stateDiagram-v2", "mindmap", "pie", "erDiagram"]) {
      const r = refused(`${t}\n whatever`);
      assert.equal(r.kind, "unsupported");
      assert.match(r.message, new RegExp(t, "i"));
    }
  });

  it("refuses a fence that is not a diagram at all", () => {
    assert.equal(refused("hello world").kind, "parse_error");
  });

  it("skips comments and blank lines before the header", () => {
    assert.equal(ok("\n%% a note\n\nflowchart TD\n A --> B").edges.length, 1);
  });
});

describe("edges", () => {
  it("reads an arrow written without spaces", () => {
    // Regression: the node-id pattern was `[\w-]*`, and `-` inside a character
    // class eats the arrow — `A-->B` parsed its id as `A--` and then failed on
    // the remaining `>B`. Agents write arrows unspaced constantly.
    const ir = ok("flowchart TD\n A-->B");
    assert.deepEqual(ir.edges.map((e) => [e.from, e.to]), [["A", "B"]]);
  });

  it("still admits a hyphenated id, which is the shape brane cares about most", () => {
    const ir = ok("flowchart TD\n claude-0qjv4nny --> claude-hhuptny5");
    assert.deepEqual(ir.edges.map((e) => [e.from, e.to]),
      [["claude-0qjv4nny", "claude-hhuptny5"]]);
  });

  it("distinguishes the four link forms", () => {
    const ir = ok("flowchart TD\n A --> B\n B <--> C\n C -.-> D\n D ==> E\n E --- F");
    assert.deepEqual(
      ir.edges.map((e) => `${e.arrow}/${e.line}`),
      ["arrow/solid", "biarrow/solid", "arrow/dotted", "arrow/thick", "open/solid"],
    );
  });

  it("carries a `|label|`", () => {
    const ir = ok("flowchart TD\n A -->|yes| B\n A -->|no| C");
    assert.deepEqual(ir.edges.map((e) => e.label), ["yes", "no"]);
  });

  it("reads the inline-label link forms", () => {
    const ir = ok("flowchart TD\n A -- yes --> B\n B -. maybe .-> C\n C == no ==> D");
    assert.deepEqual(
      ir.edges.map((e) => `${e.line}:${e.label}`),
      ["solid:yes", "dotted:maybe", "thick:no"],
    );
  });

  it("does not mistake a bare arrow for a labelled one", () => {
    const ir = ok("flowchart TD\n A --> B\n B -.-> C\n C ==> D");
    assert.deepEqual(ir.edges.map((e) => e.label), [undefined, undefined, undefined]);
  });

  it("keeps a delimiter that a quoted label legitimately contains", () => {
    // Both of these are in the archive. `P(C|A,B)` is a conditional
    // probability, where the bar is notation rather than a delimiter; the
    // lattice node's text really does contain a bracket. Scanning to the first
    // delimiter truncates each and then fails on the remainder.
    const edge = ok('flowchart TD\n A -->|"P(C|A,B)"| C');
    assert.equal(edge.edges[0].label, "P(C|A,B)");
    const node = ok('flowchart TD\n ARR["Array[…]"] --> B');
    assert.deepEqual(node.nodes[0].lines, ["Array[…]"]);
  });

  it("chains, so `A --> B --> C` is two edges", () => {
    const ir = ok("flowchart TD\n A --> B --> C");
    assert.deepEqual(ir.edges.map((e) => [e.from, e.to]), [["A", "B"], ["B", "C"]]);
  });

  it("expands `&` on both sides as a cross product, the way mermaid does", () => {
    const ir = ok("flowchart TD\n A & B --> C & D");
    assert.deepEqual(
      ir.edges.map((e) => `${e.from}${e.to}`).sort(),
      ["AC", "AD", "BC", "BD"],
    );
  });

  it("reads the LIVE loop's own `I --> V & E` fan-out", () => {
    const ir = ok([
      "flowchart TD",
      "    L[Listen] --> I[Interpret]",
      "    I --> V[Vocalize] & E[Execute]",
      "    V --> E",
      "    E --> V",
      "    V --> L",
    ].join("\n"));
    assert.equal(ir.nodes.length, 4);
    assert.deepEqual(
      ir.edges.map((e) => `${e.from}->${e.to}`),
      ["L->I", "I->V", "I->E", "V->E", "E->V", "V->L"],
    );
  });

  it("keeps a self-loop as an edge rather than dropping it", () => {
    const ir = ok("flowchart TD\n A --> A");
    assert.deepEqual(ir.edges.map((e) => [e.from, e.to]), [["A", "A"]]);
  });
});

describe("node shapes and labels", () => {
  it("reads every shape the dialect has", () => {
    const ir = ok(
      "flowchart TD\n A[r] --> B(rd) --> C([st]) --> D[[sub]] --> E[(cyl)]" +
      " --> F((ci)) --> G{di} --> H{{hex}} --> I>asym]",
    );
    assert.deepEqual(
      ir.nodes.map((n) => n.shape),
      ["rect", "round", "stadium", "subroutine", "cylinder", "circle", "diamond", "hexagon", "asymmetric"],
    );
  });

  it("prefers the longer opener, so `[[` is a subroutine and not a rect", () => {
    assert.equal(ok("flowchart TD\n A[[x]] --> B").nodes[0].shape, "subroutine");
    assert.equal(ok("flowchart TD\n A((x)) --> B").nodes[0].shape, "circle");
  });

  it("splits `<br/>` into lines rather than carrying it as markup", () => {
    const ir = ok("flowchart TD\n A[one<br/>two<br>three] --> B");
    assert.deepEqual(ir.nodes[0].lines, ["one", "two", "three"]);
  });

  it("strips the quotes mermaid allows around a label", () => {
    assert.deepEqual(ok('flowchart TD\n A["a b"] --> B').nodes[0].lines, ["a b"]);
  });

  it("defaults an unlabelled node to its own id", () => {
    assert.deepEqual(ok("flowchart TD\n A --> B").nodes[0].lines, ["A"]);
  });

  it("keeps non-Latin labels intact", () => {
    // The archive's one state diagram is Greek morphology. Whatever else it
    // exercises, a label must survive the parse byte for byte.
    assert.deepEqual(ok("flowchart TD\n A[πραΰς] --> B[πραεῖσι]").nodes[0].lines, ["πραΰς"]);
  });
});

describe("subgraphs, classes and styles", () => {
  it("collects a subgraph's members", () => {
    const ir = ok("flowchart TD\n subgraph S[Group]\n  A --> B\n end\n B --> C");
    assert.equal(ir.subgraphs.length, 1);
    assert.equal(ir.subgraphs[0].title, "Group");
    assert.deepEqual(ir.subgraphs[0].nodes, ["A", "B"]);
  });

  it("refuses an unbalanced subgraph rather than guessing", () => {
    assert.equal(refused("flowchart TD\n subgraph S\n A --> B").kind, "parse_error");
    assert.equal(refused("flowchart TD\n A --> B\n end").kind, "parse_error");
  });

  it("applies classDef through `class` and through `:::`", () => {
    const viaClass = ok("flowchart TD\n A --> B\n classDef hot fill:#f9f\n class A hot");
    assert.deepEqual(viaClass.nodes[0].classes, ["hot"]);
    assert.deepEqual(viaClass.classDefs.hot, { fill: "#f9f" });
    const viaInline = ok("flowchart TD\n A:::hot --> B\n classDef hot fill:#f9f");
    assert.deepEqual(viaInline.nodes[0].classes, ["hot"]);
  });

  it("keeps only known style properties, with values that cannot smuggle markup", () => {
    const ir = ok("flowchart TD\n A --> B\n style A fill:url(#x),stroke:#0a0,stroke-width:3px,behavior:evil");
    // `url(` is how an SVG references external content; `behavior` is not a
    // property we emit. Both are dropped; the two real ones survive.
    assert.deepEqual(ir.nodes[0].style, { stroke: "#0a0", "stroke-width": "3px" });
  });

  it("honours `style X stroke-width:4px`, which the LIVE loop diagram relies on", () => {
    const ir = ok("flowchart TD\n L[Listen] --> I\n style L stroke-width:4px");
    assert.deepEqual(ir.nodes[0].style, { "stroke-width": "4px" });
  });

  it("refuses the directives it does not implement, by name", () => {
    for (const d of ["click A callback", "linkStyle 0 stroke:#f00"]) {
      const r = refused(`flowchart TD\n A --> B\n ${d}`);
      assert.equal(r.kind, "unsupported");
      assert.equal(r.line, 3);
    }
  });

  it("ignores a per-subgraph `direction` instead of refusing the diagram", () => {
    // Not implemented, but harmless to skip: the diagram still draws, which
    // beats showing source over a one-line layout hint.
    assert.equal(ok("flowchart TD\n subgraph S\n direction LR\n A --> B\n end").edges.length, 1);
  });

  it("drops trailing semicolons, and treats `%%` as a comment only at line start", () => {
    // Mermaid's own rule. Stripping `%%` anywhere on a line broke any label
    // containing one — `A[100%% done]` failed to parse at all.
    const ir = ok("flowchart TD\n %% a whole-line note\n A --> B;\n B --> C;");
    assert.equal(ir.edges.length, 2);
    assert.deepEqual(ok("flowchart TD\n A[100%% done] --> B").nodes[0].lines, ["100%% done"]);
  });
});

describe("refusals carry a line number", () => {
  it("points at the offending line, counting from the fence body", () => {
    const r = refused("flowchart TD\n A --> B\n A --> @@@");
    assert.equal(r.line, 3);
  });
});
