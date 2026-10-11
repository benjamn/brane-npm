// Small subsequence fuzzy matcher for file paths. Case-insensitive.
//
// Each query char must appear in the target in order. Scoring rewards:
// - matches at word boundaries (/, _, -, ., space, digit-letter, camelCase)
// - consecutive runs of matched characters
// - matches near the end of the path (basename carries more weight)
// - shorter total targets
//
// Returns the top-N results sorted by descending score, with character
// indices for highlighting.
//
// For large file lists, build a `FuzzyIndex` once via `buildFuzzyIndex` and
// pass it to `fuzzyFilterIndex`. The index caches each target's lowercase
// form and a 32-bit character-presence bitmap, so most candidates are
// rejected with a single AND+compare before the full scorer runs. Passing
// the previous query's `survivors` lets the caller narrow incrementally
// when the new query extends the old — the common case while typing.

export interface FuzzyMatch {
  value: string;
  score: number;
  indices: number[]; // matched char positions in `value`
}

export interface FuzzyIndex {
  values: string[];
  lowers: string[];
  bitmaps: Int32Array;
}

export interface FuzzyFilterResult {
  matches: FuzzyMatch[];
  // Indices into index.values that passed the scorer. Feed back in as
  // `prevSurvivors` when the next query extends this one.
  survivors: Int32Array;
}

function isBoundary(prev: string, curr: string): boolean {
  if (!prev) return true;
  if (/[\/\\_\-. ]/.test(prev)) return true;
  if (/[a-z]/.test(prev) && /[A-Z]/.test(curr)) return true;
  if (/[^0-9]/.test(prev) && /[0-9]/.test(curr)) return true;
  return false;
}

// 32-bit bitmap of which character classes appear in a (lowercased) string.
// Collisions only produce false positives, never false negatives, so
// non-letter characters share a small number of spillover bits.
//   bits 0–25  a–z
//   bit  26    0–9
//   bit  27    .
//   bit  28    /
//   bit  29    -
//   bit  30    _
//   bit  31    anything else
function charBit(c: number): number {
  if (c >= 97 && c <= 122) return c - 97;
  if (c >= 48 && c <= 57) return 26;
  if (c === 46) return 27;
  if (c === 47) return 28;
  if (c === 45) return 29;
  if (c === 95) return 30;
  return 31;
}

function bitmapOf(lower: string): number {
  let bm = 0;
  for (let i = 0; i < lower.length; i++) {
    bm |= 1 << charBit(lower.charCodeAt(i));
  }
  return bm;
}

// Score a single target. Returns null if not a subsequence match.
// When `tLower` is provided, the caller has already lowercased; we skip
// re-lowering per call (the common fast-path when scoring from an index).
export function fuzzyScore(
  target: string,
  query: string,
  tLower?: string,
  qLower?: string,
): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] };
  const t = target;
  const tl = tLower ?? target.toLowerCase();
  const q = qLower ?? query.toLowerCase();
  const indices: number[] = [];
  let ti = 0;
  let qi = 0;
  let score = 0;
  let streak = 0;
  let firstMatch = -1;
  while (qi < q.length && ti < t.length) {
    if (tl.charCodeAt(ti) === q.charCodeAt(qi)) {
      if (firstMatch < 0) firstMatch = ti;
      const prev = ti > 0 ? t[ti - 1] : "";
      const curr = t[ti];
      let charScore = 1;
      if (isBoundary(prev, curr)) charScore += 4;
      if (t[ti] === query[qi]) charScore += 1; // exact case match (small bonus)
      charScore += streak * 2; // consecutive run bonus grows with streak
      score += charScore;
      streak += 1;
      indices.push(ti);
      qi += 1;
      ti += 1;
    } else {
      streak = 0;
      ti += 1;
    }
  }
  if (qi < q.length) return null;
  // Prefer matches closer to the basename (end of the path).
  const lastSlash = target.lastIndexOf("/");
  const basenameStart = lastSlash + 1;
  const inBasename = indices.filter((i) => i >= basenameStart).length;
  score += inBasename * 3;
  // Substring bonus: greedy matching can't backtrack, so directly reward
  // contiguous substring hits (strongly if in the basename, where they're
  // what users usually expect to rank first).
  const subIdx = tl.indexOf(q);
  if (subIdx >= 0) {
    score += 10;
    if (subIdx >= basenameStart) score += 15;
  }
  // Penalty for target length (prefer shorter targets on ties).
  score -= target.length * 0.05;
  // Penalty for a late first match (prefer prefix-ish matches).
  if (firstMatch > 0) score -= Math.min(firstMatch, 20) * 0.2;
  return { score, indices };
}

// Precompute per-target lowercase form and char bitmap. Do this once when
// the file list loads, not per keystroke.
export function buildFuzzyIndex(targets: string[]): FuzzyIndex {
  const n = targets.length;
  const lowers: string[] = new Array(n);
  const bitmaps = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const lower = targets[i].toLowerCase();
    lowers[i] = lower;
    bitmaps[i] = bitmapOf(lower);
  }
  return { values: targets, lowers, bitmaps };
}

// Filter using a prebuilt index. If `prevSurvivors` is provided, only those
// indices are rescored — use this when the caller knows the new query is an
// extension of the previous one (subsequence monotonicity guarantees that
// nothing outside the previous survivor set can match). The caller should
// pass `null` on the first query, or whenever the new query is not a
// prefix-extension of the previous.
export function fuzzyFilterIndex(
  index: FuzzyIndex,
  query: string,
  limit: number = 100,
  prevSurvivors: Int32Array | null = null,
): FuzzyFilterResult {
  if (!query) return { matches: [], survivors: new Int32Array(0) };
  const q = query.toLowerCase();
  const qBm = bitmapOf(q);
  const { values, lowers, bitmaps } = index;

  const results: FuzzyMatch[] = [];
  const survivors: number[] = [];
  const source = prevSurvivors;
  const len = source ? source.length : values.length;

  for (let k = 0; k < len; k++) {
    const i = source ? source[k] : k;
    if ((bitmaps[i] & qBm) !== qBm) continue;
    const m = fuzzyScore(values[i], query, lowers[i], q);
    if (!m) continue;
    results.push({ value: values[i], score: m.score, indices: m.indices });
    survivors.push(i);
  }

  results.sort(
    (a, b) =>
      b.score - a.score ||
      a.value.length - b.value.length ||
      (a.value < b.value ? -1 : 1),
  );
  return {
    matches: results.slice(0, limit),
    survivors: Int32Array.from(survivors),
  };
}

// Convenience wrapper that builds an ephemeral index. Prefer
// `buildFuzzyIndex` + `fuzzyFilterIndex` when the target list is stable
// across queries.
export function fuzzyFilter(
  targets: string[],
  query: string,
  limit: number = 100,
): FuzzyMatch[] {
  if (!query) return [];
  const index = buildFuzzyIndex(targets);
  return fuzzyFilterIndex(index, query, limit).matches;
}
