import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import {
  handleMcpNarrate,
  startMcpListen,
  type McpBridgeClient,
  type NarrateWaitPlan,
  wakeListenWaiters,
} from "../daemon/server.js";
import { appendEvent } from "../db/events.js";
import { recordMentions, pendingMentions } from "../db/mentions.js";

// A read returns what is in range, the caller's own narrations included, but
// the caller's own narrations never interrupt its waiting. #515 got the second
// by filtering them out of every forward read, which also lost them for an
// agent resuming after compaction with a remembered cursor; nothing
// server-side can tell that read from any other. Now they come back, and only
// someone else's event is an arrival. The one thing never returned is the event
// a narrate just wrote, to that narrate (#508's receipt, #509's `omit`).

const SELF = "claude-aaaaaaaa";
const OTHER = "claude-bbbbbbbb";
const BRANE = "brane-home";

type Sent = { callId: string; result: any };

function fakeClient(): { client: McpBridgeClient; sent: Sent[]; ws: { readyState: number } } {
  const sent: Sent[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => {
      const msg = JSON.parse(raw);
      if (msg.type === "tool_result") sent.push({ callId: msg.id, result: msg.result });
    },
  };
  return {
    client: { ws: ws as any, narrativeId: SELF, agentType: "claude", pendingListens: new Map() },
    sent,
    ws,
  };
}

function db(): Database.Database {
  const d = createTestDb();
  const ins = d.prepare("INSERT INTO narratives (id, brane_id, created_at, status) VALUES (?, ?, 0, 'active')");
  ins.run(SELF, BRANE);
  ins.run(OTHER, BRANE);
  return d;
}

const say = (d: Database.Database, text: string, extra: Record<string, unknown> = {}) =>
  handleMcpNarrate({ say: text, ...extra }, d, SELF, () => {}) as Record<string, any>;
const signal = (d: Database.Database, text: string) =>
  appendEvent(d, SELF, "human_signal", { content: text, source: "web" });
const listen = (
  c: McpBridgeClient, d: Database.Database, id: string, args: Record<string, unknown>,
  waiters = new Map<string, Set<() => void>>(),
) => startMcpListen(c, d, id, args, waiters, () => {}, BRANE);
const wakeAll = (waiters: Map<string, Set<() => void>>, nid: string) => {
  for (const w of [...(waiters.get(nid) ?? [])]) w();
};

describe("a read returns the agent's own words", () => {
  it("a non-blocking read hands back an earlier narration", () => {
    const d = db();
    const { client, sent } = fakeClient();
    signal(d, "a");                                  // 1
    say(d, "b");                                     // 2
    signal(d, "c");                                  // 3
    listen(client, d, "1", { after: 1, wait: false });
    assert.deepEqual(sent[0].result.events.self.map((e: any) => e.content), ["b", "c"]);
  });

  it("even when they are all that is in range", () => {
    const d = db();
    const { client, sent } = fakeClient();
    signal(d, "a");                                  // 1
    say(d, "b");                                     // 2
    listen(client, d, "1", { after: 1, wait: false });
    assert.deepEqual(sent[0].result.events.self.map((e: any) => e.content), ["b"]);
  });

  it("the narrate receipt leaves out only the narration it wrote", () => {
    const d = db();
    signal(d, "a");                                  // 1
    say(d, "b");                                     // 2
    signal(d, "c");                                  // 3
    const r = say(d, "e", { after: 1 });             // 4
    assert.equal(r.seq, 4);
    assert.deepEqual(r.events.self.map((e: any) => e.content), ["b", "c"]);
  });
});

describe("the agent's own words never interrupt its waiting", () => {
  it("a parked listen does not wake on its own narration, and brings it back with the next signal", () => {
    const d = db();
    const { client, sent } = fakeClient();
    const waiters = new Map<string, Set<() => void>>();
    const notify = (nid: string) => wakeListenWaiters(waiters, nid);
    signal(d, "go");                                 // 1
    listen(client, d, "1", { after: 1 }, waiters);
    handleMcpNarrate({ say: "working on it" }, d, SELF, notify);   // 2, fires the wakeup
    assert.equal(sent.length, 0, "its own words are not an arrival");

    signal(d, "status?");                            // 3
    notify(SELF);                                    // still registered: no 500 ms poller wait
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].result.events.self.map((e: any) => e.seq), [2, 3]);
  });

  it("a blocking listen whose cursor trails its own narration parks instead of returning at once", () => {
    const d = db();
    const { client, sent } = fakeClient();
    signal(d, "question?");                          // 1
    say(d, "progress…", { after: 1 });               // 2
    listen(client, d, "1", { after: 1 });
    assert.equal(sent.length, 0);
  });

  it("nor does a waiting narrate: the lagging cursor #508 leaves behind", () => {
    const d = db();
    const { client, sent } = fakeClient();
    signal(d, "question?");                          // 1
    say(d, "progress…", { after: 1 });               // 2
    const plan = handleMcpNarrate({ say: "done", after: 1, wait: true }, d, SELF, () => {}) as unknown as NarrateWaitPlan & Record<string, unknown>;
    const { park, ...extra } = plan;
    startMcpListen(client, d, "w", { after: park.after }, new Map(), () => {}, BRANE, { omit: park.omit, extra });
    assert.equal(sent.length, 0, "parked, rather than returning seq 2 at waited_ms 0");
  });

  it("covers foreign narration: what the agent said in another narrative wakes nothing either", () => {
    const d = db();
    const { client, sent } = fakeClient();
    const waiters = new Map<string, Set<() => void>>();
    listen(client, d, "1", { after: { self: 0, [OTHER]: 0 } }, waiters);
    say(d, "a question for you", { nid: OTHER });    // OTHER 1
    wakeAll(waiters, OTHER);
    assert.equal(sent.length, 0);
    appendEvent(d, OTHER, "narration", { content: "the answer", source: OTHER });
    wakeAll(waiters, OTHER);
    assert.deepEqual(sent[0].result.events[OTHER].map((e: any) => e.content), ["a question for you", "the answer"]);
  });
});

describe("a listen whose socket has closed", () => {
  it("does not run its receipt, so a mention is never marked delivered to nobody", () => {
    const d = db();
    const { client, sent, ws } = fakeClient();
    const waiters = new Map<string, Set<() => void>>();
    signal(d, "go");                                  // SELF 1
    listen(client, d, "1", { after: { self: 1, [OTHER]: 0 } }, waiters);
    ws.readyState = 3;                                // CLOSED, close handler not yet run

    const ev = appendEvent(d, OTHER, "narration", { content: `@${SELF} look`, source: OTHER });
    recordMentions(d, { srcNarrative: OTHER, srcSeq: ev.seq, author: OTHER, mentionedNids: [SELF], time: ev.time });
    wakeAll(waiters, OTHER);

    assert.equal(sent.length, 0);
    assert.equal(pendingMentions(d, SELF, 10).total, 1, "still owed: nobody received it");
  });

  it("can be retired: cleanup unregisters its wakeups", () => {
    const d = db();
    const { client } = fakeClient();
    const waiters = new Map<string, Set<() => void>>();
    listen(client, d, "1", { after: { self: 0, [OTHER]: 0 } }, waiters);
    assert.equal(waiters.get(SELF)?.size, 1);
    for (const p of client.pendingListens.values()) p.cleanup();
    assert.equal(waiters.get(SELF)?.size, 0);
    assert.equal(waiters.get(OTHER)?.size, 0);
  });
});
