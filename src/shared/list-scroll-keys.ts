/** The browser's scroll keys, for a list that doesn't hold focus.
 *
 *  A browser gives PageUp/PageDown, Home/End and the vertical arrows to the
 *  scroller that holds focus, or to the document when nothing does. The
 *  narrative list is an inner ScrollView, and the document has nothing to
 *  scroll on purpose (see public/index.html). So on a freshly loaded page, or
 *  after a click in the header, those keys reach no scroller and do nothing.
 *  The list screen hears them on `document` and moves its own scroller. This
 *  file works out where to scroll to. Deciding whether the screen should handle
 *  the key at all needs the DOM, so that part stays in the screen.
 *
 *  The steps match Chromium's: 40 px per arrow press, and 87.5% of the visible
 *  height per page, so a line from the old page stays in view.
 */

export const ARROW_STEP_PX = 40;
export const PAGE_FRACTION = 0.875;

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);

/** Whether this keydown is one the list should scroll for. Modified keys are
 *  left alone: ⌘↑/⌘↓ are the browser's own top/bottom keys, ⇧↑/⇧↓ extend a
 *  selection, and ⌥ and ⌃ belong to the OS. */
export function isListScrollKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return SCROLL_KEYS.has(e.key);
}

/** The scrollTop that `key` should move a scroller to, or `null` if the key
 *  doesn't scroll.
 *
 *  `from` is usually the scroller's current `scrollTop`. While a smooth scroll
 *  is still animating, pass the target it is heading for instead. Otherwise a
 *  second PageDown pressed mid-animation starts from wherever the animation
 *  had got to, and falls short of two pages. */
export function listScrollTarget(
  key: string,
  from: number,
  m: { clientHeight: number; scrollHeight: number },
): number | null {
  const max = Math.max(0, m.scrollHeight - m.clientHeight);
  const page = Math.max(1, m.clientHeight * PAGE_FRACTION);
  let to: number;
  switch (key) {
    case "ArrowUp": to = from - ARROW_STEP_PX; break;
    case "ArrowDown": to = from + ARROW_STEP_PX; break;
    case "PageUp": to = from - page; break;
    case "PageDown": to = from + page; break;
    case "Home": return 0;
    case "End": return max;
    default: return null;
  }
  return Math.min(max, Math.max(0, to));
}
