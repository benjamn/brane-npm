import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { awaitingGlow, isAwaiting } from "../shared/narrative-status.js";

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
