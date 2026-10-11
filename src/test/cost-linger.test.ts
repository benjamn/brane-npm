import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { costSampleTargets, lingerCostSampling } from "../daemon/server.js";

// The sampler's target set: connected narratives plus the recently
// disconnected, so a session's final turns — written after its MCP bridge
// tears down — still reach the ledger without a manual backfill.
describe("costSampleTargets", () => {
  it("samples a disconnected narrative until its linger expires", () => {
    const linger = new Map([["claude-gone", 1_090_000]]);
    // Within the window: sampled alongside the connected.
    assert.deepEqual(
      costSampleTargets(new Set(["claude-live"]), linger, 1_000_000),
      new Set(["claude-live", "claude-gone"]),
    );
    assert.ok(linger.has("claude-gone"), "not evicted while the window is open");
    // At the deadline: evicted, and no longer sampled.
    assert.deepEqual(costSampleTargets(new Set(["claude-live"]), linger, 1_090_000), new Set(["claude-live"]));
    assert.equal(linger.size, 0);
  });

  it("evicts a lingering narrative that reconnects, so a later disconnect starts a fresh window", () => {
    const linger = new Map([["claude-back", 1_090_000]]);
    const targets = costSampleTargets(new Set(["claude-back"]), linger, 1_000_000);
    assert.deepEqual(targets, new Set(["claude-back"]), "sampled once, as connected");
    assert.equal(linger.size, 0, "the stale deadline does not survive the reconnect");
  });

  it("lingerCostSampling feeds the sampler's own map, which linger defaults to", () => {
    lingerCostSampling("claude-observed", 5_000);
    assert.ok(costSampleTargets(new Set(), undefined, 10_000).has("claude-observed"));
    // 5_000 + the 90 s window has passed: expired and evicted, so this test
    // leaves no residue in the shared map.
    assert.ok(!costSampleTargets(new Set(), undefined, 200_000).has("claude-observed"));
  });
});
