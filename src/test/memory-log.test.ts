import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { appendEvent } from "../db/events.js";
import { parseDuration, timeSince } from "../commands/memory.js";

// Helper to insert a narrative row
function insertNarrative(
  db: ReturnType<typeof createTestDb>,
  id: string,
  opts: {
    agent_type?: string;
    role?: string;
    status?: string;
    title?: string;
    summary?: string;
    created_at?: number;
  } = {},
) {
  db.prepare(
    `INSERT INTO narratives (id, brane_id, agent_type, role, status, title, summary, created_at)
     VALUES (?, 'brane-test', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.agent_type ?? "claude",
    opts.role ?? "worker",
    opts.status ?? "active",
    opts.title ?? null,
    opts.summary ?? null,
    opts.created_at ?? Date.now(),
  );
}

// The core log query extracted for testing (mirrors memoryLog's SQL)
function queryLog(
  db: ReturnType<typeof createTestDb>,
  sinceMs: number,
  opts: { status?: string; nids?: Set<string>; limit?: number } = {},
) {
  let sql = `
    SELECT
      n.id,
      n.agent_type,
      n.role,
      n.status,
      n.title,
      n.summary,
      MAX(e.time) as last_activity,
      COUNT(e.seq) as event_count
    FROM narratives n
    JOIN events e ON e.narrative_id = n.id
    WHERE e.time > ?
  `;
  const params: (string | number)[] = [sinceMs];

  if (opts.status) {
    sql += ` AND n.status = ?`;
    params.push(opts.status);
  }

  if (opts.nids) {
    const placeholders = Array.from(opts.nids)
      .map(() => "?")
      .join(", ");
    sql += ` AND n.id IN (${placeholders})`;
    params.push(...opts.nids);
  }

  sql += `
    GROUP BY n.id
    ORDER BY last_activity DESC
    LIMIT ?
  `;
  params.push(opts.limit ?? 20);

  return db.prepare(sql).all(...params) as Array<{
    id: string;
    agent_type: string;
    role: string;
    status: string;
    title: string | null;
    summary: string | null;
    last_activity: number;
    event_count: number;
  }>;
}

describe("parseDuration", () => {
  it("parses milliseconds", () => {
    assert.equal(parseDuration("500ms"), 500);
  });

  it("parses seconds", () => {
    assert.equal(parseDuration("30s"), 30_000);
  });

  it("parses minutes", () => {
    assert.equal(parseDuration("5m"), 5 * 60 * 1000);
  });

  it("parses hours", () => {
    assert.equal(parseDuration("2h"), 2 * 60 * 60 * 1000);
  });

  it("parses days", () => {
    assert.equal(parseDuration("3d"), 3 * 24 * 60 * 60 * 1000);
  });

  it("parses weeks", () => {
    assert.equal(parseDuration("1w"), 7 * 24 * 60 * 60 * 1000);
  });

  it("throws on invalid input", () => {
    assert.throws(() => parseDuration("abc"), /Invalid duration/);
    assert.throws(() => parseDuration("10x"), /Invalid duration/);
    assert.throws(() => parseDuration(""), /Invalid duration/);
  });
});

describe("timeSince", () => {
  it("formats seconds", () => {
    const result = timeSince(Date.now() - 30_000);
    assert.match(result, /^\d+s ago$/);
  });

  it("formats minutes", () => {
    const result = timeSince(Date.now() - 5 * 60 * 1000);
    assert.match(result, /^\d+m ago$/);
  });

  it("formats hours", () => {
    const result = timeSince(Date.now() - 3 * 60 * 60 * 1000);
    assert.match(result, /^\d+h ago$/);
  });

  it("formats days", () => {
    const result = timeSince(Date.now() - 2 * 24 * 60 * 60 * 1000);
    assert.match(result, /^\d+d ago$/);
  });
});

describe("memory log query", () => {
  it("returns narratives sorted by last activity descending", () => {
    const db = createTestDb();
    const now = Date.now();

    insertNarrative(db, "n-old", { title: "Old one" });
    insertNarrative(db, "n-new", { title: "New one" });

    appendEvent(db, "n-old", "narration", { content: "old event" });
    // Manually insert a newer event for n-new
    db.prepare(
      "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
    ).run("n-new", 1, now + 1000, "narration", "new event");

    const rows = queryLog(db, now - 60_000);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "n-new");
    assert.equal(rows[1].id, "n-old");
  });

  it("filters by time window", () => {
    const db = createTestDb();
    const now = Date.now();

    insertNarrative(db, "n-recent");
    insertNarrative(db, "n-stale");

    // Recent event
    db.prepare(
      "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
    ).run("n-recent", 1, now - 1000, "narration", "recent");

    // Old event (2 hours ago)
    db.prepare(
      "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
    ).run("n-stale", 1, now - 2 * 60 * 60 * 1000, "narration", "stale");

    // Query with 1h window
    const rows = queryLog(db, now - 60 * 60 * 1000);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "n-recent");
  });

  it("filters by status", () => {
    const db = createTestDb();
    const now = Date.now();

    insertNarrative(db, "n-active", { status: "active" });
    insertNarrative(db, "n-ended", { status: "ended" });

    db.prepare(
      "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
    ).run("n-active", 1, now, "narration", "hi");
    db.prepare(
      "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
    ).run("n-ended", 1, now, "narration", "bye");

    const rows = queryLog(db, now - 60_000, { status: "active" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "n-active");
  });

  it("filters by narrative ID set (search)", () => {
    const db = createTestDb();
    const now = Date.now();

    insertNarrative(db, "n-match");
    insertNarrative(db, "n-other");

    db.prepare(
      "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
    ).run("n-match", 1, now, "narration", "relevant");
    db.prepare(
      "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
    ).run("n-other", 1, now, "narration", "unrelated");

    const rows = queryLog(db, now - 60_000, {
      nids: new Set(["n-match"]),
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "n-match");
  });

  it("respects limit", () => {
    const db = createTestDb();
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      insertNarrative(db, `n-${i}`);
      db.prepare(
        "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
      ).run(`n-${i}`, 1, now + i, "narration", `event ${i}`);
    }

    const rows = queryLog(db, now - 60_000, { limit: 3 });
    assert.equal(rows.length, 3);
  });

  it("counts events per narrative", () => {
    const db = createTestDb();
    const now = Date.now();

    insertNarrative(db, "n-busy");

    for (let i = 1; i <= 5; i++) {
      db.prepare(
        "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
      ).run("n-busy", i, now, "narration", `event ${i}`);
    }

    const rows = queryLog(db, now - 60_000);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_count, 5);
  });

  it("includes title and summary from narrative", () => {
    const db = createTestDb();
    const now = Date.now();

    insertNarrative(db, "n-titled", {
      title: "Auth Module",
      summary: "Working on JWT",
    });

    db.prepare(
      "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
    ).run("n-titled", 1, now, "narration", "doing auth");

    const rows = queryLog(db, now - 60_000);
    assert.equal(rows[0].title, "Auth Module");
    assert.equal(rows[0].summary, "Working on JWT");
  });

  it("returns empty when no narratives have recent events", () => {
    const db = createTestDb();
    const now = Date.now();

    insertNarrative(db, "n-old");
    db.prepare(
      "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
    ).run("n-old", 1, now - 48 * 60 * 60 * 1000, "narration", "ancient");

    const rows = queryLog(db, now - 24 * 60 * 60 * 1000);
    assert.equal(rows.length, 0);
  });

  it("LIKE fallback search finds matching narratives", () => {
    const db = createTestDb();
    const now = Date.now();

    insertNarrative(db, "n-auth");
    insertNarrative(db, "n-db");

    db.prepare(
      "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
    ).run("n-auth", 1, now, "narration", "implementing JWT authentication");
    db.prepare(
      "INSERT INTO events (narrative_id, seq, time, type, content) VALUES (?, ?, ?, ?, ?)",
    ).run("n-db", 1, now, "narration", "database migration complete");

    // Simulate LIKE search fallback
    const likeRows = db
      .prepare(
        `SELECT DISTINCT narrative_id FROM events WHERE content LIKE ? LIMIT 1000`,
      )
      .all("%JWT%") as Array<{ narrative_id: string }>;

    const nids = new Set(likeRows.map((r) => r.narrative_id));
    assert.equal(nids.size, 1);
    assert.ok(nids.has("n-auth"));

    const rows = queryLog(db, now - 60_000, { nids });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "n-auth");
  });
});
