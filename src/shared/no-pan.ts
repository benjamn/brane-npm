/** Rules that keep iOS Safari from moving the page under the app, window-free.
 *
 *  Every scroller in brane is an inner one; the page itself never scrolls.
 *  iOS moves it anyway in two ways, and both hide the header:
 *
 *  1. **The focus pan.** Focusing an input the keyboard will cover scrolls
 *     the page until the input clears it. Refused at the source: a tap on an
 *     editable is taken over and focuses it with `preventScroll`, which iOS
 *     honours for the keyboard too (measured on device, claude-3j4583pl:124).
 *  2. **The drag pan.** With the keyboard up the visible area is shorter than
 *     the page, and any drag the app doesn't scroll — on the header, on a bar,
 *     or past the end of a list — pans the page within it. Refused by allowing
 *     a vertical drag only where something under the finger can itself scroll
 *     that way.
 *
 *  The layout, meanwhile, is sized to the visible area (`--brane-vvh`), so a
 *  bottom bar sits on the keyboard without anything having to move. */

/** Movement past this between touchstart and touchend makes it a drag, not a
 *  tap: a scroll that happens to start on an input must not focus it. */
export const TAP_SLOP_PX = 10;

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** Whether a tap on this element should be taken over to focus it without
 *  the pan: text-entry controls that are enabled and writable. */
export function isTextEntry(el: {
  tagName: string;
  type?: string;
  disabled?: boolean;
  readOnly?: boolean;
  isContentEditable?: boolean;
}): boolean {
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag !== "INPUT" && tag !== "TEXTAREA") return false;
  if (el.disabled || el.readOnly) return false;
  return tag === "TEXTAREA" || !NON_TEXT_INPUTS.has((el.type ?? "text").toLowerCase());
}

/** One element between the touch target and the page, as the drag guard
 *  sees it: whether it scrolls vertically at all, and how far it can still
 *  move each way. Room, not `scrollTop`: a `column-reverse` scroller (the
 *  chat) runs from minus its range at the top to 0 at the bottom, so reading
 *  `scrollTop > 0` as "room above" would call a chat at its bottom stuck
 *  (claude-9cg5592w:8). */
export interface ScrollBox {
  scrolls: boolean;
  roomAbove: number;
  roomBelow: number;
}

/** A box's room each way from its raw scroll numbers. `reversed` is a
 *  `column-reverse` flex container, whose scroll origin is its bottom. */
export function scrollBoxOf(el: {
  overflowY: string;
  reversed: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): ScrollBox {
  const range = el.scrollHeight - el.clientHeight;
  const scrolls = (el.overflowY === "auto" || el.overflowY === "scroll") && range > 1;
  if (!scrolls) return { scrolls: false, roomAbove: 0, roomBelow: 0 };
  const [min, max] = el.reversed ? [-range, 0] : [0, range];
  return { scrolls: true, roomAbove: el.scrollTop - min, roomBelow: max - el.scrollTop };
}

/** Whether a drag may proceed. Horizontal drags always may — tab swipes and
 *  wide code blocks are the app's, and the page never pans sideways. A
 *  vertical one may only if some element under the finger (innermost first)
 *  can scroll in its direction; otherwise it would move the page. `dy > 0`
 *  is a finger moving down, which reveals what is above. */
export function dragAllowed(dx: number, dy: number, chain: readonly ScrollBox[]): boolean {
  if (Math.abs(dx) > Math.abs(dy)) return true;
  if (dy === 0) return true;
  for (const b of chain) {
    if (!b.scrolls) continue;
    if (dy > 0 && b.roomAbove > 1) return true;
    if (dy < 0 && b.roomBelow > 1) return true;
  }
  return false;
}

/** The layout height to use: the visible area's, except while pinch-zoomed,
 *  when the visible area is a magnified piece of the page and the layout must
 *  not change at all. */
export function layoutHeight(vvHeight: number, scale: number, previous: number | null): number | null {
  if (Math.abs(scale - 1) > 0.01) return previous;
  return Math.round(vvHeight);
}

/** After our own tap focuses a field, the keyboard takes a moment to rise;
 *  the field is not "focused with the keyboard down" during that window. */
export const TAP_FOCUS_GRACE_MS = 1000;

/** The invariant that keeps the focus pan from ever coming back: on a touch
 *  screen, a text field may hold focus only while the soft keyboard is up,
 *  or just after our own tap focused it. A field focused with the keyboard
 *  down — swiped away, focused from code, autofocused on load — turns the
 *  next tap into a native keyboard raise, and iOS pans for that one
 *  (claude-3j4583pl:171, :176). Every such state is blurred, whoever made
 *  it. Never on a fine pointer: there is no soft keyboard to wait for. */
export function mustBlur(s: {
  touch: boolean;
  textEntryFocused: boolean;
  keyboardUp: boolean;
  msSinceTapFocus: number;
}): boolean {
  return s.touch && s.textEntryFocused && !s.keyboardUp && s.msSinceTapFocus > TAP_FOCUS_GRACE_MS;
}
