import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DISTINCT_AT_L,
  EXCLUDED_HUE_DEG,
  MAX_ANCHORS,
  MIN_ANCHORS,
  MIN_ANCHOR_DE,
  MIN_HUE_SEP_DEG,
  MIN_SCHEME_DISTANCE,
  SCHEME_FAMILIES,
  abAt,
  anchorsDistinct,
  bandFade,
  fitToGamut,
  hueChromaAt,
  hueExcluded,
  hueSeparationDeg,
  inSrgbGamut,
  nextScheme,
  packAnchors,
  sampleScheme,
  schemeDistance,
  type MembraneScheme,
} from "../shared/membrane-palette.js";

// Each rule here came from looking at a contact sheet (claude-1cwe8u9p:22–33):
// the old generator's sixteen taps read as one rainbow; the first rework was
// too uniform; then "at least three anchors", "no repeats", "not two cyans".
// These pin the rules, not the look — a sheet is how the look gets judged.

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEG = 180 / Math.PI;
const SAMPLES = 400;

function samples(seed: number, n = SAMPLES): MembraneScheme[] {
  const rng = mulberry32(seed);
  let prev: MembraneScheme | null = null;
  return Array.from({ length: n }, () => (prev = nextScheme(prev, rng)));
}

describe("sampleScheme", () => {
  const all = samples(1);

  it("uses at least three anchors, and no more than the shader holds", () => {
    for (const s of all) {
      assert.ok(s.hues.length >= MIN_ANCHORS && s.hues.length <= MAX_ANCHORS, `${s.family}: ${s.hues.length}`);
      assert.equal(s.chromas.length, s.hues.length);
    }
  });

  it("never uses two anchors that would render alike", () => {
    for (const s of all) {
      const degs = s.hues.map((h) => h * DEG);
      for (let i = 0; i < degs.length; i++) {
        for (let j = i + 1; j < degs.length; j++) {
          assert.ok(hueSeparationDeg(degs[i], degs[j]) >= MIN_HUE_SEP_DEG, `${s.family}: ${degs[i]}° vs ${degs[j]}°`);
          for (const L of DISTINCT_AT_L) {
            const [, a1, b1] = fitToGamut(L, 0.3, s.hues[i]);
            const [, a2, b2] = fitToGamut(L, 0.3, s.hues[j]);
            assert.ok(Math.hypot(a1 - a2, b1 - b2) >= MIN_ANCHOR_DE);
          }
        }
      }
    }
  });

  it("keeps the thin film's banding: 2.4–3.7 cycles, L from about 0.35 to 0.95", () => {
    for (const s of all) {
      const [cL, , mid, amp] = s.light;
      assert.ok(cL >= 2.4 && cL <= 3.7);
      assert.ok(mid - amp >= 0.29 && mid - amp <= 0.41, `trough ${mid - amp}`);
      assert.ok(mid + amp >= 0.89 && mid + amp <= 1.0, `crest ${mid + amp}`);
    }
  });

  it("puts no anchor between amber and green (claude-u6qlei0j:8), and still uses both sides of the band", () => {
    let below = 0, above = 0;
    for (const s of all) {
      for (const h of s.hues.map((r) => r * DEG)) {
        assert.ok(!hueExcluded(h), `${s.family}: ${h.toFixed(1)}°`);
        assert.ok(h < EXCLUDED_HUE_DEG[0] || h > EXCLUDED_HUE_DEG[1]);
        if (h < EXCLUDED_HUE_DEG[0] && h > EXCLUDED_HUE_DEG[0] - 20) below++;
        if (h > EXCLUDED_HUE_DEG[1] && h < EXCLUDED_HUE_DEG[1] + 20) above++;
      }
    }
    assert.ok(below > 0 && above > 0, "the oranges and the greens either side of the band are not lost with it");
  });

  it("passes through every anchor within one unit of thickness", () => {
    for (const s of all) assert.ok(s.hue[0] >= 1, `hue rate ${s.hue[0]}`);
  });

  it("reaches every family", () => {
    const seen = new Set(all.map((s) => s.family));
    assert.deepEqual([...seen].sort(), [...SCHEME_FAMILIES].sort());
  });

  it("is reproducible from its random source", () => {
    assert.deepEqual(sampleScheme(mulberry32(42)), sampleScheme(mulberry32(42)));
  });
});

describe("anchorsDistinct", () => {
  it("rejects two cyans that are 30° apart on paper", () => {
    // sRGB is narrow around cyan: at these hues the displayable colors nearly
    // coincide, which is the case the angle test alone let through.
    assert.ok(hueSeparationDeg(185, 215) >= MIN_HUE_SEP_DEG);
    assert.equal(anchorsDistinct([185, 215, 40]), false);
  });

  it("accepts hues that stay apart once displayed", () => {
    assert.equal(anchorsDistinct([30, 150, 270]), true);
  });

  it("rejects a repeated hue outright", () => {
    assert.equal(anchorsDistinct([100, 100, 250]), false);
  });
});

describe("nextScheme", () => {
  it("moves each keyframe well away from the last", () => {
    const all = samples(2);
    for (let i = 1; i < all.length; i++) {
      assert.ok(schemeDistance(all[i - 1], all[i]) >= MIN_SCHEME_DISTANCE);
    }
  });

  it("counts a permutation of the same anchors as a different scheme", () => {
    const s = sampleScheme(mulberry32(7));
    const order = s.hues.map((_, i) => i).reverse();
    const reversed = { ...s, hues: order.map((i) => s.hues[i]), chromas: order.map((i) => s.chromas[i]) };
    assert.ok(schemeDistance(s, reversed) > 0.02, "reversed order is not the same film");
    assert.equal(schemeDistance(s, s), 0);
  });
});

describe("gamut", () => {
  it("fits every anchor to a displayable color at every lightness the bands reach", () => {
    for (const s of samples(3, 60)) {
      for (const h of s.hues) {
        for (let L = 0.3; L <= 0.96; L += 0.06) assert.ok(inSrgbGamut(...fitToGamut(L, 0.32, h)));
      }
    }
  });
});

describe("packAnchors", () => {
  it("repeats the first anchor after the last, so the lookup wraps without a modulo", () => {
    const s = sampleScheme(mulberry32(9));
    const packed = packAnchors(s);
    const n = s.hues.length;
    assert.equal(packed.length, (MAX_ANCHORS + 1) * 2);
    assert.equal(packed[2 * n], Math.fround(s.hues[0]));
    assert.equal(packed[2 * n + 1], Math.fround(s.chromas[0]));
  });
});


describe("no color from the band, ever (claude-u6qlei0j:8, :17)", () => {
  it("joins anchors by a straight line through OKLab: green to magenta fades through gray, not through yellow", () => {
    const s: MembraneScheme = { ...sampleScheme(mulberry32(5)), hues: [145 / DEG, 330 / DEG], chromas: [0.3, 0.3] };
    // Midway through the turn (w = 0.5 makes it linear over the whole segment).
    const [, C] = hueChromaAt(s, 0.25, 0.5);
    assert.ok(C < 0.06, `nearly gray in the middle, chroma ${C.toFixed(3)}`);
    // The line does pass the band (145° to 330° the short way is through
    // 60°), but only near the middle where there is almost no chroma, and
    // the band takes the rest: nothing in its core, only the ramps' remnant.
    for (let x = 0; x < 1; x += 1 / 512) {
      const [h, c] = hueChromaAt(s, x, 0.5);
      const hd = ((h * DEG) + 360) % 360;
      if (hd >= 75 && hd <= 115) assert.ok(c < 1e-9, `x ${x.toFixed(3)}: ${hd.toFixed(1)}° at chroma ${c.toFixed(3)}`);
      if (hueExcluded(hd)) assert.ok(c <= 0.06 * (1 - bandFade(hd)) + 1e-9, `x ${x.toFixed(3)}: ${hd.toFixed(1)}° at chroma ${c.toFixed(3)}`);
    }
  });

  it("what still lands in the band is neutral, ramped inside the band so an anchor just outside keeps its color", () => {
    assert.equal(bandFade(59), 0);
    assert.equal(bandFade(131), 0);
    assert.equal(bandFade(95), 1);
    assert.ok(bandFade(67) > 0 && bandFade(67) < 1);
    for (const s of samples(4, 200)) {
      for (let x = 0; x < 1; x += 1 / 256) {
        const [a, b] = abAt(s, x);
        const hd = ((Math.atan2(b, a) * DEG) + 360) % 360;
        const C = Math.hypot(a, b);
        if (hd >= 75 && hd <= 115) assert.ok(C < 1e-9, `${s.family} x ${x.toFixed(3)}: ${hd.toFixed(1)}° at ${C.toFixed(3)}`);
        if (hueExcluded(hd)) assert.ok(C <= 0.32 * (1 - bandFade(hd)) + 1e-9);
      }
    }
  });
});
