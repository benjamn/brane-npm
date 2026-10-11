import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram } from "../diagram/parse.js";
import { layoutDiagram, projectAttachment, faceOffset, type PlacedNode } from "../diagram/layout.js";
import { basisPath } from "../diagram/svg.js";

// Why these assertions exist.
//
// dagre picks an edge's terminal point by intersecting the node's box with the
// chord from the node's *centre* to the first bend. That chord is diagonal, so
// the edge is handed a diagonal start and the arrowhead arrives tilted — before
// any curve is fitted. On the LIVE loop diagram it attaches `Listen ->
// Interpret` 28px to the left of where the edge is actually heading.
//
// Four curve-side fixes were built and measured against it. Every one bought a
// square arrival by adding inflections, and inflections are what make a diagram
// read as busy: clamped-tangent Hermite reached 3.3° mean arrival, basis with
// normal stubs reached 0.0°, and both looked worse than untouched `curveBasis`
// at 31.4°. Moving the *attachment point* and leaving the curve alone reaches
// 8.7° with the inflection count unchanged at zero.
//
// So the property under test is not "the curve is smooth" — it is "the terminal
// point lines up with the bend the edge is heading for". That is what these
// pin, because it is the thing that would silently regress if someone
// reasonably decided to hand dagre's own points straight to the renderer.

const LIVE = [
  "flowchart TD",
  "    L[Listen] --> I[Interpret]",
  "    I --> V[Vocalize] & E[Execute]",
  "    V --> E",
  "    E --> V",
  "    V --> L",
].join("\n");

function place(src: string) {
  const p = parseDiagram(src);
  assert.equal(p.ok, true);
  return layoutDiagram(p.ok ? p.ir : (undefined as never));
}

const node = (over: Partial<PlacedNode> = {}): PlacedNode => ({
  id: "N", lines: ["N"], runs: [[{ text: "N" }]], shape: "rect", classes: [],
  x: 100, y: 100, width: 80, height: 40, ...over,
});

describe("faceOffset follows the shape, not the bounding box", () => {
  it("is flat across a rectangle", () => {
    assert.equal(faceOffset("rect", 20, 40, 0), 20);
    assert.equal(faceOffset("rect", 20, 40, 39), 20);
  });

  it("falls away linearly on a diamond, so an edge lands on the slope", () => {
    assert.equal(faceOffset("diamond", 20, 40, 0), 20);
    assert.equal(faceOffset("diamond", 20, 40, 20), 10);
    assert.equal(faceOffset("diamond", 20, 40, 40), 0);
  });

  it("follows the ellipse on a circle", () => {
    assert.equal(faceOffset("circle", 20, 40, 0), 20);
    assert.ok(Math.abs(faceOffset("circle", 20, 40, 40)) < 1e-9);
    assert.ok(faceOffset("circle", 20, 40, 20) > 17);
  });

  it("never returns a negative offset, whatever the lateral overshoot", () => {
    for (const shape of ["rect", "diamond", "circle", "hexagon"] as const) {
      assert.ok(faceOffset(shape, 20, 40, 1000) >= 0, shape);
    }
  });
});

describe("projectAttachment lines the terminal point up with the bend", () => {
  it("slides along the face toward the bend", () => {
    const n = node();                                   // box 60..140 x 80..120
    const dagrePoint = { x: 112, y: 120 };              // dagre's chord result
    const bend = { x: 132, y: 150 };                    // where the edge is going
    const p = projectAttachment(n, dagrePoint, bend);
    assert.equal(p.y, 120, "stays on the face it was on");
    assert.equal(p.x, 132, "moves under the bend");
  });

  it("holds off the corner rather than hanging an edge from the tip", () => {
    const n = node();
    const p = projectAttachment(n, { x: 139, y: 120 }, { x: 400, y: 150 });
    assert.ok(p.x < 140, "inside the right edge");
    assert.ok(p.x >= 130, "but not pulled far in");
  });

  it("uses the vertical face when that is the one the point sits on", () => {
    const n = node();
    const p = projectAttachment(n, { x: 140, y: 104 }, { x: 260, y: 96 });
    assert.equal(p.x, 140, "stays on the right face");
    assert.equal(p.y, 96, "moves level with the bend");
  });

  it("puts a diamond's attachment on the slope, not floating off it", () => {
    const n = node({ shape: "diamond" });
    const p = projectAttachment(n, { x: 100, y: 120 }, { x: 120, y: 160 });
    // Half-way out along the bottom face of a diamond is half-way up its side.
    assert.equal(p.x, 120);
    assert.ok(p.y > 100 && p.y < 120, `expected the slope, got y=${p.y}`);
  });
});

/** The angle, in degrees, between an edge's final direction and the inward
 *  normal of the face it lands on. 0 is a perfectly square arrival. */
function arrivalAngle(placed: ReturnType<typeof place>, e: typeof placed.edges[number]): number {
  const dst = placed.nodes.find((n) => n.id === e.to)!;
  const end = e.points[e.points.length - 1];
  const prev = e.points[e.points.length - 2];
  const dx = end.x - prev.x, dy = end.y - prev.y;
  const len = Math.hypot(dx, dy) || 1;
  // Inward normal of the nearest face.
  const hx = dst.width / 2, hy = dst.height / 2;
  const cand = [
    { n: { x: 0, y: 1 }, d: Math.abs(end.y - (dst.y - hy)) },
    { n: { x: 0, y: -1 }, d: Math.abs(end.y - (dst.y + hy)) },
    { n: { x: 1, y: 0 }, d: Math.abs(end.x - (dst.x - hx)) },
    { n: { x: -1, y: 0 }, d: Math.abs(end.x - (dst.x + hx)) },
  ].sort((a, b) => a.d - b.d)[0].n;
  const dot = (dx / len) * cand.x + (dy / len) * cand.y;
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

describe("the LIVE loop diagram, laid out", () => {
  const placed = place(LIVE);

  it("places all four nodes and routes all six edges", () => {
    assert.equal(placed.nodes.length, 4);
    assert.equal(placed.edges.length, 6);
    for (const e of placed.edges) assert.ok(e.points.length >= 2, `${e.from}->${e.to}`);
  });

  it("gives every edge a finite path inside a finite canvas", () => {
    assert.ok(placed.width > 0 && Number.isFinite(placed.width));
    assert.ok(placed.height > 0 && Number.isFinite(placed.height));
    for (const e of placed.edges) {
      for (const p of e.points) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${e.from}->${e.to}`);
      }
    }
  });

  it("arrives square on every bent edge", () => {
    // The measured figure for face-projected attachment on this diagram is
    // 8.7° mean / 32.6° worst, against dagre's own 31.4° / 52.0°. The bound is
    // set above the former and well below the latter, so it catches a
    // regression to raw dagre points without being a brittle pin on a number.
    const bent = placed.edges.filter((e) => !e.selfLoop && e.points.length > 2);
    assert.ok(bent.length >= 3, "expected the diagram to have bent edges");
    const angles = bent.map((e) => arrivalAngle(placed, e));
    const mean = angles.reduce((a, b) => a + b, 0) / angles.length;
    assert.ok(mean < 20, `mean arrival ${mean.toFixed(1)}° should be well under dagre's 31.4°`);
  });

  it("ends every edge on the boundary of its target, not inside it", () => {
    for (const e of placed.edges) {
      if (e.selfLoop) continue;
      const dst = placed.nodes.find((n) => n.id === e.to)!;
      const end = e.points[e.points.length - 1];
      const inX = Math.abs(end.x - dst.x) < dst.width / 2 - 0.5;
      const inY = Math.abs(end.y - dst.y) < dst.height / 2 - 0.5;
      assert.ok(!(inX && inY), `${e.from}->${e.to} ends inside ${e.to}`);
    }
  });
});

describe("self-loops", () => {
  // dagre returns a degenerate path for `A --> A`: duplicated points that
  // double back and start outside the node. It is never given one.
  const placed = place("flowchart TD\n A --> A\n A --> B");

  it("draws a loop with real geometry", () => {
    const loop = placed.edges.find((e) => e.selfLoop)!;
    assert.ok(loop, "the self-loop survived layout");
    assert.ok(loop.points.length >= 4);
    const xs = new Set(loop.points.map((p) => `${p.x},${p.y}`));
    assert.equal(xs.size, loop.points.length, "no duplicated points");
  });

  it("keeps the loop inside the reported canvas", () => {
    const loop = placed.edges.find((e) => e.selfLoop)!;
    for (const p of loop.points) {
      assert.ok(p.x <= placed.width && p.y <= placed.height,
        `loop point ${p.x},${p.y} outside ${placed.width}x${placed.height}`);
    }
  });
});

describe("basisPath is d3's curveBasis", () => {
  // Ported rather than depended on — 25 lines against a package — so the
  // equivalence is worth stating. These expectations come from d3-shape's own
  // output for the same inputs, including two real corridors dagre produced
  // for the LIVE loop diagram.
  it("draws a straight line through two points", () => {
    assert.equal(basisPath([{ x: 0, y: 0 }, { x: 10, y: 10 }]), "M0,0L10,10");
  });

  it("matches d3 on a three-point corridor", () => {
    // d3-shape emits
    //   M128,44L132.667,48.167C137.333,52.333,146.667,60.667,151.333,69
    //          C156,77.333,156,85.667,156,89.833L156,94
    // for this input. Ours is that to 2dp — coordinates are rounded on the way
    // out, because a diagram is not measured in thousandths of a pixel and the
    // saved bytes go into every event that carries a fence.
    assert.equal(
      basisPath([{ x: 128, y: 44 }, { x: 156, y: 69 }, { x: 156, y: 94 }]),
      "M128,44L132.67,48.17C137.33,52.33,146.67,60.67,151.33,69C156,77.33,156,85.67,156,89.83L156,94",
    );
  });

  it("matches d3 on a four-point corridor", () => {
    assert.equal(
      basisPath([{ x: 160, y: 130 }, { x: 166, y: 155 }, { x: 166, y: 198 }, { x: 134, y: 266 }]),
      "M160,130L161,134.17C162,138.33,164,146.67,165,158C166,169.33,166,183.67,160.67,202.17" +
      "C155.33,220.67,144.67,243.33,139.33,254.67L134,266",
    );
  });

  it("reaches both endpoints exactly", () => {
    // A basis spline does *not* pass through its interior control points, and
    // it is often said not to reach its ends either. d3 duplicates the
    // terminals, so it does — which is why the tilt this module's layout
    // corrects was never the curve's fault.
    const pts = [{ x: 160, y: 130 }, { x: 166, y: 155 }, { x: 166, y: 198 }, { x: 134, y: 266 }];
    const d = basisPath(pts);
    assert.ok(d.startsWith("M160,130"), d.slice(0, 20));
    assert.ok(d.endsWith("L134,266"), d.slice(-20));
  });

  it("degrades safely on empty and single-point input", () => {
    assert.equal(basisPath([]), "");
    assert.equal(basisPath([{ x: 3, y: 4 }]), "M3,4");
  });
});
