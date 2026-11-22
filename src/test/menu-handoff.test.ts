import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_TTL_MS,
  handOffNarrativeMenu,
  takeNarrativeMenuHandoff,
} from "../shared/menu-handoff.js";

describe("the 🦠 menu handoff", () => {
  it("is taken by the narrative it was handed to, once", () => {
    handOffNarrativeMenu("claude-aaaa1111", 1000);
    assert.equal(takeNarrativeMenuHandoff("claude-aaaa1111", 1100), true);
    // A second screen for the same narrative (a Back, a revisit) opens closed.
    assert.equal(takeNarrativeMenuHandoff("claude-aaaa1111", 1200), false);
  });

  it("is not taken by another narrative, and waits for the right one", () => {
    handOffNarrativeMenu("claude-aaaa1111", 1000);
    assert.equal(takeNarrativeMenuHandoff("claude-bbbb2222", 1100), false);
    assert.equal(takeNarrativeMenuHandoff("claude-aaaa1111", 1200), true);
  });

  it("goes to the latest handoff only", () => {
    handOffNarrativeMenu("claude-aaaa1111", 1000);
    handOffNarrativeMenu("claude-bbbb2222", 1050);
    assert.equal(takeNarrativeMenuHandoff("claude-aaaa1111", 1100), false);
    assert.equal(takeNarrativeMenuHandoff("claude-bbbb2222", 1100), true);
  });

  it("expires, so a navigation that never happened opens nothing later", () => {
    handOffNarrativeMenu("claude-aaaa1111", 1000);
    assert.equal(takeNarrativeMenuHandoff("claude-aaaa1111", 1000 + HANDOFF_TTL_MS + 1), false);
    // ...and is spent by the late look, not left for the one after.
    assert.equal(takeNarrativeMenuHandoff("claude-aaaa1111", 1000 + HANDOFF_TTL_MS + 2), false);
  });
});
