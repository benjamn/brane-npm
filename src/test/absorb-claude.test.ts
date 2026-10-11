/**
 * `brane absorb claude` — the Claude Code session store as an absorb source.
 *
 * Fixtures are written by the test into a temp dir rather than read from the
 * checkout, for two reasons: real sessions hold private content, and `brane
 * doctor` runs this suite from the tarball, where no fixture file would be.
 * Each fixture is the smallest JSONL that reproduces one thing the parser or
 * the inserter has to get right.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb } from "./helpers.js";
import {
  parseClaudeSession,
  surveyClaudeSessions,
  claudeIdentity,
  claudeCodeSource,
  classifyUserBlock,
} from "../absorb/claude-code.js";
import { createAbsorbContext, absorbOne } from "../absorb/index.js";
import { classifySessions, surveyAbsorbSources } from "../absorb/sources.js";
import { deriveBraneId } from "../absorb/brane-id.js";
import { runAbsorb, selectSessions, parseSince, resetAbsorbedNarrative, liveContributions, AbsorbInputError, type AbsorbEvent } from "../absorb/run.js";
import { formatSurvey, formatSummary } from "../commands/absorb.js";
import { SCHEMA_SQL, applyMigrations } from "../db/schema.js";
import Database from "better-sqlite3";
import type { SessionCandidate } from "../absorb/types.js";

// ---- fixture builders -----------------------------------------------------

type Rec = Record<string, unknown>;
const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function user(uuid: string, parent: string | null, text: string, at: number, extra: Rec = {}): Rec {
  return {
    type: "user", uuid, parentUuid: parent, isSidechain: false, timestamp: iso(at),
    cwd: "/home/me/dev/app", sessionId: "S", version: "2.1.0", gitBranch: "main",
    message: { role: "user", content: text }, ...extra,
  };
}
function assistant(uuid: string, parent: string, content: unknown[], at: number, extra: Rec = {}): Rec {
  return {
    type: "assistant", uuid, parentUuid: parent, isSidechain: false, timestamp: iso(at),
    cwd: "/home/me/dev/app", sessionId: "S", version: "2.1.0", gitBranch: "main", requestId: "req_" + uuid,
    message: { model: "claude-opus-5", id: "msg_" + uuid, type: "message", role: "assistant", content, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    ...extra,
  };
}
function toolResult(uuid: string, parent: string, toolUseId: string, output: unknown, at: number, isError = false): Rec {
  return {
    type: "user", uuid, parentUuid: parent, isSidechain: false, timestamp: iso(at),
    cwd: "/home/me/dev/app", sessionId: "S", version: "2.1.0",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: output, ...(isError ? { is_error: true } : {}) }] },
    toolUseResult: output,
  };
}
const jsonl = (recs: Rec[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** A message sent while a turn was running, as the harness records its
 *  delivery: an `attachment` written where the agent read it, stamped with
 *  the time it was typed (`at`). Real records from 2.1.23 on carry a
 *  `source_uuid`; task notifications carry no `origin`. */
function queued(uuid: string, parent: string, prompt: unknown, at: number, commandMode = "prompt", extra: Rec = {}): Rec {
  return {
    type: "attachment", uuid, parentUuid: parent, isSidechain: false, timestamp: iso(at),
    cwd: "/home/me/dev/app", sessionId: "S", version: "2.1.24",
    attachment: {
      type: "queued_command", prompt, commandMode, timestamp: iso(at),
      ...(commandMode === "prompt" ? { origin: { kind: "human" }, source_uuid: "src-" + uuid } : {}),
    },
    ...extra,
  };
}
function queueOp(operation: string, at: number, content?: string, reason?: string): Rec {
  return { type: "queue-operation", operation, timestamp: iso(at), sessionId: "S", ...(content ? { content } : {}), ...(reason ? { reason } : {}) };
}

/** A session in which the operator spoke mid-turn: the question "also check
 *  the lockfile" was typed at 1500 while a build ran, and read by the agent
 *  when the build's result came back at 3000. A second message was queued
 *  and then popped back into the editor — cancelled, never delivered. */
function midTurnSession(): Rec[] {
  return [
    user("u1", null, "Why does the build fail?", 0),
    assistant("a1", "u1", [
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "npm run build" } },
    ], 1000),
    queueOp("enqueue", 1500, "also check the lockfile"),
    toolResult("r1", "a1", "toolu_01", "error TS2322 in foo.ts", 3000),
    queued("q1", "r1", "also check the lockfile", 1500),
    queueOp("remove", 3001, "also check the lockfile", "absorbed_mid_turn"),
    assistant("a2", "q1", [{ type: "text", text: "A type error in foo.ts, and the lockfile is fine." }], 5000),
    queueOp("enqueue", 5500, "never mind"),
    queueOp("popAll", 5600),
  ];
}

/** A 1×1 PNG, as the harness writes a pasted image: base64 in the record. */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
function image(mediaType = "image/png", data = PNG_1PX): Rec {
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

/** A plain session: prompt, text + tool call, result, answer, retitled. */
function plainSession(): Rec[] {
  return [
    { type: "mode", mode: "default", sessionId: "S" },
    { type: "permission-mode", permissionMode: "default", sessionId: "S" },
    user("u1", null, "Why does the build fail?", 0),
    { type: "ai-title", aiTitle: "Build failure", sessionId: "S" },
    { type: "attachment", uuid: "att1", parentUuid: "u1", isSidechain: false, timestamp: iso(500), attachment: { type: "deferred_tools_delta" }, cwd: "/home/me/dev/app", sessionId: "S" },
    assistant("a1", "u1", [
      { type: "thinking", thinking: "private scratch", signature: "x" },
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "npm run build" } },
    ], 1000),
    toolResult("r1", "a1", "toolu_01", "error TS2322 in foo.ts", 4000),
    assistant("a2", "r1", [{ type: "text", text: "A type error in foo.ts." }], 5000),
    { type: "ai-title", aiTitle: "Build failure: TS2322 in foo.ts", sessionId: "S" },
    { type: "last-prompt", lastPrompt: "Why does the build fail?", leafUuid: "a2", sessionId: "S" },
  ];
}

function candidateFor(path: string, id = "S"): SessionCandidate {
  return { externalId: id, path, cwd: "/home/me/dev/app", startedAt: T0, updatedAt: T0 + 5000, bytes: 1 };
}

function tempStore(): string {
  return mkdtempSync(join(tmpdir(), "brane-claude-store-"));
}

/** Write a session into `<root>/<project>/<id>.jsonl` with a fixed mtime. */
function writeSession(root: string, project: string, id: string, recs: Rec[], mtimeMs = T0 + 5000): string {
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, jsonl(recs));
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

// ---- the parser -----------------------------------------------------------

describe("parseClaudeSession", () => {
  it("keeps the conversation, drops the bookkeeping, and takes the newest title", () => {
    const conv = parseClaudeSession(jsonl(plainSession()), candidateFor("/x/S.jsonl"))!;
    assert.equal(conv.externalId, "S");
    assert.equal(conv.title, "Build failure: TS2322 in foo.ts");
    assert.equal(conv.cwd, "/home/me/dev/app");
    assert.equal(conv.model, "claude-opus-5");
    assert.deepEqual(
      conv.messages.map((m) => [m.role, m.content, m.key]),
      [
        ["user", "Why does the build fail?", "u1"],
        ["assistant", "Let me look.", "a1"],
        ["assistant", "A type error in foo.ts.", "a2"],
      ],
    );
    assert.equal(conv.createdAt, T0);
    assert.equal(conv.updatedAt, T0 + 5000);
    // thinking blocks are not voice
    assert.ok(!conv.messages.some((m) => m.content.includes("private scratch")));
  });

  it("pairs a tool_use with its tool_result: output, status, duration, anchor", () => {
    const conv = parseClaudeSession(jsonl(plainSession()), candidateFor("/x/S.jsonl"))!;
    assert.equal(conv.toolCalls!.length, 1);
    const call = conv.toolCalls![0];
    assert.equal(call.key, "toolu_01");
    assert.equal(call.name, "Bash");
    assert.deepEqual(call.input, { command: "npm run build" });
    assert.equal(call.output, "error TS2322 in foo.ts");
    assert.equal(call.status, "completed");
    assert.equal(call.startedAt, T0 + 1000);
    assert.equal(call.durationMs, 3000);
    assert.equal(call.afterMessage, 1); // after "Let me look."
  });

  it("marks an is_error result failed and an unanswered call unknown", () => {
    const recs = [
      user("u1", null, "go", 0),
      assistant("a1", "u1", [
        { type: "tool_use", id: "toolu_bad", name: "Bash", input: { command: "false" } },
        { type: "tool_use", id: "toolu_open", name: "Read", input: { file_path: "/x" } },
      ], 1000),
      toolResult("r1", "a1", "toolu_bad", "exit 1", 2000, true),
    ];
    const conv = parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!;
    const byKey = Object.fromEntries(conv.toolCalls!.map((c) => [c.key, c.status]));
    assert.deepEqual(byKey, { toolu_bad: "failed", toolu_open: "unknown" });
    // a call before any message anchors at -1
    assert.equal(conv.toolCalls![0].afterMessage, 0); // after the user prompt
  });

  it("ignores injected user text, sidechain turns, and tool-result-only records as messages", () => {
    const recs = [
      user("u0", null, "<system-reminder>injected</system-reminder>", 0),
      user("u1", "u0", "real prompt", 100),
      user("m1", "u1", "harness note", 200, { isMeta: true }),
      user("s1", "u1", "subagent prompt", 300, { isSidechain: true }),
      assistant("s2", "s1", [{ type: "text", text: "subagent answer" }], 400, { isSidechain: true }),
      assistant("a1", "u1", [{ type: "text", text: "answer" }], 500),
    ];
    const conv = parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!;
    assert.deepEqual(conv.messages.map((m) => m.content), ["real prompt", "answer"]);
  });

  it("keeps a pasted image as an attachment, and a companion image the isMeta rule would otherwise drop", () => {
    const recs = [
      user("u1", null, "hello", 0),
      user("u2", "u1", "", 100, { message: { role: "user", content: [{ type: "text", text: "[Image #1] what is this?" }, image()] }, imagePasteIds: [1] }),
      // In the store a companion's parent is a hook `attachment` record the parser never sees.
      user("m1", "att-hook-1", "", 200, { isMeta: true, turnCompanion: true, message: { role: "user", content: [image("image/jpeg", "/9j/4AAQ")] } }),
      user("m2", "m1", "harness note", 300, { isMeta: true }),
      assistant("a1", "m1", [{ type: "text", text: "a picture" }], 400),
    ];
    const conv = parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!;
    assert.deepEqual(
      conv.messages.map((m) => [m.content, m.attachments?.map((a) => a.mediaType) ?? null]),
      [
        ["hello", null],
        ["[Image #1] what is this?", ["image/png"]],
        ["(attachment)", ["image/jpeg"]], // image with no words: the web app's own placeholder
        ["a picture", null],
      ],
    );
    assert.equal(conv.messages[1].attachments![0].data, PNG_1PX);
    assert.deepEqual(conv.messages.map((m) => m.re ?? null), [null, null, null, null]); // an unseen parent threads nothing
  });

  it("threads a branch point with re and leaves a straight line unadorned", () => {
    const recs = [
      user("u1", null, "one", 0),
      assistant("a1", "u1", [{ type: "text", text: "two" }], 1000),
      user("u2", "u1", "three, branching from one", 2000), // parent is u1, not a1
      assistant("a2", "u2", [{ type: "text", text: "four" }], 3000),
    ];
    const conv = parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!;
    assert.deepEqual(conv.messages.map((m) => m.re ?? null), [null, null, [1], null]);
  });

  it("renders a compaction summary as a system message and falls back to the first prompt for a title", () => {
    const recs = [
      user("u1", null, "first line of the prompt\nsecond line", 0),
      user("c1", "u1", "Summary of everything so far", 1000, { isCompactSummary: true }),
    ];
    const conv = parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!;
    assert.equal(conv.title, "first line of the prompt");
    assert.deepEqual(conv.messages.map((m) => m.role), ["user", "system"]);
  });

  it("returns null for a file with no conversation and survives a torn last line", () => {
    assert.equal(parseClaudeSession(jsonl([{ type: "mode", mode: "default", sessionId: "S" }]), candidateFor("/x/S.jsonl")), null);
    const torn = jsonl([user("u1", null, "hi", 0)]) + '{"type":"assistant","uuid":"a1","mess';
    const conv = parseClaudeSession(torn, candidateFor("/x/S.jsonl"))!;
    assert.equal(conv.messages.length, 1);
  });

  it("reads a message sent mid-turn from its delivery receipt, where the agent read it; a cancelled one stays out", () => {
    const conv = parseClaudeSession(jsonl(midTurnSession()), candidateFor("/x/S.jsonl"))!;
    assert.deepEqual(
      conv.messages.map((m) => [m.role, m.content, m.key, m.time - T0]),
      [
        ["user", "Why does the build fail?", "u1", 0],
        ["assistant", "Let me look.", "a1", 1000],
        ["user", "also check the lockfile", "q1", 1500], // after the result it waited on, at the time it was typed
        ["assistant", "A type error in foo.ts, and the lockfile is fine.", "a2", 5000],
      ],
    );
    assert.ok(!conv.messages.some((m) => m.content.includes("never mind")), "queued then cancelled: no receipt, no message");
    assert.equal(conv.toolCalls![0].afterMessage, 1);
  });

  it("routes a queued task notification to a tool row, and leaves unknown modes and subagent queues alone", () => {
    const note = "<task-notification>\n<task-id>bg1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n<result>ok</result>\n</task-notification>";
    const recs = [
      user("u1", null, "run it in the background", 0),
      assistant("a1", "u1", [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "sleep 1", run_in_background: true } }], 100),
      toolResult("r1", "a1", "toolu_bg", "running", 200),
      queued("q1", "r1", note, 300, "task-notification"),
      queued("q2", "q1", "not a mode this parser knows", 400, "some-future-mode"),
      queued("q3", "q2", "a subagent's queue", 450, "prompt", { isSidechain: true }),
      queued("q4", "q2", [{ type: "text", text: "[Image #1] and this" }, image()], 500),
      { type: "attachment", uuid: "h1", parentUuid: "q4", isSidechain: false, timestamp: iso(550), attachment: { type: "hook_non_blocking_error" } },
      assistant("a2", "q4", [{ type: "text", text: "done" }], 600),
    ];
    const conv = parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!;
    assert.deepEqual(conv.messages.map((m) => [m.content, m.attachments?.length ?? 0]), [
      ["run it in the background", 0],
      ["[Image #1] and this", 1],
      ["done", 0],
    ]);
    const note1 = conv.toolCalls!.find((c) => c.name === "task-notification")!;
    assert.deepEqual([note1.key, note1.parentKey, note1.status, note1.afterMessage], ["task:q1", "toolu_bg", "completed", 0]);
  });

  it("titles a session by its first words, not by the slash command that opened it", () => {
    const recs = [
      user("u0", null, "<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>", 0),
      user("u1", "u0", "Why does the build fail?", 100),
    ];
    assert.equal(parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!.title, "Why does the build fail?");
    // Nothing but commands: the command is still better than no title.
    assert.equal(parseClaudeSession(jsonl(recs.slice(0, 1)), candidateFor("/x/S.jsonl"))!.title, "`/clear`");
  });
});

// ---- the survey -----------------------------------------------------------

describe("surveyClaudeSessions", () => {
  it("lists every session file with cwd and start from the head, skipping agent-* transcripts", () => {
    const root = tempStore();
    writeSession(root, "-home-me-dev-app", "aaaa", plainSession());
    writeSession(root, "-home-me-dev-app", "agent-zzzz", plainSession()); // subagent, not a session
    writeSession(root, "-home-me-dev-other", "bbbb", [
      { type: "mode", mode: "default", sessionId: "bbbb" },
      user("u1", null, "hello", 0, { cwd: "/home/me/dev/other" }),
    ]);
    const found = surveyClaudeSessions(root).sort((a, b) => a.externalId.localeCompare(b.externalId));
    assert.deepEqual(found.map((c) => [c.externalId, c.cwd, c.startedAt]), [
      ["aaaa", "/home/me/dev/app", T0],
      ["bbbb", "/home/me/dev/other", T0],
    ]);
    assert.ok(found.every((c) => c.bytes > 0 && c.updatedAt > 0));
  });

  it("locates nothing on a home without the store, and reads the account from ~/.claude.json", () => {
    const home = tempStore();
    assert.equal(claudeCodeSource.locate(home), null);
    assert.equal(claudeIdentity(home).id.length > 0, true); // OS user fallback
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct-1", emailAddress: "me@example.com" } }));
    assert.equal(claudeCodeSource.locate(home), join(home, ".claude", "projects"));
    assert.deepEqual(claudeIdentity(home), { id: "acct-1", email: "me@example.com", label: "me@example.com" });
  });
});

describe("selectSessions / parseSince", () => {
  const cands: SessionCandidate[] = [
    { externalId: "abc-1", path: "/p/abc-1.jsonl", cwd: "/home/me/dev/app", startedAt: T0, updatedAt: T0 + 1000, bytes: 1 },
    { externalId: "abd-2", path: "/p/abd-2.jsonl", cwd: "/home/me/dev/other", startedAt: T0, updatedAt: T0 + 100_000, bytes: 1 },
  ];
  it("filters by fold (cwd), since (mtime), and session (id or prefix)", () => {
    assert.deepEqual(selectSessions(cands, { fold: "/home/me/dev/app" }).map((c) => c.externalId), ["abc-1"]);
    assert.deepEqual(selectSessions(cands, { since: "1m" }, T0 + 120_000).map((c) => c.externalId), ["abd-2"]);
    assert.deepEqual(selectSessions(cands, { session: "abd" }).map((c) => c.externalId), ["abd-2"]);
    assert.deepEqual(selectSessions(cands, { session: "abc-1" }).map((c) => c.externalId), ["abc-1"]);
    assert.throws(() => selectSessions(cands, { session: "ab" }), AbsorbInputError);
  });
  it("reads durations and dates", () => {
    assert.equal(parseSince("2w", T0), T0 - 14 * 86_400_000);
    assert.equal(parseSince("2026-09-01T00:00:00Z"), Date.parse("2026-09-01T00:00:00Z"));
    assert.throws(() => parseSince("yesterday"), AbsorbInputError);
  });
});

// ---- the inserter ---------------------------------------------------------

describe("absorbOne with keyed messages", () => {
  it("writes messages as events, tool calls as tool_uses rows beside their message, and is idempotent", () => {
    const db = createTestDb();
    const conv = parseClaudeSession(jsonl(plainSession()), candidateFor("/x/S.jsonl"))!;
    const ctx = createAbsorbContext(db, "claude", "brane-claude-1", "~/store", { id: "acct", label: "me@x" }, false);

    assert.equal(absorbOne(ctx, conv), "inserted");
    const nid = (db.prepare("SELECT id, fold_path, role, agent_session_id FROM narratives").get() as { id: string; fold_path: string; role: string; agent_session_id: string });
    assert.match(nid.id, /^claude-[0-9a-z]{8}$/);
    assert.equal(nid.role, "absorbed");
    assert.equal(nid.agent_session_id, "S");
    assert.equal(nid.fold_path, "/home/me/dev/app"); // the session's own cwd, verbatim
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM folds").get() as { n: number }).n, 0); // never registered

    const events = db.prepare("SELECT seq, type, source, content FROM events WHERE narrative_id = ? ORDER BY seq").all(nid.id) as Array<{ seq: number; type: string; source: string; content: string }>;
    assert.deepEqual(events.map((e) => [e.seq, e.type, e.source]), [
      [1, "human_signal", "claude:me@x"],
      [2, "narration", "claude"],
      [3, "narration", "claude"],
    ]);
    const rows = db.prepare("SELECT dedup_key, name, after_seq, status, output, duration_ms, source, agent_type FROM tool_uses").all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [{
      dedup_key: "toolu_01", name: "Bash", after_seq: 2, status: "completed",
      output: "error TS2322 in foo.ts", duration_ms: 3000, source: "absorb", agent_type: "claude",
    }]);
    assert.equal(ctx.summary.toolCalls, 1);

    // Same file again: nothing new, nothing duplicated, no rev bump.
    const revBefore = (db.prepare("SELECT rev FROM tool_uses").get() as { rev: number }).rev;
    assert.equal(absorbOne(ctx, conv), "skipped");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 3);
    assert.equal((db.prepare("SELECT rev FROM tool_uses").get() as { rev: number }).rev, revBefore);
    assert.equal(ctx.summary.conversations, 1);
    assert.equal(ctx.summary.skipped, 1);
    db.close();
  });

  it("writes an inline attachment to payload storage and the payloads column, and only counts it on a dry run", () => {
    const root = mkdtempSync(join(tmpdir(), "brane-payloads-"));
    const payloadsDir = (nid: string) => {
      const dir = join(root, nid);
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    const recs = [
      user("u1", null, "", 0, { message: { role: "user", content: [{ type: "text", text: "[Image #1]" }, image()] } }),
      assistant("a1", "u1", [{ type: "text", text: "a dot" }], 1000),
    ];
    const db = createTestDb();
    const ctx = createAbsorbContext(db, "claude", "brane-claude-1", "~/store", undefined, false, undefined, { payloadsDir });
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!), "inserted");
    const row = db.prepare("SELECT narrative_id, payloads FROM events WHERE seq = 1").get() as { narrative_id: string; payloads: string };
    const paths = JSON.parse(row.payloads) as string[];
    assert.deepEqual(paths, [`${row.narrative_id}/${T0}_1_0.png`]);
    assert.deepEqual(readFileSync(join(root, paths[0])), Buffer.from(PNG_1PX, "base64"));
    assert.equal(ctx.summary.assets, 1);
    assert.equal(ctx.summary.assetsBytes, Buffer.from(PNG_1PX, "base64").length);
    assert.equal(ctx.summary.unresolvedAssets, 0);
    // The same file again is a skipped conversation: nothing rewritten, nothing recounted.
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!), "skipped");
    assert.equal(ctx.summary.assets, 1);
    db.close();

    const dry = createAbsorbContext(createTestDb(), "claude", "brane-claude-1", "~/store", undefined, true, undefined, {
      payloadsDir: () => { throw new Error("a dry run must not touch payload storage"); },
    });
    assert.equal(absorbOne(dry, parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!), "inserted");
    assert.equal(dry.summary.assets, 1);
    assert.equal(dry.summary.assetsBytes, Buffer.from(PNG_1PX, "base64").length);
  });

  it("a failed attachment write costs that one image, not the message or the import", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "brane-payloads-")), "never-created");
    const db = createTestDb();
    const ctx = createAbsorbContext(db, "claude", "brane-claude-1", "~/store", undefined, false, undefined, { payloadsDir: () => missing });
    const recs = [
      user("u1", null, "", 0, { message: { role: "user", content: [{ type: "text", text: "[Image #1]" }, image()] } }),
      assistant("a1", "u1", [{ type: "text", text: "a dot" }], 1000),
    ];
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!), "inserted");
    const rows = db.prepare("SELECT content, payloads FROM events ORDER BY seq").all() as Array<{ content: string; payloads: string | null }>;
    assert.deepEqual(rows, [{ content: "[Image #1]", payloads: null }, { content: "a dot", payloads: null }]);
    assert.equal(ctx.summary.assets, 0);
    assert.equal(ctx.summary.unresolvedAssets, 1);
    db.close();
  });

  it("appends only the messages a grown file added, with their tool calls", () => {
    const db = createTestDb();
    const ctx = createAbsorbContext(db, "claude", "brane-claude-1", "~/store", undefined, false);
    const recs = plainSession();
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!), "inserted");
    recs.push(
      user("u2", "a2", "And the fix?", 6000),
      assistant("a3", "u2", [{ type: "tool_use", id: "toolu_02", name: "Edit", input: { file_path: "foo.ts" } }], 7000),
      toolResult("r2", "a3", "toolu_02", "ok", 7500),
      assistant("a4", "r2", [{ type: "text", text: "Cast it." }], 8000),
    );
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!), "appended");
    const events = db.prepare("SELECT seq, content FROM events ORDER BY seq").all() as Array<{ seq: number; content: string }>;
    assert.deepEqual(events.map((e) => e.content), [
      "Why does the build fail?", "Let me look.", "A type error in foo.ts.", "And the fix?", "Cast it.",
    ]);
    const calls = db.prepare("SELECT dedup_key, after_seq FROM tool_uses ORDER BY after_seq").all();
    assert.deepEqual(calls, [{ dedup_key: "toolu_01", after_seq: 2 }, { dedup_key: "toolu_02", after_seq: 4 }]);
    assert.equal(ctx.summary.appended, 1);
    db.close();
  });

  it("appends a message an earlier parser skipped at the tail, re its place, and moves no seq", () => {
    const db = createTestDb();
    const ctx = createAbsorbContext(db, "claude", "brane-claude-1", "~/store", undefined, false);
    // What an import that did not read queued turns wrote: everything but q1.
    const full = midTurnSession();
    const old = full.filter((r) => r.uuid !== "q1");
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(old), candidateFor("/x/S.jsonl"))!), "inserted");
    const nid = (db.prepare("SELECT id FROM narratives").get() as { id: string }).id;
    const before = db.prepare("SELECT seq, content FROM events ORDER BY seq").all();

    // The same file read again by this parser, grown by one more turn.
    full.push(user("u3", "a2", "thanks", 6000));
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(full), candidateFor("/x/S.jsonl"))!), "appended");
    const events = db.prepare("SELECT seq, content, re FROM events ORDER BY seq").all() as Array<{ seq: number; content: string; re: string | null }>;
    assert.deepEqual(events.slice(0, 3).map((e) => ({ seq: e.seq, content: e.content })), before, "every seq anyone cited still says what it said");
    assert.deepEqual(events.slice(3).map((e) => [e.seq, e.content, e.re]), [
      [4, "also check the lockfile", JSON.stringify([2])], // late: re the message it follows
      [5, "thanks", null], // new at the end: in place, unadorned
    ]);
    assert.deepEqual(
      (db.prepare("SELECT key, seq FROM absorb_messages WHERE narrative_id = ? ORDER BY seq").all(nid) as Array<{ key: string; seq: number }>).map((r) => r.key),
      ["u1", "a1", "a2", "q1", "u3"],
    );
    db.close();
  });

  it("treats a fork-copied prefix as a continuation: no duplicate, first new message re's the predecessor", () => {
    const db = createTestDb();
    const ctx = createAbsorbContext(db, "claude", "brane-claude-1", "~/store", undefined, false);
    const pred = plainSession();
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(pred), candidateFor("/x/S.jsonl", "S"))!), "inserted");
    const predNid = (db.prepare("SELECT id FROM narratives").get() as { id: string }).id;

    // The successor's file is the predecessor's records verbatim, then more.
    const succ = [
      ...pred,
      user("u9", "a2", "continuing after the fork", 9000),
      assistant("a9", "u9", [{ type: "text", text: "still here" }], 9500),
    ];
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(succ), candidateFor("/x/F.jsonl", "F"))!), "inserted");
    const succNid = (db.prepare("SELECT id FROM narratives WHERE agent_session_id = 'F'").get() as { id: string }).id;
    const events = db.prepare("SELECT seq, content, re FROM events WHERE narrative_id = ? ORDER BY seq").all(succNid) as Array<{ seq: number; content: string; re: string | null }>;
    assert.deepEqual(events.map((e) => [e.seq, e.content, e.re]), [
      [1, "continuing after the fork", JSON.stringify([`${predNid}:3`])],
      [2, "still here", null],
    ]);
    // The prefix's tool call stayed with the predecessor; none was copied.
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tool_uses WHERE narrative_id = ?").get(succNid) as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 5);

    // A pure copy — a fork with nothing after it — is not a narrative at all.
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(pred), candidateFor("/x/G.jsonl", "G"))!), "skipped");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM narratives").get() as { n: number }).n, 2);
    db.close();
  });

  it("never appends to a live narrative that holds the same session id", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at, agent_session_id) VALUES ('claude-live0001', 'brane-test', 'claude', 'worker', 'active', '/tmp', ?, 'S')",
    ).run(Date.now());
    const ctx = createAbsorbContext(db, "claude", "brane-claude-1", "~/store", undefined, false);
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(plainSession()), candidateFor("/x/S.jsonl"))!), "inserted");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE narrative_id = 'claude-live0001'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM narratives WHERE role = 'absorbed'").get() as { n: number }).n, 1);
    db.close();
  });

  it("plans a dry run identically and writes nothing", () => {
    const db = createTestDb();
    const ctx = createAbsorbContext(db, "claude", "brane-claude-1", "~/store", undefined, true);
    assert.equal(absorbOne(ctx, parseClaudeSession(jsonl(plainSession()), candidateFor("/x/S.jsonl"))!), "inserted");
    assert.equal(ctx.summary.conversations, 1);
    assert.equal(ctx.summary.messages, 3);
    assert.equal(ctx.summary.toolCalls, 1);
    for (const t of ["narratives", "events", "tool_uses", "absorb_messages"]) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t);
    }
    db.close();
  });
});

// ---- classification and the survey ---------------------------------------

describe("classifySessions / surveyAbsorbSources", () => {
  it("tells managed, absorbed-unchanged, absorbed-changed and new apart", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at, session_ids) VALUES ('claude-live0001', 'brane-test', 'claude', 'worker', 'active', '/tmp', ?, '[\"M1\",\"M2\"]')",
    ).run(Date.now());
    db.prepare(
      "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at, agent_session_id) VALUES ('claude-absorbed', 'brane-claude-1', 'claude', 'absorbed', 'ended', '/tmp', ?, 'A1')",
    ).run(Date.now());
    db.prepare("INSERT INTO absorb_files (brane_id, provider, external_id, path, bytes, mtime, absorbed_at, parser_version) VALUES ('brane-claude-1', 'claude', 'A1', '/p', 10, 1000, 1, ?)").run(claudeCodeSource.parserVersion);
    const cands: SessionCandidate[] = [
      { externalId: "M2", path: "/p", cwd: null, startedAt: null, updatedAt: 1, bytes: 1 },
      { externalId: "A1", path: "/p", cwd: null, startedAt: null, updatedAt: 1000, bytes: 10 },
      { externalId: "N1", path: "/p", cwd: null, startedAt: null, updatedAt: 1, bytes: 1 },
    ];
    const st = classifySessions(db, claudeCodeSource, cands, "brane-claude-1");
    assert.deepEqual(st.get("M2"), { managedBy: "claude-live0001", absorbedBy: null, unchanged: false, reparse: false });
    assert.deepEqual(st.get("A1"), { managedBy: null, absorbedBy: "claude-absorbed", unchanged: true, reparse: false });
    assert.deepEqual(st.get("N1"), { managedBy: null, absorbedBy: null, unchanged: false, reparse: false });
    cands[1].bytes = 11; // grown
    assert.equal(classifySessions(db, claudeCodeSource, cands, "brane-claude-1").get("A1")!.unchanged, false);
    cands[1].bytes = 10;
    // The same bytes, last read by an older parser: worth reading again.
    db.prepare("UPDATE absorb_files SET parser_version = ? WHERE external_id = 'A1'").run(claudeCodeSource.parserVersion - 1);
    assert.deepEqual(classifySessions(db, claudeCodeSource, cands, "brane-claude-1").get("A1"), {
      managedBy: null, absorbedBy: "claude-absorbed", unchanged: false, reparse: true,
    });
    // Another brane has absorbed nothing: A1 is new there, M2 is still managed.
    const other = classifySessions(db, claudeCodeSource, cands, "brane-claude-2");
    assert.deepEqual(other.get("A1"), { managedBy: null, absorbedBy: null, unchanged: false, reparse: false });
    assert.equal(other.get("M2")!.managedBy, "claude-live0001");
    db.close();
  });

  it("surveys a home: counts per source, probes listed only when found, nothing read", () => {
    const db = createTestDb();
    const home = tempStore();
    const root = join(home, ".claude", "projects");
    writeSession(root, "-home-me-dev-app", "aaaa", plainSession());
    writeSession(root, "-home-me-dev-app", "bbbb", plainSession());
    mkdirSync(join(home, ".codex", "sessions", "2026"), { recursive: true });

    const survey = surveyAbsorbSources(db, home);
    const claude = survey.sources.find((s) => s.name === "claude")!;
    assert.equal(claude.found, true);
    assert.equal(claude.sessions!.total, 2);
    assert.equal(claude.sessions!.new, 2);
    assert.equal(claude.sessions!.folds, 1);
    const codex = survey.sources.find((s) => s.name === "codex")!;
    assert.equal(codex.found, true);
    assert.equal(codex.supported, false);
    assert.equal(survey.sources.find((s) => s.name === "amp")!.found, false);

    const lines = formatSurvey(survey);
    assert.ok(lines.some((l) => /Claude Code sessions\s+2 sessions/.test(l)));
    assert.ok(lines.some((l) => l.includes("2 new")));
    assert.ok(lines.some((l) => l.includes("brane absorb claude --dry-run")));
    assert.ok(lines.some((l) => l.includes("Codex CLI rollouts")));
    assert.ok(!lines.some((l) => l.includes("Amp")));
    assert.ok(lines[lines.length - 1].startsWith("Nothing was read or imported."));
    db.close();
  });

  it("surveys a file an older parser read as its own bucket, not as changed", () => {
    const db = createTestDb();
    const home = tempStore();
    const root = join(home, ".claude", "projects");
    const path = writeSession(root, "-home-me-dev-app", "aaaa", plainSession());
    const brane = deriveBraneId("claude", claudeIdentity(home).id);
    db.prepare(
      "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at, agent_session_id) VALUES ('claude-absorbed', ?, 'claude', 'absorbed', 'ended', '/tmp', 1, 'aaaa')",
    ).run(brane);
    const st = statSync(path);
    db.prepare(
      "INSERT INTO absorb_files (brane_id, provider, external_id, path, bytes, mtime, absorbed_at, parser_version) VALUES (?, 'claude', 'aaaa', ?, ?, ?, 1, 0)",
    ).run(brane, path, st.size, Math.floor(st.mtimeMs));
    const survey = surveyAbsorbSources(db, home);
    const n = survey.sources.find((s) => s.name === "claude")!.sessions!;
    assert.deepEqual([n.new, n.changed, n.unchanged, n.reparse], [0, 0, 0, 1]);
    const lines = formatSurvey(survey);
    assert.ok(lines.some((l) => l.includes("1 to re-read (newer parser)")));
    assert.ok(lines.some((l) => l.includes("brane absorb claude --dry-run")), "worth an import, so the hint is shown");
    db.close();
  });
});

// ---- the runner -----------------------------------------------------------

describe("runAbsorb claude", () => {
  const savedHome = process.env.HOME;

  it("imports a store end to end, skips managed and unchanged on the second run, and honours --session", async () => {
    const db = createTestDb();
    const home = tempStore();
    process.env.HOME = home;
    try {
      const root = join(home, ".claude", "projects");
      writeSession(root, "-home-me-dev-app", "aaaa", plainSession());
      const bPath = writeSession(root, "-home-me-dev-app", "bbbb", [user("b-u1", null, "solo", 0), assistant("b-a1", "b-u1", [{ type: "text", text: "yes" }], 1000)]);
      writeSession(root, "-home-me-dev-app", "mmmm", plainSession());
      db.prepare(
        "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at, agent_session_id) VALUES ('claude-live0001', 'brane-test', 'claude', 'worker', 'active', '/tmp', ?, 'mmmm')",
      ).run(Date.now());

      const events: AbsorbEvent[] = [];
      const emit = (e: AbsorbEvent) => events.push(e);
      const opts = { confineFoldsToHome: false };

      const s1 = await runAbsorb(db, { provider: "claude" }, emit, opts);
      assert.equal(s1.conversations, 2);
      assert.equal(s1.managed, 1);
      assert.equal(s1.unchanged, 0);
      assert.equal(s1.toolCalls, 1);
      const summary = events.find((e) => e.type === "summary")!;
      assert.equal(summary.type === "summary" && summary.brane_id.startsWith("brane-claude-"), true);
      assert.deepEqual(summary.type === "summary" ? summary.fold_paths : [], ["/home/me/dev/app"]);
      assert.ok(events.some((e) => e.type === "info" && /Managed by brane: 1/.test(e.message)));
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM absorb_files").get() as { n: number }).n, 2);

      // Second run: both files unchanged → not even read.
      const s2 = await runAbsorb(db, { provider: "claude" }, () => {}, opts);
      assert.equal(s2.conversations, 0);
      assert.equal(s2.unchanged, 2);
      assert.equal(s2.managed, 1);

      // Grow one file: only it is read, and only its tail is appended.
      appendFileSync(bPath, jsonl([user("b-u2", "b-a1", "more", 2000)]));
      utimesSync(bPath, (T0 + 9000) / 1000, (T0 + 9000) / 1000);
      const s3 = await runAbsorb(db, { provider: "claude" }, () => {}, opts);
      assert.equal(s3.appended, 1);
      assert.equal(s3.unchanged, 1);
      assert.equal(s3.messages, 1);

      // --session narrows; a dry run of an unchanged file reports it as such.
      const s4 = await runAbsorb(db, { provider: "claude", session: "aaaa", dry_run: true }, () => {}, opts);
      assert.equal(s4.unchanged, 1);
      assert.equal(s4.conversations, 0);

      // Formatting covers the new counters.
      const lines = formatSummary(s1, false);
      assert.ok(lines.includes("Tool calls: 1"));
      assert.ok(lines.some((l) => l.startsWith("Managed by brane: 1")));
    } finally {
      process.env.HOME = savedHome;
      db.close();
    }
  });

  it("treats --brane as an independent destination: two branes, two complete copies, each idempotent", async () => {
    const db = createTestDb();
    const home = tempStore();
    process.env.HOME = home;
    try {
      const root = join(home, ".claude", "projects");
      writeSession(root, "-home-me-dev-app", "aaaa", plainSession());
      const opts = { confineFoldsToHome: false };
      const first = await runAbsorb(db, { provider: "claude" }, () => {}, opts);
      assert.equal(first.conversations, 1);
      const check = await runAbsorb(db, { provider: "claude", brane: "brane-claude-check" }, () => {}, opts);
      assert.equal(check.conversations, 1, "the second brane gets its own copy");
      assert.equal(check.unchanged, 0);
      const rows = db.prepare("SELECT brane_id, COUNT(*) n FROM narratives GROUP BY brane_id ORDER BY brane_id").all() as Array<{ brane_id: string; n: number }>;
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.n === 1));
      assert.equal((db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n, 6);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM tool_uses").get() as { n: number }).n, 2);
      // Each brane's re-run is a no-op on its own ledger.
      const again = await runAbsorb(db, { provider: "claude", brane: "brane-claude-check" }, () => {}, opts);
      assert.equal(again.unchanged, 1);
      const againFirst = await runAbsorb(db, { provider: "claude" }, () => {}, opts);
      assert.equal(againFirst.unchanged, 1);
    } finally {
      process.env.HOME = savedHome;
      db.close();
    }
  });

  it("--rebuild re-derives an absorbed narrative in place: same id, fresh events, index reset, managed untouched", async () => {
    const db = createTestDb();
    const home = tempStore();
    process.env.HOME = home;
    try {
      const root = join(home, ".claude", "projects");
      // A session absorbed under the old rendering: simulate by importing a
      // file whose user turn is a raw task notification (what #456 wrote).
      const note = "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>done</summary>\n<result>ok</result>\n</task-notification>";
      const recs = [user("u1", null, "first", 0), user("u2", "u1", note, 100), assistant("a1", "u2", [{ type: "text", text: "reply" }], 200)];
      const path = writeSession(root, "-home-me-dev-app", "aaaa", recs);
      db.prepare(
        "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at, agent_session_id) VALUES ('claude-live0001', 'brane-test', 'claude', 'worker', 'active', '/tmp', ?, 'mmmm')",
      ).run(Date.now());
      writeSession(root, "-home-me-dev-app", "mmmm", plainSession());
      const opts = { confineFoldsToHome: false };
      const first = await runAbsorb(db, { provider: "claude" }, () => {}, opts);
      assert.equal(first.conversations, 1);
      const nid = (db.prepare("SELECT id FROM narratives WHERE role = 'absorbed'").get() as { id: string }).id;
      // Pretend the old rendering: rewrite seq 2 to the raw block and index it.
      db.prepare("UPDATE events SET content = ? WHERE narrative_id = ? AND seq = 2").run(note, nid);
      db.prepare("DELETE FROM tool_uses WHERE narrative_id = ?").run(nid);
      db.exec("CREATE TABLE IF NOT EXISTS memory_chunks (id TEXT PRIMARY KEY, narrative_id TEXT NOT NULL, seq INTEGER NOT NULL, content TEXT NOT NULL, time INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS memory_cursors (narrative_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)");
      db.prepare("INSERT INTO memory_chunks VALUES ('c1', ?, 2, 'stale', 1)").run(nid);
      db.prepare("INSERT INTO memory_cursors VALUES (?, 3)").run(nid);
      // Retitle the file, and grow it, so the rebuild has something to show.
      appendFileSync(path, jsonl([{ type: "ai-title", aiTitle: "Renamed later", sessionId: "aaaa" }]));

      const dry = await runAbsorb(db, { provider: "claude", rebuild: true, dry_run: true }, () => {}, opts);
      assert.equal(dry.rebuilt, 1);
      assert.equal((db.prepare("SELECT content FROM events WHERE narrative_id = ? AND seq = 2").get(nid) as { content: string }).content, note, "dry run wrote nothing");

      const infos: string[] = [];
      const s = await runAbsorb(db, { provider: "claude", rebuild: true }, (e) => { if (e.type === "info") infos.push(e.message); }, opts);
      assert.equal(s.rebuilt, 1);
      assert.equal(s.managed, 1, "the live narrative is never a rebuild candidate");
      assert.ok(infos.some((l) => /Rebuild: 1/.test(l)));
      const n = db.prepare("SELECT id, title FROM narratives WHERE role = 'absorbed'").get() as { id: string; title: string };
      assert.equal(n.id, nid, "same narrative id");
      assert.equal(n.title, "Renamed later", "title refreshed from the file");
      const events = db.prepare("SELECT seq, content FROM events WHERE narrative_id = ? ORDER BY seq").all(nid) as Array<{ seq: number; content: string }>;
      assert.deepEqual(events.map((e) => [e.seq, e.content]), [[1, "first"], [2, "reply"]], "seqs from 1, notification no longer a message");
      assert.equal((db.prepare("SELECT COUNT(*) n FROM tool_uses WHERE narrative_id = ? AND name = 'task-notification'").get(nid) as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM memory_chunks WHERE narrative_id = ?").get(nid) as { n: number }).n, 0);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM memory_cursors WHERE narrative_id = ?").get(nid) as { n: number }).n, 0);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM events WHERE narrative_id = 'claude-live0001'").get() as { n: number }).n, 0);
      // A rebuild of an unchanged store is then a plain re-run.
      const again = await runAbsorb(db, { provider: "claude" }, () => {}, opts);
      assert.equal(again.unchanged, 1);
      assert.equal(again.rebuilt, undefined);
    } finally {
      process.env.HOME = savedHome;
      db.close();
    }
  });

  it("reads an unchanged file again when a newer parser could find more, appending what it finds late", async () => {
    const db = createTestDb();
    const home = tempStore();
    process.env.HOME = home;
    try {
      const root = join(home, ".claude", "projects");
      const opts = { confineFoldsToHome: false };
      // An import by a parser that skipped q1, of the file as it now stands.
      const path = writeSession(root, "-home-me-dev-app", "aaaa", midTurnSession().filter((r) => r.uuid !== "q1"));
      await runAbsorb(db, { provider: "claude" }, () => {}, opts);
      writeSession(root, "-home-me-dev-app", "aaaa", midTurnSession());
      const st = statSync(path);
      db.prepare("UPDATE absorb_files SET bytes = ?, mtime = ?, parser_version = 0").run(st.size, Math.floor(st.mtimeMs));

      const s = await runAbsorb(db, { provider: "claude" }, () => {}, opts);
      assert.equal(s.unchanged, 0, "same bytes, older parser: not unchanged");
      assert.equal(s.appended, 1);
      const events = db.prepare("SELECT seq, content, re FROM events ORDER BY seq").all() as Array<{ seq: number; content: string; re: string | null }>;
      assert.deepEqual(events.map((e) => [e.seq, e.content, e.re]), [
        [1, "Why does the build fail?", null],
        [2, "Let me look.", null],
        [3, "A type error in foo.ts, and the lockfile is fine.", null],
        [4, "also check the lockfile", JSON.stringify([2])],
      ]);
      // Read by the current parser now: the next run skips it on the stat.
      const again = await runAbsorb(db, { provider: "claude" }, () => {}, opts);
      assert.equal(again.unchanged, 1);
    } finally {
      process.env.HOME = savedHome;
      db.close();
    }
  });

  it("--rebuild leaves a narrative that was written into locked in: appended to, never re-derived", async () => {
    const db = createTestDb();
    const home = tempStore();
    process.env.HOME = home;
    try {
      const root = join(home, ".claude", "projects");
      const path = writeSession(root, "-home-me-dev-app", "aaaa", plainSession());
      writeSession(root, "-home-me-dev-app", "bbbb", [user("b-u1", null, "solo", 0), assistant("b-a1", "b-u1", [{ type: "text", text: "yes" }], 1000)]);
      const opts = { confineFoldsToHome: false };
      await runAbsorb(db, { provider: "claude" }, () => {}, opts);
      const nid = (db.prepare("SELECT id FROM narratives WHERE agent_session_id = 'aaaa'").get() as { id: string }).id;
      // The operator signals into the absorbed narrative from the app.
      db.prepare("INSERT INTO events (narrative_id, seq, time, type, content, source) VALUES (?, 4, ?, 'human_signal', 'said in the app', 'web')").run(nid, T0 + 9000);
      appendFileSync(path, jsonl([user("u9", "a2", "grown since", 10000)]));

      const infos: string[] = [];
      const s = await runAbsorb(db, { provider: "claude", rebuild: true }, (e) => { if (e.type === "info") infos.push(e.message); }, opts);
      assert.equal(s.locked, 1);
      assert.equal(s.rebuilt, 1, "the other narrative, which nobody wrote into, is rebuilt");
      assert.ok(infos.some((l) => /Not rebuilt: 1/.test(l)));
      const events = db.prepare("SELECT seq, content, source FROM events WHERE narrative_id = ? ORDER BY seq").all(nid) as Array<{ seq: number; content: string; source: string }>;
      assert.deepEqual(events.map((e) => [e.seq, e.content]), [
        [1, "Why does the build fail?"], [2, "Let me look."], [3, "A type error in foo.ts."],
        [4, "said in the app"], // survives
        [5, "grown since"], // and the file's growth is still read
      ]);
      assert.ok(formatSummary(s, false).some((l) => l.startsWith("Not rebuilt: 1 (") && l.includes("read as an ordinary re-run")));

      // Again, with the file now unchanged: still locked, counted once.
      const again = await runAbsorb(db, { provider: "claude", rebuild: true, dry_run: true }, () => {}, opts);
      assert.equal(again.locked, 1);
      assert.equal(again.unchanged, 0, "a locked session is not also counted as unchanged");
      assert.ok(formatSummary(again, true).some((l) => l.startsWith("Would not rebuild: 1")));
    } finally {
      process.env.HOME = savedHome;
      db.close();
    }
  });

  it("refuses plainly when the store is absent, before emitting", async () => {
    const db = createTestDb();
    const home = tempStore();
    process.env.HOME = home;
    try {
      const emitted: AbsorbEvent[] = [];
      await assert.rejects(
        () => runAbsorb(db, { provider: "claude" }, (e) => emitted.push(e), { confineFoldsToHome: false }),
        (err: unknown) => err instanceof AbsorbInputError && /No claude session store/.test(err.message),
      );
      assert.deepEqual(emitted, []);
    } finally {
      process.env.HOME = savedHome;
      db.close();
    }
  });
});

// ---- what the harness writes into user turns -----------------------------

describe("classifyUserBlock / harness-written user text", () => {

  it("renders a `!` shell command and its output as code, not tags", () => {
    const recs = [
      user("u1", null, "<bash-input>brane absorb claude</bash-input>", 0),
      user("u2", "u1", "<bash-stdout>Store: ~/.claude/projects\nTo read: 1</bash-stdout><bash-stderr></bash-stderr>", 10),
      user("u3", "u2", "<bash-stdout></bash-stdout><bash-stderr>boom</bash-stderr>", 20),
    ];
    const conv = parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!;
    assert.deepEqual(conv.messages.map((m) => m.content), [
      "```sh\n$ brane absorb claude\n```",
      "```\nStore: ~/.claude/projects\nTo read: 1\n```",
      "stderr:\n```\nboom\n```",
    ]);
    assert.ok(conv.messages.every((m) => m.role === "user"));
  });

  it("renders an interrupt as a quiet marker and a slash command as code", () => {
    const recs = [
      user("u1", null, "[Request interrupted by user for tool use]", 0),
      user("u2", "u1", "<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>", 10),
      user("u3", "u2", "<local-command-stdout>Set model to Opus 5</local-command-stdout>", 20),
      user("u4", "u3", "<local-command-stdout></local-command-stdout>", 30),
    ];
    const conv = parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!;
    assert.deepEqual(conv.messages.map((m) => m.content), [
      "*[Request interrupted by user for tool use]*",
      "`/model opus`",
      "```\nSet model to Opus 5\n```",
    ]);
  });

  it("turns a task notification into a tool row parented to its call, and keeps the typed text beside it", () => {
    const note = "<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n<result>\nall done\n</result>\n</task-notification>";
    const recs = [
      user("u1", null, "run it", 0),
      assistant("a1", "u1", [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "sleep 1", run_in_background: true } }], 100),
      toolResult("r1", "a1", "toolu_bg", "Command running in background with ID: abc123", 200),
      { ...user("u2", "r1", "", 300), message: { role: "user", content: [{ type: "text", text: note }, { type: "text", text: "and while that ran, a question" }] } },
      { ...user("u3", "u2", "", 400), message: { role: "user", content: [{ type: "text", text: note.replace("completed", "failed") }] } },
    ];
    const conv = parseClaudeSession(jsonl(recs), candidateFor("/x/S.jsonl"))!;
    assert.deepEqual(conv.messages.map((m) => m.content), ["run it", "and while that ran, a question"]);
    const notes = conv.toolCalls!.filter((c) => c.name === "task-notification");
    assert.equal(notes.length, 2);
    assert.deepEqual(notes.map((n) => [n.key, n.status, n.parentKey, n.afterMessage]), [
      ["task:u2", "completed", "toolu_bg", 0],
      ["task:u3", "failed", "toolu_bg", 1],
    ]);
    assert.deepEqual(notes[0].input, { task_id: "abc123", summary: "Background command finished" });
    assert.equal(notes[0].output, "\nall done\n");
  });

  it("fences text that contains backticks with a longer fence", () => {
    const b = classifyUserBlock("<bash-stdout>```js\nx\n```</bash-stdout><bash-stderr></bash-stderr>");
    assert.equal(b.kind, "shell");
    assert.equal((b as { text: string }).text, "````\n```js\nx\n```\n````");
  });
});

describe("absorb ledger migration to brane scope", () => {
  it("carries provider-only rows into the brane-scoped tables and keeps the old ones as _v1", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    // The #456 shape, populated as an import would have left it.
    db.exec(`
      CREATE TABLE absorb_messages (provider TEXT NOT NULL, key TEXT NOT NULL, narrative_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (provider, key));
      CREATE TABLE absorb_files (provider TEXT NOT NULL, external_id TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL, mtime INTEGER NOT NULL, absorbed_at INTEGER NOT NULL, PRIMARY KEY (provider, external_id));
      INSERT INTO narratives (id, brane_id, agent_type, role, status, created_at, agent_session_id) VALUES ('claude-abs00001', 'brane-claude-x', 'claude', 'absorbed', 'ended', 1, 'S1');
      INSERT INTO absorb_messages VALUES ('claude', 'u1', 'claude-abs00001', 1), ('claude', 'orphan', 'claude-gone0000', 1);
      INSERT INTO absorb_files VALUES ('claude', 'S1', '/p/S1.jsonl', 10, 1000, 1), ('claude', 'S2', '/p/S2.jsonl', 5, 500, 1);
    `);
    applyMigrations(db);
    assert.deepEqual(db.prepare("SELECT brane_id, key, narrative_id FROM absorb_messages ORDER BY key").all(), [
      { brane_id: "brane-claude-x", key: "u1", narrative_id: "claude-abs00001" },
    ]);
    assert.deepEqual(db.prepare("SELECT brane_id, external_id, parser_version FROM absorb_files").all(), [
      { brane_id: "brane-claude-x", external_id: "S1", parser_version: 0 }, // read again, once, by the current parser
    ]);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM absorb_messages_v1").get() as { n: number }).n, 2);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM absorb_files_v1").get() as { n: number }).n, 2);
    applyMigrations(db); // idempotent
    assert.equal((db.prepare("SELECT COUNT(*) n FROM absorb_messages").get() as { n: number }).n, 1);
    db.close();
  });
});

describe("--rebuild on an export provider", () => {
  it("is refused before anything is emitted, not ignored", async () => {
    const db = createTestDb();
    const root = mkdtempSync(join(tmpdir(), "brane-absorb-rebuild-"));
    const emitted: AbsorbEvent[] = [];
    await assert.rejects(
      () => runAbsorb(db, { provider: "chatgpt", path: root, fold: root, rebuild: true }, (e) => emitted.push(e), { confineFoldsToHome: false }),
      (err: unknown) => err instanceof AbsorbInputError && /--rebuild is not supported for the chatgpt provider/.test(err.message),
    );
    assert.deepEqual(emitted, []);
    db.close();
  });
});

describe("resetAbsorbedNarrative", () => {
  it("refuses anything that is not the absorbed narrative of that session in that brane", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at, agent_session_id) VALUES ('claude-live0001', 'brane-test', 'claude', 'worker', 'active', '/tmp', ?, 'S')",
    ).run(Date.now());
    db.prepare("INSERT INTO events (narrative_id, seq, time, type, content) VALUES ('claude-live0001', 1, 1, 'narration', 'keep me')").run();
    assert.throws(() => resetAbsorbedNarrative(db, "claude-live0001", "brane-test", "claude", "S"), /refusing to rebuild/);
    assert.throws(() => resetAbsorbedNarrative(db, "claude-live0001", "brane-other", "claude", "S"), /refusing to rebuild/);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n, 1);
    db.close();
  });

  it("refuses an absorbed narrative holding an event no import wrote", () => {
    const db = createTestDb();
    const ctx = createAbsorbContext(db, "claude", "brane-claude-1", "~/store", undefined, false);
    absorbOne(ctx, parseClaudeSession(jsonl(plainSession()), candidateFor("/x/S.jsonl"))!);
    const nid = (db.prepare("SELECT id FROM narratives").get() as { id: string }).id;
    assert.equal(liveContributions(db, nid, "brane-claude-1", "claude"), 0);
    db.prepare("INSERT INTO events (narrative_id, seq, time, type, content, source) VALUES (?, 4, 1, 'narration', 'errata', 'claude-other001')").run(nid);
    assert.equal(liveContributions(db, nid, "brane-claude-1", "claude"), 1);
    assert.throws(() => resetAbsorbedNarrative(db, nid, "brane-claude-1", "claude", "S"), /1 event\(s\) were not written by an import/);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n, 4, "nothing deleted");
    db.close();
  });
});
