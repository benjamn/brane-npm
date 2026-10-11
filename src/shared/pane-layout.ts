/** Which panes a narrative screen shows, and what tapping into one does to
 *  that set.
 *
 *  The visible set is `active ∪ pinned` — one derived rule with two writers
 *  (the tab bar's pin toggle, and every place that changes the active tab), so
 *  it belongs somewhere both can reach. It lives in `shared/` for the same
 *  reason `view-url.ts` does: being window-free is what makes the invariant
 *  below testable without a browser, and the invariant is one a DOM test would
 *  never have caught anyway.
 *
 *  Nothing here touches the URL; `viewParams` still serializes the pair.
 */

import { CANONICAL_TABS, type Tab } from "./view-url.js";

/** The panes rendered right now, in tab-bar order: the active one plus every
 *  pinned one. A single-element result is the full-width case; two or three
 *  split the row evenly. */
export function visiblePanes(active: Tab, pinned: Set<Tab>): Tab[] {
  return CANONICAL_TABS.filter((t: Tab) => t === active || pinned.has(t));
}

/** Move the keyboard to `tapped` **without taking a pane away**.
 *
 *  Naively, selecting a pane is just `setActiveTab` — but the outgoing pane is
 *  only visible because it was active, so unless it is pinned on the way past
 *  it disappears, and the split collapses to one full-width pane. That is the
 *  ordinary shape of a split (you are in Chat, you pin the Terminal), so the
 *  naive version means tapping the terminal in a split drops Chat.
 *
 *  Collapsing does not just surprise; it eats the tap. Pane selection runs on
 *  `pointerdown`, so the surviving pane doubles in width — sliding every
 *  control inside it sideways — before the finger lifts. The pointerup lands
 *  on some other element, no `click` is dispatched, and the button that was
 *  pressed never fires. On the terminal quick bar, whose row is centered, this
 *  is a quarter of the screen's travel and a keystroke silently lost.
 *
 *  So: pin the outgoing pane. The visible set is then unchanged whenever
 *  `tapped` was already visible, and merely grows by `tapped` when it wasn't
 *  (the reveal case — `revealTerminal`). It never shrinks.
 *
 *  Nor does the pin set. Tapping used to unpin the incoming pane too, on the
 *  grounds that being active already shows it — true, but a pin is the
 *  operator's statement, not bookkeeping: with Terminal and Files pinned,
 *  tapping into Files cleared Files' pin, and the next tab change dropped a
 *  pane the operator had asked to keep. A pin comes off only through its 📌.
 */
export function selectPane(
  active: Tab,
  pinned: Set<Tab>,
  tapped: Tab,
): { active: Tab; pinned: Set<Tab> } {
  const next = new Set(pinned);
  next.add(active);
  return { active: tapped, pinned: next };
}
