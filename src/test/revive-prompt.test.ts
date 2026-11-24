import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bridgeConnected, deliverRevivePrompt, promptDelayMs, whenBridgeConnects } from "../daemon/revive-prompt.js";

const fast = { minMs: 20, settleMs: 10, gapMs: 5 };

describe("revive prompt delivery", () => {
  it("waits for the agent's bridge, then types the prompt and Enter as separate keys", async () => {
    const sent: string[][] = [];
    const delivered = deliverRevivePrompt("claude-aaaaaaaa", "hello -there", (a) => void sent.push(a), { ...fast, maxWaitMs: 5_000 });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(sent, [], "nothing typed before the bridge connects, even past the floor");
    bridgeConnected("claude-aaaaaaaa");
    assert.equal(await delivered, true);
    assert.deepEqual(sent, [
      ["-t", "claude-aaaaaaaa", "-l", "hello -there"],
      ["-t", "claude-aaaaaaaa", "Enter"],
    ]);
  });

  it("types anyway when no bridge connects by the ceiling", async () => {
    const sent: string[][] = [];
    assert.equal(await deliverRevivePrompt("claude-bbbbbbbb", "p", (a) => void sent.push(a), { ...fast, maxWaitMs: 15 }), false);
    assert.equal(sent.length, 2);
  });

  it("a session gone by then ends the delivery quietly", async () => {
    const p = deliverRevivePrompt("claude-cccccccc", "p", () => { throw new Error("no session"); }, { ...fast, maxWaitMs: 5 });
    assert.equal(await p, false);
  });

  it("another narrative's bridge does not count", async () => {
    const w = whenBridgeConnects("claude-dddddddd", 20);
    bridgeConnected("claude-eeeeeeee");
    assert.equal(await w, false);
  });

  it("keeps the old 2 s floor, and settles after a connect", () => {
    assert.equal(promptDelayMs(500, false), 1_500);
    assert.equal(promptDelayMs(500, true), 1_500);
    assert.equal(promptDelayMs(5_000, false), 0);
    assert.equal(promptDelayMs(5_000, true), 1_500);
  });
});
