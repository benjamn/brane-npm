import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MEMBRANE_MOTION,
  MOTION_MAX_DT_S,
  NOISE_SCALE,
  dragMotion,
  initialMotionState,
  membraneMotion,
  stepMotion,
  type MembraneMotion,
  type MotionState,
} from "../shared/membrane-motion.js";

// The failure this module exists to prevent is a jump: the shader used to
// compute the film's position as `rate * t`, where changing the rate with t in
// the hundreds of seconds teleports the whole field. Integrating the position
// makes a jump impossible by construction, and these pin that — plus the
// defaults the operator chose, since they are a decision, not a derivation.

function run(state: MotionState, target: MembraneMotion, seconds: number, dt = 1 / 60): MotionState {
  for (let t = 0; t < seconds; t += dt) state = stepMotion(state, target, dt);
  return state;
}

describe("membraneMotion", () => {
  it("defaults to awake, rising at half the lift #465 shipped with", () => {
    assert.deepEqual(membraneMotion(), MEMBRANE_MOTION.awake);
    assert.equal(membraneMotion().lift, 0.14 / 2);
  });

  it("does not rise when dormant, and still churns", () => {
    const m = membraneMotion("dormant");
    assert.equal(m.lift, 0);
    assert.ok(m.churn > 0);
  });

  it("lets an explicit rate override the preset, and only that rate", () => {
    const m = membraneMotion("dormant", { lift: 0.2 });
    assert.equal(m.lift, 0.2);
    assert.equal(m.churn, MEMBRANE_MOTION.dormant.churn);
    assert.equal(m.sway, MEMBRANE_MOTION.dormant.sway);
    // An override that is undefined (a prop left off) is not an override.
    assert.deepEqual(membraneMotion("awake", { lift: undefined }), MEMBRANE_MOTION.awake);
  });
});

describe("stepMotion", () => {
  it("never moves the film by more than the fastest rate times the step", () => {
    const fast: MembraneMotion = { lift: 5, sway: 5, churn: 50 };
    let s = run(initialMotionState(MEMBRANE_MOTION.awake), MEMBRANE_MOTION.awake, 300);
    // Retarget from a film that has been running five minutes: under `rate * t`
    // this is where the field would leap by ~1500 units.
    for (const target of [fast, MEMBRANE_MOTION.dormant, MEMBRANE_MOTION.awake]) {
      const next = stepMotion(s, target, 1 / 60);
      assert.ok(Math.abs(next.offset[1] - s.offset[1]) <= 5 / 60);
      assert.ok(Math.abs(next.offset[0] - s.offset[0]) <= 5 / 60);
      assert.ok(Math.abs(next.phase - s.phase) <= 50 / 60);
      s = next;
    }
  });

  it("eases to a new motion within about a second", () => {
    let s = initialMotionState(MEMBRANE_MOTION.dormant);
    s = run(s, MEMBRANE_MOTION.awake, 0.1);
    assert.ok(s.motion.lift > 0 && s.motion.lift < MEMBRANE_MOTION.awake.lift, "partway after 0.1 s");
    s = run(s, MEMBRANE_MOTION.awake, 1.1);
    assert.ok(Math.abs(s.motion.lift - MEMBRANE_MOTION.awake.lift) < 0.05 * MEMBRANE_MOTION.awake.lift);
    assert.ok(Math.abs(s.motion.churn - MEMBRANE_MOTION.awake.churn) < 0.05 * MEMBRANE_MOTION.awake.churn);
  });

  it("rises while awake and holds its height while dormant", () => {
    let s = run(initialMotionState(MEMBRANE_MOTION.awake), MEMBRANE_MOTION.awake, 10);
    assert.ok(Math.abs(s.offset[1] - 0.7) < 0.01, `10 s awake rises ~0.7, got ${s.offset[1]}`);
    s = run(s, MEMBRANE_MOTION.dormant, 3); // ease down
    const settled = s.offset[1];
    s = run(s, MEMBRANE_MOTION.dormant, 10);
    assert.ok(s.offset[1] - settled < 1e-3, "no further rise once dormant");
    assert.ok(s.phase > 0, "the swirl keeps turning");
  });

  it("steps a long frame as at most MOTION_MAX_DT_S", () => {
    const s0 = initialMotionState(MEMBRANE_MOTION.awake);
    const long = stepMotion(s0, MEMBRANE_MOTION.awake, 30);
    const capped = stepMotion(s0, MEMBRANE_MOTION.awake, MOTION_MAX_DT_S);
    assert.deepEqual(long, capped);
    // And a negative dt (a clock that went backwards) moves nothing.
    assert.deepEqual(stepMotion(s0, MEMBRANE_MOTION.awake, -1).offset, [0, 0]);
  });
});

describe("a hand on the film (claude-u6qlei0j:6)", () => {
  it("stops the drift at once while held, keeps churning, and eases back in on release", () => {
    let s = run(initialMotionState(MEMBRANE_MOTION.awake), MEMBRANE_MOTION.awake, 5);
    const heldFrom = s.offset;
    const phase = s.phase;
    s = stepMotion(s, MEMBRANE_MOTION.awake, 1 / 60, true);
    assert.deepEqual(s.offset, heldFrom, "the first held frame moves nothing");
    assert.deepEqual([s.motion.lift, s.motion.sway], [0, 0]);
    for (let t = 0; t < 3; t += 1 / 60) s = stepMotion(s, MEMBRANE_MOTION.awake, 1 / 60, true);
    assert.deepEqual(s.offset, heldFrom, "nor any later one");
    assert.ok(s.phase > phase, "the swirl keeps turning under the hand");
    // Released: the rise comes back the way an awakening does, not all at once.
    const first = stepMotion(s, MEMBRANE_MOTION.awake, 1 / 60);
    assert.ok(first.motion.lift > 0 && first.motion.lift < MEMBRANE_MOTION.awake.lift * 0.2);
    s = run(s, MEMBRANE_MOTION.awake, 1.2);
    assert.ok(Math.abs(s.motion.lift - MEMBRANE_MOTION.awake.lift) < 0.05 * MEMBRANE_MOTION.awake.lift);
    assert.ok(s.offset[1] > heldFrom[1], "and it rises again");
  });

  it("a drag moves the window against the finger, scaled to the noise, and nothing else", () => {
    const s = run(initialMotionState(MEMBRANE_MOTION.awake), MEMBRANE_MOTION.awake, 2);
    const d = dragMotion(s, 0.1, -0.25);
    assert.deepEqual(d.offset, [s.offset[0] - NOISE_SCALE * 0.1, s.offset[1] + NOISE_SCALE * 0.25]);
    assert.equal(d.phase, s.phase);
    assert.deepEqual(d.motion, s.motion);
    assert.deepEqual(dragMotion(s, 0, 0), s);
  });
});
