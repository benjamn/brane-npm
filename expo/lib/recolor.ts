import { parseRecolorSalt, recolorStorageKey } from "@shared/speaker-color";

/** The per-narrative palette salt behind 🎨 Recolor — see
 *  `src/shared/speaker-color.ts`. Kept in `localStorage`, like a draft: it is
 *  a preference of this device's eyes, not a fact about the narrative, so the
 *  daemon never hears of it. Every read is guarded because the accessor itself
 *  can throw (private windows, blocked site data), and a missing or unreadable
 *  value is simply the default palette. */

export function readRecolorSalt(nid: string): number {
  try {
    return parseRecolorSalt(localStorage.getItem(recolorStorageKey(nid)));
  } catch {
    return 0;
  }
}

/** Advance to the next palette and return it. */
export function bumpRecolorSalt(nid: string): number {
  const next = readRecolorSalt(nid) + 1;
  try {
    localStorage.setItem(recolorStorageKey(nid), String(next));
  } catch {}
  return next;
}
