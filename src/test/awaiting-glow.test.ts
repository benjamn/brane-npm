import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GLOW_EDGES, awaitingGlow, isAwaiting, multiAwaitingGlow } from "../shared/narrative-status.js";

describe("awaiting glow", () => {
  it("is honoured only while bridged", () => {
    assert.equal(isAwaiting({ mcpConnected: true, awaiting: true }), true);
    assert.equal(isAwaiting({ mcpConnected: true, awaiting: false }), false);
    // A parked call cannot outlive its socket: a stale bit is not a fact.
    assert.equal(isAwaiting({ mcpConnected: false, awaiting: true }), false);
    assert.equal(isAwaiting({}), false);
  });

  it("is inset only, so it takes no layout and never spills", () => {
    for (const layer of awaitingGlow(271).split(/,\s*(?=inset)/)) {
      assert.match(layer, /^inset /);
    }
  });

  it("wears the hue it is given", () => {
    for (const h of [0, 90, 271, 359]) {
      for (const layer of awaitingGlow(h).split(/,\s*(?=inset)/)) {
        assert.match(layer, new RegExp(`oklch\\([\\d.]+ [\\d.]+ ${h} /`));
      }
    }
  });
});

describe("awaiting glow layers", () => {
  // The layers centred on the box, i.e. all but the one-sided top band.
  const centred = (h: number) => awaitingGlow(h).split(/,\s*(?=inset)/).filter((l) => l.startsWith("inset 0 0 "));

  it("are near-opaque at the rim, so the hue survives a dark row", () => {
    const alphas = centred(271).map((l) => Number(/\/ ([\d.]+)\)/.exec(l)![1]));
    assert.ok(alphas[0] >= 0.9, `rim alpha ${alphas[0]}`);
    for (let i = 1; i < alphas.length; i++) assert.ok(alphas[i] < alphas[i - 1], `alphas ${alphas}`);
  });

  it("hold lightness and chroma fixed across hues", () => {
    const lc = (h: number) => awaitingGlow(h).replace(new RegExp(` ${h} /`, "g"), " H /");
    for (const h of [0, 90, 180, 271]) assert.equal(lc(h), lc(0));
  });

  it("are all blurred: no solid edge line", () => {
    for (const layer of awaitingGlow(271).split(/,\s*(?=inset)/)) {
      const [, , blur] = layer.replace(/^inset /, "").split(" ");
      assert.notEqual(blur, "0", layer);
    }
  });

  it("thicken the top edge by one pixel, and only the top", () => {
    const [top] = awaitingGlow(271).split(/,\s*(?=inset)/).filter((l) => !l.startsWith("inset 0 0 "));
    const [, y, blur, spread] = top.replace(/^inset /, "").split(" ").map(parseFloat);
    // The hole, grown by -spread on every side, sits y + spread below the
    // top, and -spread past the sides, out of the blur's reach.
    assert.equal(y + spread, 1);
    assert.ok(-spread >= blur, top);
  });
});

describe("several awaiting narratives on one row", () => {
  // A daemon's row in the brane switcher: its undead, one edge each.
  const layers = (s: string) => s.split(/,\s*(?=inset)/);
  const geometry = (layer: string) => {
    const [x, y, blur, spread] = layer.replace(/^inset /, "").split(" ").map(parseFloat);
    return { x, y, blur, spread };
  };
  const hueOf = (layer: string) => Number(/oklch\([\d.]+ [\d.]+ (\d+) \//.exec(layer)![1]);
  const sideOf = (layer: string) => {
    const { x, y } = geometry(layer);
    return y > 0 ? "top" : y < 0 ? "bottom" : x > 0 ? "left" : x < 0 ? "right" : "ring";
  };
  const sides = (hues: number[]) => {
    const out = new Map<number, Set<string>>();
    for (const l of layers(multiAwaitingGlow(hues)!)) out.set(hueOf(l), (out.get(hueOf(l)) ?? new Set()).add(sideOf(l)));
    return [...out.entries()].map(([h, s]) => [h, [...s]]);
  };

  it("is nothing for none, and the narrative's own ring for one", () => {
    assert.equal(multiAwaitingGlow([]), undefined);
    assert.equal(multiAwaitingGlow([271]), awaitingGlow(271));
  });

  it("gives each hue one edge, long edges first: top, bottom, left, right", () => {
    assert.deepEqual(sides([10, 20]), [[10, ["top"]], [20, ["bottom"]]]);
    assert.deepEqual(sides([10, 20, 30]), [[10, ["top"]], [20, ["bottom"]], [30, ["left"]]]);
    assert.deepEqual(sides([10, 20, 30, 40]), [[10, ["top"]], [20, ["bottom"]], [30, ["left"]], [40, ["right"]]]);
  });

  it("runs out of edges at four; the row's words carry the rest", () => {
    assert.equal(GLOW_EDGES, 4);
    assert.deepEqual([...new Set(layers(multiAwaitingGlow([1, 2, 3, 4, 5, 6])!).map(hueOf))], [1, 2, 3, 4]);
  });

  it("keeps each edge's glow to its edge: the hole where the ring's is, the other sides past the blur", () => {
    const ring = awaitingGlow(0).split(/,\s*(?=inset)/).filter((l) => l.startsWith("inset 0 0 ")).map((l) => geometry(l).spread);
    for (const l of layers(multiAwaitingGlow([10, 20, 30, 40])!)) {
      const { x, y, blur, spread } = geometry(l);
      assert.match(l, /^inset /);
      assert.ok(x === 0 || y === 0, l);
      assert.ok(-spread >= blur, l);
      const hole = Math.abs(x) + Math.abs(y) + spread;
      assert.ok(ring.includes(hole), `${l}: hole at ${hole}, the ring's at ${ring}`);
    }
  });

  it("wears the ring's colors, hue for hue", () => {
    const colors = (s: string) => layers(s).map((l) => /oklch\(.*\)/.exec(l)![0]);
    const ring = new Set(colors(awaitingGlow(123)));
    const edge = colors(multiAwaitingGlow([123, 300])!).filter((c) => c.includes(" 123 /"));
    assert.equal(edge.length, 3);
    for (const c of edge) assert.ok(ring.has(c), c);
  });
});
