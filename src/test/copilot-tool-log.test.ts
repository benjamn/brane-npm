import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers.js";
import { readToolUseWindow } from "../db/tool-uses.js";
import {
  newCopilotLogCursor,
  pollCopilotToolLog,
  toolUseFromCopilotEvent,
} from "../copilot-tool-log.js";

const sessionId = "copilot-test-session";

function event(type: string, data: Record<string, unknown>, timestamp = "2026-08-16T15:00:00.000Z") {
  return { type, timestamp, data };
}

describe("Copilot tool session log", () => {
  it("maps start and completion events through their shared call id", () => {
    const start = toolUseFromCopilotEvent(event("tool.execution_start", {
      toolCallId: "call-1", toolName: "bash", arguments: { command: "true" },
    }))!;
    const complete = toolUseFromCopilotEvent(event("tool.execution_complete", {
      toolCallId: "call-1", success: false, error: { message: "nope" },
    }))!;
    assert.equal(start.status, "pending");
    assert.equal(complete.status, "failed");
    assert.equal(complete.dedupKey, start.dedupKey);
  });

  it("records appended starts and completions once, retaining an incomplete trailing line", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "brane-copilot-log-"));
    const sessionDir = join(stateRoot, sessionId);
    const eventPath = join(sessionDir, "events.jsonl");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(eventPath, JSON.stringify(event("tool.execution_start", {
      toolCallId: "call-2", toolName: "bash", arguments: { command: "echo 🦊" },
    })) + "\n");
    const db = createTestDb();
    const cursor = newCopilotLogCursor();
    assert.equal(pollCopilotToolLog(db, "copilot-test", sessionId, cursor, stateRoot).length, 1);
    appendFileSync(eventPath, JSON.stringify(event("tool.execution_complete", {
      toolCallId: "call-2", success: true, result: { output: "done" },
    }, "2026-08-16T15:00:01.000Z")) + "\n" + '{"type":"tool.execution_start"');
    assert.equal(pollCopilotToolLog(db, "copilot-test", sessionId, cursor, stateRoot).length, 1);
    const rows = readToolUseWindow(db, "copilot-test");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "completed");
    assert.equal(rows[0].name, "bash");
    assert.equal(rows[0].duration_ms, 1000);
    assert.equal(pollCopilotToolLog(db, "copilot-test", sessionId, cursor, stateRoot).length, 0);
  });

  it("compacts Brane loop calls and removes a duplicate detailed result", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "brane-copilot-log-"));
    const sessionDir = join(stateRoot, sessionId);
    const eventPath = join(sessionDir, "events.jsonl");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(eventPath, [
      event("tool.execution_start", {
        toolCallId: "bridge-1", toolName: "brane-narrate", arguments: {},
        mcpServerName: "brane", mcpToolName: "narrate",
      }),
      event("tool.execution_complete", {
        toolCallId: "bridge-1", success: true,
        result: { content: JSON.stringify({ seq: 42 }), detailedContent: JSON.stringify({ seq: 42 }) },
      }),
      event("tool.execution_start", {
        toolCallId: "bridge-2", toolName: "brane-narrate", arguments: { nid: "claude-target", say: "status" },
        mcpServerName: "brane", mcpToolName: "narrate",
      }),
      event("tool.execution_complete", {
        toolCallId: "bridge-2", success: true,
        result: {
          content: JSON.stringify({ nid: "claude-target", seq: 12 }),
          detailedContent: JSON.stringify({ nid: "claude-target", seq: 12 }),
        },
      }),
      event("tool.execution_start", {
        toolCallId: "call-3", toolName: "bash", arguments: { command: "true" },
      }),
      event("tool.execution_complete", {
        toolCallId: "call-3", success: true, result: { content: "done", detailedContent: "done" },
      }),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const db = createTestDb();

    assert.equal(pollCopilotToolLog(db, "copilot-test", sessionId, newCopilotLogCursor(), stateRoot).length, 6);
    const rows = readToolUseWindow(db, "copilot-test");
    assert.equal(rows.length, 3);
    assert.equal(rows[0].name, "mcp__brane__narrate");
    assert.equal(rows[0].input, "{}");
    assert.equal(rows[0].output, "{}");
    assert.equal(rows[1].name, "mcp__brane__narrate");
    assert.deepEqual(JSON.parse(rows[1].input!), { nid: "claude-target" });
    assert.deepEqual(JSON.parse(rows[1].output!), { nid: "claude-target", seq: 12 });
    assert.equal(rows[2].name, "bash");
    assert.deepEqual(JSON.parse(rows[2].output!), { content: "done" });
  });
});
