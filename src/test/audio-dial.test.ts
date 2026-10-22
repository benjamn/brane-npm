import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  arcPath,
  clampFraction,
  elapsedFraction,
  formatClock,
  fractionAt,
  insideRing,
} from "../shared/audio-dial.js";

// The dial is the scrubber, the clock and the progress ring in one, so these
// pin the one conversion everything rides on: a point on the ring ↔ a
// fraction of the track, clockwise from 12 o'clock.

describe("elapsedFraction", () => {
  it("is 0 until the duration is known, 1 at and past the end", () => {
    assert.equal(elapsedFraction(30, 0), 0);
    assert.equal(elapsedFraction(30, NaN), 0);
    assert.equal(elapsedFraction(0, 120), 0);
    assert.equal(elapsedFraction(30, 120), 0.25);
    assert.equal(elapsedFraction(120, 120), 1);
    assert.equal(elapsedFraction(121, 120), 1);
  });
});

describe("fractionAt", () => {
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  it("reads the clock face clockwise from the top", () => {
    near(fractionAt(10, 10, 10, 0), 0);      // 12 o'clock
    near(fractionAt(10, 10, 20, 10), 0.25);  // 3
    near(fractionAt(10, 10, 10, 20), 0.5);   // 6
    near(fractionAt(10, 10, 0, 10), 0.75);   // 9
  });
  it("never returns 1: a hair left of the top is just under a full turn", () => {
    const f = fractionAt(10, 10, 9.999, 0);
    assert.ok(f > 0.99 && f < 1);
  });
});

describe("scrubbing by angle", () => {
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  it("puts the playhead where the finger points, wherever the drag began", () => {
    // The dial is a clock face, not a knob: a finger at 3 o'clock is a
    // quarter of the way through, however it got there. Across 12 o'clock it
    // is the end and then the start, as the finger says.
    const scrub = (x: number, y: number) => clampFraction(fractionAt(10, 10, x, y));
    near(scrub(20, 10), 0.25);
    near(scrub(10, 20), 0.5);
    assert.ok(scrub(9.999, 0) > 0.99);
    assert.ok(scrub(10.001, 0) < 0.01);
  });
});

describe("insideRing", () => {
  it("is the disc within the ring's inner edge, where letting go cancels", () => {
    // A 22px dial: center (11, 11), inner edge 8px out.
    assert.equal(insideRing(11, 11, 11, 11, 8), true);
    assert.equal(insideRing(11, 11, 16, 15, 8), true);    // 6.4px out
    assert.equal(insideRing(11, 11, 11, 3, 8), false);    // on the edge scrubs
    assert.equal(insideRing(11, 11, 30, 11, 8), false);   // a finger past the dial
  });
});

describe("arcPath", () => {
  it("draws nothing at 0 and a single arc below half", () => {
    assert.equal(arcPath(10, 10, 8, 0), "");
    const p = arcPath(10, 10, 8, 0.25);
    assert.match(p, /^M 10\.000 2\.000 A 8 8 0 0 1 18\.000 10\.000$/);
  });
  it("uses the large-arc flag past half", () => {
    assert.match(arcPath(10, 10, 8, 0.75), /^M 10\.000 2\.000 A 8 8 0 1 1 2\.000 10\.000$/);
  });
  it("draws a full circle as two halves, since one arc back to its start is empty", () => {
    const p = arcPath(10, 10, 8, 1);
    assert.equal((p.match(/ A /g) ?? []).length, 2);
    assert.ok(p.endsWith("10.000 2.000"));
  });
});

describe("formatClock", () => {
  it("is m:ss under an hour and h:mm:ss from one", () => {
    assert.equal(formatClock(0), "0:00");
    assert.equal(formatClock(59.9), "0:59");
    assert.equal(formatClock(754), "12:34");
    assert.equal(formatClock(6290.1), "1:44:50");
  });
  it("shows a placeholder for a time not yet known", () => {
    assert.equal(formatClock(NaN), "–:––");
    assert.equal(formatClock(Infinity), "–:––");
    assert.equal(formatClock(-1), "–:––");
  });
});
