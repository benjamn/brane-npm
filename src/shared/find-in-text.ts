/** Find-in-file for the Files tab: the decisions, without the DOM.
 *
 *  The web hook (`expo/lib/findInFile.ts`) flattens a file body's text nodes
 *  into one string, asks this module where the query occurs, and maps each
 *  hit back onto the nodes it spans as a `Range`. Everything that is a rule
 *  rather than a DOM call lives here, so `src/test/find-in-text.test.ts` can
 *  pin it without a browser — smart-case, the `:N` line jump, which hit is
 *  current after the query changes, and the offset → node mapping that has
 *  to be exactly right for a highlight to land on the characters it names. */

/** Hits past this are not collected: a one-letter query in a large file would
 *  otherwise build tens of thousands of Ranges for a counter nobody reads. */
export const MAX_FIND_MATCHES = 5000;

/** A half-open `[start, end)` span of the flattened text. */
export interface TextSpan {
  start: number;
  end: number;
}

/** Smart-case, as in vim and ripgrep: an all-lowercase query matches any case,
 *  and a single uppercase letter makes the whole query exact. */
export function isCaseSensitive(query: string): boolean {
  return query !== query.toLowerCase();
}

/** `:120` → 120. Anything else — `:`, `:0`, `: 12`, `12` — is not a jump and
 *  is searched for literally. */
export function parseLineJump(query: string): number | null {
  const m = /^:(\d+)$/.exec(query.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/** Every non-overlapping occurrence of `query` in `text`, in order. The query
 *  is literal (no regex, no fuzziness) and is not trimmed: a trailing space is
 *  how you ask for the word and not the prefix. */
export function findMatches(text: string, query: string, limit = MAX_FIND_MATCHES): { matches: TextSpan[]; capped: boolean } {
  const matches: TextSpan[] = [];
  if (!query) return { matches, capped: false };
  const sensitive = isCaseSensitive(query);
  const hay = sensitive ? text : text.toLowerCase();
  const needle = sensitive ? query : query.toLowerCase();
  // toLowerCase can change a string's length (İ → i̇), which would shift every
  // offset after it. Fall back to the exact-case search rather than highlight
  // the wrong characters.
  const [h, n] = hay.length === text.length ? [hay, needle] : [text, query];
  let from = 0;
  while (from <= h.length - n.length) {
    const at = h.indexOf(n, from);
    if (at < 0) break;
    if (matches.length >= limit) return { matches, capped: true };
    matches.push({ start: at, end: at + n.length });
    from = at + n.length;
  }
  return { matches, capped: false };
}

/** The index of the first hit starting at or after `offset`, wrapping to 0 when
 *  every hit is before it; -1 when there are none. This is how the current hit
 *  stays put while the query is typed: each keystroke re-anchors on where the
 *  last current hit started, so `use` → `useM` → `useMemo` walks forward
 *  through the file instead of snapping back to its top. */
export function firstAtOrAfter(matches: readonly TextSpan[], offset: number): number {
  if (matches.length === 0) return -1;
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].start < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo < matches.length ? lo : 0;
}

/** Next (`+1`) or previous (`-1`) hit, wrapping at both ends. */
export function stepMatch(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return dir > 0 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** One text node's place in the flattened string: it occupies
 *  `[start, start + length)`. Separators between blocks occupy offsets that
 *  belong to no node. */
export interface NodeSlot {
  start: number;
  length: number;
}

/** A position inside one node: `node` indexes the slot list. */
export interface NodePoint {
  node: number;
  offset: number;
}

/** Map a span of the flattened text onto the nodes it covers, or null when an
 *  end falls in a separator (which `findMatches` can only produce if the query
 *  itself contains the separator character). `slots` must be in ascending,
 *  non-overlapping order, which is how a tree walk produces them. */
export function locateSpan(slots: readonly NodeSlot[], span: TextSpan): { start: NodePoint; end: NodePoint } | null {
  const start = locatePoint(slots, span.start, false);
  const end = locatePoint(slots, span.end, true);
  return start && end ? { start, end } : null;
}

/** The slot containing `pos`. A position on the boundary between two slots
 *  belongs to the later one as a start and to the earlier one as an end, so a
 *  Range never begins at the very end of a node or finishes at the very start
 *  of the next — both would be empty-looking edges on the highlight. */
function locatePoint(slots: readonly NodeSlot[], pos: number, isEnd: boolean): NodePoint | null {
  let lo = 0;
  let hi = slots.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = slots[mid];
    const lower = s.start;
    const upper = s.start + s.length;
    if (isEnd ? pos <= lower : pos < lower) hi = mid - 1;
    else if (isEnd ? pos > upper : pos >= upper) lo = mid + 1;
    else return { node: mid, offset: pos - s.start };
  }
  return null;
}
