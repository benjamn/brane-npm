/** A mouse or trackpad drives this page, not a finger. Read once: a page
 *  doesn't trade pointers mid-session. The switchers' cards use it to take
 *  the whole window's height under a mouse, while on a touch screen they
 *  stop short and leave backdrop above and below to tap away on. */
export const FINE_POINTER =
  typeof window !== "undefined" && !!window.matchMedia?.("(pointer: fine)").matches;

/** The switchers' card geometry, shared so the two read as one design.
 *  The ✕ sits in a square box as tall as the title's line, and the space
 *  above the title equals the space below it: then the ✕ is the same
 *  distance from the card's top edge, its right edge and the list's top.
 *  The box reaches CLOSE_INSET into the side padding to make the right
 *  distance come out equal too. */
export const CARD_TITLE_LINE = 24;
export const CARD_TITLE_GAP = 16;
export const CARD_SIDE_PAD = 20;
export const CARD_CLOSE_INSET = CARD_SIDE_PAD - CARD_TITLE_GAP;
