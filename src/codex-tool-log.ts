import { closeSync, openSync, readSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import { findCodexRollout, codexSessionsRoot } from "./agents.js";
import { readToolUse, recordToolUse, type RecordToolUseOpts, type ToolUseRow } from "./db/tool-uses.js";

// Codex has no hook API, so its rollout — an append-only JSONL file under
// `~/.codex/sessions/YYYY/MM/DD/` — is the only witness to the tools it ran.
// Every call appears twice: a `function_call`/`custom_tool_call` when it is
// issued, and a matching `*_output` when it returns, paired by a `call_id`
// that is stable across both halves, so no heuristic pairing is needed.
//
// Read incrementally, always. A rollout passes two megabytes within the hour
// (its leading `session_meta` line alone inlines codex's entire system prompt)
// and this runs on the daemon's only thread, so a whole-file read would put
// megabytes of JSON.parse in front of the agent's next call. Nothing here ever
// re-reads a byte it has already seen.

export interface CodexLogCursor {
  /** Byte offset of the first unconsumed record. */
  offset: number;
  /** Trailing bytes of an incomplete final line, held until it is finished.
   *
   *  Bytes rather than a string: a read boundary lands wherever the file
   *  happened to grow to, which can be the middle of a multi-byte character.
   *  Decoding each chunk on its own would turn that into a replacement
   *  character and the line would never parse; carrying the remainder as bytes
   *  and decoding only whole lines cannot. */
  pending: Buffer;
  /** call_id → tool name, so an output can be attributed even when its call
   *  line was consumed in an earlier read. */
  names: Map<string, string>;
}

export function newCodexLogCursor(): CodexLogCursor {
  return { offset: 0, pending: Buffer.alloc(0), names: new Map() };
}

/** Codex's `custom_tool_call_output` carries an array of content parts rather
 *  than a string. Flatten the text so the stored row reads as output instead of
 *  as a serialized wire envelope; anything else passes through untouched for
 *  `prepareCaptureText` to serialize. */
function flattenOutput(output: unknown): unknown {
  if (!Array.isArray(output)) return output;
  const parts = output
    .map((p) => (p as { text?: unknown } | null)?.text)
    .filter((t): t is string => typeof t === "string");
  return parts.length === output.length ? parts.join("") : output;
}

/** Translate one rollout record into the common row shape, or undefined if it
 *  isn't a tool call. Pure, so the mapping is pinned by tests rather than
 *  reachable only through a filesystem fixture.
 *
 *  `names` supplies the fallback for an output whose call line was consumed in
 *  an earlier read. It is only ever a fallback: the upsert never overwrites
 *  `name`, so an already-recorded call keeps its real one regardless. */
export function toolUseFromCodexRecord(
  record: unknown,
  names?: Map<string, string>,
): RecordToolUseOpts | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const outer = record as { type?: unknown; payload?: unknown };
  if (outer.type !== "response_item") return undefined;
  if (typeof outer.payload !== "object" || outer.payload === null) return undefined;
  const payload = outer.payload as Record<string, unknown>;
  const callId = payload.call_id;
  if (typeof callId !== "string") return undefined;

  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const name = typeof payload.name === "string" ? payload.name : "unknown";
    names?.set(callId, name);
    return {
      dedupKey: callId,
      name,
      // `function_call` carries `arguments`, `custom_tool_call` carries `input`.
      input: payload.arguments ?? payload.input,
      status: "pending",
      source: "session_log",
      agentType: "codex",
    };
  }
  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    return {
      dedupKey: callId,
      name: names?.get(callId) ?? "unknown",
      output: flattenOutput(payload.output),
      status: "completed",
      source: "session_log",
      agentType: "codex",
    };
  }
  return undefined;
}

/** Whether writing this record would tell the database anything new.
 *
 *  Every `recordToolUse` bumps the row's `rev`, and `rev` is the client sync
 *  cursor, so a redundant write is not free — it re-pushes the row to every
 *  connected client. That matters when a cursor starts cold (a daemon restart,
 *  or a revived narrative) and replays a rollout already recorded in full:
 *  without this, every restart would restate hundreds of unchanged rows as a
 *  sync storm.
 *
 *  A `pending` record is skipped against any existing row, because it can only
 *  restate or regress what is stored. The upsert already refuses the
 *  regression; this avoids paying a `rev` for the refusal. */
function wouldChangeNothing(
  db: Database.Database,
  narrativeId: string,
  toolUse: RecordToolUseOpts,
): boolean {
  const existing = readToolUse(db, narrativeId, toolUse.dedupKey!);
  if (!existing) return false;
  return toolUse.status === "pending" || existing.status === toolUse.status;
}

/** Ingest every tool call codex has written since this cursor last ran, and
 *  return the rows actually written so the caller can push them.
 *
 *  Driven from two directions over one cursor — a timer, and the agent's own
 *  MCP calls — which is safe because the cursor is a byte offset: whichever
 *  runs first advances it and the other finds nothing. See
 *  `startCodexToolSampler` in the daemon.
 *
 *  Errors are swallowed and logged: this is telemetry, and an unreadable log
 *  must never surface as a tool error on the agent's own call. */
export function pollCodexToolLog(
  db: Database.Database,
  narrativeId: string,
  sessionId: string,
  cursor: CodexLogCursor,
  sessionsRoot = codexSessionsRoot(),
): ToolUseRow[] {
  const path = findCodexRollout(sessionId, sessionsRoot);
  if (!path) return [];

  try {
    const size = statSync(path).size;
    if (size < cursor.offset) {
      // The file shrank, so it was replaced or truncated and the offset no
      // longer means anything. Start over rather than read garbage.
      cursor.offset = 0;
      cursor.pending = Buffer.alloc(0);
      cursor.names.clear();
    }
    if (size === cursor.offset) return [];

    const fd = openSync(path, "r");
    let chunk = Buffer.allocUnsafe(size - cursor.offset);
    try {
      const n = readSync(fd, chunk, 0, chunk.length, cursor.offset);
      chunk = chunk.subarray(0, n);
      cursor.offset += n;
    } finally {
      closeSync(fd);
    }

    const buf = cursor.pending.length ? Buffer.concat([cursor.pending, chunk]) : chunk;
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      cursor.pending = buf; // no complete line yet — hold it all for next time
      return [];
    }
    cursor.pending = buf.subarray(lastNewline + 1);

    const written: ToolUseRow[] = [];
    for (const line of buf.subarray(0, lastNewline).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        const toolUse = toolUseFromCodexRecord(JSON.parse(line), cursor.names);
        if (!toolUse || wouldChangeNothing(db, narrativeId, toolUse)) continue;
        written.push(recordToolUse(db, narrativeId, toolUse));
      } catch {
        // A malformed record cannot prevent later well-formed entries.
      }
    }
    return written;
  } catch (err) {
    console.error(`[codex-log] reading ${path} for ${narrativeId} failed: ${err}`);
    return [];
  }
}
