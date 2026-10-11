// The session a brane-spawned Claude Code is running *now*.
//
// The daemon assigns a claude narrative's session id at launch
// (`--session-id`), but Claude Code can move to a new session without the
// process ever exiting: `/clear` starts a fresh transcript under an id it mints
// itself, and so does `/resume <other>` from inside a running session. Nothing
// brane holds learns about it — the MCP bridge read `CLAUDE_CODE_SESSION_ID`
// once when it started, and `/clear` doesn't restart MCP servers — so cost
// kept reading a transcript that had stopped growing, and revive would resume
// the conversation from before the `/clear`.
//
// Claude Code keeps a registry of its interactive processes at
// `~/.claude/sessions/<pid>.json`, and rewrites its own entry's `sessionId`
// when the session changes. The daemon reads it for the one process it knows
// is the narrative's agent: the pane of tmux session `<nid>`, whose command
// tmux exec'd, so its `pane_pid` *is* the claude process.
//
// That choice is what keeps this free of races. It is a pull, not a push: no
// hook payload or bridge report is trusted, so a subagent (which runs
// in-process and has no entry of its own), a nested `claude -p` in the agent's
// Bash (a different pid, though it inherits the narrative's env and hooks),
// and any number of MCP reconnects have no way to move the pointer. The
// registry's one writer is the process it describes.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveTmux } from "./tmux.js";

export interface LiveSessionExpect {
  /** The narrative, which is also its tmux session name. */
  narrativeId: string;
  /** The pane's pid, as tmux reports it. */
  pid: number;
  /** Absolute fold path the agent was launched in. */
  foldPath: string;
  /** When the narrative's current launch happened (spawn, or latest revive). */
  launchedAt: number;
}

/** Slack on `launchedAt`: the daemon stamps a launch just before tmux starts
 *  the process, and the two clocks are the same machine's, so a few seconds
 *  covers it with room to spare. */
const LAUNCH_SLACK_MS = 60_000;

/** Parse one registry entry and return its `sessionId` only if it provably
 *  describes this narrative's current agent. Each guard answers a way a file
 *  could be read that isn't: the registry keeps entries for exited processes,
 *  so a recycled pid can point at a stranger's (`pid`, `tmux`, `cwd`), or at
 *  this narrative's own previous launch (`startedAt`). Pure, for tests. */
export function liveSessionFromRegistryEntry(rawJson: string, expect: LiveSessionExpect): string | undefined {
  let entry: { pid?: unknown; sessionId?: unknown; cwd?: unknown; tmux?: unknown; startedAt?: unknown; kind?: unknown };
  try {
    entry = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  if (!entry || typeof entry !== "object") return undefined;
  if (typeof entry.sessionId !== "string" || !entry.sessionId) return undefined;
  if (entry.pid !== expect.pid) return undefined;
  // `<session>:@<window>.%<pane>` — the name up to the first colon, exactly.
  if (typeof entry.tmux !== "string" || entry.tmux.split(":")[0] !== expect.narrativeId) return undefined;
  if (typeof entry.cwd !== "string" || resolve(entry.cwd) !== resolve(expect.foldPath)) return undefined;
  if (typeof entry.startedAt !== "number" || entry.startedAt < expect.launchedAt - LAUNCH_SLACK_MS) return undefined;
  if (entry.kind !== undefined && entry.kind !== "interactive") return undefined;
  return entry.sessionId;
}

/** Every tmux session's pane pid, from one `list-panes -a`. The cost tick asks
 *  for each connected claude narrative in turn, and this runs on the daemon's
 *  only thread, so one exec per tick rather than one per narrative; the short
 *  memo spans a tick and nothing longer. */
let paneMemo: { at: number; pids: Map<string, number> } | undefined;
const PANE_MEMO_MS = 1000;

/** Parse `list-panes -a -F "#{session_name} #{pane_pid}"`. A session with
 *  several panes has no single agent process, so it maps to nothing. Pure. */
export function parsePanePids(out: string): Map<string, number> {
  const pids = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const line of out.split("\n")) {
    const at = line.lastIndexOf(" ");
    if (at <= 0) continue;
    const name = line.slice(0, at);
    const pid = Number(line.slice(at + 1));
    if (!Number.isInteger(pid) || pid <= 1) continue;
    if (pids.has(name)) ambiguous.add(name);
    pids.set(name, pid);
  }
  for (const name of ambiguous) pids.delete(name);
  return pids;
}

function panePid(narrativeId: string): number | undefined {
  const now = Date.now();
  if (!paneMemo || now - paneMemo.at > PANE_MEMO_MS) {
    let out = "";
    try {
      out = execFileSync(resolveTmux(), ["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
    } catch {
      // No server, or no sessions: nothing is live.
    }
    paneMemo = { at: now, pids: parsePanePids(out) };
  }
  return paneMemo.pids.get(narrativeId);
}

/** Read the session id Claude Code's registry holds for this narrative's pane,
 *  or undefined when there is no pane, no entry, or an entry that fails a
 *  guard. Never throws. */
export function readClaudeLiveSession(opts: {
  narrativeId: string;
  foldPath: string;
  launchedAt: number;
}): string | undefined {
  const pid = panePid(opts.narrativeId);
  if (!pid) return undefined;
  let raw: string;
  try {
    raw = readFileSync(join(homedir(), ".claude", "sessions", `${pid}.json`), "utf8");
  } catch {
    return undefined;
  }
  return liveSessionFromRegistryEntry(raw, { ...opts, pid });
}
