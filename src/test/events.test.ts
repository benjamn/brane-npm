import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { appendEvent, readEventsSince, getMaxSeq } from "../db/events.js";

describe("events", () => {
  it("appends events with auto-incrementing seq", () => {
    const db = createTestDb();
    const e1 = appendEvent(db, "test-narrative", "narration", { content: "hello" });
    const e2 = appendEvent(db, "test-narrative", "narration", { content: "world" });

    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.equal(e1.content, "hello");
    assert.equal(e2.content, "world");
  });

  it("sequences are per-narrative", () => {
    const db = createTestDb();
    appendEvent(db, "narrative-a", "narration", { content: "a1" });
    appendEvent(db, "narrative-a", "narration", { content: "a2" });
    const b1 = appendEvent(db, "narrative-b", "narration", { content: "b1" });

    assert.equal(b1.seq, 1); // starts at 1, not 3
  });

  it("readEventsSince returns events after cursor", () => {
    const db = createTestDb();
    appendEvent(db, "n1", "narration", { content: "one" });
    appendEvent(db, "n1", "narration", { content: "two" });
    appendEvent(db, "n1", "narration", { content: "three" });

    const events = readEventsSince(db, "n1", 1);
    assert.equal(events.length, 2);
    assert.equal(events[0].content, "two");
    assert.equal(events[1].content, "three");
  });

  it("readEventsSince with cursor 0 returns all events", () => {
    const db = createTestDb();
    appendEvent(db, "n1", "narration", { content: "one" });
    appendEvent(db, "n1", "narration", { content: "two" });

    const events = readEventsSince(db, "n1", 0);
    assert.equal(events.length, 2);
  });

  it("readEventsSince respects limit", () => {
    const db = createTestDb();
    for (let i = 0; i < 10; i++) {
      appendEvent(db, "n1", "narration", { content: `msg-${i}` });
    }

    const events = readEventsSince(db, "n1", 0, 3);
    assert.equal(events.length, 3);
    assert.equal(events[0].content, "msg-0");
    assert.equal(events[2].content, "msg-2");
  });

  it("readEventsSince returns empty for unknown narrative", () => {
    const db = createTestDb();
    const events = readEventsSince(db, "nonexistent", 0);
    assert.equal(events.length, 0);
  });

  it("getMaxSeq returns 0 for empty narrative", () => {
    const db = createTestDb();
    assert.equal(getMaxSeq(db, "nonexistent"), 0);
  });

  it("getMaxSeq returns highest seq", () => {
    const db = createTestDb();
    appendEvent(db, "n1", "narration", { content: "one" });
    appendEvent(db, "n1", "narration", { content: "two" });
    appendEvent(db, "n1", "narration", { content: "three" });

    assert.equal(getMaxSeq(db, "n1"), 3);
  });

  it("stores and retrieves back-references as parsed arrays", () => {
    const db = createTestDb();
    const e = appendEvent(db, "n1", "narration", {
      content: "reply",
      re: [1, "other-narrative:5"],
    });

    assert.deepEqual(e.re, [1, "other-narrative:5"]);

    const events = readEventsSince(db, "n1", 0);
    assert.deepEqual(events[0].re, [1, "other-narrative:5"]);
  });

  it("source field works for all event types", () => {
    const db = createTestDb();
    const opSignal = appendEvent(db, "n1", "human_signal", {
      content: "incoming",
      source: "mobile",
    });
    assert.equal(opSignal.source, "mobile");
    assert.equal(opSignal.type, "human_signal");

    const agentMsg = appendEvent(db, "n1", "agent_signal", {
      content: "delegation result",
      source: "claude-abc",
    });
    assert.equal(agentMsg.source, "claude-abc");
    assert.equal(agentMsg.type, "agent_signal");

    const narration = appendEvent(db, "n1", "narration", {
      content: "thinking",
      source: "claude-xyz",
    });
    assert.equal(narration.source, "claude-xyz");
    assert.equal(narration.type, "narration");
  });

  it("stores payloads as parsed arrays", () => {
    const db = createTestDb();
    const e = appendEvent(db, "n1", "narration", {
      content: "with files",
      payloads: ["path/to/file.png", "path/to/doc.md"],
    });

    assert.deepEqual(e.payloads, ["path/to/file.png", "path/to/doc.md"]);
  });

  it("omits undefined optional fields", () => {
    const db = createTestDb();
    const e = appendEvent(db, "n1", "narration", { content: "minimal" });

    assert.equal(e.seq, 1);
    assert.equal(typeof e.time, "number");
    assert.equal(e.type, "narration");
    assert.equal(e.content, "minimal");
    assert.equal(e.content_type, undefined);
    assert.equal(e.source, undefined);
    assert.equal(e.re, undefined);
    assert.equal(e.payloads, undefined);
    assert.equal("narrative_id" in e, false);
    assert.equal("event_type" in e, false);
    assert.equal("timestamp_ms" in e, false);
    assert.equal("sender" in e, false);
    assert.equal("speaker" in e, false);
    assert.equal("intensity" in e, false);
  });
});
