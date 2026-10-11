import { GlowHues } from "@shared/glow-hues";

/** The awaiting glow's hue allocator — see `src/shared/glow-hues.ts` — over
 *  this device's `localStorage`. Like the Recolor salt, it is a preference of
 *  this device's eyes and the daemon never hears of it. The accessor itself
 *  can throw (private windows, blocked site data); `GlowHues` guards every
 *  call, and an unreachable store means hues are allocated afresh. */
const glowHues = new GlowHues({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});

/** The hue a glowing narrative wears. Call only while it glows. */
export function glowHueFor(nid: string): number {
  return glowHues.hueFor(nid);
}

/** 🎨 Recolor's half for the glow: a random hue clear of the others and of
 *  the hues just recolored away from. */
export function recolorGlowHue(nid: string): number {
  return glowHues.recolor(nid);
}
