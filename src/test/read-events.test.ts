import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { appendEvent, readEvents } from "../db/events.js";

/**
 * Populate a narrative with N events labeled msg-0 through msg-(N-1).
 * Returns the seq of the last event inserted.
 */
function populate(db: ReturnType<typeof createTestDb>, nid: string, count: number): number {
  let lastSeq = 0;
  for (let i = 0; i < count; i++) {
    const e = appendEvent(db, nid, "narration", { content: `msg-${i}` });
    lastSeq = e.seq;
  }
  return lastSeq;
}

describe("readEvents", () => {
  // ── after (replaces heard) ──────────────────────────────────────

  describe("after", () => {
    it("returns events after a cursor (like heard)", () => {
      const db = createTestDb();
      populate(db, "n1", 5);

      const events = readEvents(db, "n1", { after: 2 });
      assert.equal(events.length, 3);
      assert.equal(events[0].content, "msg-2"); // seq 3
      assert.equal(events[2].content, "msg-4"); // seq 5
    });

    it("after: 0 returns all events", () => {
      const db = createTestDb();
      populate(db, "n1", 3);

      const events = readEvents(db, "n1", { after: 0 });
      assert.equal(events.length, 3);
    });

    it("after beyond max seq returns empty", () => {
      const db = createTestDb();
      populate(db, "n1", 3);

      const events = readEvents(db, "n1", { after: 100 });
      assert.equal(events.length, 0);
    });
  });

  // ── before ──────────────────────────────────────────────────────

  describe("before", () => {
    it("returns events before a cursor", () => {
      const db = createTestDb();
      populate(db, "n1", 5);

      const events = readEvents(db, "n1", { before: 4 });
      assert.equal(events.length, 3); // seq 1, 2, 3
      assert.equal(events[0].content, "msg-0");
      assert.equal(events[2].content, "msg-2");
    });

    it("before: 1 returns empty (nothing before seq 1)", () => {
      const db = createTestDb();
      populate(db, "n1", 3);

      const events = readEvents(db, "n1", { before: 1 });
      assert.equal(events.length, 0);
    });

    it("before beyond max seq returns all events", () => {
      const db = createTestDb();
      populate(db, "n1", 3);

      const events = readEvents(db, "n1", { before: 100 });
      assert.equal(events.length, 3);
    });
  });

  // ── after + before (bounded range) ─────────────────────────────

  describe("after + before", () => {
    it("returns events in a bounded range", () => {
      const db = createTestDb();
      populate(db, "n1", 10);

      const events = readEvents(db, "n1", { after: 3, before: 7 });
      assert.equal(events.length, 3); // seq 4, 5, 6
      assert.equal(events[0].content, "msg-3");
      assert.equal(events[2].content, "msg-5");
    });

    it("empty range returns empty", () => {
      const db = createTestDb();
      populate(db, "n1", 10);

      // after: 5, before: 6 → only seq > 5 AND seq < 6 → nothing
      const events = readEvents(db, "n1", { after: 5, before: 6 });
      assert.equal(events.length, 0);
    });

    it("adjacent cursors return single event", () => {
      const db = createTestDb();
      populate(db, "n1", 10);

      // after: 4, before: 6 → seq 5 only
      const events = readEvents(db, "n1", { after: 4, before: 6 });
      assert.equal(events.length, 1);
      assert.equal(events[0].content, "msg-4");
    });

    it("inverted range (after >= before) returns empty", () => {
      const db = createTestDb();
      populate(db, "n1", 5);

      const events = readEvents(db, "n1", { after: 5, before: 3 });
      assert.equal(events.length, 0);
    });
  });

  // ── tail ────────────────────────────────────────────────────────

  describe("tail", () => {
    it("returns the last N events", () => {
      const db = createTestDb();
      populate(db, "n1", 10);

      const events = readEvents(db, "n1", { tail: 3 });
      assert.equal(events.length, 3);
      assert.equal(events[0].content, "msg-7"); // seq 8
      assert.equal(events[2].content, "msg-9"); // seq 10
    });

    it("tail larger than total returns all events", () => {
      const db = createTestDb();
      populate(db, "n1", 3);

      const events = readEvents(db, "n1", { tail: 100 });
      assert.equal(events.length, 3);
    });

    it("tail: 1 returns only the last event", () => {
      const db = createTestDb();
      populate(db, "n1", 5);

      const events = readEvents(db, "n1", { tail: 1 });
      assert.equal(events.length, 1);
      assert.equal(events[0].content, "msg-4");
    });

    it("tail: 0 returns empty", () => {
      const db = createTestDb();
      populate(db, "n1", 5);

      const events = readEvents(db, "n1", { tail: 0 });
      assert.equal(events.length, 0);
    });
  });

  // ── tail + before (backward pagination) ────────────────────────

  describe("tail + before", () => {
    it("returns last N events before a cursor", () => {
      const db = createTestDb();
      populate(db, "n1", 10);

      // Last 3 before seq 8 → seq 5, 6, 7
      const events = readEvents(db, "n1", { tail: 3, before: 8 });
      assert.equal(events.length, 3);
      assert.equal(events[0].content, "msg-4"); // seq 5
      assert.equal(events[2].content, "msg-6"); // seq 7
    });

    it("backward pagination walks through entire history", () => {
      const db = createTestDb();
      populate(db, "n1", 10);

      // Page 1: last 3 → seq 8, 9, 10
      const page1 = readEvents(db, "n1", { tail: 3 });
      assert.equal(page1.length, 3);
      assert.equal(page1[0].seq, 8);

      // Page 2: last 3 before seq 8 → seq 5, 6, 7
      const page2 = readEvents(db, "n1", { tail: 3, before: page1[0].seq });
      assert.equal(page2.length, 3);
      assert.equal(page2[0].seq, 5);

      // Page 3: last 3 before seq 5 → seq 2, 3, 4
      const page3 = readEvents(db, "n1", { tail: 3, before: page2[0].seq });
      assert.equal(page3.length, 3);
      assert.equal(page3[0].seq, 2);

      // Page 4: last 3 before seq 2 → seq 1 (partial page)
      const page4 = readEvents(db, "n1", { tail: 3, before: page3[0].seq });
      assert.equal(page4.length, 1);
      assert.equal(page4[0].seq, 1);

      // Page 5: before seq 1 → empty (done)
      const page5 = readEvents(db, "n1", { tail: 3, before: page4[0].seq });
      assert.equal(page5.length, 0);
    });
  });

  // ── after + tail (last N after a cursor) ───────────────────────

  describe("after + tail", () => {
    it("returns the last N events after a cursor", () => {
      const db = createTestDb();
      populate(db, "n1", 10);

      // Events after seq 2, but only the last 3 → seq 8, 9, 10
      const events = readEvents(db, "n1", { after: 2, tail: 3 });
      assert.equal(events.length, 3);
      assert.equal(events[0].content, "msg-7"); // seq 8
      assert.equal(events[2].content, "msg-9"); // seq 10
    });
  });

  // ── after + before + tail (bounded + limited) ──────────────────

  describe("after + before + tail", () => {
    it("returns last N events within a bounded range", () => {
      const db = createTestDb();
      populate(db, "n1", 20);

      // Range: seq 6-14 (after 5, before 15), tail 3 → seq 12, 13, 14
      const events = readEvents(db, "n1", { after: 5, before: 15, tail: 3 });
      assert.equal(events.length, 3);
      assert.equal(events[0].seq, 12);
      assert.equal(events[2].seq, 14);
    });
  });

  // ── no parameters ──────────────────────────────────────────────

  describe("defaults", () => {
    it("no parameters returns all events (like after: 0)", () => {
      const db = createTestDb();
      populate(db, "n1", 5);

      const events = readEvents(db, "n1", {});
      assert.equal(events.length, 5);
    });

    it("empty narrative returns empty", () => {
      const db = createTestDb();

      const events = readEvents(db, "nonexistent", {});
      assert.equal(events.length, 0);
    });
  });

  // ── ordering ───────────────────────────────────────────────────

  describe("ordering", () => {
    it("always returns events in ascending seq order", () => {
      const db = createTestDb();
      populate(db, "n1", 10);

      // tail queries internally sort DESC then reverse
      const events = readEvents(db, "n1", { tail: 5 });
      for (let i = 1; i < events.length; i++) {
        assert.ok(events[i].seq > events[i - 1].seq, `seq ${events[i].seq} should be > ${events[i - 1].seq}`);
      }
    });

    it("after+before returns in ascending order", () => {
      const db = createTestDb();
      populate(db, "n1", 10);

      const events = readEvents(db, "n1", { after: 2, before: 8 });
      for (let i = 1; i < events.length; i++) {
        assert.ok(events[i].seq > events[i - 1].seq);
      }
    });
  });
});
