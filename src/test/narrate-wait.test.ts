import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import {
  handleMcpNarrate,
  narrateWaitCursor,
  startMcpListen,
  type McpBridgeClient,
  type NarrateWaitPlan,
} from "../daemon/server.js";
import { appendEvent, readEvents } from "../db/events.js";

// `narrate({ wait: true })` is a narrate followed by a listen, in one call:
// one re-read of the agent's context per exchange instead of two. The daemon
// splits it the same way — `handleMcpNarrate` writes and returns a plan, and
// the dispatcher hands the plan to `startMcpListen` — so these drive the two
// halves exactly as the dispatcher does.

const SELF = "claude-aaaaaaaa";
const OTHER = "claude-bbbbbbbb";
const BRANE = "brane-home";

type Sent = { callId: string; result: any };

function fakeClient(): { client: McpBridgeClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const ws = {
    readyState: 1, // WebSocket.OPEN
    send: (raw: string) => {
      const msg = JSON.parse(raw);
      if (msg.type === "tool_result") sent.push({ callId: msg.id, result: msg.result });
    },
  };
  return {
    client: { ws: ws as any, narrativeId: SELF, agentType: "claude", pendingListens: new Map() },
    sent,
  };
}

function db(): Database.Database {
  const d = createTestDb();
  const ins = d.prepare("INSERT INTO narratives (id, brane_id, created_at, status) VALUES (?, ?, 0, 'active')");
  ins.run(SELF, BRANE);
  ins.run(OTHER, BRANE);
  return d;
}

/** What the dispatcher does with a `narrate` call. */
function narrateWait(
  d: Database.Database,
  c: McpBridgeClient,
  callId: string,
  args: Record<string, unknown>,
  waiters = new Map<string, Set<() => void>>(),
  settle: (nid: string, name: string) => void = () => {},
): Record<string, unknown> {
  const result = handleMcpNarrate({ ...args, wait: true }, d, SELF, () => {}) as Record<string, unknown>;
  if (result.park) {
    const { park, ...extra } = result as unknown as NarrateWaitPlan;
    startMcpListen(c, d, callId, { after: park.after }, waiters, settle, BRANE, {
      omit: park.omit,
      extra,
    });
  }
  return result;
}

describe("narrate({ wait: true })", () => {
  it("posts, then parks without handing back its own narration", () => {
    const d = db();
    const { client, sent } = fakeClient();
    appendEvent(d, SELF, "human_signal", { content: "question?", source: "web" });

    narrateWait(d, client, "1", { say: "answer", after: 1 });

    assert.equal(readEvents(d, SELF, { after: 0 }).length, 2, "the narration was written");
    assert.equal(sent.length, 0, "its own narration is not what it was waiting for");
    assert.equal(client.pendingListens.size, 1);
  });

  it("wakes on the next signal, with the narration's nid and seq on the result", () => {
    const d = db();
    const { client, sent } = fakeClient();
    const waiters = new Map<string, Set<() => void>>();
    const settled: string[] = [];

    narrateWait(d, client, "1", { say: "done — anything else?" }, waiters, (_nid, name) => settled.push(name));
    appendEvent(d, SELF, "human_signal", { content: "thanks", source: "web" });
    for (const wake of waiters.get(SELF) ?? []) wake();

    assert.equal(sent.length, 1);
    const r = sent[0].result;
    assert.equal(r.nid, SELF);
    assert.equal(r.seq, 1);
    assert.equal(r.timed_out, false);
    assert.deepEqual(r.events.self.map((e: any) => e.content), ["thanks"]);
    // The row is the narrate's, so it is the narrate's row that settles.
    assert.deepEqual(settled, ["mcp__brane__narrate"]);
  });

  it("returns at once when a signal landed between the cursor and the narration", () => {
    const d = db();
    const { client, sent } = fakeClient();
    appendEvent(d, SELF, "human_signal", { content: "first", source: "web" });
    appendEvent(d, SELF, "human_signal", { content: "actually, wait", source: "web" });

    // The agent had read seq 1 and answered it; seq 2 crossed with the answer.
    narrateWait(d, client, "1", { say: "on it", after: 1 });

    assert.equal(sent.length, 1, "a crossed signal is not something to sleep through");
    assert.equal(sent[0].result.waited_ms, 0);
    assert.deepEqual(sent[0].result.events.self.map((e: any) => e.content), ["actually, wait"]);
    assert.equal(sent[0].result.seq, 3);
  });

  it("carries rendering warnings through to the woken result", () => {
    const d = db();
    const { client, sent } = fakeClient();
    const waiters = new Map<string, Set<() => void>>();
    narrateWait(d, client, "1", { say: "The identity $\\bogusmacro{x}$ holds." }, waiters);
    appendEvent(d, SELF, "human_signal", { content: "ok", source: "web" });
    for (const wake of waiters.get(SELF) ?? []) wake();
    assert.equal(sent[0].result.warnings?.[0].kind, "math_parse_error");
  });

  it("watches every narrative in a multi-narrative cursor", () => {
    const d = db();
    const { client, sent } = fakeClient();
    const waiters = new Map<string, Set<() => void>>();

    narrateWait(d, client, "1", { say: "waiting on you both", after: { self: 0, [OTHER]: 0 } }, waiters);
    assert.equal(sent.length, 0, "our own narration does not end the wait");

    appendEvent(d, OTHER, "narration", { content: "worker done", source: OTHER });
    for (const wake of waiters.get(OTHER) ?? []) wake();

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].result.events[OTHER].map((e: any) => e.content), ["worker done"]);
    assert.deepEqual(sent[0].result.events.self, []);
  });

  it("narrates into another narrative and waits on both sides of the exchange", () => {
    const d = db();
    const { client, sent } = fakeClient();
    const waiters = new Map<string, Set<() => void>>();
    appendEvent(d, OTHER, "narration", { content: "earlier", source: OTHER });

    const plan = narrateWait(d, client, "1", { say: "can you take this?", nid: OTHER }, waiters) as unknown as NarrateWaitPlan;
    assert.equal(plan.nid, OTHER);
    assert.equal(plan.seq, 2);
    // No `after`: both narratives from their current heads, so neither the
    // history nor our own agent_signal comes back.
    assert.deepEqual(plan.park.after, { self: 0, [OTHER]: 2 });
    assert.equal(sent.length, 0);

    appendEvent(d, OTHER, "narration", { content: "on it", source: OTHER });
    for (const wake of waiters.get(OTHER) ?? []) wake();
    assert.deepEqual(sent[0].result.events[OTHER].map((e: any) => e.content), ["on it"]);
  });

  it("leaves a foreign narration out even when the cursor would include it", () => {
    const d = db();
    const { client, sent } = fakeClient();
    narrateWait(d, client, "1", { say: "ping", nid: OTHER, after: { self: 0, [OTHER]: 0 } });
    assert.equal(sent.length, 0, "our agent_signal in OTHER is not a reply");
    assert.equal(client.pendingListens.size, 1);
  });

  it("with `before` or `tail`, posts as a plain narrate and says it did not wait", () => {
    const d = db();
    for (const extra of [{ tail: 5 }, { before: 3, after: 0 }]) {
      const r = handleMcpNarrate({ say: "hi", wait: true, ...extra }, d, SELF, () => {}) as Record<string, unknown>;
      assert.ok(!("park" in r));
      assert.ok("events" in r, "a receipt, as without wait");
      assert.match(String(r.wait_ignored), /call `listen` next/);
    }
    assert.equal(readEvents(d, SELF, { after: 0 }).length, 2, "both narrations were posted");
  });

  it("accepts any cursor listen accepts, and fills omitted heads", () => {
    assert.deepEqual(narrateWaitCursor({ after: 4 }, SELF), { after: { self: 4 } });
    assert.deepEqual(narrateWaitCursor({ after: { [SELF]: 4, [OTHER]: 1 } }, SELF), { after: { [SELF]: 4, [OTHER]: 1 } });
    assert.deepEqual(narrateWaitCursor({}, SELF), { after: { self: undefined } });
    assert.deepEqual(narrateWaitCursor({ nid: SELF }, SELF), { after: { self: undefined } });
    assert.deepEqual(narrateWaitCursor({ nid: OTHER }, SELF), { after: { self: undefined, [OTHER]: undefined } });
  });

  it("without wait, narrate still answers with a receipt and parks nothing", () => {
    const d = db();
    const r = handleMcpNarrate({ say: "hello", after: 0 }, d, SELF, () => {}) as Record<string, unknown>;
    assert.ok(!("park" in r));
    assert.ok("events" in r);
    assert.ok(!("wait_ignored" in r), "a receipt reads exactly as it always has");
  });
});
