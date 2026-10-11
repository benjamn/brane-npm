import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import {
  MIN_SEMANTIC_SCORE,
  initMemorySchema,
  searchHybrid,
  upsertChunks,
  type SearchResult,
} from "../memory/storage.js";

// Synthetic vectors throughout — no embedding model. The floor is a numeric
// boundary, and pinning it needs similarities chosen to the second decimal,
// which is exactly what a real embedder won't give you twice. (The
// model-backed end-to-end path stays covered by search.test.ts.)

const DIM = 384;

/** A unit vector along `axis`. Distinct axes are orthogonal, so cosine
 *  similarity between them is 0; blending toward the query axis dials
 *  similarity to any value we want. */
function axisVector(axis: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  return v;
}

/** A unit vector whose cosine similarity to `axisVector(0)` is `target`.
 *  Built by rotating within the (0, axis) plane, so the result stays unit
 *  length and sqlite-vec's cosine distance comes back as 1 - target. */
function vectorWithSimilarity(target: number, axis = 1): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = target;
  v[axis] = Math.sqrt(Math.max(0, 1 - target * target));
  return v;
}

const QUERY = axisVector(0);

interface Chunk {
  nid: string;
  content: string;
  similarity: number;
}

function seed(chunks: Chunk[]) {
  const db = createTestDb();
  initMemorySchema(db);
  chunks.forEach((c, i) => {
    db.prepare(
      `INSERT OR IGNORE INTO narratives (id, brane_id, agent_type, role, created_at, status)
       VALUES (?, 'brane-test', 'claude', 'worker', 0, 'active')`,
    ).run(c.nid);
    upsertChunks(db, [{
      id: `${c.nid}:${i + 1}`,
      narrative_id: c.nid,
      seq: i + 1,
      content: c.content,
      time: 1000 + i,
      vector: vectorWithSimilarity(c.similarity, i + 1),
    }]);
  });
  return db;
}

function byNid(results: SearchResult[], nid: string): SearchResult | undefined {
  return results.find((r) => r.narrative_id === nid);
}

describe("searchHybrid — semantic relevance floor", () => {
  it("drops an unrelated chunk that a single co-occurring term boosted", () => {
    // The real failure this exists to prevent: a query term appears in an
    // otherwise-unrelated chunk, earning +0.5, which lifted it above genuinely
    // relevant matches.
    const db = seed([
      { nid: "claude-relevant", content: "the follow flag stays armed after the correction", similarity: 0.92 },
      { nid: "claude-unrelated", content: "a correction-clock runs slower than the capture-clock", similarity: 0.55 },
    ]);

    const results = searchHybrid(db, QUERY, "correction to the follow flag", 10);

    assert.ok(byNid(results, "claude-relevant"), "the relevant chunk survives");
    assert.equal(
      byNid(results, "claude-unrelated"),
      undefined,
      "a bare term co-occurring in unrelated text is not enough to qualify",
    );
  });

  it("keeps a weakly-similar chunk when every query term matched it", () => {
    // Exact-keyword evidence outranks similarity: an FTS hit means *all* terms
    // are present, so a rare identifier still wins even if the embedder shrugs.
    const db = seed([
      { nid: "claude-lexical", content: "followFlagRef is disarmed in cancelPendingPins", similarity: 0.2 },
    ]);

    const results = searchHybrid(db, QUERY, "followFlagRef cancelPendingPins", 10);

    const hit = byNid(results, "claude-lexical");
    assert.ok(hit, "an all-terms match survives a similarity well under the floor");
    assert.equal(hit.match, "keyword");
  });

  it("keeps an exact phrase match regardless of similarity", () => {
    const db = seed([
      { nid: "claude-phrase", content: "correctness resting on commit ordering is the real defect", similarity: 0.1 },
    ]);

    const results = searchHybrid(db, QUERY, '"correctness resting on commit ordering"', 10);

    const hit = byNid(results, "claude-phrase");
    assert.ok(hit, "phrase matches bypass the floor");
    assert.equal(hit.match, "phrase");
  });

  it("keeps a chunk with no keyword overlap when similarity clears the floor", () => {
    const db = seed([
      { nid: "claude-semantic", content: "entirely different wording about the same subject", similarity: 0.88 },
    ]);

    const results = searchHybrid(db, QUERY, "zzzz yyyy", 10);

    const hit = byNid(results, "claude-semantic");
    assert.ok(hit, "pure semantic relevance still qualifies");
    assert.equal(hit.match, "semantic");
  });

  it("never returns empty when nothing clears the floor — marks results weak", () => {
    // The bound on the floor's risk: a loosely-remembered search degrades to
    // low-confidence results, never to a blank page.
    const db = seed([
      { nid: "claude-loose", content: "vaguely adjacent material with no shared terms", similarity: 0.6 },
    ]);

    const results = searchHybrid(db, QUERY, "zzzz yyyy", 10);

    assert.equal(results.length, 1, "the only candidate is still returned");
    assert.equal(results[0].match, "weak", "and is labelled as not having qualified");
  });

  it("drops weak rows only when a qualified row replaces them", () => {
    // The precise guarantee: dropping is conditional on something better
    // surviving. Same weak chunk as above, now with a qualified peer.
    const weak = { nid: "claude-loose", content: "vaguely adjacent material with no shared terms", similarity: 0.6 };

    const alone = searchHybrid(seed([weak]), QUERY, "zzzz yyyy", 10);
    assert.equal(alone.length, 1, "alone, the weak row is kept");

    const withPeer = searchHybrid(
      seed([weak, { nid: "claude-strong", content: "clearly on topic", similarity: 0.95 }]),
      QUERY,
      "zzzz yyyy",
      10,
    );
    assert.ok(byNid(withPeer, "claude-strong"), "the qualified row is returned");
    assert.equal(byNid(withPeer, "claude-loose"), undefined, "and displaces the weak one");
  });

  it("reports the semantic score separately from the fused rank", () => {
    // Without this a caller cannot tell "ranked because it means the same
    // thing" from "ranked because a common word appeared".
    const db = seed([
      { nid: "claude-scored", content: "on topic and containing zzzz", similarity: 0.9 },
    ]);

    const results = searchHybrid(db, QUERY, "zzzz", 10);
    const hit = byNid(results, "claude-scored")!;

    assert.ok(hit.semantic !== undefined, "semantic score is exposed");
    assert.ok(
      Math.abs(hit.semantic - 0.9) < 0.02,
      `semantic score reflects similarity, not the boost (got ${hit.semantic})`,
    );

    // `score` is a fused *rank*, not a similarity, so its magnitude is not
    // comparable to `semantic` — under reciprocal-rank fusion a lone row scores
    // around 1/61. What has to hold is that the two report different things:
    // keyword evidence lifts the fused rank without touching the similarity the
    // floor reads.
    const withoutKeyword = byNid(searchHybrid(db, QUERY, "qqqq", 10), "claude-scored")!;
    assert.ok(
      hit.score > withoutKeyword.score,
      `the keyword hit lifts the fused rank (${hit.score} vs ${withoutKeyword.score})`,
    );
    assert.equal(withoutKeyword.semantic, hit.semantic, "while similarity is unchanged");
  });

  it("keeps keyword strength distinguishable instead of clipping it", () => {
    // The old `min(1, -bm25/10)` normalization clipped: on a real corpus every
    // match from bm25 -10 through -20 came back as exactly 1.0, so a tight hit
    // and an incidental all-terms hit in a long document were indistinguishable
    // by the time the floor saw them. bm25 discounts for document length; that
    // signal has to survive normalization to be worth anything.
    const term = "followFlagRef";
    const filler = "unrelated narration text that goes on at some length. ".repeat(40);
    const db = seed([
      { nid: "claude-tight", content: `${term} disarmed`, similarity: 0.1 },
      { nid: "claude-diffuse", content: `${filler} ${term} ${filler}`, similarity: 0.1 },
    ]);

    const results = searchHybrid(db, QUERY, term, 10);
    const tight = byNid(results, "claude-tight");
    const diffuse = byNid(results, "claude-diffuse");

    assert.ok(tight?.lexical !== undefined && diffuse?.lexical !== undefined,
      "both matches report a keyword strength");
    assert.ok(tight.lexical > diffuse.lexical,
      `a tight match scores above a diffuse one (tight=${tight.lexical}, diffuse=${diffuse.lexical})`);
    assert.ok(tight.lexical < 1, "and neither saturates at the top of the range");
  });

  it("gates on similarity alone, not on the boosted score", () => {
    // A chunk sitting just under the floor still collects keyword credit — one
    // of the two query terms appears in it — which is why the gate has to read
    // `semantic` rather than the fused `score`. Under the old additive scoring
    // the +0.5 term bonus carried such a row past any threshold worth setting;
    // under rank fusion the coverage multiplier does the same in miniature. The
    // gate is unchanged by either, which is the point.
    const justUnder = MIN_SEMANTIC_SCORE - 0.05;
    const db = seed([
      { nid: "claude-boosted", content: "unrelated text mentioning zzzz once", similarity: justUnder },
    ]);

    const boosted = byNid(searchHybrid(db, QUERY, "zzzz qqqq", 10), "claude-boosted");
    assert.equal(boosted?.match, "weak", "keyword credit does not promote it past the floor");

    // ...and it really was credited: the same row, queried without the term it
    // contains, ranks lower.
    const plain = byNid(searchHybrid(db, QUERY, "qqqq wwww", 10), "claude-boosted");
    assert.ok(
      (boosted?.score ?? 0) > (plain?.score ?? 0),
      `the term hit raised its rank (${boosted?.score} vs ${plain?.score})`,
    );
  });
});

describe("searchHybrid — quoted phrases are requirements", () => {
  it("excludes a semantically similar row that lacks the phrase", () => {
    // The leak this closes: FTS enforces the phrase on its own arm, but the
    // vector arm runs independently and used to union in rows that never
    // contained it — so quoting ranked rather than restricted.
    const db = seed([
      { nid: "claude-has", content: "correctness resting on commit ordering is the defect", similarity: 0.3 },
      { nid: "claude-similar", content: "the commit ordering here is a bit subtle", similarity: 0.95 },
    ]);

    const results = searchHybrid(db, QUERY, '"correctness resting on commit ordering"', 10);

    assert.ok(byNid(results, "claude-has"), "the row containing the phrase is returned");
    assert.equal(
      byNid(results, "claude-similar"),
      undefined,
      "high similarity does not substitute for the exact phrase",
    );
  });

  it("returns nothing when no row contains the phrase", () => {
    // Deliberately unlike the relevance floor, which never empties a result
    // set: quoting is an exact instruction, and zero results is the true answer.
    const db = seed([
      { nid: "claude-close", content: "commit ordering matters for correctness", similarity: 0.97 },
    ]);

    const results = searchHybrid(db, QUERY, '"correctness resting on commit ordering"', 10);
    assert.equal(results.length, 0, "no near-misses, no weak fallback");
  });

  it("requires every phrase when several are quoted", () => {
    const db = seed([
      { nid: "claude-both", content: "the follow flag went stale and cancelPendingPins ran", similarity: 0.2 },
      { nid: "claude-one", content: "the follow flag went stale, nothing else happened", similarity: 0.9 },
    ]);

    const results = searchHybrid(db, QUERY, '"follow flag went stale" "cancelPendingPins ran"', 10);

    assert.ok(byNid(results, "claude-both"), "a row with both phrases is returned");
    assert.equal(byNid(results, "claude-one"), undefined, "one of two phrases is not enough");
  });

  it("leaves unquoted queries unrestricted", () => {
    const db = seed([
      { nid: "claude-semantic", content: "totally different wording", similarity: 0.9 },
    ]);

    const results = searchHybrid(db, QUERY, "follow flag went stale", 10);
    assert.ok(byNid(results, "claude-semantic"), "bare terms still match on meaning alone");
  });
});
