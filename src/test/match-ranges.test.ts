import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { initMemorySchema } from "../memory/storage.js";
import {
  narrativeMatchRanges,
  parseHighlighted,
  prepareHighlightQuery,
  type MatchRange,
} from "../memory/match-ranges.js";

function dbWith(chunks: Array<{ nid: string; seq: number; content: string }>) {
  const db = createTestDb();
  initMemorySchema(db);
  const insert = db.prepare(
    "INSERT INTO memory_chunks (id, narrative_id, seq, content, time) VALUES (?, ?, ?, ?, 0)",
  );
  for (const c of chunks) insert.run(`${c.nid}-${c.seq}`, c.nid, c.seq, c.content);
  return db;
}

/** The marked substrings, which is what a reader sees highlighted. */
function marked(content: string, ranges: MatchRange[] | undefined): string[] {
  return (ranges ?? []).map(([s, e]) => content.slice(s, e));
}

describe("prepareHighlightQuery", () => {
  it("ORs phrases and content terms, dropping stopwords", () => {
    assert.equal(
      prepareHighlightQuery('restart the daemon "tailscale cert"'),
      '"tailscale cert" OR "restart"* OR "daemon"*',
    );
  });

  it("falls back to every term when none carries content", () => {
    assert.equal(prepareHighlightQuery("is it on"), '"is"* OR "it"* OR "on"*');
  });

  it("returns null for an empty query", () => {
    assert.equal(prepareHighlightQuery("  "), null);
  });
});

describe("parseHighlighted", () => {
  it("returns ranges in the unmarked text", () => {
    assert.deepEqual(parseHighlighted("a \u0001bc\u0002 d \u0001e\u0002"), [[2, 4], [7, 8]]);
  });

  it("refuses unpaired markers", () => {
    assert.equal(parseHighlighted("a \u0001b"), null);
    assert.equal(parseHighlighted("a \u0002b"), null);
    assert.equal(parseHighlighted("\u0001a\u0001b\u0002"), null);
  });
});

describe("narrativeMatchRanges", () => {
  it("marks what the porter tokenizer matched, stems and prefixes included", () => {
    const content = "We restarted the daemons, then the other daemon restarts cleanly.";
    const db = dbWith([{ nid: "n1", seq: 1, content }]);
    const ranges = narrativeMatchRanges(db, "the restart daemon", [{ narrative_id: "n1", seq: 1 }]);
    // "the" is a stopword (and not marked inside "other"); the stems are.
    assert.deepEqual(marked(content, ranges.get("n1:1")), [
      "restarted", "daemons", "daemon", "restarts",
    ]);
  });

  it("marks a quoted phrase as one span", () => {
    const content = "Run tailscale cert by hand, then tailscale status.";
    const db = dbWith([{ nid: "n1", seq: 2, content }]);
    const ranges = narrativeMatchRanges(db, '"tailscale cert"', [{ narrative_id: "n1", seq: 2 }]);
    assert.deepEqual(marked(content, ranges.get("n1:2")), ["tailscale cert"]);
  });

  it("keeps offsets right after astral and accented characters", () => {
    const content = "🔬 café — résumé of the search highlighting";
    const db = dbWith([{ nid: "n1", seq: 3, content }]);
    const ranges = narrativeMatchRanges(db, "highlight résumé", [{ narrative_id: "n1", seq: 3 }]);
    assert.deepEqual(marked(content, ranges.get("n1:3")), ["résumé", "highlighting"]);
  });

  it("leaves out rows with no literal match and rows not asked about", () => {
    const db = dbWith([
      { nid: "n1", seq: 1, content: "nothing relevant here" },
      { nid: "n2", seq: 1, content: "the daemon again" },
    ]);
    const ranges = narrativeMatchRanges(db, "daemon", [{ narrative_id: "n1", seq: 1 }]);
    assert.equal(ranges.size, 0);
  });

  it("gives no ranges for a row that itself holds a marker character", () => {
    const db = dbWith([{ nid: "n1", seq: 1, content: "odd \u0001 daemon text" }]);
    const ranges = narrativeMatchRanges(db, "daemon", [{ narrative_id: "n1", seq: 1 }]);
    assert.equal(ranges.size, 0);
  });
});
