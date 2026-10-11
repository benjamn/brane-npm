import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUMP_VELOCITY,
  RUBBER_BAND_LIMIT,
  clampIndex,
  compactCount,
  releaseVelocity,
  rubberBand,
  springAtRest,
  springStep,
  throwTarget,
} from "../shared/hit-drum.js";

describe("hit drum", () => {
  it("rests on the nearest hit, never past either end", () => {
    assert.equal(clampIndex(2.4, 17), 2);
    assert.equal(clampIndex(2.6, 17), 3);
    assert.equal(clampIndex(-3, 17), 0);
    assert.equal(clampIndex(40, 17), 16);
    assert.equal(clampIndex(3, 0), -1);
  });

  it("resists more the further past an end it is pulled", () => {
    assert.equal(rubberBand(5.5, 17), 5.5);
    const a = 16 - rubberBand(16 - 0, 17);
    assert.equal(a, 0);
    const one = rubberBand(17, 17) - 16;
    const four = rubberBand(20, 17) - 16;
    assert.ok(one > 0 && one < 1, `one hit of pull stretches less than a hit (${one})`);
    assert.ok(four > one && four < RUBBER_BAND_LIMIT, `and never reaches the limit (${four})`);
    assert.ok(rubberBand(-1, 17) < 0 && rubberBand(-1, 17) > -RUBBER_BAND_LIMIT);
  });

  it("bumps a quarter-detent or so into the wall and settles back", () => {
    let s = { x: 16, v: BUMP_VELOCITY };
    let max = 16;
    for (let i = 0; i < 120 && !springAtRest(s.x, s.v, 16); i++) {
      s = springStep(s.x, s.v, 16, 1 / 60);
      max = Math.max(max, s.x);
    }
    const bump = max - 16;
    assert.ok(bump > 0.15 && bump < 0.5, `visible but small (${bump})`);
    assert.ok(springAtRest(s.x, s.v, 16), "and comes to rest on the end");
  });

  it("lands on its target without overshooting", () => {
    let s = { x: 0, v: 0 };
    let max = 0;
    let frames = 0;
    while (!springAtRest(s.x, s.v, 1) && frames < 600) {
      s = springStep(s.x, s.v, 1, 1 / 60);
      max = Math.max(max, s.x);
      frames++;
    }
    assert.ok(frames < 60, `settles within a second (took ${frames} frames)`);
    assert.ok(max <= 1.002, `no overshoot (peaked at ${max})`);
  });

  it("carries a flick a few hits, stopping at the ends", () => {
    assert.equal(throwTarget(3.2, 0, 17), 3);
    assert.equal(throwTarget(3, 10, 17), 7);
    assert.equal(throwTarget(3, -12, 17), 0);
    assert.equal(throwTarget(3, 1000, 17), 16);
  });

  it("measures release velocity over the last moments only", () => {
    const samples = [
      { t: 0, y: 0 },
      { t: 100, y: -100 },
      { t: 150, y: -140 },
      { t: 180, y: -160 },
    ];
    assert.ok(Math.abs(releaseVelocity(samples, 180) - -60 / 80) < 1e-9);
    assert.equal(releaseVelocity(samples, 400), 0, "a finger that paused before lifting throws nothing");
  });

  it("shortens totals past 999, rounding down", () => {
    assert.equal(compactCount(0), "0");
    assert.equal(compactCount(999), "999");
    assert.equal(compactCount(1000), "1k");
    assert.equal(compactCount(1234), "1.2k");
    assert.equal(compactCount(1999), "1.9k");
    assert.equal(compactCount(5000), "5k");
    assert.equal(compactCount(12345), "12k");
  });
});
