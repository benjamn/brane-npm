import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import { AwaitingTracker } from "../daemon/awaiting.js";
import { cancelMcpCall, handleMcpNarrate, startMcpListen, type McpBridgeClient, type NarrateWaitPlan } from "../daemon/server.js";
import { appendEvent } from "../db/events.js";

// AGOG: a narrative parked in a blocking listen, or a waiting narrate, is
// waiting for direction. The tracker turns parks and resolutions into one
// boolean per narrative and reports only its edges.

const SELF = "claude-aaaaaaaa";
const BRANE = "brane-home";

function tracker() {
  const edges: Array<[string, boolean]> = [];
  const tr = new AwaitingTracker((nid, a) => edges.push([nid, a]));
  return { tr, edges };
}

describe("AwaitingTracker", () => {
  it("is awaiting while parked, and a delivery ends it at once", () => {
    const { tr, edges } = tracker();
    tr.parked(SELF);
    assert.equal(tr.isAwaiting(SELF), true);
    tr.resolved(SELF, "delivered");
    assert.equal(tr.isAwaiting(SELF), false);
    assert.deepEqual(edges, [[SELF, true], [SELF, false]]);
  });

  it("ends at once on a timeout too, and the re-park glows again", () => {
    // The flicker is the agent's turn between the two calls, shown as it is.
    const { tr, edges } = tracker();
    tr.parked(SELF);
    tr.resolved(SELF, "timeout");
    assert.equal(tr.isAwaiting(SELF), false);
    tr.parked(SELF);
    assert.deepEqual(edges, [[SELF, true], [SELF, false], [SELF, true]]);
  });

  it("ends at once on a cancel: the harness stopped waiting", () => {
    const { tr, edges } = tracker();
    tr.parked(SELF);
    tr.resolved(SELF, "cancelled");
    assert.equal(tr.isAwaiting(SELF), false);
    assert.deepEqual(edges, [[SELF, true], [SELF, false]]);
  });

  it("stays awaiting while any bridge of the narrative is still parked", () => {
    const { tr, edges } = tracker();
    tr.parked(SELF);
    tr.parked(SELF);
    tr.resolved(SELF, "closed");
    assert.equal(tr.isAwaiting(SELF), true);
    tr.resolved(SELF, "closed");
    assert.equal(tr.isAwaiting(SELF), false);
    assert.deepEqual(edges, [[SELF, true], [SELF, false]]);
  });

  it("ignores a resolution it never saw park", () => {
    const { tr, edges } = tracker();
    tr.resolved(SELF, "delivered");
    assert.deepEqual(edges, []);
  });
});

// The wiring: startMcpListen is what parks, so drive it as the dispatcher does.

function db(): Database.Database {
  const d = createTestDb();
  d.prepare("INSERT INTO narratives (id, brane_id, created_at, status) VALUES (?, ?, 0, 'active')").run(SELF, BRANE);
  return d;
}

function client(tr: AwaitingTracker): McpBridgeClient {
  const ws = { readyState: 1, send: () => {} };
  return { ws: ws as any, narrativeId: SELF, agentType: "claude", pendingListens: new Map(), awaiting: tr };
}

describe("AGOG wiring", () => {
  it("a blocking listen parks as awaiting; the signal that wakes it ends it", () => {
    const d = db();
    const { tr, edges } = tracker();
    const c = client(tr);
    const waiters = new Map<string, Set<() => void>>();

    startMcpListen(c, d, "1", { after: 0 }, waiters, () => {}, BRANE);
    assert.deepEqual(edges, [[SELF, true]]);

    appendEvent(d, SELF, "human_signal", { content: "go", source: "web" });
    for (const wake of waiters.get(SELF) ?? []) wake();
    assert.deepEqual(edges, [[SELF, true], [SELF, false]]);
  });

  it("a waiting narrate parks as awaiting too", () => {
    const d = db();
    const { tr, edges } = tracker();
    const c = client(tr);
    const result = handleMcpNarrate({ say: "done", wait: true }, d, SELF, () => {}) as Record<string, unknown>;
    const { park, ...extra } = result as unknown as NarrateWaitPlan;
    startMcpListen(c, d, "1", { after: park.after }, new Map(), () => {}, BRANE, { omit: park.omit, extra });
    assert.deepEqual(edges, [[SELF, true]]);
  });

  it("neither a non-blocking read nor a listen answered at once counts as parking", () => {
    const d = db();
    const { tr, edges } = tracker();
    const c = client(tr);
    startMcpListen(c, d, "1", { after: 0, wait: false }, new Map(), () => {}, BRANE);
    appendEvent(d, SELF, "human_signal", { content: "hi", source: "web" });
    startMcpListen(c, d, "2", { after: 0 }, new Map(), () => {}, BRANE);
    assert.deepEqual(edges, []);
    assert.equal(tr.isAwaiting(SELF), false);
  });

  it("a cancelled listen ends it now, is settled, and never answers", () => {
    const d = db();
    const { tr, edges } = tracker();
    const sent: unknown[] = [];
    const c = client(tr);
    (c.ws as any).send = (m: unknown) => sent.push(m);
    const waiters = new Map<string, Set<() => void>>();
    const settled: string[] = [];

    startMcpListen(c, d, "1", { after: 0 }, waiters, () => {}, BRANE);
    assert.equal(cancelMcpCall(c, "1", (_nid, name) => settled.push(name)), true);
    assert.deepEqual(edges, [[SELF, true], [SELF, false]]);
    assert.deepEqual(settled, ["mcp__brane__listen"]);
    assert.equal(c.pendingListens.size, 0);
    assert.equal(waiters.get(SELF)?.size ?? 0, 0, "its wakeup is unregistered");

    // The next signal finds nobody to answer.
    appendEvent(d, SELF, "human_signal", { content: "go", source: "web" });
    for (const wake of waiters.get(SELF) ?? []) wake();
    assert.deepEqual(sent, []);
    assert.equal(cancelMcpCall(c, "1", () => {}), false, "a second cancel is a no-op");
  });
});

describe("AwaitingTracker.narratives: the undead, for GET /api/status", () => {
  it("lists the narratives parked right now, oldest park first, and none once they resolve", () => {
    const { tr } = tracker();
    assert.deepEqual(tr.narratives(), []);
    tr.parked("claude-bbbbbbbb");
    tr.parked(SELF);
    tr.parked(SELF); // a second bridge of the same narrative
    assert.deepEqual(tr.narratives(), ["claude-bbbbbbbb", SELF]);
    tr.resolved(SELF, "delivered");
    assert.deepEqual(tr.narratives(), ["claude-bbbbbbbb", SELF], "still parked on its other bridge");
    tr.resolved(SELF, "closed");
    tr.resolved("claude-bbbbbbbb", "timeout");
    assert.deepEqual(tr.narratives(), []);
  });
});
