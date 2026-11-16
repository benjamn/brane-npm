import * as sqliteVec from "sqlite-vec";
import type Database from "better-sqlite3";
import { VECTOR_DIM } from "./embeddings.js";

/** Convert Float32Array to Node Buffer for better-sqlite3 binding. */
function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** A chunk ready for storage (text + vector). */
export interface EmbeddedChunk {
  id: string;
  narrative_id: string;
  seq: number;
  content: string;
  time: number;
  vector: Float32Array;
}

/** A search result with relevance score. */
export interface SearchResult {
  narrative_id: string;
  seq: number;
  content: string;
  /** Fused rank: semantic similarity, keyword evidence, and boosts combined. */
  score: number;
  /** Embedding similarity alone, 0–1, before IDF weighting and keyword boosts.
   *  Absent when the row was found only by FTS (no vector neighbour), which is
   *  itself informative: the match is lexical, not semantic. This is what the
   *  relevance floor gates on — `score` can't serve, because the keyword boost
   *  lifts an unrelated chunk above any threshold worth setting. */
  semantic?: number;
  /** Keyword strength, 0–1, from the FTS bm25 rank (see {@link normalizeBm25}).
   *  Absent when the row had no FTS match. Unlike a bare "did any term appear"
   *  test, this accounts for term rarity and document length — an incidental
   *  all-terms match in a long essay scores well below a tight one. */
  lexical?: number;
  /** Why this row survived the floor: `phrase` and `keyword` cleared it on
   *  lexical evidence, `semantic` on embedding similarity, `weak` means nothing
   *  cleared the floor and this is a best-effort fallback (see
   *  {@link MIN_SEMANTIC_SCORE}). */
  match?: "phrase" | "keyword" | "semantic" | "weak";
}

/** Minimum embedding similarity for a row to qualify on semantic grounds alone.
 *
 *  Calibrated like the wiki's floor (`wiki.ts`): unrelated text sits around the
 *  0.5–0.6 similarity baseline this embedder returns for *anything*, so a floor
 *  must sit above that band to reject rather than merely reorder.
 *
 *  This gates the **semantic** score, never the fused one, and only for rows
 *  with no lexical evidence — exact phrases and FTS hits (which require every
 *  query term, see {@link prepareFtsQuery}) bypass it entirely. The failure it
 *  prevents is specific: a bare term co-occurring in unrelated text earns +0.5
 *  at {@link searchHybrid}, which used to outrank genuinely relevant matches. */
export const MIN_SEMANTIC_SCORE = 0.7;

/** Reciprocal-rank fusion constant: an arm's row at rank `i` contributes
 *  `weight / (RRF_K + i + 1)`.
 *
 *  Fusing by **rank** rather than by score is the point. The arms produce
 *  numbers on incomparable scales — the vector arm's is a cosine (in practice
 *  0.62–0.73 across this whole corpus, a band so narrow it barely orders
 *  anything), the lexical arms' a squashed bm25 topping out near 0.7 for an
 *  excellent hit. Adding or blending those meant the vector arm won by
 *  construction: a topically-adjacent one-line chunk outscored the only chunk
 *  in 43,876 that contained the operator's entire sentence. Ranks have no such
 *  units problem, which is why RRF is the standard answer here.
 *
 *  60 is the value from the original RRF paper (Cormack et al. 2009) and it is
 *  deliberately large: it flattens the gap between ranks 1 and 2 so that
 *  *agreement across arms* outweighs any single arm's confidence. */
const RRF_K = 60;

/** Per-arm fusion weights.
 *
 *  ALL outranks ANY because containing every query term is strictly stronger
 *  evidence than containing some of them; the two are the same index queried
 *  two ways, so a row matching both collects from both. The vector arm is
 *  weighted lowest because that is what it earns on this corpus — ablating it
 *  from this fused design costs one probe in sixty. It is kept because it is
 *  the only arm that can rank a row sharing no terms with the query at all. */
const ARM_WEIGHTS = { all: 2.0, any: 1.0, vector: 1.0 } as const;

/** Multipliers on a row's fused rank for how much of the query it contains:
 *  `× (1 + COVERAGE_WEIGHT × termFraction + PHRASE_COVERAGE_WEIGHT × phraseFraction)`.
 *
 *  This replaced a flat `+0.5` awarded for *any single* term appearing, under
 *  which a row holding one of eight query words scored identically to a row
 *  holding all eight. Coverage is what bm25 was already measuring and the
 *  fused score was already throwing away. */
const COVERAGE_WEIGHT = 1.5;
const PHRASE_COVERAGE_WEIGHT = 2.0;

/** Distinct content terms a row must contain to count as lexical evidence when
 *  it did *not* match every term. Two, so a single common word co-occurring in
 *  unrelated text still doesn't qualify — that noise is what the relevance
 *  floor exists to drop — while a genuine partial match does. */
const MIN_TERM_HITS = 2;

/** Minimum candidates fetched per arm regardless of `limit`. Fusion can only
 *  rank what the arms returned. */
const CANDIDATE_FLOOR = 100;

/** In the last-resort `weak` pass, keep rows scoring at least this fraction of
 *  the best surviving row.
 *
 *  Relative because a fused rank has no absolute meaning to threshold against —
 *  it depends on how many arms returned the row and how deep each went, so the
 *  old `score >= 0.35` constant would pass everything or nothing depending on
 *  `limit`. Loose rather than tight: nothing qualified, so the operator is
 *  being offered guesses and deserves a few to choose between rather than one
 *  arbitrary winner. */
const WEAK_RELATIVE_FLOOR = 0.25;

/** Terms carrying no retrieval signal. Deliberately the closed class of English
 *  function words rather than a tuned list. Used by the ANY arm (ORed, `the`
 *  would match most of the corpus and swamp bm25) and by the coverage weight (a
 *  row earns no credit for containing `of`). The ALL arm keeps them: there every
 *  term is a *restriction*, so a stopword narrows correctly and costs nothing. */
const STOPWORDS = new Set(
  ("a an and are as at be been being but by can could did do does doing done for from " +
    "had has have having he her hers him his how i if in into is it its me my no nor not " +
    "of on or our ours out over she should so than that the their theirs them then there " +
    "these they this those to up us was we were what when where which while who whom why " +
    "will with would you your yours").split(" "),
);

/** Does this term carry retrieval signal? */
export function isContentTerm(term: string): boolean {
  return term.length > 2 && !STOPWORDS.has(term.toLowerCase());
}

const SCHEMA_SQL = `
-- Embedded chunks metadata
CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  narrative_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  time INTEGER NOT NULL
);

-- vec0 virtual table for vector KNN search (cosine distance)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[${VECTOR_DIM}] distance_metric=cosine
);

-- FTS5 for keyword search
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  content='memory_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_chunks_au AFTER UPDATE ON memory_chunks BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE INDEX IF NOT EXISTS idx_memory_chunks_narrative ON memory_chunks(narrative_id);

-- Document frequency for IDF filtering
CREATE TABLE IF NOT EXISTS memory_content_df (
  content_key TEXT PRIMARY KEY,
  narrative_count INTEGER NOT NULL DEFAULT 1
);

-- Index cursors: tracks last indexed seq per narrative
CREATE TABLE IF NOT EXISTS memory_cursors (
  narrative_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);

-- Aggregate stats
CREATE TABLE IF NOT EXISTS memory_stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

/** Load sqlite-vec extension and create memory tables. */
export function initMemorySchema(db: Database.Database): void {
  sqliteVec.load(db);
  db.exec(SCHEMA_SQL);
}

/** Get the last indexed seq for a narrative (0 if never indexed). */
export function getLastIndexedSeq(db: Database.Database, narrativeId: string): number {
  const row = db
    .prepare("SELECT last_seq FROM memory_cursors WHERE narrative_id = ?")
    .get(narrativeId) as { last_seq: number } | undefined;
  return row?.last_seq ?? 0;
}

/** Update the cursor after indexing. */
export function setLastIndexedSeq(db: Database.Database, narrativeId: string, seq: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO memory_cursors (narrative_id, last_seq) VALUES (?, ?)",
  ).run(narrativeId, seq);
}

/** Upsert embedded chunks into storage within a transaction. */
export function upsertChunks(db: Database.Database, chunks: EmbeddedChunk[]): void {
  if (chunks.length === 0) return;

  const insertChunk = db.prepare(
    `INSERT OR REPLACE INTO memory_chunks (id, narrative_id, seq, content, time)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const deleteVec = db.prepare("DELETE FROM memory_vec WHERE chunk_id = ?");
  const insertVec = db.prepare(
    "INSERT INTO memory_vec (chunk_id, embedding) VALUES (?, ?)",
  );
  const upsertDf = db.prepare(
    `INSERT INTO memory_content_df (content_key, narrative_count)
     VALUES (?, 1)
     ON CONFLICT(content_key) DO UPDATE SET narrative_count = narrative_count + 1`,
  );

  const seen = new Set<string>();

  const tx = db.transaction(() => {
    for (const chunk of chunks) {
      insertChunk.run(chunk.id, chunk.narrative_id, chunk.seq, chunk.content, chunk.time);
      deleteVec.run(chunk.id);
      insertVec.run(chunk.id, vecToBuffer(chunk.vector));

      // Track DF per unique (content_key, narrative_id)
      const key = normalizeForDf(chunk.content);
      const pair = `${key}\0${chunk.narrative_id}`;
      if (!seen.has(pair)) {
        seen.add(pair);
        upsertDf.run(key);
      }
    }

    // Update total narratives count
    const total = db
      .prepare("SELECT COUNT(DISTINCT narrative_id) FROM memory_chunks")
      .get() as { "COUNT(DISTINCT narrative_id)": number };
    db.prepare(
      "INSERT OR REPLACE INTO memory_stats (key, value) VALUES ('total_narratives', ?)",
    ).run(total["COUNT(DISTINCT narrative_id)"]);
  });

  tx();
}

/** Hybrid search: three ranked arms fused by reciprocal rank, then weighted by
 *  how much of the query each row actually contains.
 *  When braneIds is provided, results are scoped to narratives in those branes.
 *
 *  Quoted phrases in `queryText` are **requirements** — every phrase atom must
 *  appear in a row's content, and this is the one filter permitted to return
 *  nothing. Everything else is ranking: see {@link MIN_SEMANTIC_SCORE} for the
 *  relevance floor, which by contrast never empties a result set.
 *
 *  See {@link RRF_K} for why the arms are fused by rank rather than by score,
 *  and {@link ARM_WEIGHTS} for what each arm is for. */
export function searchHybrid(
  db: Database.Database,
  queryVector: Float32Array,
  queryText: string,
  limit: number,
  braneIds?: string[],
): SearchResult[] {
  // Build brane filter set if scoping is requested
  let braneNids: Set<string> | undefined;
  if (braneIds && braneIds.length > 0) {
    const placeholders = braneIds.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT id FROM narratives WHERE brane_id IN (${placeholders})`)
      .all(...braneIds) as Array<{ id: string }>;
    braneNids = new Set(rows.map((r) => r.id));
  }

  // Fetch depth. Fusion only sees what each arm returned, so a candidate the
  // vector arm ranked 60th can still win on lexical evidence — but only if it
  // was fetched. The old `max(limit * 4, 20)` was far too shallow: a long exact
  // match is routinely outside the top 40 neighbours of its own quotation.
  const fetchLimit = Math.max(limit * (braneNids ? 20 : 10), CANDIDATE_FLOOR);

  const tokens = tokenizeQuery(queryText);
  const phraseNeedles = tokens
    .filter((t): t is { kind: "phrase"; text: string } => t.kind === "phrase")
    .map((t) => t.text.toLowerCase());
  const termNeedles = tokens
    .filter((t): t is { kind: "term"; text: string } => t.kind === "term")
    .map((t) => t.text.toLowerCase());
  // Terms that carry retrieval signal. Stopwords are dropped for the ANY arm
  // (ORed, they would match most of the corpus and swamp bm25) and for the
  // coverage weight (a row shouldn't earn credit for containing "the").
  const contentNeedles = termNeedles.filter(isContentTerm);

  // ── Three arms, each a ranked list ────────────────────────────────────────
  //
  // ALL and ANY are the same index queried two ways, and they fail in opposite
  // directions: ALL (FTS5 implicit AND) is precise but returns *nothing* for a
  // conversational question, since no chunk contains all thirteen words of it;
  // ANY always returns something but ranks loosely. Running both means a query
  // is never silently unanswerable, and agreement between them is itself signal
  // — a row that both arms rank highly collects from both.
  const allRows = searchFts(db, prepareFtsQuery(queryText), fetchLimit);
  const anyRows = searchFts(db, prepareFtsAnyQuery(queryText), fetchLimit);
  const vecRows = searchVector(db, queryVector, fetchLimit);

  // Rows the ALL arm matched — every query term present. That's the strong
  // lexical evidence the relevance floor exempts.
  const ftsHits = new Set(allRows.map((r) => `${r.narrative_id}:${r.seq}`));

  // ── Reciprocal-rank fusion ────────────────────────────────────────────────
  const merged = new Map<string, SearchResult>();
  const contribute = (rows: SearchResult[], weight: number) => {
    rows.forEach((row, i) => {
      const key = `${row.narrative_id}:${row.seq}`;
      let entry = merged.get(key);
      if (!entry) {
        entry = {
          narrative_id: row.narrative_id,
          seq: row.seq,
          content: row.content,
          score: 0,
        };
        merged.set(key, entry);
      }
      entry.score += weight / (RRF_K + i + 1);
      // Keep each arm's own measurement intact beside the fused rank: the floor
      // reads `semantic`, and a caller can tell a keyword hit from a guess.
      if (row.semantic !== undefined) entry.semantic = row.semantic;
      if (row.lexical !== undefined) {
        entry.lexical = Math.max(entry.lexical ?? 0, row.lexical);
      }
    });
  };
  contribute(allRows, ARM_WEIGHTS.all);
  contribute(anyRows, ARM_WEIGHTS.any);
  contribute(vecRows, ARM_WEIGHTS.vector);

  // A quoted phrase is a requirement, not a preference. FTS5 already enforces
  // it on its own arm, but the vector arm runs independently and unions in
  // rows that never contained the phrase — so quoting used to rank rather than
  // restrict. Every phrase atom must be present: two quoted phrases narrow,
  // they don't widen.
  //
  // This is the one filter allowed to return nothing. The relevance floor below
  // deliberately never empties a result set, because a loosely-remembered query
  // deserves best-effort results. Quoting is the opposite: an exact, unambiguous
  // instruction, where answering with rows that don't contain the string is
  // worse than answering with none.
  const results = phraseNeedles.length > 0
    ? [...merged.values()].filter((r) => {
        const lower = r.content.toLowerCase();
        return phraseNeedles.every((p) => lower.includes(p));
      })
    : [...merged.values()];

  for (const result of results) {
    const lower = result.content.toLowerCase();
    const phraseHits = phraseNeedles.filter((p) => lower.includes(p)).length;
    const termHits = contentNeedles.filter((t) => lower.includes(t)).length;
    // Coverage, not presence. The old rule added a flat +0.5 for *any* single
    // term appearing, so a row with one of eight query words scored exactly
    // like a row with all eight — which is how "Restart* daemon" came to
    // outrank the only chunk in the corpus containing the whole sentence.
    const termCoverage = contentNeedles.length
      ? termHits / contentNeedles.length
      : 0;
    const phraseCoverage = phraseNeedles.length
      ? phraseHits / phraseNeedles.length
      : 0;
    result.score *=
      1 + COVERAGE_WEIGHT * termCoverage + PHRASE_COVERAGE_WEIGHT * phraseCoverage;

    if (phraseHits > 0) {
      result.match = "phrase";
    } else if (ftsHits.has(`${result.narrative_id}:${result.seq}`)) {
      // Every query term matched.
      result.match = "keyword";
    } else if (termHits >= MIN_TERM_HITS) {
      // Not every term, but more than one — which is lexical evidence rather
      // than an incidental word, and what carries a paraphrased question where
      // no chunk contains the whole sentence and the ALL arm comes back empty.
      //
      // Deliberately a *count*, not a fraction. A fraction punishes long
      // queries for being long: the narration this rewrite was tested against
      // matches 2 of the 8 content terms in "can we remove unused code from the
      // bundle to shrink the machine learning runtime" — real evidence, and a
      // 50% coverage gate discarded it while admitting a 2-of-3 coincidence.
      // Coverage still *ranks* (see COVERAGE_WEIGHT); it no longer gates.
      result.match = "keyword";
    }
    // Rows with no lexical evidence at all still qualify on similarity.
    if (!result.match && (result.semantic ?? 0) >= MIN_SEMANTIC_SCORE) {
      result.match = "semantic";
    }
    // Length penalty, for rows with nothing lexical to stand on.
    //
    // Gated on lexical evidence, not on `match`. Those differ for exactly the
    // rows this exists to catch: a two-character chunk sitting close to the
    // query in embedding space clears MIN_SEMANTIC_SCORE, gets tagged
    // `semantic`, and would sail past a `!result.match` guard — which is how
    // "Restart* daemon" outranked a paragraph. Embedding similarity to a very
    // short string is cheap; it is not evidence that the string answers
    // anything. (It used to sit in the same `else` as the keyword boost, so a
    // short chunk holding one query term skipped the penalty *and* took the
    // boost — the two halves of the same bug.)
    if (phraseHits === 0 && termHits === 0) {
      result.score *= Math.min(1.0, Math.max(0.5, result.content.length / 50));
    }
  }

  // Apply brane scope filter
  const scoped = braneNids
    ? results.filter((r) => braneNids.has(r.narrative_id))
    : results;

  scoped.sort((a, b) => b.score - a.score);

  // Relevance floor, applied *relatively* so it can never empty a result set.
  //
  // A row qualifies on lexical evidence (an exact phrase, or an FTS hit — which
  // means every query term matched) or on embedding similarity clearing
  // MIN_SEMANTIC_SCORE. Rows with neither are the noise this exists to drop: a
  // single common word co-occurring in unrelated text, boosted above genuinely
  // relevant matches.
  //
  // But dropping them is only safe when something better takes their place. If
  // *nothing* qualifies, the query is loosely-remembered rather than off-topic,
  // and an empty page is the worse answer — so the unqualified rows come back
  // marked `weak`. The guarantee that buys: a result is only ever dropped when a
  // better-qualified one survived to replace it.
  const qualified = scoped.filter((r) => r.match !== undefined);
  if (qualified.length > 0) return qualified.slice(0, limit);

  // Nothing qualified. The surviving rows are ranked by fused position, and a
  // fused score has no absolute meaning to threshold against — it depends on
  // how many arms returned the row and how deep they went. So the fallback is
  // relative: keep what is close to the best of a bad lot, rather than testing
  // against a constant that would pass everything or nothing as `limit` moves.
  const best = scoped[0]?.score ?? 0;
  return scoped
    .filter((r) => r.score >= best * WEAK_RELATIVE_FLOOR)
    .slice(0, limit)
    .map((r) => ({ ...r, match: "weak" as const }));
}

function searchVector(
  db: Database.Database,
  queryVector: Float32Array,
  limit: number,
): SearchResult[] {
  const totalNarratives = getTotalNarratives(db);
  const dfMap = loadDfMap(db);

  const rows = db
    .prepare(
      `SELECT v.chunk_id, v.distance, c.narrative_id, c.seq, c.content
       FROM memory_vec v
       JOIN memory_chunks c ON c.id = v.chunk_id
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`,
    )
    .all(vecToBuffer(queryVector), limit) as Array<{
    chunk_id: string;
    distance: number;
    narrative_id: string;
    seq: number;
    content: string;
  }>;

  return rows.map((row) => {
    const rawScore = Math.max(0, 1.0 - row.distance);
    const contentKey = normalizeForDf(row.content);
    const df = dfMap.get(contentKey) ?? 1;
    const idf = idfWeight(df, totalNarratives);
    return {
      narrative_id: row.narrative_id,
      seq: row.seq,
      content: row.content,
      score: rawScore * idf,
      // Kept unweighted: IDF is a ranking adjustment for how *common* a chunk's
      // text is across narratives, which says nothing about whether this chunk
      // means what the query means. The floor needs the latter.
      semantic: rawScore,
    };
  });
}

/** Map FTS5's bm25 (negative, more negative = better) onto 0–1 without ever
 *  reaching either end.
 *
 *  The previous form, `min(1, -bm25/10)`, clipped: on a real corpus, matches
 *  from -10 through -20 all came back as exactly 1.0, so a tight hit in a short
 *  chunk and an incidental all-terms hit in a 6,000-character essay were
 *  indistinguishable by the time anything downstream saw them. bm25 already
 *  discounts for document length — that's the signal that separates the two —
 *  and clipping discarded it.
 *
 *  This rational curve is monotonic over the whole range, so ordering survives
 *  into the fused score. HALF is the bm25 magnitude that maps to 0.5; above it
 *  the curve flattens without ever saturating. */
const BM25_HALF = 10;

function normalizeBm25(bm25: number): number {
  const strength = Math.max(0, -bm25);
  return strength / (strength + BM25_HALF);
}

/** Run one FTS5 arm. Takes an already-prepared MATCH expression rather than raw
 *  text, because the same index is queried two ways — see
 *  {@link prepareFtsQuery} (all terms) and {@link prepareFtsAnyQuery} (any). */
function searchFts(
  db: Database.Database,
  ftsQuery: string | null,
  limit: number,
): SearchResult[] {
  if (!ftsQuery) return [];

  try {
    const rows = db
      .prepare(
        `SELECT c.narrative_id, c.seq, c.content, bm25(memory_fts) as bm25_score
         FROM memory_fts
         JOIN memory_chunks c ON memory_fts.rowid = c.rowid
         WHERE memory_fts MATCH ?
         ORDER BY bm25_score
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as Array<{
      narrative_id: string;
      seq: number;
      content: string;
      bm25_score: number;
    }>;

    return rows.map((row) => ({
      narrative_id: row.narrative_id,
      seq: row.seq,
      content: row.content,
      score: normalizeBm25(row.bm25_score),
      lexical: normalizeBm25(row.bm25_score),
    }));
  } catch {
    // FTS query might fail on special chars
    return [];
  }
}

function getTotalNarratives(db: Database.Database): number {
  const row = db
    .prepare("SELECT value FROM memory_stats WHERE key = 'total_narratives'")
    .get() as { value: number } | undefined;
  return row?.value ?? 1;
}

function loadDfMap(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare("SELECT content_key, narrative_count FROM memory_content_df")
    .all() as Array<{ content_key: string; narrative_count: number }>;
  return new Map(rows.map((r) => [r.content_key, r.narrative_count]));
}

function normalizeForDf(content: string): string {
  return content.toLowerCase().split(/\s+/).join(" ");
}

function idfWeight(df: number, totalDocs: number): number {
  if (totalDocs === 0 || df === 0) return 1.0;
  const ratio = Math.log(1.0 + totalDocs / df);
  const maxRatio = Math.log(1.0 + totalDocs);
  return ratio / maxRatio;
}

/**
 * Phrase delimiter pairs: opener → closer.
 *
 * - ASCII `"…"` — straight double quote, paired with itself.
 * - `"…"` (U+201C/U+201D) — typographic double quote, e.g. iOS smart-quote
 *   substitution.
 * - `'…'` (U+2018/U+2019) — typographic single quote, ditto.
 *
 * ASCII `'` is deliberately **not** a delimiter: it appears inside common
 * English contractions (`don't`, `it's`) and treating it as a phrase
 * boundary would shred bare-token queries that contain apostrophes.
 */
const PHRASE_DELIMITERS: Record<string, string> = {
  '"': '"',
  "“": "”",
  "‘": "’",
};

/** A character that opens (or in the case of self-paired `"`, also closes) a phrase. */
function isPhraseBoundary(c: string): boolean {
  return c in PHRASE_DELIMITERS || c === "”" || c === "’";
}

/**
 * A parsed query atom. `phrase` tokens demand exact-sequence matching;
 * `term` tokens are bare keywords subject to prefix matching at the FTS
 * layer.
 */
export type QueryToken =
  | { kind: "phrase"; text: string }
  | { kind: "term"; text: string };

/**
 * Tokenize a user query into phrase and term atoms.
 *
 * Recognizes the quote pairs in {@link PHRASE_DELIMITERS} for phrases.
 * Phrase contents are preserved verbatim (whitespace inside the phrase
 * is internal-tokenizer business). Bare terms shorter than 2 chars are
 * dropped as noise; tokens inside a phrase are kept regardless of length
 * since the operator quoted them deliberately. Unterminated phrases
 * (opener with no matching closer) are read to end-of-input — lenient
 * on operator typos.
 *
 * There is no escape mechanism for the closer inside a phrase: the
 * first matching closer ends the phrase.
 */
export function tokenizeQuery(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  const len = query.length;
  let i = 0;
  while (i < len) {
    while (i < len && /\s/.test(query[i])) i++;
    if (i >= len) break;

    const closer = PHRASE_DELIMITERS[query[i]];
    if (closer !== undefined) {
      i++;
      const start = i;
      while (i < len && query[i] !== closer) i++;
      const text = query.slice(start, i).trim();
      if (i < len) i++;
      if (text) tokens.push({ kind: "phrase", text });
    } else {
      const start = i;
      while (i < len && !/\s/.test(query[i]) && !isPhraseBoundary(query[i])) i++;
      const text = query.slice(start, i);
      if (text.length >= 2) tokens.push({ kind: "term", text });
    }
  }
  return tokens;
}

/**
 * Translate a user query into an FTS5 MATCH expression.
 *
 * Thin wrapper over {@link tokenizeQuery}: phrases become FTS5 phrase
 * literals, terms become prefix-matched literals, all ANDed together.
 * Returns null if the query yields no usable tokens.
 */
export function prepareFtsQuery(query: string): string | null {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return null;
  // FTS5 phrase syntax always uses ASCII double quotes.
  const parts = tokens.map((t) =>
    t.kind === "phrase" ? `"${t.text}"` : `"${t.text}"*`,
  );
  return parts.join(" ");
}

/**
 * Translate a user query into an FTS5 MATCH expression that requires only
 * *some* of it — the recall counterpart to {@link prepareFtsQuery}.
 *
 * The AND that `prepareFtsQuery` builds is right for a remembered fragment and
 * catastrophic for a question. "which thread setting made embedding six times
 * slower than the code it replaced" contains thirteen terms; no chunk in the
 * archive contains all thirteen, so the strict arm returns **zero** candidates
 * and the lexical half of a hybrid search silently switches itself off at
 * exactly the moment a natural-language query needs it. Measured on this
 * corpus, ORing the content terms instead put the intended event at rank 2.
 *
 * Quoted phrases stay conjunctive: quoting is an explicit instruction and
 * {@link searchHybrid} enforces it as a hard filter regardless. Stopwords are
 * dropped — ORed, `the` matches most of the archive and drowns bm25 in noise.
 *
 * Returns null when nothing usable survives, in which case the caller simply
 * has no ANY arm — the strict arm and the vector arm still run.
 */
export function prepareFtsAnyQuery(query: string): string | null {
  const tokens = tokenizeQuery(query);
  const phrases = tokens
    .filter((t): t is { kind: "phrase"; text: string } => t.kind === "phrase")
    .map((t) => `"${t.text}"`);
  const terms = tokens
    .filter((t): t is { kind: "term"; text: string } => t.kind === "term")
    .filter((t) => isContentTerm(t.text))
    .map((t) => `"${t.text}"*`);

  // A single content term ORed with nothing is just that term — let the strict
  // arm handle it rather than running an identical query twice.
  if (terms.length < 2) return phrases.length > 0 ? phrases.join(" ") : null;

  const any = `(${terms.join(" OR ")})`;
  return phrases.length > 0 ? `${phrases.join(" ")} ${any}` : any;
}
