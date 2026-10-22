/** The now-playing dial: a ring whose lit arc is the elapsed part of the
 *  track, turned by a finger to scrub. Window-free, so the angle and arc math
 *  the header's `NowPlayingDial` draws from can be tested on its own.
 *
 *  Angles are fractions of a turn, clockwise from 12 o'clock, in [0, 1]: the
 *  same scale as elapsed / duration, so a position on the track and a point
 *  on the dial convert without a unit in between. A scrub is exactly that
 *  conversion: the playhead goes where the line from the dial's center to the
 *  finger points (`fractionAt`), wherever the drag began. */

const FULL_TURN = Math.PI * 2;

/** How far through the track, in [0, 1]; 0 while the duration is unknown. */
export function elapsedFraction(position: number, duration: number): number {
  if (!(duration > 0) || !(position > 0)) return 0;
  return position >= duration ? 1 : position / duration;
}

export function clampFraction(f: number): number {
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Where a point lies around the dial's center, as a fraction of a turn
 *  clockwise from 12 o'clock, in [0, 1). */
export function fractionAt(cx: number, cy: number, x: number, y: number): number {
  const a = Math.atan2(x - cx, cy - y) / FULL_TURN;
  return a < 0 ? a + 1 : a;
}

/** Whether a point lies inside the ring, within `inner` of its center. The
 *  angle is useless to scrub by there, since a pixel swings it a long way
 *  near the center, so a drag let go inside the ring cancels instead of
 *  seeking. */
export function insideRing(cx: number, cy: number, x: number, y: number, inner: number): boolean {
  return Math.hypot(x - cx, y - cy) < inner;
}

/** How long a finger held still on the dial is a long-press, which opens the
 *  track's file rather than playing or pausing it. React Native's own
 *  `Pressable` default, so it is the hold every other long-press here takes. */
export const LONG_PRESS_MS = 500;

/** SVG path for the lit arc: from 12 o'clock, clockwise, `fraction` of the
 *  circle. Empty at 0. A full circle is two half-arcs, because one arc
 *  command whose start and end coincide draws nothing. */
export function arcPath(cx: number, cy: number, r: number, fraction: number): string {
  const f = clampFraction(fraction);
  if (f <= 0) return "";
  const pt = (t: number): string => {
    const a = t * FULL_TURN;
    return `${(cx + r * Math.sin(a)).toFixed(3)} ${(cy - r * Math.cos(a)).toFixed(3)}`;
  };
  if (f >= 1) return `M ${pt(0)} A ${r} ${r} 0 1 1 ${pt(0.5)} A ${r} ${r} 0 1 1 ${pt(0)}`;
  return `M ${pt(0)} A ${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${pt(f)}`;
}

/** `m:ss` under an hour, `h:mm:ss` from one; `–:––` for a time not yet known. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–:––";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}
