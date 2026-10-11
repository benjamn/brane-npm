import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import { handleMcpNarrate, toolFlag } from "../daemon/server.js";

// A narrate that is going to refuse must refuse before it writes anything.
// The failure this pins is the one an agent can't recover from gracefully: an
// error returned for words that were in fact posted, which it will reasonably
// post again.

const SELF = "claude-aaaaaaaa";
const OTHER = "claude-bbbbbbbb";

function db(): Database.Database {
  const d = createTestDb();
  const ins = d.prepare("INSERT INTO narratives (id, brane_id, created_at, status) VALUES (?, 'brane-home', 0, 'active')");
  ins.run(SELF);
  ins.run(OTHER);
  return d;
}

const count = (d: Database.Database) =>
  (d.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
const summary = (d: Database.Database) =>
  (d.prepare("SELECT summary FROM narratives WHERE id = ?").get(SELF) as { summary: string | null }).summary;

describe("narrate refuses before the first write", () => {
  for (const [name, bad] of [
    ["tail", { tail: "abc" }],
    ["before", { before: { self: "nope" } }],
    ["after", { after: [1, 2] as unknown }],
  ] as const) {
    for (const wait of [false, true]) {
      it(`a malformed \`${name}\`${wait ? " with wait" : ""} throws and posts nothing`, () => {
        const d = db();
        assert.throws(
          () => handleMcpNarrate({ say: "hello", meta: { summary: "changed" }, wait, ...bad }, d, SELF, () => {}),
          /Invalid|cursor/,
        );
        assert.equal(count(d), 0, "no narration was appended");
        assert.equal(summary(d), null, "no summary was written");
      });
    }
  }

  it("an unknown foreign target refuses before the summary is touched", () => {
    const d = db();
    const r = handleMcpNarrate(
      { say: "hi", nid: "claude-zzzzzzzz", meta: { summary: "changed" } },
      d, SELF, () => {},
    ) as { error?: string };
    assert.match(r.error ?? "", /Unknown narrative/);
    assert.equal(count(d), 0);
    assert.equal(summary(d), null);
  });

  it("a well-formed call still posts", () => {
    const d = db();
    const r = handleMcpNarrate({ say: "hello", tail: "3" }, d, SELF, () => {}) as { seq: number };
    assert.equal(r.seq, 1);
    assert.equal(count(d), 1);
  });
});

describe("toolFlag", () => {
  it("reads booleans and their string spellings", () => {
    assert.equal(toolFlag(true, false), true);
    assert.equal(toolFlag("true", false), true);
    assert.equal(toolFlag(false, true), false);
    assert.equal(toolFlag("false", true), false, "a string \"false\" must not read as truthy");
  });

  it("falls back on anything else", () => {
    for (const raw of [undefined, null, 1, 0, "yes", "", {}]) {
      assert.equal(toolFlag(raw, true), true);
      assert.equal(toolFlag(raw, false), false);
    }
  });

  it("`strict: \"true\"` refuses what `strict: true` refuses", () => {
    // A narration that won't render as written, so `strict` has something to refuse.
    for (const strict of [true, "true"]) {
      const d = db();
      const r = handleMcpNarrate({ say: "$\\bogusmacro{x}$", strict }, d, SELF, () => {}) as { error?: string };
      assert.ok(r.error, `strict: ${JSON.stringify(strict)} refuses`);
      assert.equal(count(d), 0, "and posts nothing");
    }
  });

  it("`wait: \"true\"` parks a narrate instead of quietly not waiting", () => {
    const d = db();
    const r = handleMcpNarrate({ say: "hello", after: 0, wait: "true" }, d, SELF, () => {}) as Record<string, unknown>;
    assert.ok(r.park, "the plan comes back, as it does for `wait: true`");
  });
});
