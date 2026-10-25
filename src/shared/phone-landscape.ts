/**
 * When the narrative screen hides its header, leaving the tab bar on top.
 *
 * A phone held sideways has ~440pt of height, and the stacked header (id,
 * meta line, summary) took ~72 of it before the tab bar's ~41. Desktop has
 * room to spare at any window size, and the operator likes it as it is, so
 * the test is about the *device*, not the window: a window dragged short on a
 * laptop must never qualify, and neither may a desktop that happens to be
 * wider than it is tall.
 *
 * Window-free so it can be pinned without a browser (`phone-landscape.test.ts`);
 * `expo/lib/phoneLandscape.ts` feeds it from `screen`, `matchMedia` and the
 * window.
 */

/** Phones' short side is 320–440 CSS px; the smallest iPad's is 744. */
export const PHONE_SCREEN_MAX_SHORT_SIDE = 500;

export type PhoneLandscapeInput = {
  /** `screen.width` / `screen.height` — the device, which no window resize
   *  or split view changes. */
  screenWidth: number;
  screenHeight: number;
  /** `matchMedia("(pointer: coarse)")` — the primary pointer is a finger. */
  coarsePointer: boolean;
  /** `window.innerWidth` / `innerHeight` — which way the phone is held now. */
  windowWidth: number;
  windowHeight: number;
};

/** All three, never any one alone: a phone-class screen, touch as the
 *  primary pointer, and held in landscape. Orientation comes from the window
 *  rather than `screen`, because iOS Safari reports `screen` in portrait
 *  terms however the phone is turned. */
export function isPhoneLandscape(i: PhoneLandscapeInput): boolean {
  const shortSide = Math.min(i.screenWidth, i.screenHeight);
  if (!(shortSide > 0) || shortSide >= PHONE_SCREEN_MAX_SHORT_SIDE) return false;
  if (!i.coarsePointer) return false;
  return i.windowWidth > i.windowHeight;
}
