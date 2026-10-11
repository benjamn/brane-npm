import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { liveSessionFromRegistryEntry, parsePanePids } from "../claude-live-session.js";
import { maybeFollowLiveSession, getSessionIds } from "../daemon/server.js";
import { appendEvent } from "../db/events.js";

// A registry entry as Claude Code 2.1.281 writes it, trimmed to the fields read.
const entry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid: 50960,
    sessionId: "f3238166-cc8a-4f28-bfd3-7586b2e1abd1",
    cwd: "/Users/op/dev/app",
    startedAt: 1_000_000,
    kind: "interactive",
    tmux: "claude-3j4583pl:@106.%106",
    ...over,
  });
const expect = { narrativeId: "claude-3j4583pl", pid: 50960, foldPath: "/Users/op/dev/app", launchedAt: 1_000_000 };

describe("liveSessionFromRegistryEntry", () => {
  it("reads the session of the narrative's own pane process", () => {
    assert.equal(liveSessionFromRegistryEntry(entry(), expect), "f3238166-cc8a-4f28-bfd3-7586b2e1abd1");
  });

  it("refuses an entry for another pid (a recycled or foreign file)", () => {
    assert.equal(liveSessionFromRegistryEntry(entry({ pid: 50961 }), expect), undefined);
  });

  it("refuses an entry naming another tmux session, prefixes included", () => {
    assert.equal(liveSessionFromRegistryEntry(entry({ tmux: "claude-0i460qwe:@1.%1" }), expect), undefined);
    assert.equal(liveSessionFromRegistryEntry(entry({ tmux: "claude-3j4583pl2:@1.%1" }), expect), undefined);
    assert.equal(liveSessionFromRegistryEntry(entry({ tmux: undefined }), expect), undefined);
  });

  it("refuses an entry from another directory", () => {
    assert.equal(liveSessionFromRegistryEntry(entry({ cwd: "/Users/op/dev/other" }), expect), undefined);
  });

  it("refuses an entry left by the pane's previous process (started before this launch)", () => {
    assert.equal(
      liveSessionFromRegistryEntry(entry({ startedAt: 1_000_000 - 3_600_000 }), expect),
      undefined,
    );
  });

  it("refuses a non-interactive process, and anything unparseable", () => {
    assert.equal(liveSessionFromRegistryEntry(entry({ kind: "print" }), expect), undefined);
    assert.equal(liveSessionFromRegistryEntry("{not json", expect), undefined);
    assert.equal(liveSessionFromRegistryEntry("null", expect), undefined);
    assert.equal(liveSessionFromRegistryEntry(entry({ sessionId: "" }), expect), undefined);
  });
});

describe("parsePanePids", () => {
  it("maps each single-pane session to its pane pid", () => {
    const pids = parsePanePids("claude-a 101\nclaude-b 202\n");
    assert.equal(pids.get("claude-a"), 101);
    assert.equal(pids.get("claude-b"), 202);
  });

  it("maps a multi-pane session to nothing — it has no single agent process", () => {
    const pids = parsePanePids("claude-a 101\nclaude-a 303\nclaude-b 202\n");
    assert.equal(pids.has("claude-a"), false);
    assert.equal(pids.get("claude-b"), 202);
  });

  it("skips malformed lines", () => {
    assert.equal(parsePanePids("\nclaude-a x\nclaude-b 1\n 7\n").size, 0);
  });
});

describe("maybeFollowLiveSession", () => {
  function seed(db: ReturnType<typeof createTestDb>, agent = "claude") {
    db.prepare(
      `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status, fold_path, agent_session_id, session_ids)
       VALUES ('n1', 'brane-test', ?, 'worker', 5000, 'active', '/tmp/fold', 'sess-launch', '["sess-launch"]')`,
    ).run(agent);
  }
  const pointer = (db: ReturnType<typeof createTestDb>) =>
    (db.prepare("SELECT agent_session_id FROM narratives WHERE id = 'n1'").get() as { agent_session_id: string })
      .agent_session_id;

  it("follows a /clear: moves the pointer and keeps the old session in the cost set", () => {
    const db = createTestDb();
    seed(db);
    const got = maybeFollowLiveSession(db, "n1", "claude", "/tmp/fold", 5000, "sess-launch", () => "sess-cleared");
    assert.equal(got, "sess-cleared");
    assert.equal(pointer(db), "sess-cleared");
    assert.deepEqual(getSessionIds(db, "n1"), ["sess-launch", "sess-cleared"]);
  });

  it("is a no-op when the live session is the pointer, or there is no evidence", () => {
    const db = createTestDb();
    seed(db);
    assert.equal(maybeFollowLiveSession(db, "n1", "claude", "/tmp/fold", 5000, "sess-launch", () => "sess-launch"), undefined);
    assert.equal(maybeFollowLiveSession(db, "n1", "claude", "/tmp/fold", 5000, "sess-launch", () => undefined), undefined);
    assert.equal(pointer(db), "sess-launch");
    assert.deepEqual(getSessionIds(db, "n1"), ["sess-launch"]);
  });

  it("leaves capture-strategy agents to maybeCaptureSessionId", () => {
    const db = createTestDb();
    seed(db, "codex");
    assert.equal(maybeFollowLiveSession(db, "n1", "codex", "/tmp/fold", 5000, "sess-launch", () => "other"), undefined);
    assert.equal(pointer(db), "sess-launch");
  });

  it("anchors on the latest revive, not the spawn", () => {
    const db = createTestDb();
    seed(db);
    appendEvent(db, "n1", "restarted", { content: "revived" });
    const restartedAt = (db.prepare("SELECT MAX(time) AS t FROM events WHERE type = 'restarted'").get() as { t: number }).t;
    let seen: number | undefined;
    maybeFollowLiveSession(db, "n1", "claude", "/tmp/fold", 5000, "sess-launch", (o) => {
      seen = o.launchedAt;
      return undefined;
    });
    assert.equal(seen, restartedAt);
  });

  it("passes the fold as an absolute path", () => {
    const db = createTestDb();
    seed(db);
    let fold: string | undefined;
    maybeFollowLiveSession(db, "n1", "claude", "~/dev/app", 5000, "sess-launch", (o) => {
      fold = o.foldPath;
      return undefined;
    });
    assert.ok(fold && !fold.startsWith("~"), fold);
  });
});
