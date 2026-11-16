/**
 * Where, in a search hit's text, the query matched — so a snippet can show the
 * reader *why* this row came back.
 *
 * The ranges come from FTS5's own `highlight()`, run over just the rows a
 * search returned. That is the point: both indexes tokenize with
 * `porter unicode61` and match terms as prefixes, so the index finds
 * `restarted` for `restart` and `daemons` for `daemon`. A client-side
 * substring or regex scanner can't agree with that — it would miss the stems
 * the index matched and mark substrings it didn't (`the` inside `other`). One
 * parse, never a second scanner: the marks are whatever the tokenizer that
 * ranked the row says matched.
 *
 * Offsets are UTF-16 code units into the row's `content`, i.e. JavaScript
 * string indices, half-open `[start, end)`.
 */
import type Database from "better-sqlite3";
import { isContentTerm, tokenizeQuery } from "./storage.js";

export type MatchRange = [start: number, end: number];

// Control characters that ordinary text doesn't carry. A row that does contain
// one gets no ranges rather than wrong ones (see parseHighlighted).
const OPEN = "\u0001";
const CLOSE = "\u0002";

/**
 * The FTS5 expression whose matches are worth marking: every quoted phrase,
 * and every content term (stopwords dropped, as the ANY arm drops them — a
 * snippet speckled with highlighted "the" guides the eye nowhere), all ORed so
 * each one is marked wherever it appears. A query made only of short or stop
 * words falls back to all of its terms, since otherwise it would mark nothing
 * even when the row was found on exactly those words.
 */
export function prepareHighlightQuery(query: string): string | null {
  const tokens = tokenizeQuery(query);
  const phrases = tokens.filter((t) => t.kind === "phrase").map((t) => `"${t.text}"`);
  const allTerms = tokens.filter((t) => t.kind === "term").map((t) => t.text);
  const content = allTerms.filter(isContentTerm);
  const terms = (content.length > 0 ? content : allTerms).map((t) => `"${t}"*`);
  const parts = [...phrases, ...terms];
  return parts.length > 0 ? parts.join(" OR ") : null;
}

/** Strip `highlight()`'s markers from `marked`, returning the ranges they
 *  delimited. `null` when the markers don't pair up — the text itself held a
 *  marker character, so the offsets can't be trusted. */
export function parseHighlighted(marked: string): MatchRange[] | null {
  const ranges: MatchRange[] = [];
  let out = 0;
  let open = -1;
  for (let i = 0; i < marked.length; i++) {
    const c = marked[i];
    if (c === OPEN) {
      if (open >= 0) return null;
      open = out;
    } else if (c === CLOSE) {
      if (open < 0) return null;
      if (out > open) ranges.push([open, out]);
      open = -1;
    } else {
      out++;
    }
  }
  return open >= 0 ? null : ranges;
}

type Index = { fts: "memory_fts" | "wiki_fts"; chunks: "memory_chunks" | "wiki_chunks" };

/** Run `highlight()` over the rows `rowFilter` selects from `index.chunks`,
 *  keyed by whatever `key` the filter's SELECT names. */
function highlightRows(
  db: Database.Database,
  index: Index,
  query: string,
  rowFilter: string,
  params: unknown[],
): Map<string, MatchRange[]> {
  const result = new Map<string, MatchRange[]>();
  const expr = prepareHighlightQuery(query);
  if (!expr || params.length === 0) return result;
  let rows: Array<{ key: string; content: string; marked: string }>;
  try {
    rows = db
      .prepare(
        `SELECT k.key AS key, c.content AS content,
                highlight(${index.fts}, 0, '${OPEN}', '${CLOSE}') AS marked
         FROM (${rowFilter}) k
         JOIN ${index.chunks} c ON c.rowid = k.rowid
         JOIN ${index.fts} ON ${index.fts}.rowid = k.rowid
         WHERE ${index.fts} MATCH ?`,
      )
      .all(...params, expr) as typeof rows;
  } catch {
    // A query FTS5 can't parse marks nothing; the search itself already
    // survived it the same way.
    return result;
  }
  for (const r of rows) {
    if (r.content.includes(OPEN) || r.content.includes(CLOSE)) continue;
    const ranges = parseHighlighted(r.marked);
    if (ranges && ranges.length > 0) result.set(r.key, ranges);
  }
  return result;
}

/** Match ranges for narrative search hits, keyed `${narrative_id}:${seq}`.
 *  Rows with no literal match (a purely semantic hit) are absent. */
export function narrativeMatchRanges(
  db: Database.Database,
  query: string,
  hits: ReadonlyArray<{ narrative_id: string; seq: number }>,
): Map<string, MatchRange[]> {
  if (hits.length === 0) return new Map();
  const values = hits.map(() => "(?, ?)").join(", ");
  return highlightRows(
    db,
    { fts: "memory_fts", chunks: "memory_chunks" },
    query,
    `SELECT rowid, narrative_id || ':' || seq AS key FROM memory_chunks
     WHERE (narrative_id, seq) IN (VALUES ${values})`,
    hits.flatMap((h) => [h.narrative_id, h.seq]),
  );
}

/** Match ranges for wiki chunks, keyed by chunk id. */
export function wikiMatchRanges(
  db: Database.Database,
  query: string,
  chunkIds: readonly string[],
): Map<string, MatchRange[]> {
  if (chunkIds.length === 0) return new Map();
  return highlightRows(
    db,
    { fts: "wiki_fts", chunks: "wiki_chunks" },
    query,
    `SELECT rowid, id AS key FROM wiki_chunks WHERE id IN (${chunkIds.map(() => "?").join(", ")})`,
    [...chunkIds],
  );
}
