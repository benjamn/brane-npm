/**
 * Narrative list ordering — the single source of truth for the order narratives
 * appear in, shared by every surface that shows more than one of them.
 *
 * Two consumers today: the list screen (`expo/app/index.tsx`) and the header's
 * narrative switcher (`expo/app/[nid].tsx`). They have to agree. When this rule
 * lived only in the list screen, the switcher kept the older three-way rank it
 * had been copied from and went on rearranging itself under the operator's
 * thumb — in the one place that hurts most, since the switcher is a modal you
 * open in order to reach for a card.
 *
 * Deliberately dependency-free and framework-free, like its neighbors here, and
 * structurally typed: `NarrativeInfo` lives in `expo/lib/api.ts`, which this
 * file must not reach for. Ordering needs two fields, so it takes exactly those.
 *
 * Expo reaches this file through the `@shared/*` tsconfig path and the
 * `watchFolders` entry in `expo/metro.config.js` — keep it that way.
 */

/** The two fields ordering depends on. Any narrative-shaped record satisfies it. */
export interface NarrativeOrder {
  status: string;
  created_at: number;
}

/** Sort narratives: DEAD below everything, LIVE and IDLE interleaved. Newest first
 *  within each of the two groups.
 *
 *  Only the bottom edge is a partition, and that asymmetry is the point. DEAD is
 *  a durable fact about a session — it stays dead until someone revives it — so
 *  sinking it costs nobody a moving target. LIVE vs IDLE is not durable at all:
 *  it tracks `mcp_connected`, which drops whenever an agent's own work blocks its
 *  bridge, and comes back a moment later. Ranking on it made the list rearrange
 *  itself under the operator's thumb for a distinction that had already expired
 *  by the time the card landed. A card the operator is reaching for should not
 *  move because the agent inside it got busy.
 *
 *  `created_at` is the tiebreak rather than last activity for the same reason:
 *  it is the one key a status flip cannot touch, so within the live/idle block
 *  nothing moves at all.
 *
 *  The dead predicate is `status === "ended"`, matching the badge exactly (see
 *  `statusText` in `expo/app/index.tsx`) — the order on screen and the word on
 *  the card are then answering the same question.
 *
 *  Returns a new array; the input is not mutated. */
export function sortNarratives<T extends NarrativeOrder>(narrs: T[]): T[] {
  return [...narrs].sort((a, b) => {
    const rank = (n: NarrativeOrder) => (n.status === "ended" ? 1 : 0);
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : b.created_at - a.created_at;
  });
}
