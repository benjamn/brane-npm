/**
 * Utility sessions: a tracked tmux session for a non-agent command
 * (`lazygit`, `htop`, a shell), with terminal mirroring but no MCP, LIVE
 * loop or agent adapter. `doRun` is `POST /api/run`'s implementation and
 * `runHistory` is `GET /api/run-history`'s; the app's spawn dialog (its
 * Utility side) is their only client.
 *
 * There is no `brane run` CLI command any more (retired 2026-10-10). A
 * utility session's environment carries no agent token, so it is this
 * account's standing in one call, which is why the route is closed to
 * agents (`src/daemon/agent-scope.ts`). The CLI command added nothing the
 * dialog lacks — same route, same env scrubbing, no env passthrough from
 * the calling shell — and `brane attach <nid>` still attaches to a session
 * the app started. Keeping the command would have kept a `brane` verb in
 * every agent's shell whose only job was to mint that standing.
 */

import { randomBase36 } from "../ids.js";
import type Database from "better-sqlite3";
import { getBraneId, fromPortablePath } from "../db/schema.js";
import { appendEvent } from "../db/events.js";
import { newTmuxSession } from "../tmux.js";
import { unsetAgentEnvPrefix } from "../agent-env.js";
import { runningContent } from "../shared/narrative-format.js";

export interface RunOptions {
  db: Database.Database;
  command: string[];
  foldPath: string; // portable path (e.g. "~/dev/brane")
  terminalSize?: { cols: number; rows: number };
}

export interface RunResult {
  narrativeId: string;
  foldPath: string;
  command: string[];
}

/** Core run logic — creates a tmux session for an arbitrary command (no MCP, no agent). */
export function doRun(opts: RunOptions): RunResult {
  const { db, command } = opts;
  const braneId = getBraneId(db);
  const foldPath = opts.foldPath;
  const absoluteFoldPath = fromPortablePath(foldPath);

  if (command.length === 0) {
    throw new Error("No command specified");
  }

  const cmdName = command[0].replace(/^.*\//, ""); // basename

  // Verify fold is registered
  const fold = db.prepare("SELECT path FROM folds WHERE path = ?").get(foldPath);
  if (!fold) {
    throw new Error(`Not a fold: ${foldPath}. Run \`brane fold\` first.`);
  }

  // Generate narrative ID using command basename
  const uniqueId = randomBase36(8);
  const narrativeId = `${cmdName}-${uniqueId}`;

  // Record narrative in db
  db.prepare(
    `INSERT INTO narratives (id, brane_id, fold_path, agent_type, role, created_at, status)
     VALUES (?, ?, ?, ?, 'utility', ?, 'active')`,
  ).run(narrativeId, braneId, foldPath, cmdName, Date.now());

  appendEvent(db, narrativeId, "started", {
    content: runningContent(command),
    meta: { command },
  });

  // Update fold's last_spawned
  db.prepare("UPDATE folds SET last_spawned = ? WHERE path = ?").run(Date.now(), foldPath);

  // Shell-escape the command for tmux
  const tmuxCmd = command
    .map((a) => (a.includes(" ") || a.includes("'") ? `'${a.replace(/'/g, "'\\''")}'` : a))
    .join(" ");

  // Create tmux session — no BRANE_NARRATIVE_ID, no MCP. And none inherited
  // either: a tmux server started from an agent's shell holds that agent's
  // pair in its global env, and a `brane` typed in this session would then act
  // as that agent (claude-jrjh1e8w:10).
  try {
    newTmuxSession({
      name: narrativeId,
      cwd: absoluteFoldPath,
      size: opts.terminalSize,
      command: `${unsetAgentEnvPrefix()} ${tmuxCmd}`,
    });
  } catch (err) {
    db.prepare("UPDATE narratives SET status = 'ended' WHERE id = ?").run(narrativeId);
    throw new Error(`Failed to create tmux session: ${err}`);
  }

  return { narrativeId, foldPath, command };
}

export interface RunHistoryEntry {
  command: string;
  last_used: number;
  use_count: number;
}

/** The commands utility sessions have run before, most-recent first: the
 *  spawn dialog's Utility list, served as `GET /api/run-history`. It reads back the
 *  basename doRun wrote as `agent_type`, which is why it lives here. Archived
 *  narratives count — archiving a utility session is routine, not a statement
 *  about the command. Nothing is stored for it; the narratives are the record. */
export function runHistory(db: Database.Database, limit = 30): RunHistoryEntry[] {
  return db.prepare(
    `SELECT agent_type AS command, MAX(created_at) AS last_used, COUNT(*) AS use_count
     FROM narratives
     WHERE role = 'utility' AND agent_type IS NOT NULL AND agent_type != ''
     GROUP BY agent_type
     ORDER BY last_used DESC
     LIMIT ?`,
  ).all(limit) as RunHistoryEntry[];
}
