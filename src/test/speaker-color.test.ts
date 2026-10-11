import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  speakerHue,
  speakerColor,
  speakerBgColor,
  parseRecolorSalt,
} from "../shared/speaker-color.js";

// The function the app shipped with, verbatim — salt 0 must reproduce it so a
// narrative nobody has recolored keeps the colors it has always had.
function shippedHue(speaker: string): number {
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

// Same shape as real nids: `{type}-{8hex}`, so every one is the same length,
// which is the case a linear reshuffle gets wrong.
const SPEAKERS = Array.from({ length: 40 }, (_, i) => {
  const hex = ((i + 1) * 0x9e3779b1 >>> 0).toString(16).padStart(8, "0");
  return `claude-${hex}`;
});

const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe("speakerHue", () => {
  it("is the shipped hash at salt 0", () => {
    for (const s of [...SPEAKERS, "goose-aa11bb22", "web", "x", "brane"]) {
      assert.equal(speakerHue(s), shippedHue(s), s);
      assert.equal(speakerHue(s, 0), shippedHue(s), s);
    }
  });

  it("stays in [0, 360) for every salt", () => {
    for (let salt = 0; salt < 32; salt++) {
      for (const s of SPEAKERS) {
        const h = speakerHue(s, salt);
        assert.ok(Number.isInteger(h) && h >= 0 && h < 360, `${s} @${salt} → ${h}`);
      }
    }
  });

  it("reshuffles per speaker, not by rotating the whole palette", () => {
    // Under a uniform rotation every pairwise gap survives. Under a real
    // reshuffle most of them change — that is what lets two close hues part.
    const before = SPEAKERS.map((s) => speakerHue(s, 0));
    const after = SPEAKERS.map((s) => speakerHue(s, 1));
    let moved = 0, pairs = 0;
    for (let i = 0; i < SPEAKERS.length; i++) {
      for (let j = i + 1; j < SPEAKERS.length; j++) {
        pairs++;
        if (gap(before[i], before[j]) !== gap(after[i], after[j])) moved++;
      }
    }
    assert.ok(moved > pairs * 0.9, `${moved}/${pairs} pairwise gaps changed`);
  });

  it("separates a colliding pair within a few recolors", () => {
    // The operator's case: two speakers that hash within 15° of each other.
    // Find such a pair in the fixture, then show that some salt in the first
    // handful puts them at least 60° apart — a tap or two, not a lottery.
    let pair: [string, string] | null = null;
    outer: for (let i = 0; i < SPEAKERS.length; i++) {
      for (let j = i + 1; j < SPEAKERS.length; j++) {
        if (gap(speakerHue(SPEAKERS[i]), speakerHue(SPEAKERS[j])) <= 15) {
          pair = [SPEAKERS[i], SPEAKERS[j]];
          break outer;
        }
      }
    }
    assert.ok(pair, "fixture should contain a colliding pair");
    const [a, b] = pair!;
    const salts = [1, 2, 3, 4, 5].filter((salt) => gap(speakerHue(a, salt), speakerHue(b, salt)) >= 60);
    assert.ok(salts.length > 0, `no salt in 1..5 separates ${a} and ${b}`);
  });
});

describe("speakerColor / speakerBgColor", () => {
  it("share one hue and differ only in lightness", () => {
    for (const salt of [0, 3]) {
      const h = speakerHue("goose-aa11bb22", salt);
      assert.equal(speakerColor("goose-aa11bb22", salt), `hsl(${h}, 60%, 80%)`);
      assert.equal(speakerBgColor("goose-aa11bb22", salt), `hsl(${h}, 30%, 20%)`);
    }
  });
});

describe("parseRecolorSalt", () => {
  it("reads a stored count and treats anything else as the default palette", () => {
    assert.equal(parseRecolorSalt("3"), 3);
    assert.equal(parseRecolorSalt("0"), 0);
    assert.equal(parseRecolorSalt(null), 0);
    assert.equal(parseRecolorSalt(undefined), 0);
    assert.equal(parseRecolorSalt(""), 0);
    assert.equal(parseRecolorSalt("-2"), 0);
    assert.equal(parseRecolorSalt("1.5"), 0);
    assert.equal(parseRecolorSalt("purple"), 0);
  });
});
