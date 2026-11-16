/**
 * The snippet a search result shows: a window of the hit's text placed where
 * the query matched, split into segments so the matches can be painted.
 *
 * A hit is a whole chunk — often a long narration — and the result row has
 * room for two or three lines of it. Shown from its first character, the part
 * that made it a hit is usually clipped away, and the reader is left to trust
 * the ranking. So the window is placed on the densest run of matches (most
 * distinct terms, then most matches), with a little context before it, and
 * `…` marks each end that was cut.
 *
 * The match ranges come from the daemon (`src/memory/match-ranges.ts`), which
 * asks the search index's own tokenizer; this module never decides for itself
 * what matched. A hit with no ranges — found on meaning, not words — shows its
 * opening, unmarked.
 */

export type MatchRange = readonly [start: number, end: number];

export interface SnippetSegment {
  text: string;
  match: boolean;
}

export interface SnippetOptions {
  /** Characters of (collapsed) text to show. The row clamps by lines anyway;
   *  this bounds the work and decides where the trailing `…` goes. */
  window?: number;
  /** Characters of context to keep before the first match in the window. */
  lead?: number;
  /** Drop leading markdown heading lines (a wiki hit shows its heading as the
   *  `#anchor` label already). */
  stripHeading?: boolean;
}

const DEFAULT_WINDOW = 240;
const DEFAULT_LEAD = 40;

/** Collapse every whitespace run to one space (the snippet is a line of
 *  prose, and a newline would spend one of its two or three lines), starting
 *  at `from`. `map[i]` is the output offset of input offset `i`. */
function collapse(text: string, from: number): { out: string; map: number[] } {
  const map = new Array<number>(text.length + 1).fill(0);
  let out = "";
  let pendingSpace = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      map[i] = out.length;
      if (out.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    map[i] = out.length;
    out += c;
  }
  map[text.length] = out.length;
  return { out, map };
}

/** Offset just past any leading blank and markdown heading lines. */
function headingEnd(text: string): number {
  let at = 0;
  for (;;) {
    const nl = text.indexOf("\n", at);
    const line = text.slice(at, nl < 0 ? text.length : nl).trim();
    if (line !== "" && !/^#{1,6}\s/.test(line)) return at;
    if (nl < 0) return 0; // heading-only: show it rather than nothing
    at = nl + 1;
  }
}

/** Index of the start of the best cluster: the match whose following
 *  `span` characters hold the most distinct matched words, then the most
 *  matches. Ties go to the earliest. */
function bestClusterStart(text: string, ranges: Array<[number, number]>, span: number): number {
  let best = 0;
  let bestDistinct = -1;
  let bestCount = -1;
  for (let i = 0; i < ranges.length; i++) {
    const limit = ranges[i][0] + span;
    const words = new Set<string>();
    let count = 0;
    for (let j = i; j < ranges.length && ranges[j][1] <= limit; j++) {
      words.add(text.slice(ranges[j][0], ranges[j][1]).toLowerCase());
      count++;
    }
    if (words.size > bestDistinct || (words.size === bestDistinct && count > bestCount)) {
      best = i;
      bestDistinct = words.size;
      bestCount = count;
    }
  }
  return ranges[best][0];
}

/** Don't cut between the halves of a surrogate pair. */
function safeCut(text: string, at: number): number {
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff ? at + 1 : at;
}

export function buildHitSnippet(
  content: string,
  matches: readonly MatchRange[] | undefined,
  opts: SnippetOptions = {},
): SnippetSegment[] {
  const window = opts.window ?? DEFAULT_WINDOW;
  const lead = opts.lead ?? DEFAULT_LEAD;
  const skip = opts.stripHeading ? headingEnd(content) : 0;
  const { out: text, map } = collapse(content, skip);

  // Map the ranges into the collapsed text, dropping any in the stripped
  // heading or past the end (a stale range from a reindexed row).
  const ranges: Array<[number, number]> = [];
  for (const [s, e] of matches ?? []) {
    if (s < skip || e > content.length || e <= s) continue;
    const a = map[s];
    const b = map[e - 1] + 1;
    if (b <= a) continue;
    const prev = ranges[ranges.length - 1];
    if (prev && a < prev[1]) continue; // overlapping: keep the first
    ranges.push([a, b]);
  }
  ranges.sort((x, y) => x[0] - y[0]);

  let start = 0;
  if (ranges.length > 0) {
    const anchor = bestClusterStart(text, ranges, window - lead);
    if (anchor > lead) {
      // Fill the window: near the end, show more before rather than less.
      start = Math.max(0, Math.min(anchor - lead, text.length - window));
      // Snap forward to a word start, unless that would eat into the match.
      const sp = text.indexOf(" ", start);
      if (start > 0 && sp >= 0 && sp + 1 <= anchor && sp - start < 15) start = sp + 1;
    }
  }
  start = safeCut(text, start);
  let end = Math.min(text.length, start + window);
  if (end < text.length) {
    const sp = text.lastIndexOf(" ", end);
    if (sp > start + window / 2) end = sp;
    end = safeCut(text, end);
  }

  const segs: SnippetSegment[] = [];
  const push = (t: string, match: boolean) => {
    if (!t) return;
    const last = segs[segs.length - 1];
    if (last && last.match === match) last.text += t;
    else segs.push({ text: t, match });
  };
  if (start > 0) push("…", false);
  let at = start;
  for (const [a, b] of ranges) {
    if (b <= start) continue;
    if (a >= end) break;
    const s = Math.max(a, start);
    const e = Math.min(b, end);
    push(text.slice(at, s), false);
    push(text.slice(s, e), true);
    at = e;
  }
  push(text.slice(at, end), false);
  if (end < text.length) push("…", false);
  return segs;
}
