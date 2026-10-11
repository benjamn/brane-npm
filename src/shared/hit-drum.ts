/** The physics of the find-in-file hit drum, window-free.
 *
 *  The drum's position is a real number in *hit units*: 2.0 means hit #3 is
 *  centered, 2.5 is halfway to #4. It does not wrap — reaching the first or
 *  last hit is information the reader needs — so a position past either end
 *  only ever exists as rubber-band overscroll on its way back. The page
 *  follows it in whole hits (`clampIndex`), snapping each onto the middle
 *  line as the drum passes it. */

/** The hit a position rests on: nearest, and never past either end. */
export function clampIndex(pos: number, count: number): number {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, Math.round(pos)));
}

/** How far past an end the drum can be pulled, in hits. */
export const RUBBER_BAND_LIMIT = 0.5;

/** Map a raw position (finger-tracked, unbounded) onto the drum: exact
 *  inside the range, and past either end an overscroll that grows ever more
 *  slowly toward `RUBBER_BAND_LIMIT` — the resistance that says "end". */
export function rubberBand(raw: number, count: number): number {
  const hi = Math.max(0, count - 1);
  const band = (over: number) => (RUBBER_BAND_LIMIT * over) / (RUBBER_BAND_LIMIT + over);
  if (raw < 0) return -band(-raw);
  if (raw > hi) return hi + band(raw - hi);
  return raw;
}

/** The nudge a step into an end gives the drum (hits/s): under the spring
 *  it travels about a quarter of a detent toward the wall and settles back,
 *  so Enter on the last hit visibly lands rather than doing nothing. */
export const BUMP_VELOCITY = 22;

/** Critically damped spring: fastest approach with no overshoot, so the page
 *  it drives never scrolls past a hit and comes back. */
export const SPRING_OMEGA = 16;

/** One integration step (semi-implicit Euler) toward `target`; `dt` in
 *  seconds, velocity in hits per second. */
export function springStep(x: number, v: number, target: number, dt: number, omega = SPRING_OMEGA): { x: number; v: number } {
  const a = -omega * omega * (x - target) - 2 * omega * v;
  const nv = v + a * dt;
  return { x: x + nv * dt, v: nv };
}

/** Close enough to call it landed. */
export function springAtRest(x: number, v: number, target: number): boolean {
  return Math.abs(x - target) < 0.002 && Math.abs(v) < 0.05;
}

/** How far a flick carries, in seconds of release velocity — the same
 *  projection iOS scroll views use (deceleration 0.998/ms ≈ 0.5 s), trimmed
 *  so a casual flick skims a handful of hits rather than the whole file. */
export const THROW_SECONDS = 0.35;

/** Where a release at `pos` moving `v` hits/s comes to rest: a whole hit,
 *  and never past either end — a flick into the last hit stops there, with
 *  its leftover velocity spent as a bounce against the wall. */
export function throwTarget(pos: number, v: number, count: number): number {
  return clampIndex(pos + v * THROW_SECONDS, count);
}

/** Release velocity from recent pointer samples, in px/ms: the slope over the
 *  last `windowMs`, so a finger that stopped before lifting throws nothing. */
export function releaseVelocity(samples: readonly { t: number; y: number }[], now: number, windowMs = 80): number {
  const recent = samples.filter((s) => now - s.t <= windowMs);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

/** A hit total short enough for the drum's face: exact below 1,000, then
 *  `1.2k`. Rounded down, so the total never claims a hit that isn't there;
 *  the ordinal beside it stays exact, which is what tells hit 1,234 from
 *  1,235. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${Math.floor(n / 100) / 10}k`;
  return `${Math.floor(n / 1000)}k`;
}
