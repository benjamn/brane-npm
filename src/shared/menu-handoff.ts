/** Hands the 🦠 menu across a navigation: a list badge's End or Revive takes
 *  the operator to the narrative's terminal, and the narrative's own 🦠 menu is
 *  open when they get there, so the next tap (Archive, once the session is
 *  dead) is where the last one left off. The same for a Revive that continues
 *  under a new nid, from either surface.
 *
 *  Not a URL param: an open menu is a moment, not a view. A reload or a Back
 *  should not reopen it, and Meld and Isolate should not carry it to another
 *  device. A module-level slot is enough, since the screen that takes it is
 *  mounted by the very navigation that follows the handoff.
 *
 *  The slot expires, so a handoff whose navigation never happened (a revive
 *  that failed, say) is not picked up by a later, unrelated visit. */

export const HANDOFF_TTL_MS = 5000;

let pending: { nid: string; at: number } | null = null;

/** Ask the next narrative screen for `nid` to open with its 🦠 menu open. Call
 *  just before navigating there. */
export function handOffNarrativeMenu(nid: string, now: number = Date.now()): void {
  pending = { nid, at: now };
}

/** Whether a handoff for `nid` is waiting, consuming it if so. One taker: the
 *  screen that arrived. */
export function takeNarrativeMenuHandoff(nid: string, now: number = Date.now()): boolean {
  const p = pending;
  if (!p || p.nid !== nid) return false;
  pending = null;
  return now - p.at <= HANDOFF_TTL_MS;
}
