import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import {
  startMcpListen,
  handleMcpNarrate,
  createMentionRecorder,
  type McpBridgeClient,
  wakeListenWaiters,
} from "../daemon/server.js";
import { appendEvent } from "../db/events.js";
import { allMentions, pendingMentions } from "../db/mentions.js";

// The flows an agent actually runs, end to end through the real pieces: the
// real markdown scan (so a handle in a fence is inert here for the same reason
// it is inert on screen), the real recorder with its guards, the real wake
// path, the real receipt.
//
// The other mention suites test parts. This one tests that the parts are wired
// to each other — which is where a feature like this dies.

const A = "claude-aaaaaaaa"; // the one doing the mentioning
const B = "claude-bbbbbbbb"; // the one being mentioned
const C = "goose-cccccccc"; // a third narrative
const BRANE = "brane-home";

type Sent = { callId: string; result: any };

/** A whole brane: a db, the real recorder, and a wake fabric. */
function brane() {
  const db = createTestDb();
  const ins = db.prepare(
    "INSERT INTO narratives (id, brane_id, created_at, status) VALUES (?, ?, 0, 'active')",
  );
  for (const nid of [A, B, C]) ins.run(nid, BRANE);

  const listenWaiters = new Map<string, Set<() => void>>();
  const notify = (nid: string) => wakeListenWaiters(listenWaiters, nid);
  const record = createMentionRecorder(db, notify);

  /** An agent with a bridge whose socket records what it was sent. */
  function agent(nid: string) {
    const sent: Sent[] = [];
    const client: McpBridgeClient = {
      ws: {
        readyState: 1,
        send: (raw: string) => {
          const msg = JSON.parse(raw);
          if (msg.type === "tool_result") sent.push({ callId: msg.id, result: msg.result });
        },
      } as any,
      narrativeId: nid,
      agentType: "claude",
      pendingListens: new Map(),
    };
    let calls = 0;
    return {
      nid,
      sent,
      client,
      /** Park on `listen`, or resolve immediately if something is waiting. */
      listen(args: Record<string, unknown> = {}) {
        startMcpListen(
          client,
          db,
          `${nid}-${++calls}`,
          { after: { self: 0 }, ...args },
          listenWaiters,
          () => {},
          BRANE,
        );
      },
      /** Say something — into this narrative, or into another's. */
      say(text: string, into?: string) {
        return handleMcpNarrate(
          { say: text, ...(into ? { nid: into } : {}) },
          db,
          nid,
          notify,
          undefined,
          record,
          BRANE,
        ) as any;
      },
      last() {
        return sent[sent.length - 1]?.result;
      },
    };
  }

  /** The operator typing into a narrative's composer. */
  function operatorSignal(into: string, text: string) {
    const event = appendEvent(db, into, "human_signal", { content: text, source: "web" });
    notify(into);
    record(into, event, "web");
  }

  return { db, agent, operatorSignal, notify };
}

describe("one agent gets another's attention", () => {
  it("wakes a parked listen and hands over a pointer to the message", () => {
    const { agent } = brane();
    const a = agent(A);
    const b = agent(B);

    b.listen(); // B is idle, blocked on listen
    assert.equal(b.sent.length, 0);
    assert.equal(b.client.pendingListens.size, 1);

    a.say(`found the bug in the resync path, @${B} — it's the rAF guard`);

    assert.equal(b.sent.length, 1, "the mention must wake B");
    assert.equal(b.client.pendingListens.size, 0);
    const m = b.last().mentions;
    assert.equal(m.length, 1);
    assert.equal(m[0].src, A, "where to go read");
    assert.equal(m[0].author, A, "who said it");
    assert.equal(m[0].seq, 1);
    assert.equal(b.last().events.self.length, 0, "nothing landed in B's own log");
  });

  it("B reads A, which settles it, and B answers into A's narrative", () => {
    const { db, agent } = brane();
    const a = agent(A);
    const b = agent(B);

    b.listen();
    a.say(`@${B} can you take the ledger tests?`);
    const { src, seq } = b.last().mentions[0];

    // Interpreting a mention means going to read it. The cursor is the ack.
    b.listen({ after: { self: 0, [src]: seq - 1 } });
    const events = b.last().events[src];
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].mentions, [B], "the event says it addresses B");
    assert.equal(pendingMentions(db, B, 10).total, 0, "reading it settled it");

    // B replies the loud way — into A's narrative.
    b.say("on it", A);
    const aEvents = db.prepare("SELECT type, source FROM events WHERE narrative_id = ?").all(A) as any[];
    assert.deepEqual(aEvents.map((e) => e.type), ["narration", "agent_signal"]);

    // And B goes back to idle without being re-woken by the settled mention.
    b.listen();
    assert.equal(b.client.pendingListens.size, 1, "B parks again");
  });

  it("an unread mention nags but does not re-wake", () => {
    const { agent } = brane();
    const a = agent(A);
    const b = agent(B);

    b.listen();
    a.say(`@${B} low priority, whenever`);
    assert.equal(b.sent.length, 1);

    // B parks and re-parks without reading A. It is reminded on each *resolved*
    // call, but the unread mention never resolves one by itself again.
    for (let i = 0; i < 5; i++) b.listen();
    assert.equal(b.sent.length, 1, "SPIN LOOP: an unread mention re-resolved a listen");

    // A fresh mention does wake it, and the unread one rides along.
    b.listen();
    a.say(`@${B} bumping this`);
    assert.equal(b.sent.length, 2);
    assert.equal(b.last().mentions.length, 2, "both are still owed");
  });
});

describe("mentioning an agent that isn't running", () => {
  it("records without waking anything, and delivers when it comes back", () => {
    const { db, agent } = brane();
    const a = agent(A);

    // B has no bridge at all — nothing is listening.
    a.say(`@${B} when you're back, the migration needs a look`);
    assert.equal(pendingMentions(db, B, 10).total, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM events WHERE narrative_id = ?").get(B) as any).c,
      0,
      "and nothing was written into B's log — no revive, no trace",
    );

    // B restarts and does what a restarted agent does: whoami, then listen.
    const b = agent(B);
    const recovered = allMentions(db, B, 10, BRANE);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].src, A);

    b.listen();
    assert.equal(b.sent.length, 1, "the first listen after a restart delivers it");
    assert.equal(b.last().mentions[0].src, A);
  });

  it("survives a restart that loses the agent's cursor entirely", () => {
    const { db, agent } = brane();
    agent(A).say(`@${B} ping`);

    // A restarted agent re-derives its cursor from tail:50 and may well read
    // from 0. The mention must not be lost to that, nor re-delivered forever.
    const b = agent(B);
    b.listen({ tail: { self: 50 } });
    assert.equal(b.sent.length, 1);
    assert.equal(b.last().mentions.length, 1);

    b.listen({ after: { self: 0 } });
    assert.equal(b.sent.length, 1, "a rewound cursor must not resurrect the wake");
    assert.equal(pendingMentions(db, B, 10).total, 1, "but it is still owed until read");
  });
});

describe("the operator mentions an agent", () => {
  it("delivers a human signal's mention the same way", () => {
    const { agent, operatorSignal } = brane();
    const b = agent(B);
    b.listen();

    // Typed into A's composer: "@B — look at this".
    operatorSignal(A, `@${B} see the trace above`);

    assert.equal(b.sent.length, 1);
    assert.equal(b.last().mentions[0].author, "web", "the operator, not an agent");
    assert.equal(b.last().mentions[0].src, A);
  });
});

describe("a third party's narration", () => {
  it("names where to read and who said it, separately", () => {
    const { agent } = brane();
    const a = agent(A);
    const b = agent(B);
    b.listen();

    // A narrates into C's narrative, mentioning B. B must be sent to C to read
    // it, while knowing A wrote it.
    a.say(`@${B} this is the thread`, C);

    const m = b.last().mentions[0];
    assert.equal(m.src, C, "read C");
    assert.equal(m.author, A, "A said it");
  });
});

describe("what must not page anyone", () => {
  it("a handle inside a fenced block in a real narration", () => {
    const { db, agent } = brane();
    const a = agent(A);
    const b = agent(B);
    b.listen();

    a.say(
      `here's the log I was sent:\n\n\`\`\`\n[12:03] operator: ping @${B}\n\`\`\`\n\nnot sure what to make of it`,
    );

    assert.equal(b.sent.length, 0, "a pasted log must not page anyone");
    assert.equal(b.client.pendingListens.size, 1);
    assert.equal(pendingMentions(db, B, 10).total, 0);
  });

  it("a handle in a code span, a link, or mid-word", () => {
    const { db, agent } = brane();
    const a = agent(A);
    a.say(`run \`brane revive @${B}\` — see [@${B}](https://example.com/x) or mail ben@${B}`);
    assert.equal(pendingMentions(db, B, 10).total, 0);
  });

  it("an agent mentioning itself", () => {
    const { db, agent } = brane();
    const b = agent(B);
    b.say(`note to self: @${B} should check this`);
    assert.equal(pendingMentions(db, B, 10).total, 0);
  });

  it("an author mentioning itself in someone else's narrative", () => {
    const { db, agent } = brane();
    // A narrates into B and signs off `@A`. The words are A's own; a row would
    // wake A's own `narrate({ wait })` at once, pointing at an event A's cursor
    // never reads, so the reminder would recur until dismissed.
    agent(A).say(`answered — ping @${A} if not`, B);
    assert.equal(pendingMentions(db, A, 10).total, 0);
  });

  it("a mention of the narrative being narrated into", () => {
    const { db, agent } = brane();
    // A narrates into B's narrative and mentions B. The message is already in
    // B's log and already woke it; a row would be a duplicate plus a wake.
    agent(A).say(`@${B} here you go`, B);
    assert.equal(pendingMentions(db, B, 10).total, 0);
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM events WHERE narrative_id = ?").get(B) as any).c,
      1,
      "the agent_signal itself still landed",
    );
  });

  it("a handle that names no narrative", () => {
    const { db, agent } = brane();
    agent(A).say("@claude-deadbeef are you there?");
    assert.equal((db.prepare("SELECT COUNT(*) c FROM mentions").get() as any).c, 0);
  });
});

describe("the loop stays exactly as it was when no one is mentioned", () => {
  it("an ordinary narrate/listen exchange is byte-identical", () => {
    const { agent, operatorSignal } = brane();
    const a = agent(A);
    const b = agent(B);

    const narrated = a.say("working on the resync heartbeat");
    assert.equal("mentions" in narrated, false);
    assert.equal("mentions_pending" in narrated, false);

    b.listen();
    operatorSignal(B, "how's it going?");
    assert.equal(b.sent.length, 1);
    assert.deepEqual(Object.keys(b.last()).sort(), ["events", "timed_out", "waited_ms"]);
  });
});

describe("two agents mentioning each other", () => {
  it("each wake is earned by a new mention, never by an old one", () => {
    const { agent } = brane();
    const a = agent(A);
    const b = agent(B);

    // The shape that would ping-pong if an unread mention could re-resolve.
    for (let round = 0; round < 5; round++) {
      a.listen();
      b.listen();
      a.say(`round ${round} @${B}`);
      b.say(`round ${round} @${A}`);
    }
    // Five mentions each way, five wakes each way — one per new mention, and
    // never a sixth from the pile of unread ones.
    assert.equal(a.sent.length, 5);
    assert.equal(b.sent.length, 5);
  });
});
