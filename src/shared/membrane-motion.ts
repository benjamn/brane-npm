/**
 * How the 膜 film moves, as numbers the component can be handed.
 *
 * The film in `expo/components/Membrane.web.tsx` is Perlin noise read through
 * a moving window: `lift` carries the window up (so structure forms below and
 * dissolves above), `sway` carries it sideways, and `churn` is how fast the
 * noise evolves in place. The window's position and the noise's time phase
 * are *integrated* here, frame by frame, rather than computed as `rate * t`
 * in the shader: with `t` in the hundreds of seconds, changing a rate under
 * `rate * t` teleports the whole field, and the motion is meant to change
 * while you watch it. An awakening should read as the film starting to rise.
 *
 * A hand on the film holds it: while `held`, the drift stops at once (a
 * grip, not an ease) and `dragMotion` moves the window with the finger, so
 * the film follows it 1:1 (claude-u6qlei0j:6). Letting go eases the drift
 * back in. The churn keeps turning under a hand, so a held film still lives.
 *
 * `voice` names the motion by what it means. The glyph is the brane's
 * touch-and-hold-to-talk button in waiting (claude-1ejyovuv:115, :120), and
 * how it moves says whether the brane's voice is live or would need waking.
 * Window-free, so `src/test/membrane-motion.test.ts` can pin it.
 */

/** Whether the brane's voice is live (`awake`) or would need waking (`dormant`). */
export type MembraneVoice = "awake" | "dormant";

export type MembraneMotion = {
  /** Upward drift of the noise window, in noise units per second. */
  lift: number;
  /** Sideways drift, same units. */
  sway: number;
  /** How fast the noise evolves in place; 1 is the film as first merged. */
  churn: number;
};

export const MEMBRANE_MOTION: Record<MembraneVoice, MembraneMotion> = {
  // Half the lift #465 shipped with (0.14), which read as busier than a
  // resting surface should.
  awake: { lift: 0.07, sway: 0.012, churn: 1 },
  // Settled but alive: nothing rises, the swirl keeps turning slowly.
  dormant: { lift: 0, sway: 0.012, churn: 0.4 },
};

export const DEFAULT_MEMBRANE_VOICE: MembraneVoice = "awake";

/** The motion for a voice state, with any explicit rate winning over the preset. */
export function membraneMotion(
  voice: MembraneVoice = DEFAULT_MEMBRANE_VOICE,
  overrides: Partial<MembraneMotion> = {},
): MembraneMotion {
  const base = MEMBRANE_MOTION[voice];
  return {
    lift: overrides.lift ?? base.lift,
    sway: overrides.sway ?? base.sway,
    churn: overrides.churn ?? base.churn,
  };
}

/** Time constant of the ease toward a new motion: ~95% there after 3τ ≈ 1 s. */
export const MOTION_EASE_S = 0.35;

/** Longest step integrated at once. The loop stops while the glyph is off
 *  screen or the tab hidden, and the first frame back must continue from where
 *  the film was left rather than jump ahead by the whole absence. */
export const MOTION_MAX_DT_S = 0.1;

export type MotionState = {
  /** The rates in effect now, easing toward the target. */
  motion: MembraneMotion;
  /** Integrated window offset: x from sway, y from lift. */
  offset: [number, number];
  /** Integrated noise time phase, advanced at `churn` per second. */
  phase: number;
};

export function initialMotionState(motion: MembraneMotion): MotionState {
  return { motion: { ...motion }, offset: [0, 0], phase: 0 };
}

/** The shader reads the noise at `p * NOISE_SCALE + offset`, glyph-normalized
 *  `p`; a drag of `d` glyph widths is an offset change of `NOISE_SCALE * d`. */
export const NOISE_SCALE = 2.4;

/**
 * Advance by `dt` seconds toward `target`: ease the rates, then integrate the
 * position and phase at the eased rates. Position therefore only ever moves
 * by rate × dt, whatever the target does, so no change of motion can make the
 * field jump. While `held`, the drift is zero at once rather than eased: a
 * hand stops a film, and it is the release that eases back in.
 */
export function stepMotion(state: MotionState, target: MembraneMotion, dt: number, held = false): MotionState {
  const h = Math.min(Math.max(dt, 0), MOTION_MAX_DT_S);
  const k = 1 - Math.exp(-h / MOTION_EASE_S);
  const ease = (from: number, to: number) => from + (to - from) * k;
  const motion = {
    lift: held ? 0 : ease(state.motion.lift, target.lift),
    sway: held ? 0 : ease(state.motion.sway, target.sway),
    churn: ease(state.motion.churn, target.churn),
  };
  return {
    motion,
    offset: [state.offset[0] + motion.sway * h, state.offset[1] + motion.lift * h],
    phase: state.phase + motion.churn * h,
  };
}

/**
 * The film dragged by (dx, dy) glyph widths (y down, as the shader's `p`):
 * the noise window moves the other way by NOISE_SCALE times as much, so the
 * pattern under the finger stays under it. The one way the field moves by
 * more than rate × dt, and it is the hand's own motion.
 */
export function dragMotion(state: MotionState, dx: number, dy: number): MotionState {
  return { ...state, offset: [state.offset[0] - NOISE_SCALE * dx, state.offset[1] - NOISE_SCALE * dy] };
}
