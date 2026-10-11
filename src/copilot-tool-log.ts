import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { recordToolUse, type RecordToolUseOpts } from "./db/tool-uses.js";

export function copilotEventsPath(sessionId: string, stateRoot?: string): string {
  return join(
    stateRoot ?? join(process.env.HOME ?? "/tmp", ".copilot", "session-state"),
    sessionId,
    "events.jsonl",
  );
}

export interface CopilotLogCursor {
  /** UTF-8 byte offset of the first unconsumed JSONL record. */
  offset: number;
  signature: string | null;
  startedAt: Map<string, number>;
  names: Map<string, string>;
  inputs: Map<string, unknown>;
}

export function newCopilotLogCursor(): CopilotLogCursor {
  return { offset: 0, signature: null, startedAt: new Map(), names: new Map(), inputs: new Map() };
}

type EventData = Record<string, unknown>;

function copilotToolName(data: EventData): string | undefined {
  if (typeof data.toolName !== "string") return undefined;
  if (
    data.mcpServerName === "brane" &&
    (data.mcpToolName === "narrate" || data.mcpToolName === "listen")
  ) {
    return `mcp__brane__${data.mcpToolName}`;
  }
  return data.toolName;
}

function copilotResult(result: unknown): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const record = result as EventData;
  if (record.content !== undefined && record.content === record.detailedContent) {
    const { detailedContent: _detailedContent, ...withoutDuplicate } = record;
    if (typeof withoutDuplicate.content !== "string") return withoutDuplicate;
    try {
      return JSON.parse(withoutDuplicate.content);
    } catch {
      return withoutDuplicate;
    }
  }
  return result;
}

/** Translate Copilot's persisted tool start/complete events into the common
 * row shape. Its call id is stable across both halves, so no heuristic pairing
 * is needed. */
export function toolUseFromCopilotEvent(event: unknown): RecordToolUseOpts | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const e = event as { type?: unknown; timestamp?: unknown; data?: unknown };
  if (typeof e.data !== "object" || e.data === null) return undefined;
  const data = e.data as EventData;
  const id = data.toolCallId;
  if (typeof id !== "string") return undefined;
  const startedAt = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  const parentId = typeof data.parentToolCallId === "string" ? data.parentToolCallId : undefined;
  if (e.type === "tool.execution_start" && typeof data.toolName === "string") {
    const name = copilotToolName(data);
    if (!name) return undefined;
    return {
      dedupKey: id, name, input: data.arguments, status: "pending",
      source: "session_log", agentType: "copilot", parentId,
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    };
  }
  if (e.type === "tool.execution_complete" && typeof data.success === "boolean") {
    return {
      dedupKey: id, name: "unknown", output: data.success ? copilotResult(data.result) : undefined,
      status: data.success ? "completed" : "failed",
      error: data.success ? undefined : typeof data.error === "string" ? data.error : data.error === undefined ? undefined : JSON.stringify(data.error),
      source: "session_log", agentType: "copilot", parentId,
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    };
  }
  return undefined;
}

/** Read only appended JSONL bytes. Newlines are single-byte UTF-8 delimiters,
 * so a byte cursor never splits a multi-byte payload character. An incomplete
 * final line remains unconsumed until Copilot finishes writing it later. */
export function pollCopilotToolLog(
  db: Database.Database,
  narrativeId: string,
  sessionId: string,
  cursor: CopilotLogCursor,
  stateRoot?: string,
): ReturnType<typeof recordToolUse>[] {
  const path = copilotEventsPath(sessionId, stateRoot);
  let signature: string;
  try {
    const stat = statSync(path);
    signature = `${stat.size}:${stat.mtimeMs}`;
    if (signature === cursor.signature) return [];
    if (stat.size < cursor.offset) {
      cursor.offset = 0;
      cursor.startedAt.clear();
      cursor.names.clear();
      cursor.inputs.clear();
    }
    const bytes = stat.size - cursor.offset;
    if (bytes === 0) {
      cursor.signature = signature;
      return [];
    }
    const fd = openSync(path, "r");
    const pending = Buffer.allocUnsafe(bytes);
    let bytesRead: number;
    try {
      bytesRead = readSync(fd, pending, 0, bytes, cursor.offset);
    } finally {
      closeSync(fd);
    }
    const content = pending.subarray(0, bytesRead);
    const completeEnd = content.lastIndexOf(0x0a);
    if (completeEnd < 0) return [];
    cursor.offset += completeEnd + 1;
    cursor.signature = signature;
    const written: ReturnType<typeof recordToolUse>[] = [];
    for (const line of content.subarray(0, completeEnd).toString("utf8").split("\n")) {
      try {
        const event = JSON.parse(line);
        const toolUse = toolUseFromCopilotEvent(event);
        if (!toolUse || !toolUse.dedupKey) continue;
        if (toolUse.status === "pending" && toolUse.startedAt !== undefined) {
          cursor.startedAt.set(toolUse.dedupKey, toolUse.startedAt);
          cursor.names.set(toolUse.dedupKey, toolUse.name);
          cursor.inputs.set(toolUse.dedupKey, toolUse.input);
        } else if (toolUse.status !== "pending") {
          toolUse.name = cursor.names.get(toolUse.dedupKey) ?? toolUse.name;
          toolUse.input = cursor.inputs.get(toolUse.dedupKey);
          const startedAt = cursor.startedAt.get(toolUse.dedupKey);
          if (startedAt !== undefined && toolUse.startedAt !== undefined && toolUse.startedAt >= startedAt) {
            toolUse.durationMs = toolUse.startedAt - startedAt;
          }
          cursor.startedAt.delete(toolUse.dedupKey);
          cursor.names.delete(toolUse.dedupKey);
          cursor.inputs.delete(toolUse.dedupKey);
        }
        written.push(recordToolUse(db, narrativeId, toolUse));
      } catch {
        // A malformed record cannot prevent later well-formed entries.
      }
    }
    return written;
  } catch (err) {
    console.error(`[copilot-log] reading ${path} for ${narrativeId} failed: ${err}`);
    return [];
  }
}
