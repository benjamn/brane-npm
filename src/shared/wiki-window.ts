/**
 * Lay out a windowed wiki read for a reader.
 *
 * `readWikiSection` (`src/memory/wiki.ts`) returns `prev` and `next`
 * **nearest-first** on both sides: `prev[0]` is the section just above the
 * current one, `next[0]` the one just below. That is the right shape for a
 * caller walking the page a hop at a time ("read on" = `next[0]`), and for
 * the reader's preloader, which interleaves `prev[i]` / `next[i]` so ±1 is
 * warmed before ±2.
 *
 * It is the wrong shape to render as a column. Above the current section the
 * page runs *toward* it, so the neighbors above must be listed in document
 * order — furthest first — or the column reads 3, 2, 1, [4], 5. Below, the
 * page runs *away* from it, and nearest-first already is document order.
 *
 * Window-free so `src/test/wiki-window.test.ts` can pin it without a browser.
 */
export interface NeighborColumns<N> {
  /** Sections above the current one, in document order (furthest first). */
  above: N[];
  /** Sections below the current one, in document order (nearest first). */
  below: N[];
}

export function neighborColumns<N>(prev: readonly N[], next: readonly N[]): NeighborColumns<N> {
  return { above: [...prev].reverse(), below: [...next] };
}
