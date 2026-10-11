import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram } from "../diagram/parse.js";
import { renderDiagram } from "../diagram/index.js";
import { layoutDiagram, type Placed, type PlacedEdge } from "../diagram/layout.js";
import { measureEdgeLabel } from "../diagram/metrics.js";

// A self-loop's label was parsed, carried through the IR, and dropped at the
// last step: layout synthesises loops itself (dagre never sees them) and left
// `labelPos` undefined, which the renderer reads as "no label". Nothing
// warned — the diagram drew — so a Rule 30 state graph came back with all 24
// arrows and none of the three loop labels that distinguish the vacuum from
// the two stripe phases (claude-1vugmmfw:5, :7, :9). Every test here reads the
// *output*: a label in the IR proves nothing, which is the trap the `classDef`
// test fell into before it.

const ok = (src: string) => {
  const r = parseDiagram(src);
  assert.equal(r.ok, true, `expected a parse, got ${r.ok ? "" : r.refusal.message}`);
  return r.ok ? r.ir : (undefined as never);
};

interface Rect { left: number; top: number; right: number; bottom: number }

/** The chip `svg.ts` draws for a label, as a rect — the thing that has to fit. */
function chipRect(e: PlacedEdge): Rect {
  assert.ok(e.label && e.labelPos, `${e.from}→${e.to} has a placed label`);
  const { width, height } = measureEdgeLabel(e.label!);
  return {
    left: e.labelPos!.x - width / 2, right: e.labelPos!.x + width / 2,
    top: e.labelPos!.y - height / 2, bottom: e.labelPos!.y + height / 2,
  };
}

const intersects = (a: Rect, b: Rect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function assertInside(placed: Placed, r: Rect, what: string) {
  assert.ok(r.left >= 0 && r.top >= 0 && r.right <= placed.width && r.bottom <= placed.height,
    `${what} chip ${JSON.stringify(r)} is not inside ${placed.width}x${placed.height}`);
}

/** The diagram self-loop labels were built for: eight states, 24 arrows, three
 *  loops (claude-1vugmmfw:5). */
const RULE30 = `flowchart TD
  s000(["000"])
  s001(["001"])
  s010(["010"])
  s011(["011"])
  s100(["100"])
  s101(["101"])
  s110(["110"])
  s111(["111"])
  s000 -->|"00000"| s000
  s000 -->|"00001"| s001
  s000 -->|"10000"| s100
  s000 -->|"10001"| s101
  s001 -->|"00010/00011"| s011
  s001 -->|"10010/10011"| s111
  s010 -->|"10101"| s010
  s010 -->|"10100"| s011
  s010 -->|"00101"| s110
  s010 -->|"00100"| s111
  s011 -->|"10110/10111"| s010
  s011 -->|"00110/00111"| s110
  s100 -->|"11000"| s010
  s100 -->|"11001"| s011
  s100 -->|"01000"| s110
  s100 -->|"01001"| s111
  s101 -->|"11010/11011"| s001
  s101 -->|"01010/01011"| s101
  s110 -->|"11101"| s000
  s110 -->|"11100"| s001
  s110 -->|"01101"| s100
  s110 -->|"01100"| s101
  s111 -->|"11110/11111"| s000
  s111 -->|"01110/01111"| s100`;

const loopOf = (placed: Placed, id: string) =>
  placed.edges.find((e) => e.selfLoop && e.from === id)!;

describe("a self-loop's label is drawn", () => {
  const DIRS = ["TD", "BT", "LR", "RL"];

  it("reaches the SVG in every direction", () => {
    for (const dir of DIRS) {
      const r = renderDiagram(`flowchart ${dir}\n A -->|"vacuum"| A\n A --> B`);
      assert.ok(r && r.svg.includes(">vacuum<"), `${dir}: the loop label is in the output`);
    }
  });

  it("fits inside the viewBox, by its chip's four corners, on a top-rank node", () => {
    // The union that sizes the canvas covered only the curve's points, and a
    // chip is wider than the point it hangs on. "The text is in the SVG"
    // would pass a chip drawn at negative y and never seen.
    for (const dir of DIRS) {
      const placed = layoutDiagram(ok(`flowchart ${dir}\n A -->|"a long loop label"| A\n A --> B`));
      assertInside(placed, chipRect(loopOf(placed, "A")), `${dir} A`);
    }
  });

  it("fits on the far side too, where only the maximum would have noticed", () => {
    // A right-hand node in LR bows past `graph.width`; a bottom node in BT
    // bows below `graph.height`. Both grow the canvas rather than clipping.
    for (const src of [
      `flowchart LR\n A --> B\n B -->|"a long loop label"| B`,
      `flowchart TD\n A --> B\n B -->|"a long loop label"| B`,
    ]) {
      const placed = layoutDiagram(ok(src));
      assertInside(placed, chipRect(loopOf(placed, "B")), src);
    }
  });

  it("sits outside the node, off a cross-axis face — one no rank edge uses", () => {
    for (const dir of ["TD", "BT"]) {
      const placed = layoutDiagram(ok(`flowchart ${dir}\n A -->|"x"| A`));
      const a = placed.nodes[0];
      assert.ok(chipRect(loopOf(placed, "A")).left > a.x + a.width / 2, `${dir}: right of the right face`);
    }
    for (const dir of ["LR", "RL"]) {
      const placed = layoutDiagram(ok(`flowchart ${dir}\n A -->|"x"| A`));
      const a = placed.nodes[0];
      assert.ok(chipRect(loopOf(placed, "A")).top > a.y + a.height / 2, `${dir}: below the bottom face`);
    }
  });
});

describe("the loop's space is reserved from dagre", () => {
  // Dagre routes around what it was told about, and it was told nothing about
  // the bow. On the Rule 30 graph it parked `01100` (110→101) exactly where
  // 101's loop bows, and with the loop's own label missing, a reader took it
  // for the loop's. Placing the label alone would have turned one wrong chip
  // into two overlapping ones.
  it("keeps another edge's chip out of the loop's chip", () => {
    for (const dir of ["TD", "LR"]) {
      const placed = layoutDiagram(ok(
        `flowchart ${dir}\n B -->|"from B to A"| A\n A -->|"loop on A"| A`,
      ));
      const loop = chipRect(loopOf(placed, "A"));
      const other = chipRect(placed.edges.find((e) => !e.selfLoop)!);
      assert.ok(!intersects(loop, other),
        `${dir}: ${JSON.stringify(loop)} overlaps ${JSON.stringify(other)}`);
    }
  });

  it("but the node itself is drawn at its measured size, and edges attach to it", () => {
    // Only dagre's box grows. If the drawn node grew with it, or attachments
    // used the inflated extents, every other edge on a loop-bearing node
    // would end in the air above its face.
    const placed = layoutDiagram(ok(`flowchart TD\n B -->|"in"| A\n A -->|"loop"| A`));
    const plain = layoutDiagram(ok(`flowchart TD\n B -->|"in"| A`));
    const a = placed.nodes.find((n) => n.id === "A")!;
    const a0 = plain.nodes.find((n) => n.id === "A")!;
    assert.deepEqual([a.width, a.height], [a0.width, a0.height]);
    const into = placed.edges.find((e) => !e.selfLoop)!;
    const end = into.points[into.points.length - 1];
    assert.equal(end.y, a.y - a.height / 2, "the incoming edge ends on A's top face");
  });

  it("does not grow a node that has no loop", () => {
    const withLoop = layoutDiagram(ok(`flowchart TD\n A --> B\n B -->|"loop"| B`));
    const without = layoutDiagram(ok(`flowchart TD\n A --> B`));
    const a = withLoop.nodes.find((n) => n.id === "A")!;
    const a0 = without.nodes.find((n) => n.id === "A")!;
    assert.deepEqual([a.width, a.height, a.y], [a0.width, a0.height, a0.y], "A keeps its size and its rank");
  });

  it("grows the cross axis, not the rank axis", () => {
    // A TD diagram's height is the chat bubble's height. #504 reserved the
    // loop's room along the rank axis — +50% on a two-node graph — and on
    // the side every rank edge arrives from.
    const withLoop = layoutDiagram(ok(`flowchart TD\n B -->|"in"| A\n A -->|"loop"| A`));
    const without = layoutDiagram(ok(`flowchart TD\n B -->|"in"| A`));
    assert.ok(withLoop.height <= without.height + 8, `${withLoop.height} vs ${without.height}`);
  });
});

describe("two loops on one node", () => {
  // They used to draw the same bow twice — and would have stacked their
  // chips on top of each other. The second bows outside the first's chip.
  it("draw as two bows with two legible chips", () => {
    for (const dir of ["TD", "LR"]) {
      const placed = layoutDiagram(ok(
        `flowchart ${dir}\n A -->|"first"| A\n A -->|"second"| A\n A --> B`,
      ));
      const loops = placed.edges.filter((e) => e.selfLoop);
      assert.equal(loops.length, 2);
      assert.notDeepEqual(loops[0].points, loops[1].points, `${dir}: distinct bows`);
      const [c0, c1] = loops.map(chipRect);
      assert.ok(!intersects(c0, c1), `${dir}: chips ${JSON.stringify(c0)} / ${JSON.stringify(c1)}`);
      assertInside(placed, c0, `${dir} first`);
      assertInside(placed, c1, `${dir} second`);
    }
  });
});

describe("the Rule 30 state graph", () => {
  // The diagram this was found on: eight states, 24 arrows, three loops.
  const src = RULE30;

  it("renders all three loop labels, inside the canvas, clear of every other chip", () => {
    const r = renderDiagram(src);
    assert.ok(r);
    for (const l of ["00000", "10101", "01010/01011"]) {
      assert.ok(r.svg.includes(`>${l}<`), `${l} is drawn`);
    }
    const placed = layoutDiagram(ok(src));
    const loops = placed.edges.filter((e) => e.selfLoop);
    assert.equal(loops.length, 3);
    const others = placed.edges.filter((e) => !e.selfLoop && e.labelPos).map(chipRect);
    for (const loop of loops) {
      const chip = chipRect(loop);
      assertInside(placed, chip, loop.from);
      for (const o of others) {
        assert.ok(!intersects(chip, o), `${loop.from}'s chip overlaps another label`);
      }
    }
  });
});

// The finding that moved the loops (claude-djdja7g6:13): the checks above hold a
// loop's chip against other *chips*, and the Rule 30 test passed while three
// edges ran straight through 101's label. A chip an edge passes through reads
// as that edge's label, so what has to hold is chip against *path*.
describe("no edge runs through a loop's label", () => {
  /** Points along an edge as drawn — `curveBasis`, sampled. */
  function along(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
    if (points.length < 3) return points;
    // B-spline, uniform, clamped the way d3's curveBasis is: sample densely.
    const p = [points[0], points[0], ...points, points[points.length - 1], points[points.length - 1]];
    const out: Array<{ x: number; y: number }> = [];
    for (let i = 0; i + 3 < p.length; i++) {
      for (let s = 0; s <= 20; s++) {
        const t = s / 20, t2 = t * t, t3 = t2 * t;
        const b0 = (1 - 3 * t + 3 * t2 - t3) / 6, b1 = (4 - 6 * t2 + 3 * t3) / 6;
        const b2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6, b3 = t3 / 6;
        out.push({
          x: b0 * p[i].x + b1 * p[i + 1].x + b2 * p[i + 2].x + b3 * p[i + 3].x,
          y: b0 * p[i].y + b1 * p[i + 1].y + b2 * p[i + 2].y + b3 * p[i + 3].y,
        });
      }
    }
    return out;
  }
  const inside = (q: { x: number; y: number }, r: Rect) =>
    q.x > r.left && q.x < r.right && q.y > r.top && q.y < r.bottom;

  function crossings(src: string): string[] {
    const placed = layoutDiagram(ok(src));
    const out: string[] = [];
    for (const loop of placed.edges.filter((e) => e.selfLoop && e.label)) {
      const chip = chipRect(loop);
      for (const o of placed.edges) {
        if (o === loop) continue;
        if (along(o.points).some((q) => inside(q, chip))) out.push(`${o.from}→${o.to} crosses ${loop.from}'s loop label`);
      }
      for (const n of placed.nodes) {
        const r = { left: n.x - n.width / 2, right: n.x + n.width / 2, top: n.y - n.height / 2, bottom: n.y + n.height / 2 };
        if (intersects(chip, r)) out.push(`${loop.from}'s loop label covers node ${n.id}`);
      }
    }
    return out;
  }

  it("the smallest case: an edge into a node with a labelled loop", () => {
    for (const dir of ["TD", "BT", "LR", "RL"]) {
      assert.deepEqual(crossings(`flowchart ${dir}\n B --> A\n A -->|"loop"| A`), [], dir);
      assert.deepEqual(crossings(`flowchart ${dir}\n A -->|"loop"| A\n A --> C\n B --> A`), [], `${dir}, in and out`);
    }
  });

  it("two loop-bearing nodes side by side, with labels wider than the nodes", () => {
    for (const dir of ["TD", "LR"]) {
      assert.deepEqual(crossings(
        `flowchart ${dir}\n R --> A\n R --> B\n A -->|"a rather long loop label"| A\n B -->|"another long loop label"| B`,
      ), [], dir);
    }
  });

  it("stacked loops with labels of different widths, in every direction", () => {
    // #504 stacked chips by height in every direction, so beside the node a
    // wider first label ran into the second: "a lon[second]abel".
    for (const dir of ["TD", "BT", "LR", "RL"]) {
      const placed = layoutDiagram(ok(
        `flowchart ${dir}\n A -->|"a longer first label"| A\n A -->|"second"| A\n A -->|"3"| A\n B --> A`,
      ));
      const chips = placed.edges.filter((e) => e.selfLoop).map(chipRect);
      for (let i = 0; i < chips.length; i++) {
        assertInside(placed, chips[i], `${dir} loop ${i}`);
        for (let j = i + 1; j < chips.length; j++) {
          assert.ok(!intersects(chips[i], chips[j]), `${dir}: loop chips ${i} and ${j} overlap`);
        }
      }
      assert.deepEqual(crossings(
        `flowchart ${dir}\n A -->|"a longer first label"| A\n A -->|"second"| A\n A -->|"3"| A\n B --> A`,
      ), [], dir);
    }
  });

  it("a loop without a label draws, reserves its bow, and places nothing", () => {
    const placed = layoutDiagram(ok(`flowchart TD\n B --> A\n A --> A`));
    const loop = loopOf(placed, "A");
    assert.equal(loop.labelPos, undefined);
    const a = placed.nodes.find((n) => n.id === "A")!;
    assert.ok(loop.points.every((q) => q.x >= a.x + a.width / 2 - 1e-9), "the bow is off the right face");
    assert.ok(Math.max(...loop.points.map((q) => q.x)) <= placed.width, "and inside the canvas");
  });

  it("an edge fanning into a wide-labelled loop node, in every direction", () => {
    // Dagre ends each edge on the node's inflated box; pulled back onto the
    // drawn face, the last leg of a steep edge used to cut the corner of a
    // chip wider than its node (LR/RL: claude-w6c1k8h4:7).
    for (const dir of ["TD", "BT", "LR", "RL"]) {
      assert.deepEqual(crossings(
        `flowchart ${dir}\n A --> X\n B --> X\n C --> X\n X -->|"a rather long loop label"| X`,
      ), [], `${dir}, fan-in`);
      assert.deepEqual(crossings(
        `flowchart ${dir}\n X -->|"a rather long loop label"| X\n X --> A\n X --> B\n X --> C`,
      ), [], `${dir}, fan-out`);
    }
  });

  it("each label sits just outside its own arc, stacked or not", () => {
    // The apex is 23/24 of the control depth, not 5/6: with the wrong ratio an
    // outer arc of a stack ran through its own label.
    for (const dir of ["TD", "BT", "LR", "RL"]) {
      const placed = layoutDiagram(ok(
        `flowchart ${dir}\n A -->|"one"| A\n A -->|"a middling label"| A\n A -->|"3"| A\n B --> A`,
      ));
      const a = placed.nodes.find((n) => n.id === "A")!;
      const vertical = dir === "LR" || dir === "RL"; // loops hang below
      for (const loop of placed.edges.filter((e) => e.selfLoop)) {
        const chip = chipRect(loop);
        const arc = along(loop.points);
        assert.ok(!arc.some((q) => inside(q, chip)), `${dir}: "${loop.label}" is crossed by its own arc`);
        const apex = vertical
          ? Math.max(...arc.map((q) => q.y)) - (a.y + a.height / 2)
          : Math.max(...arc.map((q) => q.x)) - (a.x + a.width / 2);
        const near = vertical ? chip.top - (a.y + a.height / 2) : chip.left - (a.x + a.width / 2);
        assert.ok(near - apex >= 1 && near - apex <= 6,
          `${dir}: "${loop.label}" sits ${(near - apex).toFixed(1)}px past its apex`);
      }
    }
  });

  it("the Rule 30 board", () => {
    const src = RULE30;
    assert.deepEqual(crossings(src), []);
  });
});
