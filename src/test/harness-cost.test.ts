import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import {
  discoverGooseSession,
  readGooseUsage,
  discoverCrushSession,
  readCrushUsage,
  readClineSessionUsage,
  readCopilotUsage,
  getAgentAdapter,
} from "../agents.js";
import { maybeCaptureSessionId, getSessionIds } from "../daemon/server.js";
import { priceMessage } from "../cost/pricing.js";
import type { MessageUsage } from "../cost/pricing.js";

const scratch = () => mkdtempSync(join(tmpdir(), "brane-harness-cost-"));

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe("Fireworks K3 pricing", () => {
  const oneMEach: MessageUsage = {
    input: 1e6,
    output: 1e6,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };

  it("resolves the fast router to the fast tier, not the base tier", () => {
    // Regression guard for the table's insertion order: priceForModel returns
    // the FIRST substring hit, and "accounts/fireworks/routers/kimi-k3-fast"
    // contains "kimi-k3" too. Listed the wrong way round this silently prices
    // the fast router a third cheap, with nothing to notice it by.
    assert.equal(priceMessage("accounts/fireworks/routers/kimi-k3-fast", oneMEach), 4.5 + 22.5);
    assert.equal(priceMessage("accounts/fireworks/models/kimi-k3", oneMEach), 3 + 15);
  });

  it("prices cached input at Fireworks' 0.1x rate", () => {
    const cacheOnly: MessageUsage = {
      input: 0,
      output: 0,
      cacheRead: 1e6,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    };
    // $0.30/M against a $3.00/M input price.
    assert.equal(priceMessage("accounts/fireworks/models/kimi-k3", cacheOnly), 0.3);
  });
});

// ---------------------------------------------------------------------------
// goose — one shared SQLite store, a usage ledger brane has to price itself
// ---------------------------------------------------------------------------

function gooseFixture(): string {
  const path = join(scratch(), "sessions.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', working_dir TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      created_timestamp INTEGER NOT NULL, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      cost REAL, cost_source TEXT, is_compaction INTEGER DEFAULT 0
    );
  `);
  const sess = db.prepare("INSERT INTO sessions (id, name, working_dir, created_at) VALUES (?,?,?,?)");
  sess.run("20260816_1", "goose-alpha", "/work/fold", "2026-08-16 15:00:00");
  sess.run("20260816_2", "goose-beta", "/work/fold", "2026-08-16 15:25:32");
  // A second row sharing goose-alpha's name, created later — `name` carries no
  // UNIQUE constraint, so newest must win.
  sess.run("20260817_1", "goose-alpha", "/work/fold", "2026-08-17 09:00:00");

  const led = db.prepare(
    `INSERT INTO usage_ledger
       (session_id, created_timestamp, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction)
     VALUES (?,?,?,?,?,?,?,NULL,NULL,?)`,
  );
  // input_tokens is INCLUSIVE of cache_read_tokens, as goose records it.
  led.run("20260816_2", 1, "accounts/fireworks/models/kimi-k3", 100_000, 1_000, 90_000, 0, 0);
  led.run("20260816_2", 2, "accounts/fireworks/models/kimi-k3", 50_000, 500, 40_000, 0, 1); // compaction
  led.run("20260816_2", 3, "accounts/fireworks/routers/kimi-k3-fast", 10_000, 200, 0, 0, 0);
  db.close();
  return path;
}

describe("goose session discovery", () => {
  it("looks the session up by the narrative id brane launched it under", () => {
    const path = gooseFixture();
    assert.equal(discoverGooseSession(path, "goose-beta"), "20260816_2");
  });

  it("takes the newest row when a name somehow repeats", () => {
    const path = gooseFixture();
    assert.equal(discoverGooseSession(path, "goose-alpha"), "20260817_1");
  });

  it("returns undefined for an unknown narrative or an unreadable store", () => {
    const path = gooseFixture();
    assert.equal(discoverGooseSession(path, "goose-nobody"), undefined);
    assert.equal(discoverGooseSession(join(scratch(), "absent.db"), "goose-beta"), undefined);
  });
});

describe("goose usage reading", () => {
  it("prices the ledger, subtracting cache reads out of the inclusive input", () => {
    const reading = readGooseUsage(gooseFixture(), "20260816_2")!;
    // Rows 1+2 are base-tier kimi-k3, row 3 is the fast router — priced
    // separately because the reader groups by model.
    const base = priceMessage("accounts/fireworks/models/kimi-k3", {
      input: 100_000 - 90_000 + (50_000 - 40_000),
      output: 1_500,
      cacheRead: 130_000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });

    const fast = priceMessage("accounts/fireworks/routers/kimi-k3-fast", {
      input: 10_000,
      output: 200,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });

    assert.equal(reading.amount, Math.round((base + fast) * 1e4) / 1e4);
    assert.equal(reading.unit, "USD");
  });

  it("counts compaction rows — they are real spend", () => {
    // Row 2 is the only is_compaction row; dropping it would cost this much.
    const reading = readGooseUsage(gooseFixture(), "20260816_2")!;
    const withoutCompaction = priceMessage("accounts/fireworks/models/kimi-k3", {
      input: 10_000,
      output: 500,
      cacheRead: 40_000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    assert.ok(withoutCompaction > 0);
    assert.ok(reading.amount > withoutCompaction);
  });

  it("reports goose's own inclusive input count in the token breakdown", () => {
    const reading = readGooseUsage(gooseFixture(), "20260816_2")!;
    assert.deepEqual(reading.tokens, {
      input: 160_000,
      output: 1_700,
      cacheRead: 130_000,
      cacheWrite: 0,
    });
  });

  it("returns null for an unknown session and a missing database", () => {
    const path = gooseFixture();
    assert.equal(readGooseUsage(path, "no-such-session"), null);
    assert.equal(readGooseUsage(join(scratch(), "absent.db"), "20260816_2"), null);
  });
});

// ---------------------------------------------------------------------------
// copilot — one local SQLite store with nano-AIU billing
// ---------------------------------------------------------------------------

function copilotFixture(): string {
  const path = join(scratch(), "session-store.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE assistant_usage_events (
      session_id TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_nano_aiu INTEGER
    );
  `);
  const usage = db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?)");
  usage.run("copilot-1", 100, 20, 80, 5, 1_250_000_000);
  usage.run("copilot-1", 200, 30, 150, 10, 2_500_000_000);
  db.close();
  return path;
}

describe("copilot usage", () => {
  it("converts nano AIU to AIC and retains Copilot's token breakdown", () => {
    assert.deepEqual(readCopilotUsage(copilotFixture(), "copilot-1"), {
      amount: 3.75,
      unit: "AIC",
      tokens: { input: 300, output: 50, cacheRead: 230, cacheWrite: 15 },
    });
  });
});

// ---------------------------------------------------------------------------
// crush — per-fold store, cost pre-computed by the harness, second-precision
// ---------------------------------------------------------------------------

const SPAWN_MS = 1786899518031; // narrative created_at, milliseconds
const SPAWN_S = 1786899518;

function crushFixture(createdAt: (s: number) => number = (s) => s): string {
  const path = join(scratch(), "crush.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0.0,
      updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  const ins = db.prepare(
    "INSERT INTO sessions (id, parent_session_id, title, prompt_tokens, completion_tokens, cost, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  const at = (s: number) => createdAt(s);
  // Predates the spawn — a previous narrative sharing this fold.
  ins.run("older-session", null, "old", 10, 10, 9.99, at(SPAWN_S - 500), at(SPAWN_S - 500));
  // Ours.
  ins.run("real-session", null, "ours", 67422, 118, 1.25, at(SPAWN_S + 2), at(SPAWN_S + 2));
  // Synthetic children of ours: an agent-tool session and a title generator.
  ins.run("abc$$agentic_fetch_68", "real-session", "sub", 19960, 1335, 0.5, at(SPAWN_S + 9), at(SPAWN_S + 9));
  ins.run("title-real-session", null, "titler", 100, 20, 0.25, at(SPAWN_S + 3), at(SPAWN_S + 3));
  // A later unrelated session in the same fold.
  ins.run("newer-session", null, "later", 5, 5, 7.5, at(SPAWN_S + 9999), at(SPAWN_S + 9999));
  db.close();
  return path;
}

describe("crush session discovery", () => {
  it("normalizes a millisecond `since` against crush's second-precision column", () => {
    // The trap this exists for: crush's schema annotates created_at as
    // milliseconds but writes seconds, so comparing the narrative's ms spawn
    // time directly matches nothing at all — forever, and silently.
    assert.equal(discoverCrushSession(crushFixture(), SPAWN_MS), "real-session");
  });

  it("works too if crush ever starts honouring its own millisecond comment", () => {
    assert.equal(discoverCrushSession(crushFixture((s) => s * 1000), SPAWN_MS), "real-session");
  });

  it("takes the earliest session after the spawn, not the newest in the fold", () => {
    assert.equal(discoverCrushSession(crushFixture(), SPAWN_MS), "real-session");
  });

  it("skips crush's synthetic title and agent-tool session rows", () => {
    // With `since` dropped, the earliest real row wins and neither the
    // `title-` nor the `$$` row is ever a candidate.
    assert.equal(discoverCrushSession(crushFixture()), "older-session");
  });

  it("returns undefined when nothing started after the spawn, or the db is absent", () => {
    assert.equal(discoverCrushSession(crushFixture(), (SPAWN_S + 99999) * 1000), undefined);
    assert.equal(discoverCrushSession(join(scratch(), "absent.db"), SPAWN_MS), undefined);
  });
});

describe("crush usage reading", () => {
  it("sums the session's own cost with its agent-tool and title children", () => {
    const reading = readCrushUsage(crushFixture(), "real-session")!;
    assert.equal(reading.amount, 1.25 + 0.5 + 0.25);
    assert.equal(reading.unit, "USD");
  });

  it("omits tokens — crush's columns are last-request snapshots, not totals", () => {
    // prompt_tokens/completion_tokens are overwritten per request to gauge
    // context size, so surfacing them as a session total would be a lie.
    assert.equal(readCrushUsage(crushFixture(), "real-session")!.tokens, undefined);
  });

  it("reports a genuine $0 rather than null when the model is unpriced", () => {
    // Crush defaults a custom provider's models to zero cost, so $0 means
    // "config declares no rates", which is different from "unreadable".
    const path = join(scratch(), "crush.db");
    const db = new Database(path);
    db.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, cost REAL NOT NULL DEFAULT 0.0, created_at INTEGER NOT NULL)",
    );
    db.prepare("INSERT INTO sessions (id, parent_session_id, cost, created_at) VALUES ('s',NULL,0.0,1)").run();
    db.close();
    assert.deepEqual(readCrushUsage(path, "s"), { amount: 0, unit: "USD" });
  });

  it("returns null for an unknown session and a missing database", () => {
    assert.equal(readCrushUsage(crushFixture(), "no-such-session"), null);
    assert.equal(readCrushUsage(join(scratch(), "absent.db"), "real-session"), null);
  });
});

// ---------------------------------------------------------------------------
// cline — per-narrative store, cost pre-computed per message
// ---------------------------------------------------------------------------

function clineLog(
  dir: string,
  sessionId: string,
  messages: Array<Record<string, unknown>>,
): string {
  const sdir = join(dir, sessionId);
  mkdirSync(sdir, { recursive: true });
  const file = join(sdir, `${sessionId}.messages.json`);
  writeFileSync(file, JSON.stringify({ sessionId, messages }));
  return file;
}

const msg = (id: string, cost: number, input = 100, output = 10, cacheRead = 0) => ({
  id,
  role: "assistant",
  metrics: { cost, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0 },
});

describe("cline usage reading", () => {
  it("sums per-message cost and the full token breakdown", () => {
    const file = clineLog(scratch(), "1786899559349_f9dpo", [
      { id: "u1", role: "user" }, // no metrics — skipped
      msg("m1", 0.25, 1000, 30, 900),
      msg("m2", 0.5, 2000, 40, 1800),
    ]);
    assert.deepEqual(readClineSessionUsage(file), {
      amount: 0.75,
      unit: "USD",
      tokens: { input: 3000, output: 70, cacheRead: 2700, cacheWrite: 0 },
    });
  });

  it("counts an errored turn's cost, which metadata.totalCost would drop", () => {
    // Cline accumulates metadata.totalCost only on the turn-success path, so a
    // session with a failed turn persists that message's metrics but not its
    // cost. Summing the messages is what makes the badge whole.
    const file = clineLog(scratch(), "sess-err", [msg("ok", 0.25), msg("failed", 0.28)]);
    assert.equal(readClineSessionUsage(file)!.amount, 0.53);
  });

  it("dedupes a message id repeated within one file", () => {
    const file = clineLog(scratch(), "sess-dup", [msg("m1", 0.25), msg("m1", 0.25), msg("m2", 0.5)]);
    assert.equal(readClineSessionUsage(file)!.amount, 0.75);
  });

  it("returns null for a missing or malformed log", () => {
    const dir = scratch();
    assert.equal(readClineSessionUsage(join(dir, "gone.messages.json")), null);
    const bad = join(dir, "bad.messages.json");
    writeFileSync(bad, "{not json");
    assert.equal(readClineSessionUsage(bad), null);
  });
});

describe("cline adapter over its private per-narrative store", () => {
  // The store lives at a fixed /tmp/brane-cline-<nid> path (brane writes it at
  // spawn), so these use a throwaway narrative id under the same root.
  const nid = `cline-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionsDir = join("/tmp", `brane-cline-${nid}`, "data", "sessions");
  const cline = getAgentAdapter("cline");

  it("discovers the newest session in the narrative's own directory", () => {
    clineLog(sessionsDir, "1786898522696_gg36a", []);
    clineLog(sessionsDir, "1786899559349_f9dpo", [msg("m1", 2.0)]);
    assert.equal(cline.discoverSessionId("/work/fold", 0, nid), "1786899559349_f9dpo");
  });

  it("sums sessions present on disk that brane never recorded", () => {
    // Every dir under the narrative's private store is that narrative's spend.
    // The five dead 401-revive sessions observed live are exactly this case:
    // real launches whose ids the daemon never captured.
    clineLog(sessionsDir, "1786898667854_rf6n9", [msg("m2", 0.5)]);
    const reading = cline.readUsageMany!({ sessionIds: [], foldPath: "/work/fold", narrativeId: nid });
    assert.equal(reading!.amount, 2.5);
  });

  it("excludes sessions that predate `since`, so a revive can't re-adopt the incumbent", () => {
    // Cline ids carry their own start time (`<epochMs>_<rand5>`). Without this
    // filter, discovery in the window between a revive and the new session dir
    // appearing returns the previous session — which then reads as the
    // successor and pins the pointer to a session that stopped spending.
    const afterEverything = 1786899559350;
    assert.equal(cline.discoverSessionId("/work/fold", afterEverything, nid), undefined);
    assert.equal(cline.discoverSessionId("/work/fold", 1786899559349, nid), "1786899559349_f9dpo");
  });

  it("still honours recorded ids, and needs a narrative id to read anything", () => {
    const both = cline.readUsageMany!({
      sessionIds: ["1786899559349_f9dpo"],
      foldPath: "/work/fold",
      narrativeId: nid,
    });
    assert.equal(both!.amount, 2.5); // union, not double-counted
    assert.equal(cline.readUsageMany!({ sessionIds: [], foldPath: "/work/fold" }), null);
    assert.equal(cline.readUsage!({ sessionId: "x", foldPath: "/work/fold" }), null);
  });
});

// ---------------------------------------------------------------------------
// Revive re-capture
// ---------------------------------------------------------------------------

describe("maybeCaptureSessionId across revives", () => {
  function seed(id: string, agent: string, sessionId: string | null): ReturnType<typeof createTestDb> {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status, fold_path, agent_session_id)
       VALUES (?, 'brane-test', ?, 'worker', 1000, 'active', '~/work', ?)`,
    ).run(id, agent, sessionId);
    return db;
  }
  const restart = (db: ReturnType<typeof createTestDb>, id: string, seq: number, time: number) =>
    db
      .prepare("INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?,?,?,'restarted','r')")
      .run(id, seq, time);

  it("captures on the first bind, anchored at the narrative's spawn time", () => {
    const db = seed("crush-a", "crush", null);
    const seen: Array<number | undefined> = [];
    const got = maybeCaptureSessionId(db, "crush-a", "crush", "~/work", 1000, null, (_fp, since) => {
      seen.push(since);
      return "sess-1";
    });
    assert.equal(got, "sess-1");
    assert.deepEqual(seen, [1000]);
    assert.deepEqual(getSessionIds(db, "crush-a"), ["sess-1"]);
  });

  it("leaves a captured pointer alone while the narrative has never been revived", () => {
    const db = seed("crush-b", "crush", "sess-1");
    let called = false;
    const got = maybeCaptureSessionId(db, "crush-b", "crush", "~/work", 1000, "sess-1", () => {
      called = true;
      return "sess-2";
    });
    assert.equal(got, undefined);
    assert.equal(called, false, "discovery must not even run for a settled pointer");
  });

  it("re-anchors at the last revive and adopts the session that launch minted", () => {
    // Crush has no resume and cline writes a fresh session dir per start, so
    // without this every post-revive dollar goes unread against a pointer that
    // names a session which stopped spending.
    const db = seed("crush-c", "crush", "sess-1");
    restart(db, "crush-c", 1, 5000);
    restart(db, "crush-c", 2, 9000);
    const seen: Array<number | undefined> = [];
    const got = maybeCaptureSessionId(db, "crush-c", "crush", "~/work", 1000, "sess-1", (_fp, since) => {
      seen.push(since);
      return "sess-3";
    });
    assert.equal(got, "sess-3");
    assert.deepEqual(seen, [9000], "anchored at the latest revive, not the spawn");
    // Both sessions are retained, so cost spans the whole narrative.
    assert.deepEqual(getSessionIds(db, "crush-c"), ["sess-1", "sess-3"]);
  });

  it("is idempotent when the agent resumed its session in place", () => {
    // Goose re-attaches to the row named after the narrative, so discovery
    // returns the same id and nothing is written.
    const db = seed("goose-d", "goose", "20260816_2");
    restart(db, "goose-d", 1, 5000);
    const got = maybeCaptureSessionId(db, "goose-d", "goose", "~/work", 1000, "20260816_2", () => "20260816_2");
    assert.equal(got, undefined);
    assert.deepEqual(getSessionIds(db, "goose-d"), ["20260816_2"]);
  });

  it("does not let the discovery cache pin a stale pointer after a revive", () => {
    // Exercises the real (uninjected) discovery path, so the production cache
    // is live — the injected-`discover` tests above bypass it by design.
    // Sequence: revive, then a tick landing before the new session dir exists,
    // then the dir appears. The first tick must not cache the incumbent
    // against the new anchor, or the successor is never adopted.
    const nid = `cline-cache-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = join("/tmp", `brane-cline-${nid}`, "data", "sessions");
    const before = "1000000000000_aaaaa";
    const after = "1000000009000_bbbbb";
    clineLog(dir, before, [msg("m1", 1)]);

    const db = seed(nid, "cline", before);
    restart(db, nid, 1, 1000000005000);

    // Tick one: only the pre-revive session exists.
    assert.equal(
      maybeCaptureSessionId(db, nid, "cline", "~/work", 1, before),
      undefined,
      "the incumbent is not re-adopted as its own successor",
    );

    // Tick two: cline has now written the session this revive minted.
    clineLog(dir, after, [msg("m2", 2)]);
    assert.equal(maybeCaptureSessionId(db, nid, "cline", "~/work", 1, before), after);
    assert.deepEqual(getSessionIds(db, nid), [before, after]);
  });

  it("ignores agents whose session id the daemon assigns or does not own", () => {
    const db = seed("claude-e", "claude", null);
    assert.equal(
      maybeCaptureSessionId(db, "claude-e", "claude", "~/work", 1000, null, () => "nope"),
      undefined,
    );
  });
});
