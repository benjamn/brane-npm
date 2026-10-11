import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import {
  recordMentions,
  pendingMentions,
  allMentions,
  hasUnsentMentions,
  ackMentionsByRead,
  dismissMentions,
  markSent,
  mentionsInEvents,
} from "../db/mentions.js";

// The ledger makes two guarantees survive restarts, crashes and re-scans: a
// mention wakes an agent exactly once, and a mention the agent never actually
// read keeps coming back. Those pull in opposite directions, which is why each
// row carries two marks — `sent_at` for the first, `seen_at` for the second.
// Most of what follows pins that split, and one test pins the reason they are
// per-row rather than high-water marks per narrative.

const A = "claude-aaaaaaaa";
const B = "claude-bbbbbbbb";
const C = "goose-cccccccc";

function db(): Database.Database {
  const d = createTestDb();
  const ins = d.prepare(
    "INSERT INTO narratives (id, brane_id, created_at, status) VALUES (?, ?, 0, 'active')",
  );
  ins.run(A, "brane-home");
  ins.run(B, "brane-home");
  ins.run(C, "brane-far");
  return d;
}

/** B mentions A at `seq`. */
function mention(d: Database.Database, seq: number, src = B, mentioned = A): string[] {
  return recordMentions(d, {
    mentionedNids: [mentioned],
    srcNarrative: src,
    srcSeq: seq,
    author: src,
    time: 1000 + seq,
  });
}

describe("recording", () => {
  it("returns the rising edge, so only new mentions wake anyone", () => {
    const d = db();
    assert.deepEqual(mention(d, 5), [A]);
    assert.deepEqual(mention(d, 5), [], "a re-scan of the same event wakes nobody");
    assert.deepEqual(mention(d, 6), [A]);
  });

  it("dedups a handle repeated inside one event", () => {
    const d = db();
    const fresh = recordMentions(d, {
      mentionedNids: [A, A, C],
      srcNarrative: B,
      srcSeq: 1,
      author: B,
      time: 1,
    });
    assert.deepEqual(fresh, [A, C]);
    const { c } = d.prepare("SELECT COUNT(*) c FROM mentions").get() as { c: number };
    assert.equal(c, 2);
  });

  it("is idempotent under a full re-scan, which is what makes rebuild safe", () => {
    const d = db();
    for (const seq of [1, 2, 3]) mention(d, seq);
    markSent(d, A);
    const before = d.prepare("SELECT id, src_seq, sent_at FROM mentions ORDER BY id").all();
    for (const seq of [1, 2, 3]) mention(d, seq);
    const after = d.prepare("SELECT id, src_seq, sent_at FROM mentions ORDER BY id").all();
    // Same rows, same ids, and — the part that matters — delivery state
    // untouched. A rebuild that reassigned ids or cleared these would
    // re-deliver mentions the agent already handled.
    assert.deepEqual(after, before);
  });

  it("keeps mentions of different narratives apart", () => {
    const d = db();
    recordMentions(d, { mentionedNids: [A, C], srcNarrative: B, srcSeq: 1, author: B, time: 1 });
    assert.equal(pendingMentions(d, A, 10).total, 1);
    assert.equal(pendingMentions(d, C, 10).total, 1);
    assert.equal(pendingMentions(d, B, 10).total, 0);
  });
});

describe("the two marks", () => {
  it("delivery stops the wake but not the reminder", () => {
    const d = db();
    mention(d, 5);
    assert.ok(hasUnsentMentions(d, A), "undelivered: should wake");

    const { rows } = pendingMentions(d, A, 10);
    markSent(d, A); // what delivery does

    assert.equal(hasUnsentMentions(d, A), false, "delivered: must not wake again");
    assert.equal(pendingMentions(d, A, 10).total, 1, "unread: must still be shown");
    assert.equal(rows[0].src, B);
  });

  it("a new mention wakes again even while an old one is still unread", () => {
    const d = db();
    mention(d, 5);
    markSent(d, A);
    assert.equal(hasUnsentMentions(d, A), false);

    mention(d, 6);
    assert.ok(hasUnsentMentions(d, A));
    assert.equal(pendingMentions(d, A, 10).total, 2);
  });

  it("neither mark can rewind, because there is no value that would", () => {
    // A high-water integer can be written backwards by a cursor that reset.
    // NULL -> timestamp cannot: re-running either transition is a no-op.
    const d = db();
    for (const seq of [1, 2, 3]) mention(d, seq);
    markSent(d, A);
    markSent(d, A);
    assert.equal(hasUnsentMentions(d, A), false);
    ackMentionsByRead(d, A, { [B]: [1, 2, 3, 5] });
    ackMentionsByRead(d, A, { [B]: [1, 2, 3, 5] });
    assert.equal(pendingMentions(d, A, 10).total, 0);
  });

  it("caps the receipt without leaving a remainder that re-wakes", () => {
    const d = db();
    for (let seq = 1; seq <= 25; seq++) mention(d, seq);
    const { rows, total } = pendingMentions(d, A, 10);
    assert.equal(rows.length, 10);
    assert.equal(total, 25);
    // markSent covers everything pending, not just the slice shown.
    markSent(d, A);
    assert.equal(hasUnsentMentions(d, A), false, "the uncapped remainder must not re-wake");
    assert.equal(pendingMentions(d, A, 10).total, 25, "but it is still owed to the agent");
  });

  it("shows the most recent when capped, oldest-first within the slice", () => {
    const d = db();
    for (let seq = 1; seq <= 5; seq++) mention(d, seq);
    const { rows } = pendingMentions(d, A, 3);
    assert.deepEqual(rows.map((r) => r.seq), [3, 4, 5]);
  });
});

describe("receiving the event is the acknowledgment", () => {
  it("settles exactly the events delivered, not a range", () => {
    const d = db();
    for (const seq of [5, 7, 9]) mention(d, seq);
    assert.equal(pendingMentions(d, A, 10).total, 3);

    // The read returned seq 7 and 9 — a `before` bound, or a `tail`, can skip
    // what lies between. Settling on "seq > 5" would mark all three read.
    assert.equal(ackMentionsByRead(d, A, { [B]: [7, 9] }), 2);
    const rest = pendingMentions(d, A, 10);
    assert.equal(rest.total, 1);
    assert.equal(rest.rows[0].seq, 5, "the event that was never shown is still owed");
  });

  it("settles nothing when the delivered events carry no mention", () => {
    const d = db();
    mention(d, 5);
    assert.equal(ackMentionsByRead(d, A, { [B]: [4, 6, 99] }), 0);
    assert.equal(pendingMentions(d, A, 10).total, 1);
  });

  it("ignores a read of an unrelated narrative", () => {
    const d = db();
    mention(d, 5);
    assert.equal(ackMentionsByRead(d, A, { [C]: [5] }), 0);
    assert.equal(pendingMentions(d, A, 10).total, 1);
  });

  it("ignores an empty delivery", () => {
    const d = db();
    mention(d, 5);
    assert.equal(ackMentionsByRead(d, A, { [B]: [] }), 0);
    assert.equal(ackMentionsByRead(d, A, {}), 0);
    assert.equal(pendingMentions(d, A, 10).total, 1);
  });

  it("reading your own log is not evidence you looked at someone else's", () => {
    const d = db();
    mention(d, 5, A, A); // pathological, but the guard must hold
    assert.equal(ackMentionsByRead(d, A, { [A]: [5] }), 0);
  });

  it("settles one source without touching another, in either recording order", () => {
    // The bug that forced per-row marks. A single high-water over a shared id
    // space settles every mention with a lower id when one is acknowledged —
    // including one from a narrative the agent never looked at. Recording C
    // *first* is what exposes it, so both orders are pinned.
    for (const [first] of [[B], [C]] as const) {
      const d = db();
      mention(d, 5, first);
      mention(d, 5, first === B ? C : B);
      assert.equal(pendingMentions(d, A, 10).total, 2);
      ackMentionsByRead(d, A, { [B]: [5] });
      const rest = pendingMentions(d, A, 10);
      assert.equal(rest.total, 1, `reading B settled C's mention (${first} recorded first)`);
      assert.equal(rest.rows[0].src, C);
    }
  });

  it("is idempotent", () => {
    const d = db();
    mention(d, 5);
    assert.equal(ackMentionsByRead(d, A, { [B]: [5] }), 1);
    assert.equal(ackMentionsByRead(d, A, { [B]: [5] }), 0);
    assert.equal(pendingMentions(d, A, 10).total, 0);
  });
});

describe("annotating delivered events", () => {
  it("says what each event addresses, keyed by nid:seq", () => {
    const d = db();
    recordMentions(d, { mentionedNids: [A, C], srcNarrative: B, srcSeq: 5, author: B, time: 1 });
    const ann = mentionsInEvents(d, { [B]: [4, 5, 6] });
    assert.deepEqual(Object.keys(ann), [`${B}:5`]);
    assert.deepEqual(ann[`${B}:5`].sort(), [A, C].sort());
  });

  it("is empty for events that mention nobody, so the common case costs nothing", () => {
    const d = db();
    mention(d, 5);
    assert.deepEqual(mentionsInEvents(d, { [B]: [1, 2, 3] }), {});
    assert.deepEqual(mentionsInEvents(d, {}), {});
  });

  it("reports regardless of either mark", () => {
    const d = db();
    mention(d, 5);
    markSent(d, A);
    ackMentionsByRead(d, A, { [B]: [5] });
    // The event still mentions A; it just isn't owed any more.
    assert.deepEqual(mentionsInEvents(d, { [B]: [5] }), { [`${B}:5`]: [A] });
  });
});

describe("recovery and dismissal", () => {
  it("allMentions ignores both marks and moves neither", () => {
    const d = db();
    mention(d, 5);
    markSent(d, A);
    ackMentionsByRead(d, A, { [B]: [1, 2, 3, 5] });
    assert.equal(pendingMentions(d, A, 10).total, 0);

    // Delivery is at-most-once — a tool result can be dropped by a socket that
    // closes mid-flight — so "settled" must never mean "unreachable".
    assert.equal(allMentions(d, A, 10).length, 1);
    assert.equal(pendingMentions(d, A, 10).total, 0, "reading recovery settles nothing");
    assert.equal(hasUnsentMentions(d, A), false, "and wakes nobody");
  });

  it("dismiss settles everything currently recorded, and nothing later", () => {
    const d = db();
    mention(d, 5);
    mention(d, 6);
    assert.equal(dismissMentions(d, A), 2);
    assert.equal(pendingMentions(d, A, 10).total, 0);
    mention(d, 7);
    assert.equal(pendingMentions(d, A, 10).total, 1, "a later mention is unaffected");
    assert.ok(hasUnsentMentions(d, A), "and still wakes");
  });

  it("dismiss on an empty ledger is a no-op", () => {
    const d = db();
    assert.equal(dismissMentions(d, A), 0);
  });
});

describe("cross-brane", () => {
  it("stamps brane_id only when it differs from the reader's", () => {
    const d = db();
    mention(d, 1, C); // C lives in brane-far
    mention(d, 1, B); // B is home
    const rows = pendingMentions(d, A, 10, "brane-home").rows;
    const fromFar = rows.find((r) => r.src === C);
    const fromHome = rows.find((r) => r.src === B);
    assert.equal(fromFar?.brane_id, "brane-far");
    assert.equal(fromHome?.brane_id, undefined);
  });

  it("carries the author separately from the source narrative", () => {
    const d = db();
    // C narrated into B's narrative, mentioning A: read B, but C said it.
    recordMentions(d, {
      mentionedNids: [A],
      srcNarrative: B,
      srcSeq: 3,
      author: C,
      time: 1,
    });
    const row = pendingMentions(d, A, 10).rows[0];
    assert.equal(row.src, B, "where to read");
    assert.equal(row.author, C, "who said it");
  });
});
