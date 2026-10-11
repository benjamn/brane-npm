import { describe, it } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers.js";
import { adoptBindTokens } from "../db/tokens.js";
import { appendEvent, readEventsSince, readEvents, getMaxSeq } from "../db/events.js";
import { getBraneId } from "../db/schema.js";
import { walkProcessTreeForSession, sessionIdFromRegistryEntry } from "../mcp/server.js";
import {
  resolveMcpBind,
  mintExternalNarrative,
  mintExternalNarrativeWithSecret,
  boundClientCount,
  handleMcpNarrate,
  maybeCaptureSessionId,
  recordSessionId,
  getSessionIds,
} from "../daemon/server.js";
import { buildAgentArgs } from "../commands/spawn.js";
import { getAgentAdapter, discoverCodexSession } from "../agents.js";

// We test the MCP tool logic directly rather than going through the stdio protocol.
// The handlers are internal to server.ts, so we replicate the core logic here
// using the same DB functions the handlers use.

describe("MCP narrate logic", () => {
  it("local narration creates a narration event", () => {
    const db = createTestDb();
    const selfId = "claude-test";

    // Simulate handleNarrate: local narration
    appendEvent(db, selfId, "narration", {
      content: "thinking out loud",
      source: selfId,
    });

    const events = readEventsSince(db, selfId, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "narration");
    assert.equal(events[0].content, "thinking out loud");
    assert.equal(events[0].source, selfId);
  });

  it("foreign narration creates an agent_signal event on target", () => {
    const db = createTestDb();
    const senderId = "claude-sender";
    const targetId = "claude-target";

    // Simulate handleNarrate: foreign narration (agent → agent)
    appendEvent(db, targetId, "agent_signal", {
      content: "hey there",
      source: senderId,
    });

    const events = readEventsSince(db, targetId, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "agent_signal");
    assert.equal(events[0].source, senderId);

    // Sender's narrative should be empty
    const senderEvents = readEventsSince(db, senderId, 0);
    assert.equal(senderEvents.length, 0);
  });

  it("narrate with polling returns events from target narratives", () => {
    const db = createTestDb();

    // Pre-populate some events
    appendEvent(db, "other-agent", "narration", { content: "msg1" });
    appendEvent(db, "other-agent", "narration", { content: "msg2" });

    // Simulate polling via after parameter
    const events = readEventsSince(db, "other-agent", 0, 50);
    const headSeq = getMaxSeq(db, "other-agent");

    assert.equal(events.length, 2);
    assert.equal(headSeq, 2);
  });

  it("meta.session_id is stored on narrative", () => {
    const db = createTestDb();
    const narrativeId = "claude-meta-test";

    // Create narrative row first
    db.prepare(
      `INSERT INTO narratives (id, brane_id, fold_path, agent_type, role, created_at, status)
       VALUES (?, 'brane-test', '~/dev/test', 'claude', 'worker', ?, 'active')`,
    ).run(narrativeId, Date.now());

    // Simulate meta handling in handleNarrate
    const sessionId = "abc-123-session";
    db.prepare("UPDATE narratives SET agent_session_id = ? WHERE id = ?").run(
      sessionId,
      narrativeId,
    );

    const row = db.prepare("SELECT agent_session_id FROM narratives WHERE id = ?").get(
      narrativeId,
    ) as { agent_session_id: string };
    assert.equal(row.agent_session_id, sessionId);
  });
});

describe("MCP listen logic", () => {
  it("returns events after cursor", () => {
    const db = createTestDb();

    appendEvent(db, "n1", "narration", { content: "old" });
    appendEvent(db, "n1", "narration", { content: "new" });

    // Simulate listen with cursor at 1
    const events = readEventsSince(db, "n1", 1, 50);
    assert.equal(events.length, 1);
    assert.equal(events[0].content, "new");
  });

  it("returns empty when no new events", () => {
    const db = createTestDb();

    appendEvent(db, "n1", "narration", { content: "only" });

    const events = readEventsSince(db, "n1", 1, 50);
    assert.equal(events.length, 0);
  });

  it("works with tail only (no after)", () => {
    const db = createTestDb();

    appendEvent(db, "n1", "narration", { content: "first" });
    appendEvent(db, "n1", "narration", { content: "second" });
    appendEvent(db, "n1", "narration", { content: "third" });

    // Simulate listen { tail: 2, wait: false } — after is omitted
    const events = readEvents(db, "n1", { tail: 2 });
    assert.equal(events.length, 2);
    assert.equal(events[0].content, "second");
    assert.equal(events[1].content, "third");
  });

  it("works with before only (no after)", () => {
    const db = createTestDb();

    appendEvent(db, "n1", "narration", { content: "first" });
    appendEvent(db, "n1", "narration", { content: "second" });
    appendEvent(db, "n1", "narration", { content: "third" });

    // Simulate listen { before: 3, wait: false } — after is omitted
    const events = readEvents(db, "n1", { before: 3 });
    assert.equal(events.length, 2);
    assert.equal(events[0].content, "first");
    assert.equal(events[1].content, "second");
  });

  it("works with tail + before (no after)", () => {
    const db = createTestDb();

    for (let i = 0; i < 10; i++) {
      appendEvent(db, "n1", "narration", { content: `msg-${i}` });
    }

    // Simulate listen { tail: 3, before: 8, wait: false } — backward pagination
    const events = readEvents(db, "n1", { tail: 3, before: 8 });
    assert.equal(events.length, 3);
    assert.equal(events[0].content, "msg-4"); // seq 5
    assert.equal(events[1].content, "msg-5"); // seq 6
    assert.equal(events[2].content, "msg-6"); // seq 7
  });

  it("works with no cursor parameters at all", () => {
    const db = createTestDb();

    appendEvent(db, "n1", "narration", { content: "only" });

    // Simulate listen {} — defaults to after: 0 in daemon
    const events = readEvents(db, "n1", {});
    assert.equal(events.length, 1);
    assert.equal(events[0].content, "only");
  });
});

describe("MCP whoami logic", () => {
  it("returns brane_id from meta table", () => {
    const db = createTestDb();
    const braneId = getBraneId(db);
    assert.equal(braneId, "brane-test");
  });
});

describe("session-id process-tree fallback", () => {
  // Fake registry: only the Claude process pid 100 has a session entry.
  const registry: Record<number, string> = { 100: "sess-abc" };
  const lookup = (pid: number) => registry[pid];

  it("finds the session at the immediate parent (zero-hop case)", () => {
    // Bridge's process.ppid is already the Claude pid.
    const getParent = () => 0;
    assert.equal(walkProcessTreeForSession(100, lookup, getParent), "sess-abc");
  });

  it("climbs the parent chain through an intervening shell", () => {
    // bridge(13) → shell(50) → claude(100)
    const parents: Record<number, number> = { 50: 100, 13: 50 };
    const getParent = (pid: number) => parents[pid] ?? 0;
    assert.equal(walkProcessTreeForSession(50, lookup, getParent), "sess-abc");
  });

  it("returns undefined when no ancestor is in the registry", () => {
    const parents: Record<number, number> = { 7: 8, 8: 1 };
    const getParent = (pid: number) => parents[pid] ?? 0;
    assert.equal(walkProcessTreeForSession(7, lookup, getParent), undefined);
  });

  it("stops after maxHops and does not loop forever", () => {
    // A chain that never reaches pid 100; each pid's parent is pid+1.
    let calls = 0;
    const getParent = (pid: number) => {
      calls++;
      return pid + 1;
    };
    assert.equal(walkProcessTreeForSession(200, lookup, getParent, 3), undefined);
    assert.equal(calls, 3); // exactly maxHops climbs, no runaway
  });
});

describe("session registry cwd guard (pid-reuse defense)", () => {
  const fold = "/Users/ben/dev/brane";

  it("returns the sessionId when cwd matches", () => {
    const raw = JSON.stringify({ sessionId: "sess-1", cwd: fold });
    assert.equal(sessionIdFromRegistryEntry(raw, fold), "sess-1");
  });

  it("rejects a stale entry whose cwd is a different directory (recycled pid)", () => {
    const raw = JSON.stringify({ sessionId: "wrong-sess", cwd: "/some/other/project" });
    assert.equal(sessionIdFromRegistryEntry(raw, fold), undefined);
  });

  it("tolerates trailing-slash / unnormalized cwd via resolve()", () => {
    const raw = JSON.stringify({ sessionId: "sess-2", cwd: fold + "/" });
    assert.equal(sessionIdFromRegistryEntry(raw, fold), "sess-2");
  });

  it("returns undefined for an entry missing cwd or sessionId", () => {
    assert.equal(sessionIdFromRegistryEntry(JSON.stringify({ sessionId: "x" }), fold), undefined);
    assert.equal(sessionIdFromRegistryEntry(JSON.stringify({ cwd: fold }), fold), undefined);
  });

  it("returns undefined for malformed JSON", () => {
    assert.equal(sessionIdFromRegistryEntry("{not json", fold), undefined);
  });
});

// ---------------------------------------------------------------------------
// Same-agent MCP bind race — the two race-deleting rules:
//   Rule 1: the secret is the identity; every authenticated holder binds and
//           concurrent connections coexist (no session-conflict eviction).
//   Rule 2: the daemon owns agent_session_id; clients never write it.
// ---------------------------------------------------------------------------
describe("same-agent MCP bind race", () => {
  const BRANE = "brane-test";

  function seedSpawned(
    db: ReturnType<typeof createTestDb>,
    id: string,
    bindToken: string | null,
    sessionId: string | null = "sess-A",
  ): void {
    db.prepare(
      `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status, agent_session_id, bind_token)
       VALUES (?, 'brane-test', 'claude', 'worker', 0, 'active', ?, ?)`,
    ).run(id, sessionId, bindToken);
    // As the daemon's start does: the plaintext becomes an agent token row.
    adoptBindTokens(db);
  }
  function sessionOf(db: ReturnType<typeof createTestDb>, id: string): string | null {
    return (
      db.prepare("SELECT agent_session_id FROM narratives WHERE id = ?").get(id) as {
        agent_session_id: string | null;
      }
    ).agent_session_id;
  }
  function narrativeCount(db: ReturnType<typeof createTestDb>): number {
    return (db.prepare("SELECT COUNT(*) as n FROM narratives").get() as { n: number }).n;
  }
  function rejectedCount(db: ReturnType<typeof createTestDb>, id: string): number {
    return (
      db
        .prepare("SELECT COUNT(*) as n FROM events WHERE narrative_id = ? AND type = 'binding_rejected'")
        .get(id) as { n: number }
    ).n;
  }
  // Minimal stand-in for a live MCP connection: boundClientCount only reads
  // narrativeId + ws.readyState. Cast to the real client type at the call.
  function fakeClient(narrativeId: string, readyState: number = WebSocket.OPEN) {
    return { narrativeId, ws: { readyState } };
  }
  type ClientSet = Parameters<typeof boundClientCount>[0];
  type Client = ClientSet extends Set<infer T> ? T : never;

  // Test 1 — Two concurrent authenticated connections, same nid, different
  // self-detected sessions → both bind; neither is evicted; no binding_rejected,
  // no external-* row minted.
  it("two authenticated connections to the same nid both bind and coexist", () => {
    const db = createTestDb();
    seedSpawned(db, "claude-alpha", "secret-alpha", "sess-A");
    const before = narrativeCount(db);

    // Both connections present the correct secret (identities differ only in the
    // unreliable self-detected session param, which no longer decides anything).
    const bindA = resolveMcpBind(db, BRANE, "claude-alpha", "secret-alpha");
    const bindB = resolveMcpBind(db, BRANE, "claude-alpha", "secret-alpha");
    for (const bind of [bindA, bindB]) {
      assert.equal(bind.nid, "claude-alpha");
      assert.equal(bind.minted, false);
      assert.equal(bind.rejected, undefined);
    }

    // Both resolve to the claimed nid even though their self-detected sessions
    // differ, so nothing downstream has a conflict to arbitrate: the secret is
    // the proof of identity, and a parent bridge, a reconnect and a subagent
    // bridge are facets of one agent.
    assert.equal(narrativeCount(db), before, "no external-* narrative minted");
    assert.equal(rejectedCount(db, "claude-alpha"), 0, "no binding_rejected event");

    // Both connections' whoami would report the same claimed nid.
    assert.equal(boundClientCount(new Set([fakeClient("claude-alpha"), fakeClient("claude-alpha")]) as ClientSet, "claude-alpha"), 2);
  });

  // Test 2 — the daemon owns agent_session_id; clients never write it.
  it("spawn pins daemon-minted session ids for Claude and Copilot", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    const claudeArgs = buildAgentArgs("claude", { sessionId: uuid });
    const flagIdx = claudeArgs.indexOf("--session-id");
    assert.notEqual(flagIdx, -1, "claude launch carries --session-id");
    assert.equal(claudeArgs[flagIdx + 1], uuid, "the pinned id is the daemon-minted uuid");

    const copilotArgs = buildAgentArgs("copilot", { sessionId: uuid });
    const copilotFlagIdx = copilotArgs.indexOf("--session-id");
    assert.notEqual(copilotFlagIdx, -1, "copilot launch carries --session-id");
    assert.equal(copilotArgs[copilotFlagIdx + 1], uuid);

    // Other agent types get no --session-id (they keep their own resolution).
    const codexArgs = buildAgentArgs("codex", { sessionId: uuid });
    assert.ok(!codexArgs.includes("--session-id"), "non-claude agents are not pinned at spawn");
    // Claude with no minted id (defensive) omits the flag rather than emitting a bare one.
    assert.ok(!buildAgentArgs("claude", {}).includes("--session-id"));
  });

  it("a client-supplied session id never overwrites the row (bind param or narrate meta)", () => {
    const db = createTestDb();
    seedSpawned(db, "claude-beta", "secret-beta", "owner-sess");

    // A bind carrying a *different* session param: the secret check binds the
    // connection without writing agent_session_id.
    resolveMcpBind(db, BRANE, "claude-beta", "secret-beta");
    assert.equal(sessionOf(db, "claude-beta"), "owner-sess", "bind path leaves the daemon-owned id intact");

    // A narrate carrying meta.session_id: the row's session is unchanged, but
    // meta.summary still lands (only the session-id write was removed).
    handleMcpNarrate(
      { say: "working", meta: { session_id: "client-claimed-session", summary: "doing the thing" } },
      db,
      "claude-beta",
      () => {},
      "bridge-session",
    );
    assert.equal(sessionOf(db, "claude-beta"), "owner-sess", "narrate meta.session_id is ignored");
    const row = db.prepare("SELECT summary FROM narratives WHERE id = ?").get("claude-beta") as { summary: string | null };
    assert.equal(row.summary, "doing the thing", "meta.summary is still applied");
  });

  /** Rendering warnings ride back on the receipt — advisory, and absent when
   *  there is nothing to say, so a narration that renders as written gets the
   *  result shape it always got. See src/markdown-diagnostics.ts. */
  it("narrate reports rendering warnings, and only when there are any", () => {
    const db = createTestDb();
    seedSpawned(db, "claude-warn", "secret-warn", "sess-w");

    const clean = handleMcpNarrate(
      { say: "Euler: $e^{i\\pi} + 1 = 0$ — and $5 is not math." },
      db,
      "claude-warn",
      () => {},
    ) as Record<string, unknown>;
    assert.ok(!("warnings" in clean), "no key at all when nothing is wrong");

    const broken = handleMcpNarrate(
      { say: "The identity $\\bogusmacro{x}$ holds." },
      db,
      "claude-warn",
      () => {},
    ) as { warnings?: Array<{ kind: string; fallback: string }>; seq: number };
    assert.equal(broken.warnings?.length, 1);
    assert.equal(broken.warnings![0].kind, "math_parse_error");
    assert.equal(broken.warnings![0].fallback, "$\\bogusmacro{x}$");

    // Advisory, not a veto: the narration is written either way.
    assert.equal(readEvents(db, "claude-warn", { after: 0 }).length, 2);
  });

  /** `strict: true` is the opt-in exception, and it has to leave *nothing*
   *  behind — a refusal that had already written the summary or copied the
   *  payloads would not be safely retryable, and the golden rule forbids
   *  cleaning either up afterwards. */
  it("strict refuses the narration and writes nothing at all", () => {
    const db = createTestDb();
    seedSpawned(db, "claude-strict", "secret-strict", "sess-s");
    const summaryOf = () =>
      (db.prepare("SELECT summary FROM narratives WHERE id = ?").get("claude-strict") as { summary: string | null })
        .summary;

    const refused = handleMcpNarrate(
      {
        say: "```js\nconst x = 1;\nand the rest of this message",
        meta: { summary: "must not be applied" },
        strict: true,
      },
      db,
      "claude-strict",
      () => {},
    ) as { error?: string };

    assert.match(refused.error ?? "", /strict was requested/);
    assert.match(refused.error ?? "", /fence_unclosed/);
    // The refusal has to say what to do about it, or it costs a turn for nothing.
    assert.match(refused.error ?? "", /Renders as:/);
    assert.equal(readEvents(db, "claude-strict", { after: 0 }).length, 0, "nothing appended");
    assert.notEqual(summaryOf(), "must not be applied", "no metadata written either");

    // The same text without `strict` posts, warnings and all — pace over polish.
    const posted = handleMcpNarrate(
      { say: "```js\nconst x = 1;\nand the rest of this message" },
      db,
      "claude-strict",
      () => {},
    ) as { warnings?: Array<{ kind: string }> };
    assert.equal(posted.warnings?.[0].kind, "fence_unclosed");
    assert.equal(readEvents(db, "claude-strict", { after: 0 }).length, 1);
  });

  it("strict posts as normal when the markdown renders as written", () => {
    const db = createTestDb();
    seedSpawned(db, "claude-strict-ok", "secret-ok", "sess-ok");

    const result = handleMcpNarrate(
      { say: "Euler: $e^{i\\pi} + 1 = 0$, and $5 is still five.", strict: true },
      db,
      "claude-strict-ok",
      () => {},
    ) as Record<string, unknown>;

    assert.ok(!("error" in result), "clean markdown is never refused");
    assert.ok(!("warnings" in result));
    assert.equal(readEvents(db, "claude-strict-ok", { after: 0 }).length, 1);
  });

  /** The receipt carries what the caller has not seen, never the narration it
   *  just sent: echoing `say` back put every narration into the agent's
   *  context twice, re-read on each later turn. */
  it("narrate's receipt omits the narration it just wrote", () => {
    const db = createTestDb();
    seedSpawned(db, "claude-echo", "secret-echo", "sess-e");
    seedSpawned(db, "claude-other", "secret-other", "sess-o");
    appendEvent(db, "claude-echo", "human_signal", { content: "go ahead", source: "web" });

    type Receipt = { seq: number; events: Record<string, Array<{ seq: number; content?: string }>> };
    const first = handleMcpNarrate(
      { say: "starting", after: 0 },
      db,
      "claude-echo",
      () => {},
    ) as Receipt;
    assert.equal(first.seq, 2, "seq still says where the narration landed");
    assert.deepEqual(first.events.self.map((e) => e.seq), [1], "the signal is returned, the narration is not");
    assert.equal(readEvents(db, "claude-echo", { after: 0 }).length, 2, "and it was written");

    // An earlier narration of our own is still history like any other event;
    // only this call's own event is left out, including from a `tail` read.
    const second = handleMcpNarrate({ say: "done", tail: 5 }, db, "claude-echo", () => {}) as Receipt;
    assert.deepEqual(second.events.self.map((e) => e.seq), [1, 2]);

    // Foreign narration: the target's cursor gets everything but our event.
    appendEvent(db, "claude-other", "narration", { content: "hello", source: "claude-other" });
    const foreign = handleMcpNarrate(
      { say: "ping", nid: "claude-other", after: { self: 3, "claude-other": 0 } },
      db,
      "claude-echo",
      () => {},
    ) as Receipt;
    assert.equal(foreign.seq, 2);
    assert.deepEqual(foreign.events["claude-other"].map((e) => e.content), ["hello"]);
    assert.deepEqual(foreign.events.self, []);
  });

  // Test 3 — wrong/absent secret is rejected and minted external (regression
  // pin on #354). The claimed narrative is left completely untouched.
  it("a wrong or absent secret is rejected and minted external (#354 regression)", () => {
    const db = createTestDb();
    seedSpawned(db, "claude-gamma", "secret-gamma", "sess-g");

    const wrong = resolveMcpBind(db, BRANE, "claude-gamma", "not-the-secret");
    assert.match(wrong.nid, /^external-[0-9a-z]{8}$/);
    assert.equal(wrong.minted, true);
    assert.deepEqual(wrong.rejected, { claimedNid: "claude-gamma", reason: "secret_mismatch" });

    const absent = resolveMcpBind(db, BRANE, "claude-gamma", undefined);
    assert.match(absent.nid, /^external-[0-9a-z]{8}$/);
    assert.equal(absent.minted, true);
    assert.deepEqual(absent.rejected, { claimedNid: "claude-gamma", reason: "secret_absent" });

    // Victim untouched: its session is preserved and nothing leaked into it.
    assert.equal(sessionOf(db, "claude-gamma"), "sess-g");
    assert.equal(
      (db.prepare("SELECT COUNT(*) as n FROM events WHERE narrative_id = ?").get("claude-gamma") as { n: number }).n,
      0,
    );
  });

  // Test 4 — the migration grace is retired. A `bind_token IS NULL` row (every
  // narrative spawned before #354) is no longer bindable without a secret; it
  // is refused like any other unproven claim, with its own reason so the log
  // says *why* rather than blaming a secret the client may well have sent.
  it("a tokenless row is refused, not waved through (grace retirement)", () => {
    const db = createTestDb();
    seedSpawned(db, "claude-legacy", null, "sess-A");
    const before = narrativeCount(db);

    const bind = resolveMcpBind(db, BRANE, "claude-legacy", undefined);
    assert.match(bind.nid, /^external-[0-9a-z]{8}$/, "refused claims land on a fresh external id");
    assert.equal(bind.minted, true);
    assert.deepEqual(bind.rejected, { claimedNid: "claude-legacy", reason: "no_bind_token" });

    // Presenting *a* secret doesn't help either — there is nothing to check it
    // against — and the reason still names the row, not the client.
    const withSecret = resolveMcpBind(db, BRANE, "claude-legacy", "anything-at-all");
    assert.deepEqual(withSecret.rejected, { claimedNid: "claude-legacy", reason: "no_bind_token" });

    // The claimed narrative is untouched: its session survives and nothing was
    // written into it by the refusal itself.
    assert.equal(sessionOf(db, "claude-legacy"), "sess-A");
    assert.equal(rejectedCount(db, "claude-legacy"), 0, "resolveMcpBind reports; the caller records");
    assert.equal(narrativeCount(db), before + 2, "one external per refused claim");
  });

  // Test 4b — the reconnect that the retirement would otherwise have broken.
  // An external's id is minted server-side and adopted by the bridge from
  // `welcome`; without a token of its own, every reconnect carrying that id
  // would now be refused and minted afresh, fragmenting one client across a
  // new narrative per reconnect. So externals get a real bind token.
  it("a minted external can re-bind to itself (no litter on reconnect)", () => {
    const db = createTestDb();
    const { nid, secret: token } = mintExternalNarrativeWithSecret(db, BRANE);
    assert.ok(token, "a minted external carries an agent token");

    const before = narrativeCount(db);
    const again = resolveMcpBind(db, BRANE, nid, token!);
    assert.equal(again.nid, nid, "reconnect returns to the same narrative");
    assert.equal(again.minted, false);
    assert.equal(again.rejected, undefined);
    assert.equal(narrativeCount(db), before, "nothing new minted");

    // And it is a real credential: another client that merely knows the id
    // cannot take the narrative over.
    const impostor = resolveMcpBind(db, BRANE, nid, undefined);
    assert.match(impostor.nid, /^external-[0-9a-z]{8}$/);
    assert.notEqual(impostor.nid, nid);
    assert.deepEqual(impostor.rejected, { claimedNid: nid, reason: "secret_absent" });
  });

  // Test 5 — status transitions fire on the 0↔1 client-count boundary, so a
  // secondary connection closing can't flash the narrative offline.
  it("mcp connect/disconnect status keys off the 0↔1 client-count transition", () => {
    const nid = "claude-delta";
    const first = fakeClient(nid) as unknown as Client;
    const second = fakeClient(nid) as unknown as Client;
    const set = new Set([first, second]) as ClientSet;

    // Two live connections on the narrative.
    assert.equal(boundClientCount(set, nid), 2);

    // First of two closes — the handler deletes it, one live sibling remains
    // (>0): NOT a disconnect, the close handler returns before broadcasting or
    // touching tmux, so the narrative can't flash offline mid-session.
    set.delete(first);
    assert.equal(boundClientCount(set, nid), 1);

    // Last one closes → 0 remaining: the 1→0 transition, disconnect path runs.
    set.delete(second);
    assert.equal(boundClientCount(set, nid), 0);

    // A CLOSED socket still lingering in the set is not counted as live.
    const stale = fakeClient(nid, WebSocket.CLOSED) as unknown as Client;
    assert.equal(boundClientCount(new Set([stale]) as ClientSet, nid), 0, "a CLOSED socket is not live");

    // The very first connection is a 0→1 transition (empty set → connect fires).
    assert.equal(boundClientCount(new Set() as ClientSet, nid), 0);
  });
});

// ---------------------------------------------------------------------------
// Per-adapter session-id ownership + codex session capture.
//   - "assign" agents (claude) get a daemon-minted id (tested above, Test 2).
//   - "capture" agents (codex) generate their own id, which the daemon
//     discovers from the agent's own store, scoped per-narrative.
//   - the cost `session_ids` SET stays populated regardless (cost path intact).
// ---------------------------------------------------------------------------
describe("session-id ownership + codex capture", () => {
  // Write a codex rollout into a fixture tree matching the real layout:
  //   <base>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, first line a `session_meta`.
  function writeRollout(base: string, when: Date, uuid: string, cwd: string): void {
    const dir = join(
      base,
      String(when.getFullYear()),
      String(when.getMonth() + 1).padStart(2, "0"),
      String(when.getDate()).padStart(2, "0"),
    );
    mkdirSync(dir, { recursive: true });
    const fname = `rollout-${when.toISOString().replace(/[:.]/g, "-")}-${uuid}.jsonl`;
    const meta = JSON.stringify({
      type: "session_meta",
      payload: { id: uuid, cwd, timestamp: when.toISOString() },
    });
    // A second line ensures we only ever parse the first (bounded prefix read).
    writeFileSync(join(dir, fname), meta + "\n" + JSON.stringify({ type: "message" }) + "\n");
  }

  it("adapters declare the intended session-id ownership strategy", () => {
    assert.equal(getAgentAdapter("claude").sessionIdOwnership, "assign");
    assert.equal(getAgentAdapter("claude").resumeCreatesNewSession, true);
    assert.equal(getAgentAdapter("codex").sessionIdOwnership, "capture");
    // Gemini has no local session source. Copilot accepts a daemon-minted UUID,
    // so its cost and tool log are exactly scoped even in a shared fold.
    assert.equal(getAgentAdapter("gemini").sessionIdOwnership, undefined);
    assert.equal(getAgentAdapter("copilot").sessionIdOwnership, "assign");
    assert.equal(getAgentAdapter("copilot").resumeCreatesNewSession, undefined);
    assert.equal(getAgentAdapter("unknown-agent").sessionIdOwnership, undefined);
  });

  it("keeps Copilot's assigned session stable across revives", () => {
    const copilot = getAgentAdapter("copilot");
    assert.deepEqual(
      copilot.resumeArgs({ sessionId: "existing", newSessionId: "unused", foldPath: "/work" }),
      ["--session-id", "existing"],
    );
    assert.deepEqual(
      copilot.resumeArgs({ newSessionId: "legacy-row-repair", foldPath: "/work" }),
      ["--session-id", "legacy-row-repair"],
    );
  });

  it("discoverCodexSession finds this narrative's rollout by cwd + spawn time", () => {
    const base = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const fold = "/Users/test/dev/proj";
    const spawn = new Date(2026, 2, 5, 10, 0, 0);

    // The narrative's own rollout: same fold, created just after spawn.
    writeRollout(base, new Date(2026, 2, 5, 10, 0, 30), "aaaaaaaa-0000-4000-8000-000000000001", fold);

    const found = discoverCodexSession(base, fold, spawn.getTime());
    assert.equal(found, "aaaaaaaa-0000-4000-8000-000000000001");
  });

  it("discoverCodexSession ignores rollouts from other folds and before spawn", () => {
    const base = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const fold = "/Users/test/dev/proj";
    const spawn = new Date(2026, 2, 5, 10, 0, 0);

    // Different fold — must be ignored even though it's after spawn.
    writeRollout(base, new Date(2026, 2, 5, 10, 1, 0), "bbbbbbbb-0000-4000-8000-000000000002", "/Users/test/dev/other");
    // Right fold but BEFORE spawn (a stale predecessor session) — ignored.
    writeRollout(base, new Date(2026, 2, 5, 9, 0, 0), "cccccccc-0000-4000-8000-000000000003", fold);

    assert.equal(discoverCodexSession(base, fold, spawn.getTime()), undefined);
  });

  it("discoverCodexSession picks the earliest rollout after spawn (two same-fold narratives)", () => {
    const base = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const fold = "/Users/test/dev/proj";
    // Narrative A spawns first; its rollout is the earliest one after A's spawn.
    const spawnA = new Date(2026, 2, 5, 10, 0, 0);
    writeRollout(base, new Date(2026, 2, 5, 10, 0, 20), "aaaaaaaa-0000-4000-8000-00000000000a", fold);
    // Narrative B spawns later in the SAME fold; its rollout comes after B's spawn.
    const spawnB = new Date(2026, 2, 5, 10, 5, 0);
    writeRollout(base, new Date(2026, 2, 5, 10, 5, 20), "bbbbbbbb-0000-4000-8000-00000000000b", fold);

    // Each narrative resolves to its OWN rollout via its own spawn time —
    // the cwd+since scoping that avoids fold-wide cross-contamination.
    assert.equal(discoverCodexSession(base, fold, spawnA.getTime()), "aaaaaaaa-0000-4000-8000-00000000000a");
    assert.equal(discoverCodexSession(base, fold, spawnB.getTime()), "bbbbbbbb-0000-4000-8000-00000000000b");
  });

  // Narrative row seed for the capture-write tests.
  function seedNarrative(
    db: ReturnType<typeof createTestDb>,
    id: string,
    agentType: string,
    sessionId: string | null,
  ): void {
    db.prepare(
      `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status, fold_path, agent_session_id)
       VALUES (?, 'brane-test', ?, 'worker', 0, 'active', '~/dev/proj', ?)`,
    ).run(id, agentType, sessionId);
  }
  function sessionOf(db: ReturnType<typeof createTestDb>, id: string): string | null {
    return (db.prepare("SELECT agent_session_id FROM narratives WHERE id = ?").get(id) as {
      agent_session_id: string | null;
    }).agent_session_id;
  }

  it("maybeCaptureSessionId captures a codex id (and records it for cost) when the pointer is unset", () => {
    const db = createTestDb();
    seedNarrative(db, "codex-one", "codex", null);

    const captured = maybeCaptureSessionId(
      db, "codex-one", "codex", "~/dev/proj", 0, null,
      () => "discovered-codex-id",
    );
    assert.equal(captured, "discovered-codex-id");
    assert.equal(sessionOf(db, "codex-one"), "discovered-codex-id", "pointer captured onto the row");
    assert.deepEqual(getSessionIds(db, "codex-one"), ["discovered-codex-id"], "captured id is in the cost set");
  });

  it("maybeCaptureSessionId is a no-op for assign agents, none agents, and an already-set pointer", () => {
    const db = createTestDb();
    // assign agent (claude): the daemon assigns; capture never runs.
    seedNarrative(db, "claude-x", "claude", null);
    assert.equal(maybeCaptureSessionId(db, "claude-x", "claude", "~/dev/proj", 0, null, () => "should-not-be-used"), undefined);
    assert.equal(sessionOf(db, "claude-x"), null);

    // none agent (gemini): no id to capture.
    seedNarrative(db, "gemini-x", "gemini", null);
    assert.equal(maybeCaptureSessionId(db, "gemini-x", "gemini", "~/dev/proj", 0, null, () => "nope"), undefined);
    assert.equal(sessionOf(db, "gemini-x"), null);

    // capture agent but pointer already set: never clobbered.
    seedNarrative(db, "codex-set", "codex", "already-have-one");
    assert.equal(maybeCaptureSessionId(db, "codex-set", "codex", "~/dev/proj", 0, "already-have-one", () => "new-id"), undefined);
    assert.equal(sessionOf(db, "codex-set"), "already-have-one", "an established pointer is not overwritten");
  });

  it("the cumulative session_ids cost set stays populated (cost path intact under Rule 2)", () => {
    const db = createTestDb();
    seedNarrative(db, "claude-cost", "claude", "current-sess");

    // recordSessionId feeds the SET independently of the row pointer; dedups.
    recordSessionId(db, "claude-cost", "sess-1");
    recordSessionId(db, "claude-cost", "sess-2");
    recordSessionId(db, "claude-cost", "sess-1"); // duplicate ignored

    // getSessionIds = the SET ∪ the current agent_session_id — what cost sums over.
    const ids = getSessionIds(db, "claude-cost");
    assert.deepEqual(ids.sort(), ["current-sess", "sess-1", "sess-2"].sort());
  });
});
