import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QuipLoop, shuffled } from "../shared/membrane-quips.js";

// The caption's order: one shuffle per page load, then a fixed loop through
// it — every line once before any line twice, the same order each time round.

const list: readonly string[] = ["a", "b", "c", "d", "e"];

/** A seeded generator, so a "random" shuffle is the same on every run. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

describe("shuffled", () => {
  it("is a permutation, and leaves its input alone", () => {
    const before = [...list];
    const out = shuffled(list, seeded(7));
    assert.deepEqual([...out].sort(), before);
    assert.deepEqual(list, before);
  });

  it("can produce every order", () => {
    const seen = new Set<string>();
    for (let s = 1; s < 2000; s++) seen.add(shuffled(list.slice(0, 3), seeded(s)).join(""));
    assert.equal(seen.size, 6);
  });

  it("clamps a rand that returns 1", () => {
    assert.equal(shuffled(list, () => 1).length, list.length);
  });
});

describe("QuipLoop", () => {
  it("shows every line once per cycle, and the same cycle each time round", () => {
    const loop = new QuipLoop(list, seeded(3));
    const first = [loop.current()];
    for (let i = 1; i < list.length; i++) first.push(loop.next());
    assert.equal(new Set(first).size, list.length);
    const second = [loop.next()];
    for (let i = 1; i < list.length; i++) second.push(loop.next());
    assert.deepEqual(second, first);
  });

  it("never shows the same line twice in a row", () => {
    const loop = new QuipLoop(list, seeded(11));
    let prev = loop.current();
    for (let i = 0; i < list.length * 3; i++) {
      const q = loop.next();
      assert.notEqual(q, prev);
      prev = q;
    }
  });

  it("does not move until told to", () => {
    const loop = new QuipLoop(list, seeded(5));
    assert.equal(loop.current(), loop.current());
  });

  it("holds a single line", () => {
    const one: readonly string[] = ["solo"];
    const loop = new QuipLoop(one);
    assert.equal(loop.next(), one[0]);
  });
});
