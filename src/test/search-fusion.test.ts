import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import {
  initMemorySchema,
  prepareFtsAnyQuery,
  prepareFtsQuery,
  searchHybrid,
  upsertChunks,
} from "../memory/storage.js";

// What this file pins is *ranking*, which had no test at all and so drifted
// until an exact quotation from a real message came back at rank 1 less than
// half the time. Measured on the operator's 43,876-chunk archive, the fusion
// this suite describes took that from 48% to 95%.
//
// Those corpus percentages can't live in a unit test — they move with the
// archive (the same probe read 52%, 47% and 37% across one afternoon as new
// events were indexed). So each case below is instead the *smallest corpus
// that reproduces one defect*, with vectors chosen by hand. A percentage tells
// you something regressed; these tell you which thing.
//
// Vectors are synthetic for the same reason search-floor.test.ts uses them: a
// real embedder won't give you the same similarity twice, and every case here
// turns on the vector arm being deliberately *wrong* — that's the situation the
// lexical arms exist to survive.

const DIM = 384;

/** A unit vector whose cosine similarity to {@link QUERY} is `target`. */
function withSimilarity(target: number, axis = 1): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = target;
  v[axis] = Math.sqrt(Math.max(0, 1 - target * target));
  return v;
}

const QUERY = withSimilarity(1);

interface Row {
  content: string;
  /** Cosine similarity to the query vector. */
  similarity: number;
}

function seed(rows: Row[]) {
  const db = createTestDb();
  initMemorySchema(db);
  db.prepare(
    `INSERT OR IGNORE INTO narratives (id, brane_id, agent_type, role, created_at, status)
     VALUES ('claude-test', 'brane-test', 'claude', 'worker', 0, 'active')`,
  ).run();
  upsertChunks(
    db,
    rows.map((r, i) => ({
      id: `claude-test:${i + 1}`,
      narrative_id: "claude-test",
      seq: i + 1,
      content: r.content,
      time: i,
      vector: withSimilarity(r.similarity, (i % (DIM - 1)) + 1),
    })),
  );
  return db;
}

const contents = (db: ReturnType<typeof seed>, query: string, limit = 10) =>
  searchHybrid(db, QUERY, query, limit).map((r) => r.content);

describe("search fusion", () => {
  // The case that motivated all of this. On the real archive, this query's only
  // all-terms match in 43,876 chunks came back 11th, behind ten one-line
  // operator signals that each contained the single word "daemon" and happened
  // to sit near the query in embedding space.
  //
  // Two compounding causes, both reproduced here: a flat +0.5 for *any* term
  // appearing (so 1-of-8 scored like 8-of-8), and score-blending two arms whose
  // numbers aren't on the same scale (so the vector arm won by construction).
  it("ranks the one chunk containing the whole query above topical one-liners", () => {
    const db = seed([
      {
        content:
          "The self-inflicted instance restarted the daemon four times today, " +
          "each time because a config write raced the supervisor's health check.",
        similarity: 0.64, // *below* the noise: the vector arm is no help here
      },
      { content: "Daemon is restarted", similarity: 0.82 },
      { content: "Restarting daemon now.", similarity: 0.79 },
      { content: "Restart* daemon", similarity: 0.78 },
      { content: "Now restart the daemon and test it yourself", similarity: 0.77 },
      { content: "daemon restarted", similarity: 0.76 },
    ]);

    const top = contents(db, "self-inflicted instance restarted the daemon four times today")[0];
    assert.match(top, /self-inflicted instance restarted/);
  });

  // Coverage has to *scale*, not merely exist. A row holding every query term
  // must beat one holding a single term, however similar the latter looks.
  it("scores partial keyword matches below complete ones", () => {
    const db = seed([
      { content: "one term only: embedding", similarity: 0.9 },
      { content: "tokenizer embedding pooling normalization vectors", similarity: 0.5 },
    ]);
    assert.match(
      contents(db, "tokenizer embedding pooling normalization vectors")[0],
      /tokenizer embedding pooling/,
    );
  });

  // The ANY arm's reason to exist. FTS5's implicit AND requires every term, so
  // a natural-language question — which no single chunk ever contains in full —
  // returned *zero* lexical candidates, silently disabling half of a "hybrid"
  // search at precisely the moment it was asked a hard question.
  it("finds the best partial match when no chunk contains every query term", () => {
    const db = seed([
      { content: "The intraOpNumThreads cap made embedding six times slower.", similarity: 0.6 },
      { content: "Unrelated note about terminal cursor rendering.", similarity: 0.61 },
      { content: "Another unrelated note about payload storage.", similarity: 0.62 },
    ]);
    const query = "which thread setting made embedding six times slower than before";

    // Precondition, asserted rather than assumed: the strict arm really does
    // come back empty here. If it ever stops doing so, this test is measuring
    // something else and should be rewritten rather than silently passing.
    const strict = db
      .prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH ?")
      .get(prepareFtsQuery(query)!) as { n: number };
    assert.equal(strict.n, 0);

    assert.match(contents(db, query)[0], /intraOpNumThreads/);
  });

  // A quoted phrase is an instruction, not a preference — the one filter
  // allowed to return nothing. The vector arm unions in rows independently, so
  // without this it would rank rather than restrict.
  it("treats a quoted phrase as a requirement", () => {
    const db = seed([
      { content: "the exact phrase we want lives here", similarity: 0.3 },
      { content: "a much closer neighbour that lacks it", similarity: 0.99 },
    ]);
    const results = searchHybrid(db, QUERY, '"exact phrase we want"', 10);
    assert.equal(results.length, 1);
    assert.match(results[0].content, /exact phrase we want/);
  });

  // ...but only quoting may empty the page. A loosely-remembered query gets
  // best-effort guesses, marked `weak`, rather than nothing.
  it("never returns an empty page for an unquoted query", () => {
    const db = seed([
      { content: "something about terminals", similarity: 0.4 },
      { content: "something about payloads", similarity: 0.39 },
    ]);
    const results = searchHybrid(db, QUERY, "zzqqxx blorptangle wibblefrotz", 10);
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.match === "weak"));
  });

  // The length penalty used to sit in the same branch as the missing keyword
  // boost, so a 15-character chunk holding one query word skipped the penalty
  // *and* collected the bonus. It now applies to rows with no lexical evidence,
  // which is the only place it was ever meant to.
  it("discounts very short chunks that match nothing lexically", () => {
    const db = seed([
      { content: "ok", similarity: 0.88 },
      {
        content:
          "A full paragraph of genuinely relevant prose that does not repeat " +
          "the query's vocabulary but is long enough to be a real answer.",
        similarity: 0.86,
      },
    ]);
    assert.match(contents(db, "some unrelated wording entirely")[0], /full paragraph/);
  });

  // A single rare identifier is the query most at risk from adding an OR arm:
  // it must not get diluted by loosely-related rows.
  it("keeps a rare identifier's exact match at rank 1", () => {
    const db = seed([
      { content: "Set intraOpNumThreads to 8; it saturates there.", similarity: 0.5 },
      { content: "thread pool sizing notes", similarity: 0.9 },
      { content: "more about threads and pools", similarity: 0.89 },
    ]);
    assert.match(contents(db, "intraOpNumThreads")[0], /intraOpNumThreads/);
  });
});

describe("prepareFtsAnyQuery", () => {
  it("ORs content terms and drops stopwords", () => {
    const q = prepareFtsAnyQuery("can we remove the unused code from the bundle");
    assert.equal(q, '("remove"* OR "unused"* OR "code"* OR "bundle"*)');
  });

  it("keeps quoted phrases conjunctive alongside the OR group", () => {
    const q = prepareFtsAnyQuery('"exact thing" alpha beta');
    assert.equal(q, '"exact thing" ("alpha"* OR "beta"*)');
  });

  // One term ORed with nothing is just that term — the strict arm already runs
  // it, and a duplicate query is pure cost.
  it("declines a single-term query, leaving it to the strict arm", () => {
    assert.equal(prepareFtsAnyQuery("intraOpNumThreads"), null);
    assert.equal(prepareFtsAnyQuery("the of and"), null);
  });

  it("returns null for an empty query", () => {
    assert.equal(prepareFtsAnyQuery(""), null);
    assert.equal(prepareFtsAnyQuery("   "), null);
  });
});
