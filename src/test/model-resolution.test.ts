import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb } from "./helpers.js";
import { appendEvent } from "../db/events.js";
import { getAgentAdapter } from "../agents.js";
import { resolvePendingTraces } from "../memory/index.js";

// meta.session / meta.model per-message provenance resolution (claude).
//
// claude's resolveTrace and the runIndex resolver read the agent's own
// session JSONL under ~/.claude/projects/<cwd-encoded>/<id>.jsonl. We sandbox
// HOME to a temp dir, fabricate a session log with two assistant turns on
// *different* models (proving per-message granularity), and assert both the
// adapter and the DB-level backfill resolve correctly.

const SESSION = "11111111-2222-3333-4444-555555555555";
const FOLD = "/work/proj"; // absolute fold path (stored verbatim in narratives)
const UUID_A = "aaaaaaaa-0000-0000-0000-000000000001";
const UUID_B = "bbbbbbbb-0000-0000-0000-000000000002";
const SAY_A = "First narration, on the older model.";
const SAY_B = "Second narration, after a /model switch.";

let origHome: string | undefined;
let homeDir: string;

function assistantLine(uuid: string, model: string, say: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    message: {
      model,
      role: "assistant",
      content: [{ type: "tool_use", name: "mcp__brane__narrate", input: { say } }],
    },
  });
}

before(() => {
  origHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), "brane-home-"));
  process.env.HOME = homeDir;

  const projectDir = join(homeDir, ".claude", "projects", FOLD.replace(/\//g, "-"));
  mkdirSync(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", uuid: "user-0", message: { role: "user", content: "hi" } }),
    assistantLine(UUID_A, "claude-opus-4-7", SAY_A),
    assistantLine(UUID_B, "claude-opus-4-8", SAY_B),
  ];
  writeFileSync(join(projectDir, `${SESSION}.jsonl`), lines.join("\n") + "\n");
});

after(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
});

describe("claude resolveTrace", () => {
  const claude = getAgentAdapter("claude");

  it("declares per-message granularity", () => {
    assert.equal(claude.modelGranularity, "per-message");
  });

  it("resolves offset (uuid) + model by exact say match, per message", () => {
    const a = claude.resolveTrace!({ sessionId: SESSION, foldPath: FOLD, content: SAY_A });
    assert.deepEqual(a, { offset: UUID_A, model: "claude-opus-4-7" });
    const b = claude.resolveTrace!({ sessionId: SESSION, foldPath: FOLD, content: SAY_B });
    assert.deepEqual(b, { offset: UUID_B, model: "claude-opus-4-8" });
  });

  it("returns null on no content match and on a missing session file", () => {
    assert.equal(claude.resolveTrace!({ sessionId: SESSION, foldPath: FOLD, content: "never said" }), null);
    assert.equal(claude.resolveTrace!({ sessionId: "no-such-session", foldPath: FOLD, content: SAY_A }), null);
  });
});

describe("resolvePendingTraces (runIndex backfill)", () => {
  function seedNarrative(db: ReturnType<typeof createTestDb>, id: string, opts: {
    agent_type?: string;
    agent_session_id?: string | null;
  } = {}) {
    db.prepare(
      `INSERT INTO narratives (id, brane_id, fold_path, agent_type, role, created_at, status, agent_session_id)
       VALUES (?, 'brane-test', ?, ?, 'worker', ?, 'active', ?)`,
    ).run(id, FOLD, opts.agent_type ?? "claude", Date.now(), opts.agent_session_id ?? null);
  }

  it("stamps meta.session + meta.model on self narrations, idempotently", async () => {
    const db = createTestDb();
    seedNarrative(db, "claude-A", { agent_session_id: SESSION });
    appendEvent(db, "claude-A", "narration", { content: SAY_B, source: "claude-A" });

    const n = await resolvePendingTraces(db);
    assert.equal(n, 1);

    const row = db.prepare("SELECT meta FROM events WHERE narrative_id = 'claude-A' AND seq = 1").get() as { meta: string };
    const meta = JSON.parse(row.meta);
    assert.equal(meta.model, "claude-opus-4-8");
    assert.deepEqual(meta.session, { id: SESSION, offset: UUID_B });

    // Second pass resolves nothing (gated on absence of meta.model).
    assert.equal(await resolvePendingTraces(db), 0);
  });

  it("attributes a FOREIGN narration to its author's session (via source)", async () => {
    const db = createTestDb();
    // Author A (claude, has the session) narrates into host B (any agent).
    seedNarrative(db, "claude-A", { agent_session_id: SESSION });
    seedNarrative(db, "goose-B", { agent_type: "goose" });
    appendEvent(db, "goose-B", "agent_signal", { content: SAY_A, source: "claude-A" });

    assert.equal(await resolvePendingTraces(db), 1);
    const row = db.prepare("SELECT meta FROM events WHERE narrative_id = 'goose-B' AND seq = 1").get() as { meta: string };
    const meta = JSON.parse(row.meta);
    assert.equal(meta.model, "claude-opus-4-7"); // author's model, not host's
    assert.equal(meta.session.id, SESSION);
  });

  it("uses live-stamped meta.session.id when present (no agent_session_id needed)", async () => {
    const db = createTestDb();
    seedNarrative(db, "claude-A", { agent_session_id: null });
    appendEvent(db, "claude-A", "narration", {
      content: SAY_A,
      source: "claude-A",
      meta: { session: { id: SESSION } },
    });
    assert.equal(await resolvePendingTraces(db), 1);
    const row = db.prepare("SELECT meta FROM events WHERE narrative_id = 'claude-A' AND seq = 1").get() as { meta: string };
    assert.equal(JSON.parse(row.meta).model, "claude-opus-4-7");
  });

  it("skips unsupported agents and unresolvable sessions, leaving meta unset", async () => {
    const db = createTestDb();
    // goose has no resolveTrace → skipped.
    seedNarrative(db, "goose-C", { agent_type: "goose", agent_session_id: "x" });
    appendEvent(db, "goose-C", "narration", { content: SAY_A, source: "goose-C" });
    // claude but no session id discoverable → skipped.
    seedNarrative(db, "claude-D", { agent_session_id: null });
    appendEvent(db, "claude-D", "narration", { content: SAY_A, source: "claude-D" });

    assert.equal(await resolvePendingTraces(db), 0);
    const g = db.prepare("SELECT meta FROM events WHERE narrative_id = 'goose-C' AND seq = 1").get() as { meta: string | null };
    assert.equal(g.meta, null);
  });

  it("parses each session transcript once for many same-session events (memoized)", async () => {
    const db = createTestDb();
    seedNarrative(db, "claude-A", { agent_session_id: SESSION });
    // Two pending events, both authored in the same session transcript.
    appendEvent(db, "claude-A", "narration", { content: SAY_A, source: "claude-A" });
    appendEvent(db, "claude-A", "narration", { content: SAY_B, source: "claude-A" });

    // Spy on the claude adapter's transcript parse to count file reads.
    const claude = getAgentAdapter("claude");
    const orig = claude.buildTraceIndex!.bind(claude);
    let parses = 0;
    claude.buildTraceIndex = (opts) => {
      parses++;
      return orig(opts);
    };
    try {
      assert.equal(await resolvePendingTraces(db), 2); // both resolved
      assert.equal(parses, 1); // …from a single transcript parse
    } finally {
      claude.buildTraceIndex = orig;
    }

    const a = JSON.parse((db.prepare("SELECT meta FROM events WHERE narrative_id='claude-A' AND seq=1").get() as { meta: string }).meta);
    const b = JSON.parse((db.prepare("SELECT meta FROM events WHERE narrative_id='claude-A' AND seq=2").get() as { meta: string }).meta);
    assert.equal(a.model, "claude-opus-4-7");
    assert.equal(b.model, "claude-opus-4-8");
  });

  it("skips a corrupt-meta row without aborting the pass (json_valid gate)", async () => {
    const db = createTestDb();
    seedNarrative(db, "claude-A", { agent_session_id: SESSION });
    // A resolvable event (seq 1) plus one with corrupt meta written directly
    // (seq 2). Without the json_valid CASE guard, json_extract on the corrupt
    // blob would throw and abort the whole SELECT.
    appendEvent(db, "claude-A", "narration", { content: SAY_B, source: "claude-A" });
    appendEvent(db, "claude-A", "narration", { content: SAY_A, source: "claude-A" });
    db.prepare("UPDATE events SET meta = '{bad json' WHERE narrative_id = 'claude-A' AND seq = 2").run();

    // The pass completes; the corrupt row is excluded, the valid one resolves.
    assert.equal(await resolvePendingTraces(db), 1);
    const ok = db.prepare("SELECT meta FROM events WHERE narrative_id = 'claude-A' AND seq = 1").get() as { meta: string };
    assert.equal(JSON.parse(ok.meta).model, "claude-opus-4-8");
  });
});
