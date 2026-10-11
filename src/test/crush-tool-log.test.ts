import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers.js";
import { readToolUseWindow } from "../db/tool-uses.js";
import {
  toolUsesFromCrushParts,
  resolveCrushSessionIds,
  pollCrushToolLog,
  newCrushLogCursor,
  crushDbPath,
  crushLogSignature,
} from "../crush-tool-log.js";

/** crush's schema, copied from a live `~/dev/crush/.crush/crush.db` — including
 *  the comments that claim milliseconds on columns that hold seconds. */
const CRUSH_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  title TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0.0,
  updated_at INTEGER NOT NULL,  -- Unix timestamp in milliseconds
  created_at INTEGER NOT NULL   -- Unix timestamp in milliseconds
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  provider TEXT
);
`;

/** Real part shapes, from the live database. Note the double encoding: `input`
 *  and `metadata` are JSON strings inside a JSON document. */
const TOOL_CALL_PART = JSON.stringify([
  {
    type: "tool_call",
    data: {
      id: "bash_88",
      name: "bash",
      input: '{"command": "sleep 25"}',
      provider_executed: false,
      finished: false,
    },
  },
]);

const TOOL_RESULT_PART = JSON.stringify([
  {
    type: "tool_result",
    data: {
      tool_call_id: "bash_88",
      name: "bash",
      content: "done",
      is_error: false,
      metadata: '{"start_time":1786903334560,"end_time":1786903335561,"description":"sleep"}',
    },
  },
]);

function crushFold(): string {
  const fold = mkdtempSync(join(tmpdir(), "brane-crush-"));
  mkdirSync(join(fold, ".crush"), { recursive: true });
  return fold;
}

function seedCrush(fold: string): Database.Database {
  const crush = new Database(crushDbPath(fold));
  crush.exec(CRUSH_SCHEMA);
  return crush;
}

function addSession(crush: Database.Database, id: string, createdAt: number, parent?: string): void {
  crush
    .prepare(
      "INSERT INTO sessions (id, parent_session_id, title, updated_at, created_at) VALUES (?, ?, 'x', ?, ?)",
    )
    .run(id, parent ?? null, createdAt, createdAt);
}

function addMessage(
  crush: Database.Database,
  id: string,
  sessionId: string,
  parts: string,
  at: number,
): void {
  crush
    .prepare(
      "INSERT INTO messages (id, session_id, role, parts, created_at, updated_at) VALUES (?, ?, 'assistant', ?, ?, ?)",
    )
    .run(id, sessionId, parts, at, at);
}

function seedNarrative(
  db: ReturnType<typeof createTestDb>,
  fold: string,
  createdAtMs: number,
): string {
  const nid = "crush-test0001";
  db.prepare(
    "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at) VALUES (?, 'brane-test', 'crush', 'worker', 'active', ?, ?)",
  ).run(nid, fold, createdAtMs);
  return nid;
}

describe("toolUsesFromCrushParts", () => {
  // crush persists the tool_call part before the tool runs, which is the whole
  // reason a session-log tail can stand in for a PreToolUse hook.
  it("reads a call as pending and un-double-encodes its input", () => {
    const [call] = toolUsesFromCrushParts(TOOL_CALL_PART, {});
    assert.equal(call.dedupKey, "bash_88");
    assert.equal(call.name, "bash");
    assert.equal(call.status, "pending");
    assert.deepEqual(call.input, { command: "sleep 25" }, "input arrives as a JSON string");
    assert.equal(call.source, "session_log");
    assert.equal(call.agentType, "crush");
  });

  // `finished` says the call returned, not that it worked. The outcome lives in
  // the tool_result part, which may not be written yet — so reading `finished`
  // as success would mark failed calls completed.
  it("keeps a finished call pending until its result part arrives", () => {
    const finished = TOOL_CALL_PART.replace('"finished":false', '"finished":true');
    assert.equal(toolUsesFromCrushParts(finished, {})[0].status, "pending");
  });

  it("completes the call from its result, with a duration in the right unit", () => {
    const [result] = toolUsesFromCrushParts(TOOL_RESULT_PART, {});
    assert.equal(result.dedupKey, "bash_88", "same key as the call — one row, not two");
    assert.equal(result.status, "completed");
    assert.equal(result.output, "done");
    // metadata's start_time/end_time are milliseconds, unlike the columns.
    assert.equal(result.durationMs, 1_001);
    assert.equal(result.startedAt, 1_786_903_334_560);
  });

  it("reads is_error as a failure", () => {
    const failed = TOOL_RESULT_PART.replace('"is_error":false', '"is_error":true');
    assert.equal(toolUsesFromCrushParts(failed, {})[0].status, "failed");
  });

  it("survives junk parts rather than throwing inside a poll", () => {
    assert.deepEqual(toolUsesFromCrushParts("not json", {}), []);
    assert.deepEqual(toolUsesFromCrushParts('{"not":"an array"}', {}), []);
    assert.deepEqual(toolUsesFromCrushParts('[{"type":"text","data":{"text":"hi"}}]', {}), []);
    assert.deepEqual(toolUsesFromCrushParts('[{"type":"tool_call","data":{}}]', {}), []);
    // A result with no metadata still completes; it just has no duration.
    const [bare] = toolUsesFromCrushParts(
      '[{"type":"tool_result","data":{"tool_call_id":"x_1","name":"x","content":"ok"}}]',
      {},
    );
    assert.equal(bare.status, "completed");
    assert.equal(bare.durationMs, undefined);
  });
});

describe("resolveCrushSessionIds", () => {
  it("prefers the ids brane recorded over any heuristic", () => {
    const fold = crushFold();
    const crush = seedCrush(fold);
    addSession(crush, "recorded-one", 1_000);
    addSession(crush, "newer-other", 9_999);
    assert.deepEqual(
      resolveCrushSessionIds(crush, { recorded: ["recorded-one"], narrativeCreatedAtMs: 1_000_000 }),
      ["recorded-one"],
    );
  });

  // The fallback compares against crush's clock, which counts seconds — the
  // schema comment says milliseconds and the live rows do not. A narrative's
  // created_at is milliseconds, so an unconverted comparison matches nothing,
  // forever, and reads exactly like a session that made no tool calls.
  it("compares against crush's seconds, not brane's milliseconds", () => {
    const fold = crushFold();
    const crush = seedCrush(fold);
    const spawnedAtMs = 1_786_900_000_000;
    addSession(crush, "before", Math.floor(spawnedAtMs / 1000) - 60);
    addSession(crush, "after", Math.floor(spawnedAtMs / 1000) + 60);
    assert.deepEqual(
      resolveCrushSessionIds(crush, { narrativeCreatedAtMs: spawnedAtMs }),
      ["after"],
    );
  });

  // The exclusion has to happen in the query. Asking for the newest row and
  // then discarding it if it turns out to be bookkeeping reports "no session"
  // while a perfectly good one sits directly underneath it — and the poller
  // then captures nothing at all until the next real session is created.
  it("skips past bookkeeping rows to the newest real session", () => {
    const fold = crushFold();
    const crush = seedCrush(fold);
    addSession(crush, "real-session", 1_000);
    // Both shapes are live in the operator's own crush database today. Give
    // them null parents: sub-agent rows are parented in the logs seen so far,
    // but nothing guarantees every kind of synthetic row is.
    addSession(crush, "title-real-session", 2_000);
    addSession(crush, "a0ffd9e8$$agentic_fetch_68", 3_000);
    assert.deepEqual(resolveCrushSessionIds(crush, { narrativeCreatedAtMs: 0 }), ["real-session"]);
    assert.deepEqual(
      resolveCrushSessionIds(crush, { recorded: ["title-x", "real-session"], narrativeCreatedAtMs: 0 }),
      ["real-session"],
    );
  });
});

describe("pollCrushToolLog", () => {
  it("records a running call, then settles it when the result lands", () => {
    const fold = crushFold();
    const crush = seedCrush(fold);
    const db = createTestDb();
    const nid = seedNarrative(db, fold, 1_000_000);
    addSession(crush, "s1", 1_000);
    addMessage(crush, "m1", "s1", TOOL_CALL_PART, 1_100);

    const cursor = newCrushLogCursor();
    const first = pollCrushToolLog(db, nid, { foldPath: fold, narrativeCreatedAtMs: 0 }, cursor);
    assert.equal(first.length, 1);
    assert.equal(first[0].status, "pending");

    addMessage(crush, "m2", "s1", TOOL_RESULT_PART, 1_101);
    const second = pollCrushToolLog(db, nid, { foldPath: fold, narrativeCreatedAtMs: 0 }, cursor);
    assert.equal(second.length, 1);
    assert.equal(second[0].status, "completed");
    assert.equal(second[0].duration_ms, 1_001);

    const rows = readToolUseWindow(db, nid);
    assert.equal(rows.length, 1, "the call and its result are one row, not two");
    assert.equal(rows[0].source, "session_log");
  });

  // Every write bumps rev, and rev is the client's sync cursor — so re-writing
  // a settled row would re-push it to every connected client on every poll,
  // forever.
  it("writes nothing when nothing changed", () => {
    const fold = crushFold();
    const crush = seedCrush(fold);
    const db = createTestDb();
    const nid = seedNarrative(db, fold, 1_000_000);
    addSession(crush, "s1", 1_000);
    addMessage(crush, "m1", "s1", TOOL_CALL_PART, 1_100);
    addMessage(crush, "m2", "s1", TOOL_RESULT_PART, 1_100);

    const cursor = newCrushLogCursor();
    assert.equal(
      pollCrushToolLog(db, nid, { foldPath: fold, narrativeCreatedAtMs: 0 }, cursor).length,
      2,
      "the call and its completion are both new the first time",
    );
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(
        pollCrushToolLog(db, nid, { foldPath: fold, narrativeCreatedAtMs: 0 }, cursor),
        [],
      );
    }
    assert.equal(readToolUseWindow(db, nid)[0].rev, 2, "rev stopped moving once the row settled");
  });

  // crush timestamps have one-second resolution, so a strict `>` cursor would
  // skip anything written in the same second as the last message read.
  it("does not skip a message written in the same second as the cursor", () => {
    const fold = crushFold();
    const crush = seedCrush(fold);
    const db = createTestDb();
    const nid = seedNarrative(db, fold, 1_000_000);
    addSession(crush, "s1", 1_000);
    addMessage(crush, "m1", "s1", TOOL_CALL_PART, 1_100);

    const cursor = newCrushLogCursor();
    pollCrushToolLog(db, nid, { foldPath: fold, narrativeCreatedAtMs: 0 }, cursor);
    // Same second, different message — the very next tool call in a fast turn.
    addMessage(
      crush,
      "m2",
      "s1",
      TOOL_CALL_PART.replace(/bash_88/g, "bash_89"),
      1_100,
    );
    const next = pollCrushToolLog(db, nid, { foldPath: fold, narrativeCreatedAtMs: 0 }, cursor);
    assert.equal(next.length, 1);
    assert.equal(next[0].dedup_key, "bash_89");
  });

  it("captures a sub-agent's calls and nests them under the call that spawned it", () => {
    const fold = crushFold();
    const crush = seedCrush(fold);
    const db = createTestDb();
    const nid = seedNarrative(db, fold, 1_000_000);
    addSession(crush, "s1", 1_000);
    // crush encodes the spawning tool call in a sub-agent session's own id.
    addSession(crush, "msg7$$agentic_fetch_68", 1_050, "s1");
    addSession(crush, "title-s1", 1_060, "s1");
    addMessage(crush, "m1", "msg7$$agentic_fetch_68", TOOL_CALL_PART, 1_100);
    addMessage(crush, "m2", "title-s1", TOOL_CALL_PART.replace(/bash_88/g, "title_1"), 1_100);

    const written = pollCrushToolLog(
      db,
      nid,
      { foldPath: fold, sessionIds: ["s1"], narrativeCreatedAtMs: 0 },
      newCrushLogCursor(),
    );
    assert.equal(written.length, 1, "the title-generation session is not a conversation");
    assert.equal(written[0].parent_id, "agentic_fetch_68");
  });

  // This poller ticks every couple of seconds, so almost all of its work is
  // avoiding work: an unchanged log is never opened at all.
  it("does not open the log when nothing has changed", () => {
    const fold = crushFold();
    const crush = seedCrush(fold);
    const db = createTestDb();
    const nid = seedNarrative(db, fold, 1_000_000);
    addSession(crush, "s1", 1_000);
    addMessage(crush, "m1", "s1", TOOL_CALL_PART, 1_100);

    const cursor = newCrushLogCursor();
    pollCrushToolLog(db, nid, { foldPath: fold, narrativeCreatedAtMs: 0 }, cursor);
    const signature = cursor.signature;
    assert.ok(signature, "a log that was read leaves a signature to compare against");

    // Break the log so that opening it would throw. A poll that still returns
    // cleanly is a poll that never opened it.
    const table = new Database(crushDbPath(fold));
    table.exec("ALTER TABLE messages RENAME TO messages_moved");
    table.close();
    // Restore the signature: the rename changed the file, and the point of the
    // test is the unchanged case.
    cursor.signature = crushLogSignature(fold);
    assert.deepEqual(
      pollCrushToolLog(db, nid, { foldPath: fold, narrativeCreatedAtMs: 0 }, cursor),
      [],
    );
  });

  it("notices a write that lands only in the WAL sibling", () => {
    const fold = crushFold();
    const crush = seedCrush(fold);
    crush.pragma("journal_mode = WAL");
    const db = createTestDb();
    const nid = seedNarrative(db, fold, 1_000_000);
    addSession(crush, "s1", 1_000);

    const cursor = newCrushLogCursor();
    pollCrushToolLog(db, nid, { foldPath: fold, narrativeCreatedAtMs: 0 }, cursor);

    // In WAL mode this write lands in <db>-wal and may not move the main
    // file's mtime at all — a gate that stats only the database would go blind
    // during exactly the burst of activity it exists to catch.
    addMessage(crush, "m1", "s1", TOOL_CALL_PART, 1_100);
    const written = pollCrushToolLog(db, nid, { foldPath: fold, narrativeCreatedAtMs: 0 }, cursor);
    assert.equal(written.length, 1);
    assert.equal(written[0].status, "pending");
  });

  it("degrades to silence when there is no crush log, or it is unreadable", () => {
    const db = createTestDb();
    const bare = mkdtempSync(join(tmpdir(), "brane-crush-"));
    const nid = seedNarrative(db, bare, 1_000_000);
    assert.deepEqual(
      pollCrushToolLog(db, nid, { foldPath: bare, narrativeCreatedAtMs: 0 }, newCrushLogCursor()),
      [],
    );

    // A file that exists but is not a crush database at all.
    const fold = crushFold();
    new Database(crushDbPath(fold)).exec("CREATE TABLE unrelated (x TEXT)");
    assert.deepEqual(
      pollCrushToolLog(db, nid, { foldPath: fold, narrativeCreatedAtMs: 0 }, newCrushLogCursor()),
      [],
    );
  });
});
