import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { archiveRefusal } from "../daemon/archive-gate.js";

const ended = { status: "ended", mcpConnected: false, tmuxLive: false };

describe("archiveRefusal", () => {
  it("allows an ended narrative with nothing running", () => {
    assert.equal(archiveRefusal(ended), null);
  });

  it("refuses a narrative whose status is not ended", () => {
    assert.ok(archiveRefusal({ ...ended, status: "active" }));
    assert.ok(archiveRefusal({ ...ended, status: null }));
  });

  it("refuses an ended row with an agent still on the bridge", () => {
    // The stale row the menu also treats as running: hiding it would hide a
    // live agent.
    assert.match(archiveRefusal({ ...ended, mcpConnected: true }) ?? "", /connected/);
  });

  it("refuses an ended row whose tmux session is still up", () => {
    assert.match(archiveRefusal({ ...ended, tmuxLive: true }) ?? "", /running/);
  });
});
