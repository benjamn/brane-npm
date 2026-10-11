/** Which narrative ids a screen is allowed to linkify.
 *
 *  `narrativeIdLinks` links only ids that actually exist, so that arbitrary
 *  strings of the same shape don't become dead links. That refusal is right,
 *  but it makes the *set* load-bearing in a way that is easy to miss: an
 *  incomplete set is indistinguishable, on screen, from a narrative that isn't
 *  there. Nothing renders differently. Nothing is logged. A reference just
 *  quietly stops being a link.
 *
 *  So the rule this module exists to enforce is: **linkification degrades, it
 *  does not switch off.** Ids come from every source the screen already has,
 *  ordered by how little can go wrong with them:
 *
 *    viewing — the route param. No network, always available.
 *    pushed  — the control channel's `state` frame, sent on connect over the
 *              socket the screen needs anyway, and covering every narrative
 *              including archived ones.
 *    listed  — the `GET /api/narratives` sweep. The heaviest request the
 *              screen makes, and the one that fails first on a slow link.
 *
 *  Before this, `listed` was the only source. On a slow or flaky connection it
 *  would fail, its rejection was swallowed, the effect could not re-fire, and
 *  every narrative reference on the screen stayed dead until a reload — while
 *  the conversation itself, fetched separately, rendered perfectly. That is
 *  what makes it read as "the linkifier is broken" rather than "a request
 *  didn't land".
 *
 *  Window-free on purpose, like `view-url.ts`, so the property can be tested
 *  without a browser.
 */

export type NidBearing = { id: string };

export type KnownNidSources = {
  /** The narrative currently on screen. */
  viewing?: string | null;
  /** Narratives from the control channel's `state` frame. */
  pushed?: Iterable<NidBearing> | null;
  /** Narratives from the HTTP list sweep. May never arrive. */
  listed?: Iterable<NidBearing> | null;
};

function addAll(into: Set<string>, from: Iterable<NidBearing> | null | undefined): void {
  if (!from) return;
  for (const n of from) {
    if (n && typeof n.id === "string" && n.id) into.add(n.id);
  }
}

/** Every narrative id this screen can vouch for.
 *
 *  Deliberately a union rather than a fallback chain: a source being present
 *  says nothing about it being complete. The `state` frame is a snapshot from
 *  connect time and misses anything spawned since; the list sweep is a moment
 *  later. Taking both costs nothing and each covers the other's gap.
 *
 *  Note what is *not* a source: ids parsed out of event `re` arrays. Those are
 *  never validated on write, so trusting them would hand the dead-link problem
 *  back to whoever wrote the reference — which is exactly what the existence
 *  check is there to prevent. */
export function collectKnownNids(sources: KnownNidSources): Set<string> {
  const known = new Set<string>();
  if (sources.viewing) known.add(sources.viewing);
  addAll(known, sources.pushed);
  addAll(known, sources.listed);
  return known;
}
