import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { appendEvent, readEvents } from "../db/events.js";
import { initMemorySchema, prepareFtsQuery, searchHybrid, tokenizeQuery } from "../memory/storage.js";
import { runIndex, hasUnindexedEvents } from "../memory/index.js";
import { disposeEmbeddingModel } from "../memory/embeddings.js";

// The embedding pipeline runs in a worker_threads Worker that keeps the
// test process alive until terminated. Tear it down after this suite so
// `node --test` can exit cleanly.
after(async () => {
  await disposeEmbeddingModel();
});

/** Create a test DB with migrations applied (adds archived column etc.) */
function createSearchTestDb() {
  const db = createTestDb();
  // Apply migrations that createTestDb doesn't run
  const cols = db.pragma("table_info(narratives)") as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("archived")) {
    db.exec("ALTER TABLE narratives ADD COLUMN archived INTEGER DEFAULT 0");
  }
  return db;
}

function insertNarrative(
  db: ReturnType<typeof createTestDb>,
  id: string,
  opts: {
    agent_type?: string;
    role?: string;
    status?: string;
    summary?: string;
    archived?: boolean;
  } = {},
) {
  const hasArchived = (db.pragma("table_info(narratives)") as Array<{ name: string }>)
    .some((c) => c.name === "archived");
  if (hasArchived) {
    db.prepare(
      `INSERT INTO narratives (id, brane_id, agent_type, role, status, summary, archived, created_at)
       VALUES (?, 'brane-test', ?, ?, ?, ?, ?, ?)`,
    ).run(id, opts.agent_type ?? "claude", opts.role ?? "worker", opts.status ?? "active",
      opts.summary ?? null, opts.archived ? 1 : 0, Date.now());
  } else {
    db.prepare(
      `INSERT INTO narratives (id, brane_id, agent_type, role, status, summary, created_at)
       VALUES (?, 'brane-test', ?, ?, ?, ?, ?)`,
    ).run(id, opts.agent_type ?? "claude", opts.role ?? "worker", opts.status ?? "active",
      opts.summary ?? null, Date.now());
  }
}

describe("events endpoint limit with after", () => {
  it("readEvents with after returns all events after cursor", () => {
    const db = createSearchTestDb();
    insertNarrative(db, "n1");
    for (let i = 0; i < 20; i++) {
      appendEvent(db, "n1", "narration", { content: `msg-${i}` });
    }

    // Without limit, returns all 15 events after seq 5
    const all = readEvents(db, "n1", { after: 5 });
    assert.equal(all.length, 15);
  });

  it("readEvents with after + tail caps results", () => {
    const db = createSearchTestDb();
    insertNarrative(db, "n1");
    for (let i = 0; i < 20; i++) {
      appendEvent(db, "n1", "narration", { content: `msg-${i}` });
    }

    // With tail, returns last N events after cursor
    const capped = readEvents(db, "n1", { after: 5, tail: 5 });
    assert.equal(capped.length, 5);
    // Should be the last 5 events (seq 16-20)
    assert.equal(capped[0].seq, 16);
    assert.equal(capped[4].seq, 20);
  });

  it("readEvents with after + before provides a window", () => {
    const db = createSearchTestDb();
    insertNarrative(db, "n1");
    for (let i = 0; i < 20; i++) {
      appendEvent(db, "n1", "narration", { content: `msg-${i}` });
    }

    // Window: events with 5 < seq < 15
    const windowed = readEvents(db, "n1", { after: 5, before: 15 });
    assert.equal(windowed.length, 9); // seq 6-14
    assert.equal(windowed[0].seq, 6);
    assert.equal(windowed[8].seq, 14);
  });
});

describe("tokenizeQuery", () => {
  it("returns terms for bare tokens", () => {
    assert.deepEqual(tokenizeQuery("foo bar"), [
      { kind: "term", text: "foo" },
      { kind: "term", text: "bar" },
    ]);
  });

  it("returns a phrase for a quoted span", () => {
    assert.deepEqual(tokenizeQuery('"foo bar"'), [
      { kind: "phrase", text: "foo bar" },
    ]);
  });

  it("mixes phrase and term tokens preserving order", () => {
    assert.deepEqual(tokenizeQuery('"foo bar" baz'), [
      { kind: "phrase", text: "foo bar" },
      { kind: "term", text: "baz" },
    ]);
  });

  it("recognizes smart-quote phrase pairs", () => {
    assert.deepEqual(tokenizeQuery("“foo bar” ‘baz qux’"), [
      { kind: "phrase", text: "foo bar" },
      { kind: "phrase", text: "baz qux" },
    ]);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(tokenizeQuery(""), []);
    assert.deepEqual(tokenizeQuery("   "), []);
  });
});

describe("prepareFtsQuery", () => {
  it("bare tokens become AND of prefix-matched terms", () => {
    assert.equal(prepareFtsQuery("foo bar"), '"foo"* "bar"*');
  });

  it("drops bare tokens shorter than 2 chars", () => {
    assert.equal(prepareFtsQuery("a foo b"), '"foo"*');
  });

  it("returns null for empty or all-too-short input", () => {
    assert.equal(prepareFtsQuery(""), null);
    assert.equal(prepareFtsQuery("   "), null);
    assert.equal(prepareFtsQuery("a b c"), null);
  });

  it("quoted phrase becomes an FTS5 phrase (no prefix)", () => {
    assert.equal(prepareFtsQuery('"foo bar"'), '"foo bar"');
  });

  it("phrase + bare term ANDs both", () => {
    assert.equal(prepareFtsQuery('"foo bar" baz'), '"foo bar" "baz"*');
  });

  it("phrase preserves short tokens that bare-token rules would drop", () => {
    assert.equal(prepareFtsQuery('"a b"'), '"a b"');
  });

  it("unterminated phrase reads to end-of-input", () => {
    assert.equal(prepareFtsQuery('foo "bar baz'), '"foo"* "bar baz"');
  });

  it("empty quoted span is dropped", () => {
    assert.equal(prepareFtsQuery('"" foo'), '"foo"*');
  });

  it("recognizes smart double quotes as a phrase pair", () => {
    assert.equal(prepareFtsQuery("“foo bar” baz"), '"foo bar" "baz"*');
  });

  it("recognizes smart single quotes as a phrase pair", () => {
    assert.equal(prepareFtsQuery("‘foo bar’"), '"foo bar"');
  });

  it("does not treat ASCII apostrophe as a delimiter (preserves contractions)", () => {
    assert.equal(prepareFtsQuery("don't stop"), `"don't"* "stop"*`);
  });

  it("smart-quote opener without matching closer reads to EOF", () => {
    assert.equal(prepareFtsQuery("foo “bar baz"), '"foo"* "bar baz"');
  });

  it("treats `\"` as a phrase boundary even when adjacent (no escape syntax)", () => {
    // `""hi""` is parsed as: empty phrase, then bare token `hi` (the trailing
    // `"` ends the bare token), then another empty phrase. Empties drop out;
    // `hi` is treated as a regular bare term.
    assert.equal(prepareFtsQuery('""hi""'), '"hi"*');
  });
});

describe("memory search", () => {
  it("hasUnindexedEvents detects unindexed events", () => {
    const db = createSearchTestDb();
    initMemorySchema(db);
    insertNarrative(db, "n1");
    appendEvent(db, "n1", "narration", { content: "hello world" });

    assert.equal(hasUnindexedEvents(db), true);
  });

  it("indexing and search finds matching content", async () => {
    const db = createSearchTestDb();
    initMemorySchema(db);
    insertNarrative(db, "n1");
    appendEvent(db, "n1", "narration", { content: "The mitochondria is the powerhouse of the cell" });
    appendEvent(db, "n1", "narration", { content: "JavaScript is a programming language" });

    await runIndex(db, false);
    assert.equal(hasUnindexedEvents(db), false);

    // Import embedText dynamically since it loads a model
    const { embedText } = await import("../memory/embeddings.js");
    const queryVector = await embedText("mitochondria cell biology");
    const results = searchHybrid(db, queryVector, "mitochondria cell biology", 10);

    assert.ok(results.length > 0, "Should find at least one result");
    assert.ok(
      results[0].content.includes("mitochondria"),
      "Top result should be about mitochondria",
    );
  });

  it("phrase match outranks bare-keyword match", async () => {
    const db = createSearchTestDb();
    initMemorySchema(db);
    insertNarrative(db, "n-adj");
    appendEvent(db, "n-adj", "narration", { content: "context compaction recovery happens after long sessions" });
    insertNarrative(db, "n-split");
    appendEvent(db, "n-split", "narration", { content: "context window state and unrelated compaction logic" });

    await runIndex(db, false);

    const { embedText } = await import("../memory/embeddings.js");
    const queryVector = await embedText("context compaction");

    const phrase = searchHybrid(db, queryVector, '"context compaction"', 10);
    assert.ok(phrase.length > 0, "phrase query should return results");
    const adj = phrase.find((r) => r.narrative_id === "n-adj");
    const split = phrase.find((r) => r.narrative_id === "n-split");
    assert.ok(adj, "phrase query should surface the adjacent-tokens narrative");
    if (split) {
      assert.ok(adj.score > split.score,
        `adjacent-phrase narrative should outrank split-tokens narrative ` +
        `(adj=${adj.score}, split=${split.score})`);
    }
  });

  it("search surfaces archived narratives", async () => {
    const db = createSearchTestDb();
    initMemorySchema(db);
    insertNarrative(db, "n-archived", { archived: true, summary: "Old conversation" });
    appendEvent(db, "n-archived", "narration", { content: "Quantum computing uses qubits for parallel computation" });

    await runIndex(db, false);

    const { embedText } = await import("../memory/embeddings.js");
    const queryVector = await embedText("quantum computing qubits");
    const results = searchHybrid(db, queryVector, "quantum computing qubits", 10);

    assert.ok(results.length > 0, "Should find results from archived narrative");
    assert.equal(results[0].narrative_id, "n-archived");
  });
});
