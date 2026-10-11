import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { neighborColumns } from "../shared/wiki-window.js";

// The daemon's windowed read hands back neighbors nearest-first on both sides
// (pinned in wiki.test.ts). A column has to read top-to-bottom in document
// order, which for the side above the current section is the reverse.
describe("neighborColumns", () => {
  it("lists the neighbors above in document order, furthest first", () => {
    const { above } = neighborColumns(["step-3", "step-2", "step-1"], []);
    assert.deepEqual(above, ["step-1", "step-2", "step-3"]);
  });

  it("keeps the neighbors below in document order, nearest first", () => {
    const { below } = neighborColumns([], ["step-5", "step-6", "step-7"]);
    assert.deepEqual(below, ["step-5", "step-6", "step-7"]);
  });

  it("reads 1 → 2 → 3 → [current] → 5 → 6 around a mid-page section", () => {
    const { above, below } = neighborColumns(["3", "2", "1"], ["5", "6"]);
    assert.deepEqual([...above, "[4]", ...below], ["1", "2", "3", "[4]", "5", "6"]);
  });

  it("does not mutate the arrays it is given", () => {
    const prev = ["b", "a"];
    const next = ["d"];
    neighborColumns(prev, next);
    assert.deepEqual(prev, ["b", "a"]);
    assert.deepEqual(next, ["d"]);
  });

  it("is empty at a page edge", () => {
    assert.deepEqual(neighborColumns([], []), { above: [], below: [] });
  });
});
