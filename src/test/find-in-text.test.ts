import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findMatches,
  firstAtOrAfter,
  isCaseSensitive,
  locateSpan,
  parseLineJump,
  stepMatch,
  type NodeSlot,
} from "../shared/find-in-text.js";

describe("find-in-text", () => {
  it("is smart-case", () => {
    assert.equal(isCaseSensitive("usememo"), false);
    assert.equal(isCaseSensitive("useMemo"), true);
    assert.deepEqual(findMatches("useMemo usememo USEMEMO", "usememo").matches.length, 3);
    assert.deepEqual(findMatches("useMemo usememo USEMEMO", "useMemo").matches, [{ start: 0, end: 7 }]);
  });

  it("finds non-overlapping literal hits, untrimmed", () => {
    assert.deepEqual(findMatches("aaaa", "aa").matches, [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    // Regex metacharacters are just characters.
    assert.deepEqual(findMatches("a.b a*b", ".").matches, [{ start: 1, end: 2 }]);
    // A trailing space asks for the word, not the prefix.
    assert.deepEqual(findMatches("use user use", "use ").matches, [{ start: 0, end: 4 }]);
    assert.deepEqual(findMatches("abc", "").matches, []);
  });

  it("caps the hit count and says so", () => {
    const r = findMatches("x".repeat(10), "x", 4);
    assert.equal(r.matches.length, 4);
    assert.equal(r.capped, true);
    assert.equal(findMatches("xxxx", "x", 4).capped, false);
  });

  it("falls back to exact case when lowercasing would shift offsets", () => {
    // "İ".toLowerCase() is two code units; a case-folded search would put
    // every later hit one character to the left of where it is.
    const text = "İ foo";
    assert.notEqual(text.toLowerCase().length, text.length);
    assert.deepEqual(findMatches(text, "foo").matches, [{ start: 2, end: 5 }]);
  });

  it("parses :N as a line jump and nothing else", () => {
    assert.equal(parseLineJump(":120"), 120);
    assert.equal(parseLineJump(" :7 "), 7);
    for (const q of [":", ":0", ": 12", "12", ":12a", "a:12"]) assert.equal(parseLineJump(q), null, q);
  });

  it("keeps the current hit moving forward while the query grows", () => {
    const m = [{ start: 3, end: 5 }, { start: 10, end: 12 }, { start: 20, end: 22 }];
    assert.equal(firstAtOrAfter(m, 0), 0);
    assert.equal(firstAtOrAfter(m, 10), 1);
    assert.equal(firstAtOrAfter(m, 11), 2);
    assert.equal(firstAtOrAfter(m, 21), 0, "wraps past the last hit");
    assert.equal(firstAtOrAfter([], 5), -1);
  });

  it("steps with wraparound", () => {
    assert.equal(stepMatch(0, 3, 1), 1);
    assert.equal(stepMatch(2, 3, 1), 0);
    assert.equal(stepMatch(0, 3, -1), 2);
    assert.equal(stepMatch(-1, 3, 1), 0);
    assert.equal(stepMatch(-1, 3, -1), 2);
    assert.equal(stepMatch(0, 0, 1), -1);
  });

  describe("locateSpan", () => {
    // "use" "Memo" | sep | "(x)" — a Shiki-style token split, then a line break.
    const slots: NodeSlot[] = [
      { start: 0, length: 3 },
      { start: 3, length: 4 },
      { start: 8, length: 3 },
    ];

    it("maps a hit that crosses token spans", () => {
      assert.deepEqual(locateSpan(slots, { start: 0, end: 7 }), {
        start: { node: 0, offset: 0 },
        end: { node: 1, offset: 4 },
      });
    });

    it("starts a hit on a boundary in the later node and ends it in the earlier", () => {
      assert.deepEqual(locateSpan(slots, { start: 3, end: 7 }), {
        start: { node: 1, offset: 0 },
        end: { node: 1, offset: 4 },
      });
      assert.deepEqual(locateSpan(slots, { start: 1, end: 3 }), {
        start: { node: 0, offset: 1 },
        end: { node: 0, offset: 3 },
      });
    });

    it("refuses an end that lands in a separator", () => {
      assert.equal(locateSpan(slots, { start: 7, end: 8 }), null);
      assert.deepEqual(locateSpan(slots, { start: 8, end: 11 }), {
        start: { node: 2, offset: 0 },
        end: { node: 2, offset: 3 },
      });
    });
  });
});
