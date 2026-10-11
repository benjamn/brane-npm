import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers.js";
import { appendEvent } from "../db/events.js";
import { readToolUse, readToolUseWindow, maxToolUseRev, type ToolUseRow } from "../db/tool-uses.js";
import {
  newCodexLogCursor,
  pollCodexToolLog,
  toolUseFromCodexRecord,
  type CodexLogCursor,
} from "../codex-tool-log.js";
import { findCodexRollout, readCodexUsage, resetCodexCaches } from "../agents.js";
import { startCodexToolSampler, type McpBridgeClient } from "../daemon/server.js";

// ---------------------------------------------------------------------------
// Fixture construction — the real layout:
//   <base>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, first line a `session_meta`.
// ---------------------------------------------------------------------------

const WHEN = new Date(2026, 2, 5, 10, 0, 0);

function rolloutPath(base: string, uuid: string, when = WHEN): string {
  const dir = join(
    base,
    String(when.getFullYear()),
    String(when.getMonth() + 1).padStart(2, "0"),
    String(when.getDate()).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-${when.toISOString().replace(/[:.]/g, "-")}-${uuid}.jsonl`);
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function sessionMeta(uuid: string, cwd = "/Users/test/dev/proj"): string {
  return line({
    type: "session_meta",
    // `base_instructions` stands in for codex's inlined system prompt, which is
    // what makes a real first line hundreds of kilobytes.
    payload: { id: uuid, cwd, timestamp: WHEN.toISOString(), base_instructions: "x".repeat(4096) },
  });
}

function tokenCount(total: number, extra: Record<string, number> = {}): string {
  return line({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          total_tokens: total,
          ...extra,
        },
      },
    },
  });
}

function toolCall(callId: string, name: string, input: string, custom = false): string {
  return line({
    type: "response_item",
    payload: custom
      ? { type: "custom_tool_call", call_id: callId, name, input, status: "completed" }
      : { type: "function_call", call_id: callId, name, arguments: input },
  });
}

function toolOutput(callId: string, output: unknown, custom = false): string {
  return line({
    type: "response_item",
    payload: {
      type: custom ? "custom_tool_call_output" : "function_call_output",
      call_id: callId,
      output,
    },
  });
}

function newBase(): string {
  return mkdtempSync(join(tmpdir(), "codex-log-test-"));
}

function seedNarrative(db: ReturnType<typeof createTestDb>, id = "codex-test0001"): string {
  db.prepare(
    "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at) VALUES (?, 'brane-test', 'codex', 'worker', 'active', '/tmp', ?)",
  ).run(id, Date.now());
  return id;
}

/** One narrative's reader: a fresh cursor, bound to a fixture root. A second
 *  `reader()` over the same fixture is what a daemon restart looks like — the
 *  rows are already in the database and the cursor knows nothing about them. */
function reader(db: ReturnType<typeof createTestDb>, nid: string, sessionId: string, base: string) {
  const cursor: CodexLogCursor = newCodexLogCursor();
  return () => pollCodexToolLog(db, nid, sessionId, cursor, base);
}

// The rollout-path and usage caches are process-lifetime by design, keyed on a
// path that a fresh mkdtemp fixture never reuses — but reset anyway so no test
// can depend on another having run.
beforeEach(() => resetCodexCaches());

// ---------------------------------------------------------------------------

describe("findCodexRollout", () => {
  it("locates a rollout by session id under the YYYY/MM/DD tiers", () => {
    const base = newBase();
    const path = rolloutPath(base, "aaaaaaaa-0000-4000-8000-000000000001");
    writeFileSync(path, sessionMeta("aaaaaaaa-0000-4000-8000-000000000001"));

    assert.equal(findCodexRollout("aaaaaaaa-0000-4000-8000-000000000001", base), path);
  });

  it("returns undefined when no rollout records that session", () => {
    const base = newBase();
    writeFileSync(rolloutPath(base, "aaaa-1"), sessionMeta("aaaa-1"));

    assert.equal(findCodexRollout("bbbb-2", base), undefined);
  });

  it("trusts session_meta over the filename", () => {
    // A file *named* for one session whose meta records another is not a match:
    // the name is a hint, the meta is the authority.
    const base = newBase();
    const path = rolloutPath(base, "cccc-3");
    writeFileSync(path, sessionMeta("dddd-4"));

    assert.equal(findCodexRollout("cccc-3", base), undefined);
  });

  it("does not cache a miss — a session found later still resolves", () => {
    const base = newBase();
    assert.equal(findCodexRollout("eeee-5", base), undefined);

    const path = rolloutPath(base, "eeee-5");
    writeFileSync(path, sessionMeta("eeee-5"));
    assert.equal(findCodexRollout("eeee-5", base), path);
  });
});

describe("readCodexUsage", () => {
  it("reports the last cumulative total as TOK, not USD", () => {
    // pricing.ts prices Anthropic models only and falls through to a
    // $10/$50-per-Mtok default tier, so pricing a GPT session would invoice an
    // OpenAI transcript at Opus rates. Tokens are the honest unit.
    const base = newBase();
    const path = rolloutPath(base, "usage-1");
    writeFileSync(path, sessionMeta("usage-1") + tokenCount(100) + tokenCount(4200));

    const reading = readCodexUsage("usage-1", base);
    assert.equal(reading?.unit, "TOK");
    assert.equal(reading?.amount, 4200);
  });

  it("subtracts cached input so the breakdown is disjoint like claude's", () => {
    // Codex's `cached_input_tokens` is a SUBSET of `input_tokens`; claude
    // reports the two separately. A consumer summing the fields must not count
    // the cached portion twice.
    const base = newBase();
    const path = rolloutPath(base, "usage-2");
    writeFileSync(
      path,
      sessionMeta("usage-2") +
        tokenCount(0, {
          input_tokens: 1000,
          cached_input_tokens: 900,
          output_tokens: 50,
          total_tokens: 1050,
        }),
    );

    const reading = readCodexUsage("usage-2", base);
    assert.deepEqual(reading?.tokens, { input: 100, output: 50, cacheRead: 900, cacheWrite: 0 });
    assert.equal(reading?.amount, 1050);
    // The parts of a disjoint breakdown add back up to the whole.
    const t = reading!.tokens!;
    assert.equal(t.input + t.cacheRead + t.output, reading!.amount);
  });

  it("clamps a cached count that exceeds input rather than reporting negative input", () => {
    const base = newBase();
    writeFileSync(
      rolloutPath(base, "usage-3"),
      sessionMeta("usage-3") +
        tokenCount(0, { input_tokens: 10, cached_input_tokens: 999, total_tokens: 10 }),
    );

    const reading = readCodexUsage("usage-3", base);
    assert.equal(reading?.tokens?.input, 0);
  });

  it("finds the last counter past a tail window filled with a huge tool output", () => {
    // The window doubles until it catches a `token_count`. A single turn can
    // append far more than the initial 64KB window (one big tool result), and
    // the counter must not be lost behind it.
    const base = newBase();
    const path = rolloutPath(base, "usage-4");
    const huge = line({ type: "response_item", payload: { type: "message", text: "y".repeat(200_000) } });
    writeFileSync(path, sessionMeta("usage-4") + tokenCount(777) + huge);

    assert.equal(readCodexUsage("usage-4", base)?.amount, 777);
  });

  it("returns null for a rollout with no counters, and for an unknown session", () => {
    const base = newBase();
    writeFileSync(rolloutPath(base, "usage-5"), sessionMeta("usage-5"));

    assert.equal(readCodexUsage("usage-5", base), null);
    assert.equal(readCodexUsage("nope", base), null);
  });

  it("picks up a counter appended after a previous read", () => {
    // The (size, mtime) memo must not pin a stale reading once the file grows.
    const base = newBase();
    const path = rolloutPath(base, "usage-6");
    writeFileSync(path, sessionMeta("usage-6") + tokenCount(10));
    assert.equal(readCodexUsage("usage-6", base)?.amount, 10);

    appendFileSync(path, tokenCount(20));
    assert.equal(readCodexUsage("usage-6", base)?.amount, 20);
  });
});


describe("toolUseFromCodexRecord", () => {
  it("maps both call shapes, reading input from the field each one uses", () => {
    // function_call carries `arguments`; custom_tool_call carries `input`.
    const fn = toolUseFromCodexRecord(
      JSON.parse(toolCall("call_a", "shell", '{"cmd":"ls"}')),
    );
    assert.equal(fn?.name, "shell");
    assert.equal(fn?.input, '{"cmd":"ls"}');
    assert.equal(fn?.status, "pending");

    const custom = toolUseFromCodexRecord(JSON.parse(toolCall("call_b", "exec", "text(1)", true)));
    assert.equal(custom?.name, "exec");
    assert.equal(custom?.input, "text(1)");
  });

  it("ignores records that are not tool calls", () => {
    for (const record of [
      { type: "event_msg", payload: { type: "token_count" } },
      { type: "response_item", payload: { type: "reasoning" } },
      { type: "response_item", payload: { type: "function_call" } }, // no call_id
      { type: "session_meta", payload: { id: "x" } },
      null,
      "not an object",
    ]) {
      assert.equal(toolUseFromCodexRecord(record), undefined);
    }
  });

  it("attributes an output from the names map, falling back to unknown", () => {
    const names = new Map<string, string>();
    toolUseFromCodexRecord(JSON.parse(toolCall("call_c", "apply_patch", "{}")), names);

    const known = toolUseFromCodexRecord(JSON.parse(toolOutput("call_c", "ok")), names);
    assert.equal(known?.name, "apply_patch");
    assert.equal(known?.status, "completed");

    const orphan = toolUseFromCodexRecord(JSON.parse(toolOutput("call_z", "ok")), names);
    assert.equal(orphan?.name, "unknown");
  });

  it("flattens custom_tool_call_output content parts into text", () => {
    // The wire shape is [{type,text},…]. Storing it verbatim would show the
    // operator JSON where the output should be.
    const mapped = toolUseFromCodexRecord(
      JSON.parse(
        toolOutput(
          "call_d",
          [
            { type: "input_text", text: "Script completed\n" },
            { type: "input_text", text: "2" },
          ],
          true,
        ),
      ),
    );
    assert.equal(mapped?.output, "Script completed\n2");
  });
});

describe("pollCodexToolLog", () => {
  it("records calls, completes them from their output, and returns written rows", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    writeFileSync(
      rolloutPath(base, "tools-1"),
      sessionMeta("tools-1") +
        toolCall("call_a", "shell", '{"cmd":"ls"}') +
        toolOutput("call_a", "a.txt\n"),
    );

    const written = reader(db, nid, "tools-1", base)();

    // The caller pushes what comes back, so the return value is part of the
    // contract, not a convenience.
    assert.deepEqual(
      written.map((r) => `${r.dedup_key}:${r.status}`),
      ["call_a:pending", "call_a:completed"],
    );
    const row = readToolUse(db, nid, "call_a");
    assert.equal(row?.name, "shell");
    assert.equal(row?.status, "completed");
    assert.equal(row?.input, '{"cmd":"ls"}');
    assert.equal(row?.output, "a.txt\n");
    assert.equal(row?.source, "session_log");
    assert.equal(row?.agent_type, "codex");
  });

  it("leaves a call pending until its output is appended", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    const path = rolloutPath(base, "tools-2");
    writeFileSync(path, sessionMeta("tools-2") + toolCall("call_b", "shell", "{}"));
    const poll = reader(db, nid, "tools-2", base);

    poll();
    assert.equal(readToolUse(db, nid, "call_b")?.status, "pending");

    appendFileSync(path, toolOutput("call_b", "done"));
    poll();
    const row = readToolUse(db, nid, "call_b");
    assert.equal(row?.status, "completed");
    assert.equal(row?.output, "done");
  });

  it("attributes an output whose call was consumed by an earlier read", () => {
    // The names map lives on the cursor precisely so this survives the gap
    // between two polls.
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    const path = rolloutPath(base, "tools-3");
    writeFileSync(path, sessionMeta("tools-3") + toolCall("call_c", "apply_patch", "{}"));
    const poll = reader(db, nid, "tools-3", base);

    poll();
    appendFileSync(path, toolOutput("call_c", "ok"));
    poll();

    // The upsert never overwrites `name`, so the real one survives regardless;
    // this pins that the completing write doesn't even try to replace it.
    assert.equal(readToolUse(db, nid, "call_c")?.name, "apply_patch");
  });

  it("reads only appended bytes — a re-poll with no growth writes nothing", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    writeFileSync(
      rolloutPath(base, "tools-4"),
      sessionMeta("tools-4") + toolCall("call_d", "shell", "{}") + toolOutput("call_d", "ok"),
    );
    const poll = reader(db, nid, "tools-4", base);

    poll();
    const after = maxToolUseRev(db, nid);
    assert.deepEqual(poll(), []);
    assert.deepEqual(poll(), []);
    assert.equal(maxToolUseRev(db, nid), after);
  });

  it("does not restate unchanged rows when a cold cursor replays the file", () => {
    // The cursor is in memory, so the first poll after a daemon restart (or a
    // revive) re-reads the whole rollout. Every write bumps rev, and rev is the
    // client sync cursor — without the guard that would be a sync storm on
    // every restart.
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    writeFileSync(
      rolloutPath(base, "tools-5"),
      sessionMeta("tools-5") +
        toolCall("call_e", "shell", "{}") +
        toolOutput("call_e", "ok") +
        toolCall("call_f", "read", "{}") +
        toolOutput("call_f", "ok"),
    );

    reader(db, nid, "tools-5", base)();
    const after = maxToolUseRev(db, nid);

    // A brand-new cursor over the same file: what a restart actually does.
    assert.deepEqual(reader(db, nid, "tools-5", base)(), []);
    assert.equal(maxToolUseRev(db, nid), after);
    assert.equal(readToolUseWindow(db, nid).length, 2);
  });

  it("survives a chunk boundary that splits a multi-byte character", () => {
    // This is why `pending` is a Buffer. Decoding each chunk independently
    // would leave U+FFFD inside the JSON and the line would never parse.
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    const path = rolloutPath(base, "tools-6");
    writeFileSync(path, sessionMeta("tools-6"));
    const poll = reader(db, nid, "tools-6", base);

    const record = Buffer.from(toolCall("call_g", "shell", "héllo — wörld 🌍"), "utf8");
    const cut = record.lastIndexOf(Buffer.from("🌍", "utf8")) + 2; // inside the emoji
    appendFileSync(path, record.subarray(0, cut));
    poll();
    assert.equal(readToolUse(db, nid, "call_g"), null); // incomplete — held back

    appendFileSync(path, record.subarray(cut));
    poll();
    assert.equal(readToolUse(db, nid, "call_g")?.input, "héllo — wörld 🌍");
  });

  it("holds back a partial trailing line and completes it on the next poll", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    const path = rolloutPath(base, "tools-7");
    writeFileSync(path, sessionMeta("tools-7"));
    const poll = reader(db, nid, "tools-7", base);

    const record = toolCall("call_h", "shell", "{}");
    appendFileSync(path, record.slice(0, 20));
    poll();
    assert.equal(readToolUse(db, nid, "call_h"), null);

    appendFileSync(path, record.slice(20));
    poll();
    assert.equal(readToolUse(db, nid, "call_h")?.name, "shell");
  });

  it("skips malformed lines without blocking the ones after them", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    writeFileSync(
      rolloutPath(base, "tools-8"),
      sessionMeta("tools-8") +
        "{not json at all\n" +
        toolCall("call_i", "shell", "{}") +
        toolOutput("call_i", "ok"),
    );

    reader(db, nid, "tools-8", base)();
    assert.equal(readToolUse(db, nid, "call_i")?.status, "completed");
  });

  it("restarts from zero when the rollout shrinks", () => {
    // A shorter file was replaced or truncated, so the stored offset no longer
    // points at anything meaningful and reading from it would yield garbage.
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    const path = rolloutPath(base, "tools-9");
    writeFileSync(
      path,
      sessionMeta("tools-9") + toolCall("call_j", "shell", "{}") + toolOutput("call_j", "ok"),
    );
    const poll = reader(db, nid, "tools-9", base);
    poll();

    writeFileSync(path, sessionMeta("tools-9") + toolCall("call_k", "read", "{}"));
    poll();

    assert.equal(readToolUse(db, nid, "call_k")?.name, "read");
  });

  it("anchors rows to the narrative head that preceded them", () => {
    // The flush runs before the MCP tool dispatches, so calls made since the
    // last narration anchor under it — which is what places them between
    // messages in chat rather than bunched at the end.
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    const path = rolloutPath(base, "tools-10");
    writeFileSync(path, sessionMeta("tools-10"));
    const poll = reader(db, nid, "tools-10", base);

    appendEvent(db, nid, "narration", { content: "first" });
    appendFileSync(path, toolCall("call_l", "shell", "{}"));
    poll();

    appendEvent(db, nid, "narration", { content: "second" });
    appendFileSync(path, toolCall("call_m", "read", "{}"));
    poll();

    assert.equal(readToolUse(db, nid, "call_l")?.after_seq, 1);
    assert.equal(readToolUse(db, nid, "call_m")?.after_seq, 2);
  });

  it("does nothing for a session with no rollout on disk", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);

    assert.deepEqual(reader(db, nid, "absent", newBase())(), []);
    assert.equal(readToolUseWindow(db, nid).length, 0);
  });
});


// ---------------------------------------------------------------------------
// The daemon-side driver. Codex is read from two directions over one cursor:
// a timer (so a call shows while it runs) and the agent's own MCP calls (so
// nothing dangles when it goes quiet). These pin that they cooperate.
//
// Asserted behaviourally — through rows appearing or not appearing — rather
// than by inspecting timer handles, since the interval is `unref`'d and so is
// deliberately invisible to the event loop.
// ---------------------------------------------------------------------------

describe("startCodexToolSampler", () => {
  const TICK_MS = 10;
  const settle = () => new Promise((resolve) => setTimeout(resolve, TICK_MS * 5));

  /** A stand-in for a connected MCP bridge. Only the fields the sampler reads
   *  are real; `ws` needs nothing but a readyState. */
  function bridge(narrativeId: string, agentType: string, open = true): McpBridgeClient {
    return {
      ws: { readyState: open ? 1 : 3 } as McpBridgeClient["ws"],
      narrativeId,
      agentType,
      pendingListens: new Map(),
    };
  }

  function seedSession(db: ReturnType<typeof createTestDb>, nid: string, sessionId: string): void {
    db.prepare("UPDATE narratives SET agent_session_id = ? WHERE id = ?").run(sessionId, nid);
  }

  it("flushes inline for codex and ignores every other agent", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    writeFileSync(
      rolloutPath(base, "samp-1"),
      sessionMeta("samp-1") + toolCall("call_a", "shell", "{}") + toolOutput("call_a", "ok"),
    );
    seedSession(db, nid, "samp-1");

    const pushed: ToolUseRow[] = [];
    const sampler = startCodexToolSampler(db, new Set(), (r) => pushed.push(r), 0, base);

    // A non-codex bridge on the same narrative must not trigger a read.
    sampler.flushFor(bridge(nid, "claude"));
    assert.equal(pushed.length, 0);

    sampler.flushFor(bridge(nid, "codex"));
    assert.deepEqual(pushed.map((r) => r.status), ["pending", "completed"]);
    sampler.stop();
  });

  it("shares one cursor between the timer and the inline flush", () => {
    // Both paths drain through the same cursor, so whichever runs first
    // advances the byte offset and the other finds nothing. A second read of
    // the same bytes would bump rev and re-push rows that never changed.
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    writeFileSync(
      rolloutPath(base, "samp-2"),
      sessionMeta("samp-2") + toolCall("call_b", "shell", "{}") + toolOutput("call_b", "ok"),
    );
    seedSession(db, nid, "samp-2");

    const pushed: ToolUseRow[] = [];
    const sampler = startCodexToolSampler(db, new Set([bridge(nid, "codex")]), (r) => pushed.push(r), 0, base);

    sampler.flushFor(bridge(nid, "codex"));
    assert.equal(pushed.length, 2);
    const rev = maxToolUseRev(db, nid);

    sampler.flushFor(bridge(nid, "codex"));
    sampler.flushFor(bridge(nid, "codex"));
    assert.equal(pushed.length, 2);
    assert.equal(maxToolUseRev(db, nid), rev);
    sampler.stop();
  });

  it("does not arm for a non-codex agent", async () => {
    // A daemon that never runs codex does no recurring work at all: arming is
    // one string comparison per bridge and nothing else.
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    writeFileSync(rolloutPath(base, "samp-3"), sessionMeta("samp-3") + toolCall("call_c", "shell", "{}"));
    seedSession(db, nid, "samp-3");

    const sampler = startCodexToolSampler(db, new Set([bridge(nid, "codex")]), () => {}, TICK_MS, base);
    sampler.armFor("claude");
    sampler.armFor("copilot");
    sampler.armFor(undefined);
    await settle();
    assert.equal(readToolUse(db, nid, "call_c"), null);

    // The same sampler, armed properly, does read it.
    sampler.armFor("codex");
    await settle();
    assert.equal(readToolUse(db, nid, "call_c")?.name, "shell");
    sampler.stop();
  });

  it("picks up calls as they are appended, without an MCP call to prompt it", async () => {
    // This is the whole point of the timer: a burst of tool calls with no
    // narration in it used to stay invisible until the burst ended.
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    const path = rolloutPath(base, "samp-4");
    writeFileSync(path, sessionMeta("samp-4"));
    seedSession(db, nid, "samp-4");

    const sampler = startCodexToolSampler(db, new Set([bridge(nid, "codex")]), () => {}, TICK_MS, base);
    sampler.armFor("codex");

    appendFileSync(path, toolCall("call_d", "shell", "{}"));
    await settle();
    assert.equal(readToolUse(db, nid, "call_d")?.status, "pending");

    appendFileSync(path, toolOutput("call_d", "ok"));
    await settle();
    assert.equal(readToolUse(db, nid, "call_d")?.status, "completed");
    sampler.stop();
  });

  it("drains every connected codex narrative on one tick", async () => {
    const db = createTestDb();
    const one = seedNarrative(db, "codex-test0001");
    const two = seedNarrative(db, "codex-test0002");
    const base = newBase();
    writeFileSync(rolloutPath(base, "samp-5"), sessionMeta("samp-5") + toolCall("call_e", "shell", "{}"));
    writeFileSync(
      rolloutPath(base, "samp-6", new Date(2026, 2, 6, 10, 0, 0)),
      sessionMeta("samp-6") + toolCall("call_f", "read", "{}"),
    );
    seedSession(db, one, "samp-5");
    seedSession(db, two, "samp-6");

    const sampler = startCodexToolSampler(
      db,
      new Set([bridge(one, "codex"), bridge(two, "codex")]),
      () => {},
      TICK_MS,
      base,
    );
    sampler.armFor("codex");
    await settle();
    sampler.stop();

    assert.equal(readToolUse(db, one, "call_e")?.name, "shell");
    assert.equal(readToolUse(db, two, "call_f")?.name, "read");
  });

  it("stops ticking once the last codex bridge is gone", async () => {
    // An ended codex session must not leave recurring work behind. The first
    // tick that finds nothing connected disarms the timer; the next codex
    // bridge to arm restarts it.
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    const path = rolloutPath(base, "samp-7");
    writeFileSync(path, sessionMeta("samp-7"));
    seedSession(db, nid, "samp-7");

    const clients = new Set([bridge(nid, "codex")]);
    const sampler = startCodexToolSampler(db, clients, () => {}, TICK_MS, base);
    sampler.armFor("codex");
    await settle();

    clients.clear(); // the bridge disconnected
    await settle(); // a tick observes that and disarms

    appendFileSync(path, toolCall("call_g", "shell", "{}"));
    await settle();
    assert.equal(readToolUse(db, nid, "call_g"), null);

    // Re-arming after a new bridge connects picks it straight back up.
    clients.add(bridge(nid, "codex"));
    sampler.armFor("codex");
    await settle();
    assert.equal(readToolUse(db, nid, "call_g")?.name, "shell");
    sampler.stop();
  });

  it("keeps the inline flush working when the timer is disabled", async () => {
    // `codex_tool_log.poll_ms = 0` turns off the timer only. Unlike crush and
    // copilot, where that setting disables capture outright, codex falls back
    // to MCP-call-driven reads — less immediate, but still complete.
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    writeFileSync(rolloutPath(base, "samp-8"), sessionMeta("samp-8") + toolCall("call_h", "shell", "{}"));
    seedSession(db, nid, "samp-8");

    const sampler = startCodexToolSampler(db, new Set([bridge(nid, "codex")]), () => {}, 0, base);
    sampler.armFor("codex");
    await settle();
    assert.equal(readToolUse(db, nid, "call_h"), null); // no timer ever started

    sampler.flushFor(bridge(nid, "codex"));
    assert.equal(readToolUse(db, nid, "call_h")?.name, "shell");
    sampler.stop();
  });

  it("releases a narrative's cursor when its last bridge closes", () => {
    // A revive re-reads from zero, which the row-level guard makes cheap — the
    // point is not to hold cursors for narratives that are gone.
    const db = createTestDb();
    const nid = seedNarrative(db);
    const base = newBase();
    writeFileSync(
      rolloutPath(base, "samp-9"),
      sessionMeta("samp-9") + toolCall("call_i", "shell", "{}") + toolOutput("call_i", "ok"),
    );
    seedSession(db, nid, "samp-9");

    const pushed: ToolUseRow[] = [];
    const sampler = startCodexToolSampler(db, new Set(), (r) => pushed.push(r), 0, base);
    sampler.flushFor(bridge(nid, "codex"));
    assert.equal(pushed.length, 2);

    sampler.release(nid);
    // Cursor gone, so the file is replayed — but nothing changed, so the guard
    // rewrites no row and re-pushes nothing.
    sampler.flushFor(bridge(nid, "codex"));
    assert.equal(pushed.length, 2);
    sampler.stop();
  });
});
