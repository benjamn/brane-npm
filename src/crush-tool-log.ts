/** Reading tool calls out of crush's own session log.
 *
 *  Every other harness brane captures reports its tool calls by running a hook.
 *  crush cannot: it has a `PreToolUse` hook and no `PostToolUse` event at all,
 *  and its pre payload carries no call id — so the two halves of a call could
 *  never share a `dedup_key` even if both fired, and every call would strand as
 *  `pending`. What crush does have is a database that records both halves, and
 *  records the first one *while the call is still running*: a `tool_call` part
 *  is persisted with `finished: false` the moment the call starts (verified
 *  live against a 25s sleep by crush-cdcwzh2b, claude-pasen1co:24). That is the
 *  same pending→completed shape the hook path produces, arriving by a different
 *  road, which is what the `source: "session_log"` lane was declared for.
 *
 *  Everything here is read-only against a database another process owns.
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { statSync } from "node:fs";
import { recordToolUse, type RecordToolUseOpts } from "./db/tool-uses.js";

/** crush keeps one database per project, under the working directory. The data
 *  directory is configurable (`options.data_directory`), and a fold that moved
 *  it will simply read as "no log", which degrades to no capture. */
export function crushDbPath(foldPath: string): string {
  return join(foldPath, ".crush", "crush.db");
}

/** crush's own timestamp columns are in **seconds**, despite the schema comment
 *  on them saying milliseconds — the live rows read `created_at = 1786904402`,
 *  and its `AFTER UPDATE` trigger stamps `strftime('%s','now')`, which is
 *  seconds by definition. The `start_time`/`end_time` inside a tool result's
 *  metadata really are milliseconds. Mixing the two units in one file is easy
 *  and silent: a `created_at >= Date.now()` comparison matches nothing at all,
 *  forever, and looks exactly like a session with no tool calls. */
function toCrushSeconds(epochMs: number): number {
  return Math.floor(epochMs / 1000);
}

/** Session ids crush mints for its own bookkeeping rather than for a
 *  conversation: `title-<parentId>` for summary generation, and
 *  `<messageID>$$<toolCallID>` for a sub-agent invoked through its `agent`
 *  tool. Neither is the session a narrative is having. */
function isSyntheticSessionId(id: string): boolean {
  return id.startsWith("title-") || id.includes("$$");
}

/** The tool call that spawned a sub-agent session, from the session's own id.
 *  crush encodes it as `<messageID>$$<toolCallID>`, which is exactly the
 *  `parent_id` edge `tool_uses` records — so a sub-agent's calls nest under the
 *  call that started it instead of arriving as orphans. */
function parentToolCallId(sessionId: string): string | undefined {
  const marker = sessionId.indexOf("$$");
  return marker === -1 ? undefined : sessionId.slice(marker + 2) || undefined;
}

/** crush double-encodes: `tool_call.input` and `tool_result.metadata` are JSON
 *  *strings* inside a JSON document. Parse them when they are, pass them
 *  through when they aren't, and never throw on either. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

interface CrushRow {
  id: string;
  session_id: string;
  parts: string;
  created_at: number;
  updated_at: number;
}

/** One poll's worth of state. Held by the caller so a restart re-reads from the
 *  top — which is harmless, because `recordToolUse` is idempotent. */
export interface CrushLogCursor {
  /** Highest `updated_at` (crush seconds) consumed so far. */
  updatedAt: number;
  /** `dedup_key` → the status already written for it, so an unchanged row is
   *  not re-upserted. Every write bumps `rev`, and `rev` is the client's sync
   *  cursor: re-writing an unchanged row would push it to every connected
   *  client again, forever, at the poll interval. */
  written: Map<string, string>;
  /** Signature of the log the last poll read, so an unchanged one is not
   *  opened at all. */
  signature: string | null;
}

export function newCrushLogCursor(): CrushLogCursor {
  return { updatedAt: 0, written: new Map(), signature: null };
}

/** A cheap fingerprint of the log's contents: size and mtime of the database
 *  *and of its `-wal` sibling*.
 *
 *  The sibling is the whole point. In WAL mode a write lands in `-wal` and the
 *  main file's mtime does not move until a checkpoint — so a gate that stats
 *  only the database would go quiet during exactly the burst of activity it
 *  exists to catch, and look like a session that stopped making tool calls.
 *
 *  Returns null when there is no log at all, which is also "nothing to do".
 *  This is the poller's whole idle cost: two stats, no open, no query. */
export function crushLogSignature(foldPath: string): string | null {
  const path = crushDbPath(foldPath);
  let signature: string;
  try {
    const main = statSync(path);
    signature = `${main.size}:${main.mtimeMs}`;
  } catch {
    return null;
  }
  try {
    const wal = statSync(`${path}-wal`);
    signature += `|${wal.size}:${wal.mtimeMs}`;
  } catch {
    // No -wal: either checkpointed away or the journal mode changed. Absence
    // is itself a stable part of the signature.
    signature += "|none";
  }
  return signature;
}

/** Which crush session belongs to this narrative.
 *
 *  Prefers the id brane recorded at spawn. The fallback — newest real session
 *  created at or after the narrative was — is a heuristic with a known failure
 *  mode: two crush instances started in one fold at the same moment can be
 *  cross-assigned. That is the same risk the codex adapter's discovery already
 *  accepts, and it disappears the moment `agent_session_id` is populated. */
export function resolveCrushSessionIds(
  crush: Database.Database,
  opts: { recorded?: string[]; narrativeCreatedAtMs: number },
): string[] {
  const recorded = (opts.recorded ?? []).filter((id) => id && !isSyntheticSessionId(id));
  if (recorded.length > 0) return recorded;

  // The synthetic-id exclusion belongs in the query, not after it. Filtering a
  // `LIMIT 1` result in JS asks for the newest row and then throws it away if
  // it turns out to be bookkeeping — reporting "no session" while a perfectly
  // good one sits directly underneath it. `parent_session_id IS NULL` is not
  // enough on its own: it happens to exclude sub-agent rows in the logs seen so
  // far, but nothing guarantees every kind of synthetic row is parented.
  const row = crush
    .prepare(
      `SELECT id FROM sessions
        WHERE created_at >= ?
          AND parent_session_id IS NULL
          AND id NOT LIKE 'title-%'
          AND id NOT LIKE '%$$%'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(toCrushSeconds(opts.narrativeCreatedAtMs)) as { id: string } | undefined;
  return row ? [row.id] : [];
}

/** A session and every sub-agent session under it, so calls made by a
 *  sub-agent are captured too rather than vanishing into a child row. */
function sessionFamily(crush: Database.Database, sessionIds: string[]): string[] {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => "?").join(", ");
  const children = crush
    .prepare(`SELECT id FROM sessions WHERE parent_session_id IN (${placeholders})`)
    .all(...sessionIds) as Array<{ id: string }>;
  const family = new Set(sessionIds);
  for (const child of children) {
    // Title-generation sessions summarize; they make no tool calls worth
    // showing and would only add rows the operator never asked about.
    if (!child.id.startsWith("title-")) family.add(child.id);
  }
  return [...family];
}

/** Translate one message's `parts` into record calls.
 *
 *  A `tool_call` part is the call as announced — crush persists it with
 *  `finished: false` before the tool runs — so it maps to `pending` no matter
 *  what `finished` says by the time we read it. `finished: true` means the call
 *  returned, not that it succeeded; the outcome is in the `tool_result` part,
 *  which may not have been written yet. Letting `finished` imply success would
 *  mark failed calls completed.
 *
 *  Exported for tests: the payload shapes below are crush's, and pinning them
 *  in a pure function is cheaper than standing up a crush. */
export function toolUsesFromCrushParts(
  partsJson: string,
  ctx: { parentId?: string },
): RecordToolUseOpts[] {
  let parts: unknown;
  try {
    parts = JSON.parse(partsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parts)) return [];

  const out: RecordToolUseOpts[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const { type, data } = part as { type?: unknown; data?: unknown };
    if (typeof data !== "object" || data === null) continue;
    const d = data as Record<string, unknown>;

    if (type === "tool_call") {
      if (typeof d.id !== "string" || typeof d.name !== "string") continue;
      out.push({
        dedupKey: d.id,
        name: d.name,
        input: parseMaybeJson(d.input),
        status: "pending",
        source: "session_log",
        agentType: "crush",
        parentId: ctx.parentId,
      });
      continue;
    }

    if (type === "tool_result") {
      if (typeof d.tool_call_id !== "string") continue;
      const metadata = parseMaybeJson(d.metadata);
      const times =
        typeof metadata === "object" && metadata !== null
          ? (metadata as { start_time?: unknown; end_time?: unknown })
          : {};
      const start = typeof times.start_time === "number" ? times.start_time : undefined;
      const end = typeof times.end_time === "number" ? times.end_time : undefined;
      out.push({
        dedupKey: d.tool_call_id,
        // The result names the tool again, but a pending row already has it;
        // recordToolUse ignores a name it already holds.
        name: typeof d.name === "string" ? d.name : "unknown",
        status: d.is_error === true ? "failed" : "completed",
        output: d.content,
        // These are milliseconds, unlike the columns around them.
        startedAt: start,
        durationMs: start !== undefined && end !== undefined && end > start ? end - start : undefined,
        source: "session_log",
        agentType: "crush",
        parentId: ctx.parentId,
      });
    }
  }
  return out;
}

/** Read whatever is new in a crush session log and record it.
 *
 *  Returns the rows actually written, for the caller to push. An unchanged row
 *  is not rewritten: every write bumps `rev`, which is the sync cursor, so
 *  re-recording a settled call would re-push it to every client on every poll.
 *
 *  Opens the log read-only. crush runs in WAL mode, so a concurrent reader is
 *  safe while its TUI is live, and read-only means this can never be the
 *  process that damages someone else's session. Any failure — no log, a schema
 *  that moved, a locked file — is swallowed into "nothing to record": capture
 *  is a bystander and must never take a narrative down with it. */
export function pollCrushToolLog(
  db: Database.Database,
  narrativeId: string,
  opts: { foldPath: string; sessionIds?: string[]; narrativeCreatedAtMs: number },
  cursor: CrushLogCursor,
): ReturnType<typeof recordToolUse>[] {
  // Nothing has changed since the last look — and most looks find nothing,
  // since an agent is idle far more often than it is calling a tool. Costing
  // an idle narrative two stats instead of a database open is what makes a
  // 2-second interval defensible at all.
  const signature = crushLogSignature(opts.foldPath);
  if (signature === null || signature === cursor.signature) return [];

  const path = crushDbPath(opts.foldPath);
  let crush: Database.Database | null = null;
  const written: ReturnType<typeof recordToolUse>[] = [];
  try {
    crush = new Database(path, { readonly: true, fileMustExist: true });
    const sessions = sessionFamily(
      crush,
      resolveCrushSessionIds(crush, {
        recorded: opts.sessionIds,
        narrativeCreatedAtMs: opts.narrativeCreatedAtMs,
      }),
    );
    if (sessions.length === 0) return [];

    const placeholders = sessions.map(() => "?").join(", ");
    // `>=`, not `>`: crush's timestamps have one-second resolution, so a strict
    // cursor would skip a message written in the same second as the last one
    // read. Re-reading a second costs an upsert that the `written` map then
    // discards.
    const rows = crush
      .prepare(
        `SELECT id, session_id, parts, created_at, updated_at FROM messages
          WHERE session_id IN (${placeholders}) AND updated_at >= ?
          ORDER BY updated_at, created_at`,
      )
      .all(...sessions, cursor.updatedAt) as CrushRow[];

    for (const row of rows) {
      if (row.updated_at > cursor.updatedAt) cursor.updatedAt = row.updated_at;
      for (const opt of toolUsesFromCrushParts(row.parts, {
        parentId: parentToolCallId(row.session_id),
      })) {
        const key = opt.dedupKey!;
        const prior = cursor.written.get(key);
        if (prior === opt.status) continue;
        // The same message rows are re-read whenever the cursor's second is
        // revisited, so a settled call's `tool_call` part comes back around
        // after its `tool_result` has already completed the row. recordToolUse
        // refuses the status regression, but it still bumps `rev` and so still
        // re-pushes the row to every client — every poll, forever. The rule
        // that matters is the same one the upsert applies: a call already seen
        // never goes back to pending.
        if (prior !== undefined && opt.status === "pending") continue;
        cursor.written.set(key, opt.status);
        written.push(recordToolUse(db, narrativeId, opt));
      }
    }
    // Only on a clean read: a poll that threw halfway must look again rather
    // than treat the log as consumed.
    cursor.signature = signature;
  } catch (err) {
    console.error(`[crush-log] reading ${path} for ${narrativeId} failed: ${err}`);
  } finally {
    try {
      crush?.close();
    } catch {
      // Closing a read-only handle can't lose data; nothing to do about it.
    }
  }
  return written;
}
