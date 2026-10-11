import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import {
  announceEvent,
  createMentionRecorder,
  startMcpListen,
  type McpBridgeClient,
  wakeListenWaiters,
} from "../daemon/server.js";
import { appendEvent } from "../db/events.js";
import { recordMentions } from "../db/mentions.js";

// The regression guard for the failure that would make this feature worse than
// not having it.
//
// A mention has to resolve a parked `listen` — otherwise the daemon's wake
// finds no *events*, parks again, and the mention waits out the full hold (up
// to 3400s for claude). But the moment mentions can resolve a listen, they can
// also resolve *every* listen: if the resolve doesn't settle durable state in
// the same synchronous block as the send, the agent's next listen returns
// instantly, forever, at inference speed, with no operator in the loop.
//
// So: exactly once. That is what these pin.

const SELF = "claude-aaaaaaaa";
const OTHER = "claude-bbbbbbbb";
const BRANE = "brane-home";

type Sent = { callId: string; result: any };

/** A bridge client whose socket records what it was sent. */
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
    client: {
      ws: ws as any,
      narrativeId: SELF,
      agentType: "claude",
      pendingListens: new Map(),
    },
    sent,
  };
}

function db(): Database.Database {
  const d = createTestDb();
  const ins = d.prepare(
    "INSERT INTO narratives (id, brane_id, created_at, status) VALUES (?, ?, 0, 'active')",
  );
  ins.run(SELF, BRANE);
  ins.run(OTHER, BRANE);
  return d;
}

/** OTHER mentions SELF, exactly as the daemon's recorder would. */
function mentionSelf(d: Database.Database, content = `ping @${SELF}`): number {
  const event = appendEvent(d, OTHER, "narration", { content, source: OTHER });
  recordMentions(d, {
    mentionedNids: [SELF],
    srcNarrative: OTHER,
    srcSeq: event.seq,
    author: OTHER,
    time: event.time,
  });
  return event.seq;
}

function listen(
  d: Database.Database,
  c: McpBridgeClient,
  callId: string,
  args: Record<string, unknown> = {},
): void {
  startMcpListen(c, d, callId, { after: { self: 0 }, ...args }, new Map(), () => {}, BRANE);
}

describe("a mention resolves a listen exactly once", () => {
  it("resolves the first listen and blocks the next", () => {
    const d = db();
    const { client, sent } = fakeClient();
    mentionSelf(d);

    listen(d, client, "1");
    assert.equal(sent.length, 1, "a pending mention must resolve a parked listen");
    assert.equal(sent[0].result.mentions.length, 1);
    assert.equal(sent[0].result.mentions[0].src, OTHER);

    listen(d, client, "2");
    assert.equal(sent.length, 1, "SPIN LOOP: the same mention resolved a second listen");
    assert.equal(client.pendingListens.size, 1, "the second listen should be parked");
  });

  it("keeps blocking across many listens while the mention stays unread", () => {
    const d = db();
    const { client, sent } = fakeClient();
    mentionSelf(d);
    listen(d, client, "1");
    for (let i = 2; i <= 10; i++) listen(d, client, `${i}`);
    assert.equal(sent.length, 1);
  });

  it("resolves again for a *new* mention, even with the first still unread", () => {
    const d = db();
    const { client, sent } = fakeClient();
    mentionSelf(d);
    listen(d, client, "1");
    assert.equal(sent.length, 1);

    mentionSelf(d, `again @${SELF}`);
    listen(d, client, "2");
    assert.equal(sent.length, 2, "a fresh mention must wake the agent");
    assert.equal(sent[1].result.mentions.length, 2, "the unread one is still owed");
  });

  it("settles in the same call that sends, so a crash after cannot double-deliver", () => {
    // `markSent` runs inside `mentionReceipt`, which is spread into the very
    // object handed to `sendToolResult`. Nothing between them can throw and
    // leave the mention both sent and pending.
    const d = db();
    const { client, sent } = fakeClient();
    mentionSelf(d);
    listen(d, client, "1");
    const unsent = d
      .prepare("SELECT COUNT(*) c FROM mentions WHERE mentioned_nid = ? AND sent_at IS NULL")
      .get(SELF) as { c: number };
    assert.equal(unsent.c, 0);
    assert.equal(sent.length, 1);
  });
});

describe("the receipt", () => {
  it("is absent entirely when nothing is in play", () => {
    const d = db();
    const { client, sent } = fakeClient();
    appendEvent(d, SELF, "human_signal", { content: "hello", source: "web" });

    listen(d, client, "1");
    assert.equal(sent.length, 1);
    assert.equal("mentions" in sent[0].result, false, "an ordinary listen must be unchanged");
    assert.equal("mentions_pending" in sent[0].result, false);
  });

  it("does not resolve a listen on its own when only ordinary events arrive", () => {
    const d = db();
    const { client, sent } = fakeClient();
    listen(d, client, "1");
    assert.equal(sent.length, 0, "nothing to return: must park");
    assert.equal(client.pendingListens.size, 1);
  });

  it("carries pointers, never the prose", () => {
    const d = db();
    const { client, sent } = fakeClient();
    const seq = mentionSelf(d, `a long and private message @${SELF} with secrets`);

    listen(d, client, "1");
    const row = sent[0].result.mentions[0];
    assert.deepEqual(Object.keys(row).sort(), ["author", "id", "seq", "src", "time"]);
    assert.equal(row.seq, seq);
    assert.equal(JSON.stringify(row).includes("secrets"), false);
  });
});

describe("reading the source settles it", () => {
  it("annotates the delivered event and stops owing the mention", () => {
    const d = db();
    const { client, sent } = fakeClient();
    const seq = mentionSelf(d);

    // The agent goes and reads OTHER, which is what interpreting a mention
    // means — and the cursor it already passes is the evidence.
    listen(d, client, "1", { after: { self: 0, [OTHER]: 0 } });

    const events = sent[0].result.events[OTHER];
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].mentions, [SELF], "the event says what it addresses");

    // Settled by the read: a later listen owes nothing.
    listen(d, client, "2", { after: { self: 0 } });
    assert.equal(sent.length, 1, "nothing left to wake for");
  });

  it("does not settle a mention the read never showed", () => {
    const d = db();
    const { client, sent } = fakeClient();
    const first = mentionSelf(d);
    mentionSelf(d, `later @${SELF}`);

    // `before` truncates: this read returns the first event only.
    listen(d, client, "1", { after: { self: 0, [OTHER]: 0 }, before: { [OTHER]: first + 1 } });
    assert.equal(sent[0].result.events[OTHER].length, 1);

    // The receipt acks before it reports, so the mention delivered in this
    // very batch is already settled and only the untouched one is listed.
    assert.equal(sent[0].result.mentions.length, 1);
    assert.notEqual(sent[0].result.mentions[0].seq, first);

    const owed = d
      .prepare("SELECT COUNT(*) c FROM mentions WHERE mentioned_nid = ? AND seen_at IS NULL")
      .get(SELF) as { c: number };
    assert.equal(owed.c, 1, "the event that was never returned is still owed");
  });
});

describe("the escape hatches", () => {
  it('"dismiss" settles an irrelevant mention so it stops reappearing', () => {
    const d = db();
    const { client, sent } = fakeClient();
    mentionSelf(d);

    listen(d, client, "1", { mentions: "dismiss" });
    assert.equal(sent.length, 1);

    listen(d, client, "2");
    assert.equal(sent.length, 1, "dismissed: must not wake or be re-reported");
  });

  it('"all" replays settled mentions without un-settling them', () => {
    const d = db();
    const { client, sent } = fakeClient();
    mentionSelf(d);
    listen(d, client, "1", { after: { self: 0, [OTHER]: 0 } }); // read + settle

    listen(d, client, "2", { mentions: "all" });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].result.mentions.length, 1, "recovery shows what was settled");

    listen(d, client, "3");
    assert.equal(sent.length, 2, "and a recovery read must not resurrect it");
  });
});

describe("announceEvent records before it wakes", () => {
  // The ordering bug this pins, observed live at claude-9o0vgfvb:14–:17.
  //
  // Every test above records the mention *before* any listen is parked, so
  // none of them can see it: the failure needs a waiter that is already
  // parked when the event lands. `notifyListenWaiters` resolves that waiter
  // synchronously, and the receipt it builds acks by read — so if the wake
  // runs before the insert, the ack updates zero rows, the mention lands
  // unseen, and the agent's cursor has already moved past the only event
  // that could ever settle it.
  //
  // Driving the real `announceEvent` and the real `createMentionRecorder` is
  // the point: a test that re-implemented the order would pass no matter what
  // `server.ts` did.
  const harness = () => {
    const d = db();
    const { client, sent } = fakeClient();
    const waiters = new Map<string, Set<() => void>>();
    // Stands in for the daemon's transport only. The order under test lives
    // entirely inside `announceEvent`.
    const notify = (nid: string) => wakeListenWaiters(waiters, nid);
    const record = createMentionRecorder(d, notify);
    const say = (content: string) => {
      const event = appendEvent(d, OTHER, "narration", { content, source: OTHER });
      announceEvent(OTHER, event, OTHER, notify, record);
      return event.seq;
    };
    const unseen = () =>
      (d
        .prepare("SELECT COUNT(*) c FROM mentions WHERE mentioned_nid = ? AND seen_at IS NULL")
        .get(SELF) as { c: number }).c;
    return { d, client, sent, waiters, say, unseen };
  };

  it("settles a mention delivered to a listen that was already parked", () => {
    const { d, client, sent, waiters, say, unseen } = harness();

    // SELF is watching OTHER — the twin's cursor, and the case that breaks.
    startMcpListen(client, d, "1", { after: { self: 0, [OTHER]: 0 } }, waiters, () => {}, BRANE);
    assert.equal(sent.length, 0, "nothing to return yet: must park");

    const seq = say(`ping @${SELF}`);
    assert.equal(sent.length, 1, "the parked listen must be woken by the event");

    const events = sent[0].result.events[OTHER];
    assert.equal(events.length, 1);
    assert.equal(events[0].seq, seq);
    assert.deepEqual(events[0].mentions, [SELF], "the row existed when the receipt was built");
    assert.equal(unseen(), 0, "reading the event that carried it must settle it");
  });

  it("does not re-report a mention the parked listen already read", () => {
    // The user-visible symptom: it came back in every later receipt, and only
    // a deliberate backward read cleared it.
    const { d, client, sent, waiters, say } = harness();
    startMcpListen(client, d, "1", { after: { self: 0, [OTHER]: 0 } }, waiters, () => {}, BRANE);
    const seq = say(`ping @${SELF}`);
    assert.equal(sent.length, 1);

    // A forward cursor past that seq — exactly what an agent passes next.
    startMcpListen(client, d, "2", { after: { self: 0, [OTHER]: seq } }, waiters, () => {}, BRANE);
    assert.equal(sent.length, 1, "settled: must not wake again");
    assert.equal(client.pendingListens.size, 1, "the second listen should be parked");
  });

  it("still wakes a mentioned agent that is not watching the source", () => {
    // The other half of the contract: recording first must not cost the wake
    // path, which is the only way a mention reaches someone watching only
    // their own narrative.
    const { d, client, sent, waiters, say } = harness();
    startMcpListen(client, d, "1", { after: { self: 0 } }, waiters, () => {}, BRANE);
    assert.equal(sent.length, 0);

    say(`ping @${SELF}`);
    assert.equal(sent.length, 1, "the mention itself must resolve the listen");
    assert.equal(sent[0].result.mentions.length, 1);
    assert.equal(sent[0].result.mentions[0].src, OTHER);
  });
});
