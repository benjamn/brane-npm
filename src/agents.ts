import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { priceMessage } from "./cost/pricing.js";
import { readClaudeLiveSession } from "./claude-live-session.js";

// Agent adapter interface — just enough to support session resumption
// and per-message model/trace resolution.
// Add new agents by adding an entry to the AGENTS map below.
export interface AgentAdapter {
  // Return CLI args needed to resume a previous session.
  // Returns empty array if no resumption is possible.
  resumeArgs(opts: ResumeOpts): string[];

  // Discover the agent's internal session ID from the filesystem.
  // Returns undefined if not discoverable. `since` (epoch ms, usually the
  // narrative's spawn time) scopes discovery to a session started after it, so a
  // "capture" agent picks up *this* narrative's session rather than an unrelated
  // one that happens to share the fold. `narrativeId` is supplied for the
  // adapters whose store is keyed by it — brane names goose's session after the
  // narrative (`-n <nid>`) and gives cline a per-narrative config dir — which
  // turns discovery into an exact lookup instead of a fold+time heuristic.
  //
  // Contract for "capture" agents: never return a session that started before
  // `since`. The daemon re-anchors `since` at the latest revive and caches
  // successful discoveries per anchor, so an adapter that ignores it can hand
  // back the pre-revive session during the window before the new one exists on
  // disk — which reads as "the successor" and pins the pointer to a session
  // that has stopped spending. An exact lookup (goose) is exempt: it resolves
  // the narrative's one session by name, whenever it started.
  discoverSessionId(
    foldPath: string,
    since?: number,
    narrativeId?: string,
  ): string | undefined;

  // How the daemon owns this agent's `agent_session_id` (the resume pointer):
  //   "assign"  — the daemon mints a uuid up front and forces it at launch via
  //               a caller-assign flag (claude's `--session-id`). The row is
  //               written at spawn/fork; clients never write it.
  //   "capture" — the agent generates its own id; the daemon captures that
  //               self-generated id at a controlled moment (scoped per-narrative)
  //               and records it, guarded so a concurrent bind can't clobber it.
  //   omitted   — the agent has no id-based resume (or none the daemon owns), so
  //               the pointer stays NULL and nothing writes it.
  // Gates the spawn-time mint and any capture write; the daemon's decision logic
  // reads this capability instead of branching on the agent's name.
  sessionIdOwnership?: "assign" | "capture";

  // Most assigned ids remain stable on resume. Claude is the exception: its
  // resume command always creates a successor session.
  resumeCreatesNewSession?: boolean;

  // The session an "assign" agent is running *now*, for harnesses that can move
  // to a new session without the process exiting (claude's `/clear`, or
  // `/resume` from inside a session). The daemon follows it on the live cost
  // tick so cost and revive track the conversation actually in progress. Must
  // answer only from a source that describes the narrative's own agent process
  // (never a hook or bridge report, which anything in the pane could send), and
  // only for a process started at or after `launchedAt`. Undefined means "no
  // evidence", never "no session".
  liveSessionId?(opts: { narrativeId: string; foldPath: string; launchedAt: number }): string | undefined;

  // Whether this agent's model can vary per message or is fixed per session.
  // Omitted/"none" means no model attribution is available for this agent.
  modelGranularity?: "per-message" | "per-session" | "none";

  // Resolve the originating message's position + model from the agent's own
  // session log. Opaque per-adapter: may read a JSONL transcript, query a
  // local SQLite DB, hit a cloud API, etc. Returns null when unresolvable
  // (no session file, no mechanism, no match) — callers must degrade
  // gracefully and never guess. Only implemented for supportable agents.
  resolveTrace?(opts: ResolveTraceOpts): TraceResolution | null;

  // Build a whole-session lookup table in one read, mapping each narration's
  // exact text → its TraceResolution. Lets a batch resolver parse a transcript
  // once and answer many events with O(1) lookups, instead of re-reading the
  // file per event via resolveTrace. Returns null when the session is
  // unresolvable (no file, no mechanism). Only implemented for agents that
  // also implement resolveTrace; resolveTrace delegates to it.
  buildTraceIndex?(opts: TraceIndexOpts): Map<string, TraceResolution> | null;

  // Read cumulative resource cost for a session from the agent's own log or
  // telemetry. Opaque per-adapter (JSONL transcript, local DB, cloud API, …)
  // and unit-agnostic: `unit` may be "USD", "AIC" (copilot credits), etc., so
  // the UI never assumes dollars. Returns null when unavailable (no session,
  // no mechanism, not supported) — callers degrade to showing no cost. Only
  // implemented for agents whose usage is actually readable.
  readUsage?(opts: ReadUsageOpts): CostReading | null;

  // Read cumulative cost across every session a narrative has bound, deduping
  // work that appears in more than one transcript. Claude's `--fork-session`
  // copies the predecessor's messages — usage records and message ids included
  // — into the successor's file, so summing per-session readings double-counts
  // everything before the fork. Sessions are walked in the order given (pass
  // bind order) with one shared seen-set over message ids. Callers fall back
  // to per-session readUsage + summation when this isn't implemented.
  readUsageMany?(opts: ReadUsageManyOpts): CostReading | null;

  // Read usage as individually keyed entries, for the daemon's usage ledger.
  // Each entry's `key` must be globally unique and stable across re-reads and
  // across files (e.g. the API message id), because the ledger dedupes on it:
  // an entry is credited to the first narrative that inserts it and never
  // moves. Adapters whose harness only exposes a cumulative total leave this
  // unimplemented; the daemon then records a per-session high-water mark from
  // readUsage instead. Returns one reading per readable session, in the order
  // given; null when no session is readable.
  readUsageEntries?(opts: ReadUsageManyOpts): UsageEntriesReading[] | null;
}

/** One priced unit of work, as the ledger stores it. */
export interface UsageEntry {
  key: string;
  amount: number;
  /** The model that produced this entry, when the harness records it. With
   *  the token counts this is what makes the row re-priceable later; without
   *  it a purged transcript's cost is whatever was written at the time. */
  model?: string;
  /** `cacheWrite1h` is the 1-hour share of `cacheWrite`, when the harness
   *  distinguishes them; a reprice needs it because the two bill differently. */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number };
  /** `usage.speed` (`"standard"` / `"fast"`), when the harness records it. */
  speed?: string;
}

/** A session's entries plus the signature of the source they were read from,
 *  so a caller can skip re-writing a session whose transcript hasn't changed. */
export interface UsageEntriesReading {
  sessionId: string;
  sig: string;
  unit: string;
  entries: UsageEntry[];
}

export interface ResumeOpts {
  // Session ID stored in the narratives table (from narrate metadata or discovery)
  sessionId?: string;
  // Absolute path to the fold directory
  foldPath: string;
  // Branch a copy off the session instead of resuming it in place. Needed when
  // the session is still live elsewhere (e.g. Claude Code's background-agent
  // mode holds a lock that makes a plain `--resume` refuse). Adapters that have
  // no fork affordance ignore this.
  forkSession?: boolean;
  // The daemon-minted session id for the session this launch will create. The
  // daemon owns agent_session_id, and a resume never continues under the old
  // id (Claude Code rotates to a fresh session on any `--resume`, forked or
  // not), so the daemon mints the successor's id itself and pins it via the
  // agent's own flag (claude: `--session-id`) rather than letting the client
  // rotate to an id the daemon never learns. Consulted for every launch shape
  // — resume, fork, and fresh start — by agents that support pinning.
  newSessionId?: string;
}

export interface ResolveTraceOpts {
  // The author agent's session identifier (e.g. CLAUDE_CODE_SESSION_ID).
  sessionId: string;
  // Absolute path to the author narrative's fold directory.
  foldPath: string;
  // The narration text to locate within the session log (exact match key).
  content: string;
}

export interface TraceIndexOpts {
  // The author agent's session identifier (e.g. CLAUDE_CODE_SESSION_ID).
  sessionId: string;
  // Absolute path to the author narrative's fold directory.
  foldPath: string;
}

export interface TraceResolution {
  // Per-message position within the session log (per-adapter scheme; for
  // claude, the assistant message UUID). Omitted for per-session granularity.
  offset?: string;
  // The model that produced the message, if determinable.
  model?: string;
}

export interface ReadUsageOpts {
  // The agent's session identifier (as stored in narratives.agent_session_id).
  sessionId: string;
  // Absolute path to the narrative's fold directory.
  foldPath: string;
  // The brane narrative the reading is for. Needed by adapters whose usage
  // store is addressed per-narrative rather than per-fold (cline's private
  // `/tmp/brane-cline-<nid>/` config dir).
  narrativeId?: string;
}

export interface ReadUsageManyOpts {
  // Every session id the narrative has bound, in recorded bind order —
  // predecessors before their forked successors, so dedup keeps the first
  // sighting of each message.
  sessionIds: string[];
  // Absolute path to the narrative's fold directory.
  foldPath: string;
  // The brane narrative the reading is for — see ReadUsageOpts.narrativeId.
  narrativeId?: string;
}

export interface CostReading {
  // Metered amount to display, e.g. 6.81 (USD) or 1200 (credits).
  amount: number;
  // Unit of `amount`: "USD", "AIC" (copilot AI credits), etc. Drives display
  // formatting on the client; never assume dollars.
  unit: string;
  // Optional token breakdown for a detail view. Omitted for agents that only
  // expose a pre-priced total.
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

// ---------------------------------------------------------------------------
// Shared plumbing for harness usage readers (goose / cline / crush)
// ---------------------------------------------------------------------------

/** Signature of the files a reading derives from, for memoization. Returns null
 *  when the *first* path is missing — that's the store itself, so there is
 *  nothing to read; later paths are optional and sign as "-" when absent.
 *
 *  For a SQLite store, always pass the `-wal` sidecar alongside the db: under
 *  WAL a writer appends to the sidecar without touching the main file's mtime,
 *  so signing on the db alone would pin a stale reading for the whole life of
 *  the WAL — precisely the case here, since every one of these harnesses is
 *  writing while we sample. */
function fileSignature(paths: string[]): string | null {
  let sig = "";
  for (const [i, p] of paths.entries()) {
    try {
      const st = statSync(p);
      sig += `${st.size}:${st.mtimeMs};`;
    } catch {
      if (i === 0) return null;
      sig += "-;";
    }
  }
  return sig;
}

const usageMemo = new Map<string, { sig: string; value: unknown }>();

/** Memoize a reading on its source files' signature, so the daemon's 20s cost
 *  sampler re-reads a session store only when it actually changed. A null
 *  result is never cached — absence is usually transient (a session dir that
 *  hasn't been written yet), and re-checking it costs one stat. */
function memoized<T>(key: string, paths: string[], compute: () => T | null): T | null {
  const sig = fileSignature(paths);
  if (sig === null) return null;
  const hit = usageMemo.get(key);
  if (hit && hit.sig === sig) return hit.value as T;
  const value = compute();
  if (value === null) return null;
  usageMemo.set(key, { sig, value });
  return value;
}

/** Run `fn` against a read-only connection to `dbPath`, always closing it.
 *  Returns null if the database can't be opened or the query throws — a
 *  harness store we can't read must degrade to "no cost", never to an
 *  exception in the sampler. Read-only is not merely polite: these are live
 *  databases owned by other processes, and brane must never write to them. */
function withReadonlyDb<T>(dbPath: string, fn: (db: Database.Database) => T | null): T | null {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // Nothing actionable — the connection is being discarded anyway.
    }
  }
}

/** Sum per-session cost readings into one cumulative total. Readings share an
 *  agent (and thus a unit) since they belong to one narrative; a stray
 *  mismatched unit is skipped rather than summed across units. Returns null when
 *  no reading is available (every session's transcript gone / unreadable). */
export function sumCostReadings(readings: Array<CostReading | null>): CostReading | null {
  let unit: string | undefined;
  let amount = 0;
  let tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
  let any = false;
  for (const r of readings) {
    if (!r) continue;
    if (unit === undefined) unit = r.unit;
    if (r.unit !== unit) continue; // never add across differing units
    any = true;
    amount += r.amount;
    if (r.tokens) {
      tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      tokens.input += r.tokens.input;
      tokens.output += r.tokens.output;
      tokens.cacheRead += r.tokens.cacheRead;
      tokens.cacheWrite += r.tokens.cacheWrite;
    }
  }
  if (!any || unit === undefined) return null;
  return tokens ? { amount, unit, tokens } : { amount, unit };
}

/** Epoch seconds from a timestamp that may be recorded in either unit. Crush's
 *  `sessions.created_at` is annotated "Unix timestamp in milliseconds" in its
 *  own schema but is written in *seconds* (verified against a live store), so
 *  neither the comment nor a single observation is worth trusting on its own.
 *  Values past ~2001 in ms are unambiguous, so magnitude decides. */
function epochSeconds(ts: number): number {
  return ts > 1e12 ? Math.floor(ts / 1000) : ts;
}

// One assistant message's priced usage, parsed from a session transcript.
// `id` is the API message id when present — fork-copied history repeats ids
// verbatim across files, so it doubles as the cross-session dedup key. Id-less
// records (e.g. `<synthetic>` messages) always count.
interface ClaudeUsageEntry {
  id?: string;
  model?: string;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  speed?: string;
}

// Memoize a session's parsed per-message entries on its file (size, mtime)
// signature so the daemon's periodic cost sampler doesn't re-read an unchanged
// multi-MB transcript every tick. Invalidated automatically when the file grows.
const claudeUsageCache = new Map<string, { sig: string; entries: ClaudeUsageEntry[] }>();

// Parse a session transcript into priced per-message entries, deduping streamed
// duplicates (same message id repeated within the file). Returns null when the
// session file is gone or unreadable.
function readClaudeUsageEntries(sessionId: string, foldPath: string): ClaudeUsageEntry[] | null {
  return readClaudeUsageEntriesSigned(sessionId, foldPath)?.entries ?? null;
}

function readClaudeUsageEntriesSigned(
  sessionId: string,
  foldPath: string,
): { sig: string; entries: ClaudeUsageEntry[] } | null {
  const cwdEncoded = foldPath.replace(/\//g, "-");
  const sessionFile = join(
    homedir(),
    ".claude",
    "projects",
    cwdEncoded,
    `${sessionId}.jsonl`,
  );

  let sig: string;
  try {
    const st = statSync(sessionFile);
    sig = `${st.size}:${st.mtimeMs}`;
  } catch {
    return null; // session file gone or never existed
  }
  const cached = claudeUsageCache.get(sessionFile);
  if (cached && cached.sig === sig) return cached;

  let raw: string;
  try {
    raw = readFileSync(sessionFile, "utf-8");
  } catch {
    return null;
  }

  const entries: ClaudeUsageEntry[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const message = obj.message as
      | { id?: string; model?: string; usage?: Record<string, unknown> }
      | undefined;
    const usage = message?.usage;
    if (!usage) continue;
    const id = typeof message?.id === "string" ? message.id : undefined;
    if (id) {
      if (seen.has(id)) continue; // dedupe streamed duplicates
      seen.add(id);
    }
    const i = num(usage.input_tokens);
    const o = num(usage.output_tokens);
    const r = num(usage.cache_read_input_tokens);
    const cc = usage.cache_creation as Record<string, unknown> | undefined;
    const w5 = num(cc?.ephemeral_5m_input_tokens);
    const w1 = num(cc?.ephemeral_1h_input_tokens);
    const model = typeof message?.model === "string" ? message.model : undefined;
    const speed = typeof usage.speed === "string" ? usage.speed : undefined;
    entries.push({
      id,
      model,
      cost: priceMessage(model ?? "", {
        input: i,
        output: o,
        cacheRead: r,
        cacheWrite5m: w5,
        cacheWrite1h: w1,
        speed,
      }),
      input: i,
      output: o,
      cacheRead: r,
      cacheWrite: w5 + w1,
      cacheWrite1h: w1,
      speed,
    });
  }
  const result = { sig, entries };
  claudeUsageCache.set(sessionFile, result);
  return result;
}

/** Ledger key for a claude message. Id-less records (`<synthetic>` messages)
 *  carry no identity to dedup on, so they key on their position in the file
 *  they were read from: unique and stable for an append-only transcript. A
 *  fork that copies one gets a second key for it — accepted, because
 *  synthetic records carry no usage, so only the row count is affected. */
function claudeEntryKey(sessionId: string, e: ClaudeUsageEntry, index: number): string {
  return e.id ? `claude:${e.id}` : `claude:${sessionId}#${index}`;
}

// Sum priced entries from one or more session transcripts into a single
// reading. One seen-set spans all the sessions (walked in bind order), so each
// message id counts only at its first sighting: fork-copied history prices to
// zero in successor files, while a genuinely diverged fork's distinct new
// messages on both sides still count.
function sumClaudeEntries(sessions: ClaudeUsageEntry[][]): CostReading {
  let input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    cost = 0;
  const seen = new Set<string>();
  for (const entries of sessions) {
    for (const e of entries) {
      if (e.id) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
      }
      input += e.input;
      output += e.output;
      cacheRead += e.cacheRead;
      cacheWrite += e.cacheWrite;
      cost += e.cost;
    }
  }
  return {
    amount: Math.round(cost * 1e4) / 1e4,
    unit: "USD",
    tokens: { input, output, cacheRead, cacheWrite },
  };
}

// Claude Code: stores sessions at ~/.claude/projects/<path-encoded>/
const claudeAdapter: AgentAdapter = {
  // Claude accepts a caller-assigned id via `--session-id`, so the daemon mints
  // and pins it (see buildAgentArgs / reviveNarrative). First agent through the
  // "assign" gate, not a special-cased one.
  sessionIdOwnership: "assign",
  resumeCreatesNewSession: true,
  liveSessionId: readClaudeLiveSession,

  resumeArgs({ sessionId, foldPath, forkSession, newSessionId }) {
    // A fresh start still pins the daemon-minted id when one is supplied, the
    // same way spawn does — otherwise the row's stale pointer survives the
    // revive and keeps naming a session that no longer exists.
    const freshStart = newSessionId ? ["--session-id", newSessionId] : [];

    // Per-narrative session ID is the only safe key. Falling back to
    // discoverSessionId(foldPath) cross-contaminates narratives that share
    // a fold: it picks the most-recently-modified jsonl in the fold's project
    // dir, which can belong to an unrelated narrative. Start fresh instead.
    if (!sessionId) return freshStart;

    // Validate the .jsonl file still exists
    const cwdEncoded = foldPath.replace(/\//g, "-");
    const sessionFile = join(
      homedir(),
      ".claude",
      "projects",
      cwdEncoded,
      `${sessionId}.jsonl`,
    );

    try {
      statSync(sessionFile);
    } catch {
      // Session file gone (e.g., after cleanup), start fresh
      return freshStart;
    }

    // Any `--resume` rotates to a fresh session id — Claude Code never
    // continues under the old one — so an un-pinned resume strands the row's
    // agent_session_id on the dead predecessor (frozen cost readings, and the
    // next revive resumes the pre-revive fork point). With a daemon-minted id
    // in hand, always resume fork-style and pin the successor's id via
    // `--session-id`; `--fork-session` also covers the case where the original
    // is still live (e.g. background-agent mode), which refuses a plain
    // `--resume`.
    if (newSessionId) {
      return ["--resume", sessionId, "--fork-session", "--session-id", newSessionId];
    }
    if (forkSession) return ["--resume", sessionId, "--fork-session"];
    return ["--resume", sessionId];
  },

  discoverSessionId(foldPath) {
    const cwdEncoded = foldPath.replace(/\//g, "-");
    const projectDir = join(homedir(), ".claude", "projects", cwdEncoded);

    try {
      const files = readdirSync(projectDir);
      let latestId: string | undefined;
      let latestMtime = 0;

      for (const file of files) {
        // Skip non-jsonl and agent-* files
        if (!file.endsWith(".jsonl") || file.startsWith("agent-")) continue;

        const id = file.replace(/\.jsonl$/, "");
        // UUID-like: contains dashes
        if (!id.includes("-")) continue;

        try {
          const stat = statSync(join(projectDir, file));
          const mtime = stat.mtimeMs;
          if (mtime > latestMtime) {
            latestMtime = mtime;
            latestId = id;
          }
        } catch {
          continue;
        }
      }

      return latestId;
    } catch {
      return undefined;
    }
  },

  // Claude can switch models mid-session (/model), so model is per-message.
  modelGranularity: "per-message",

  // Parse the whole session JSONL once into a `say` → {offset, model} map.
  // Each assistant turn carrying an mcp__brane__narrate tool-call contributes
  // one entry keyed by its exact `say` text; the assistant message UUID is a
  // stable, append-only-immutable offset and message.model is the truth.
  // First occurrence wins, matching resolveTrace's original first-match scan.
  buildTraceIndex({ sessionId, foldPath }) {
    const cwdEncoded = foldPath.replace(/\//g, "-");
    const sessionFile = join(
      homedir(),
      ".claude",
      "projects",
      cwdEncoded,
      `${sessionId}.jsonl`,
    );

    let raw: string;
    try {
      raw = readFileSync(sessionFile, "utf-8");
    } catch {
      return null; // session file gone or never existed
    }

    const index = new Map<string, TraceResolution>();
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type !== "assistant") continue;
      const message = obj.message as { model?: string; content?: unknown } | undefined;
      const blocks = message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "tool_use" &&
          (block as { name?: string }).name === "mcp__brane__narrate"
        ) {
          const input = (block as { input?: { say?: unknown } }).input;
          if (input && typeof input.say === "string" && !index.has(input.say)) {
            index.set(input.say, {
              offset: typeof obj.uuid === "string" ? obj.uuid : undefined,
              model: typeof message?.model === "string" ? message.model : undefined,
            });
          }
        }
      }
    }
    return index;
  },

  // Thin lookup over buildTraceIndex — preserved for callers that resolve a
  // single narration. Batch callers should use buildTraceIndex directly to
  // parse each transcript once.
  resolveTrace({ sessionId, foldPath, content }) {
    const index = this.buildTraceIndex!({ sessionId, foldPath });
    return index?.get(content) ?? null;
  },

  // Cumulative USD cost from the session JSONL: sum each assistant message's
  // token usage, priced by its *own* model (Claude can switch models
  // mid-session via /model). Deduped by message id to skip streamed
  // duplicates, matching the `brane-cost` reference. Memoized on the file
  // signature so unchanged transcripts aren't re-parsed.
  readUsage({ sessionId, foldPath }) {
    const entries = readClaudeUsageEntries(sessionId, foldPath);
    if (!entries) return null;
    return sumClaudeEntries([entries]);
  },

  // Narrative-level cost: sum every bound session's entries with one shared
  // seen-set so fork-copied history (see readUsageMany in AgentAdapter) counts
  // once. Null only when no session file is readable at all.
  readUsageMany({ sessionIds, foldPath }) {
    const sessions = sessionIds
      .map((sessionId) => readClaudeUsageEntries(sessionId, foldPath))
      .filter((entries): entries is ClaudeUsageEntry[] => entries !== null);
    if (sessions.length === 0) return null;
    return sumClaudeEntries(sessions);
  },

  // Same entries, keyed for the ledger. No seen-set here: the ledger's primary
  // key is the dedup, and it has to be, because it is the only copy that
  // survives the harness purging a transcript.
  readUsageEntries({ sessionIds, foldPath }) {
    const readings: UsageEntriesReading[] = [];
    for (const sessionId of sessionIds) {
      const read = readClaudeUsageEntriesSigned(sessionId, foldPath);
      if (!read) continue;
      readings.push({
        sessionId,
        sig: read.sig,
        unit: "USD",
        entries: read.entries.map((e, i) => ({
          key: claudeEntryKey(sessionId, e, i),
          amount: e.cost,
          model: e.model,
          tokens: {
            input: e.input,
            output: e.output,
            cacheRead: e.cacheRead,
            cacheWrite: e.cacheWrite,
            cacheWrite1h: e.cacheWrite1h,
          },
          speed: e.speed,
        })),
      });
    }
    return readings.length ? readings : null;
  },
};

// Goose keeps every session in one SQLite database (WAL), not per-session
// files: `sessions` is a row per session and `usage_ledger` a row per LLM
// request. Overridable for tests.
function gooseSessionsDb(): string {
  return join(homedir(), ".local", "share", "goose", "sessions", "sessions.db");
}

function copilotSessionStoreDb(): string {
  return join(homedir(), ".copilot", "session-store.db");
}

/** Copilot stores the metered amount in nano AIU, so divide exactly once at
 * the harness boundary and expose the existing unit-agnostic cost surface as
 * AIC. Token columns are per request and can be summed independently. */
export function readCopilotUsage(dbPath: string, sessionId: string): CostReading | null {
  return memoized(`copilot:${dbPath}:${sessionId}`, [dbPath, `${dbPath}-wal`], () =>
    withReadonlyDb(dbPath, (db) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count,
                  SUM(COALESCE(total_nano_aiu, 0)) AS nanoAiu,
                  SUM(COALESCE(input_tokens, 0)) AS input,
                  SUM(COALESCE(output_tokens, 0)) AS output,
                  SUM(COALESCE(cache_read_tokens, 0)) AS cacheRead,
                  SUM(COALESCE(cache_write_tokens, 0)) AS cacheWrite
             FROM assistant_usage_events WHERE session_id = ?`,
        )
        .get(sessionId) as {
        count: number; nanoAiu: number; input: number; output: number; cacheRead: number; cacheWrite: number;
      };
      if (row.count === 0) return null;
      return {
        amount: Math.round((row.nanoAiu / 1e9) * 1e9) / 1e9,
        unit: "AIC",
        tokens: { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite },
      };
    }),
  );
}

/** Resolve the goose session id backing a narrative. Exact, not heuristic:
 *  brane launches goose as `-n <narrativeId>` at both spawn and revive, and
 *  goose stores that verbatim as `sessions.name`, so the narrative id *is* the
 *  lookup key. That avoids the fold+time scoping codex needs (and its
 *  same-fold cross-assignment race) entirely.
 *
 *  Because revive reuses `-n <nid>`, goose resumes the same named row rather
 *  than minting a new session — so unlike cline and crush, a goose narrative
 *  keeps one session id for life and needs no post-revive re-capture.
 *
 *  Newest-first only to be safe: `name` is not declared UNIQUE, so a goose that
 *  somehow failed to resume could leave two rows sharing it, and the latest is
 *  then the live one. */
export function discoverGooseSession(dbPath: string, narrativeId: string): string | undefined {
  return (
    withReadonlyDb(dbPath, (db) => {
      const row = db
        .prepare("SELECT id FROM sessions WHERE name = ? ORDER BY created_at DESC LIMIT 1")
        .get(narrativeId) as { id?: string } | undefined;
      return typeof row?.id === "string" ? row.id : null;
    }) ?? undefined
  );
}

/** Price a goose session from its usage ledger. Goose records usage faithfully
 *  but prices nothing — `usage_ledger.cost`/`cost_source` are NULL for a
 *  custom provider — so brane owns the pricing here, unlike cline and crush
 *  which report USD the harness already computed.
 *
 *  Grouped by model because a session can switch models mid-flight; each group
 *  is priced by its own rate. `is_compaction` rows are real spend and count. */
export function readGooseUsage(dbPath: string, sessionId: string): CostReading | null {
  return memoized(`goose:${dbPath}:${sessionId}`, [dbPath, `${dbPath}-wal`], () =>
    withReadonlyDb(dbPath, (db) => {
      const rows = db
        .prepare(
          `SELECT model,
                  SUM(COALESCE(input_tokens, 0))       AS input,
                  SUM(COALESCE(output_tokens, 0))      AS output,
                  SUM(COALESCE(cache_read_tokens, 0))  AS cacheRead,
                  SUM(COALESCE(cache_write_tokens, 0)) AS cacheWrite
             FROM usage_ledger
            WHERE session_id = ?
            GROUP BY model`,
        )
        .all(sessionId) as Array<{
        model: string | null;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      }>;
      if (rows.length === 0) return null;

      let cost = 0,
        input = 0,
        output = 0,
        cacheRead = 0,
        cacheWrite = 0;
      for (const r of rows) {
        // Goose's `input_tokens` is *inclusive* of the cache-read portion
        // (a live sample read 172,498 input of which 171,667 were cache
        // reads), whereas priceMessage expects Anthropic-style disjoint
        // counts. Subtract, and clamp: a provider that reported them
        // disjointly would otherwise price as a negative.
        const freshInput = Math.max(0, r.input - r.cacheRead);
        // A NULL model falls through priceForModel to the most-expensive known
        // tier, per the price table's never-under-report policy. Not observed
        // in a live ledger, but worth knowing the error direction is over.
        cost += priceMessage(r.model ?? "", {
          input: freshInput,
          output: r.output,
          cacheRead: r.cacheRead,
          // Goose records one undifferentiated cache-write count with no TTL,
          // so bill it at the 5-minute rate — right for Anthropic-backed
          // sessions, and moot for Fireworks, which never charges for cache
          // writes and always reports zero here.
          cacheWrite5m: r.cacheWrite,
          cacheWrite1h: 0,
        });
        input += r.input;
        output += r.output;
        cacheRead += r.cacheRead;
        cacheWrite += r.cacheWrite;
      }
      return {
        amount: Math.round(cost * 1e4) / 1e4,
        unit: "USD",
        // Report goose's own inclusive input count, matching what its ledger
        // says; only the pricing math needs the disjoint split.
        tokens: { input, output, cacheRead, cacheWrite },
      };
    }),
  );
}

// Goose: resumes by session name (narrative ID) with -r flag
const gooseAdapter: AgentAdapter = {
  // Goose mints its own session id (`<yyyymmdd>_<n>`); brane learns it by
  // looking up the name it launched goose under. Capture rather than assign.
  sessionIdOwnership: "capture",

  resumeArgs() {
    return ["-r"];
  },

  // foldPath/since are unused: the narrative id is an exact key, which is
  // strictly better than scoping by fold and spawn time.
  discoverSessionId(_foldPath, _since, narrativeId) {
    if (!narrativeId) return undefined;
    return discoverGooseSession(gooseSessionsDb(), narrativeId);
  },

  readUsage({ sessionId }) {
    return readGooseUsage(gooseSessionsDb(), sessionId);
  },
};

// Gemini: no session resume support (uses -i for prompt injection)
const geminiAdapter: AgentAdapter = {
  resumeArgs() {
    return [];
  },
  discoverSessionId() {
    return undefined;
  },
};

// Read just the first line of a file without slurping a multi-MB rollout: read a
// bounded prefix and cut at the first newline. Codex's `session_meta` line embeds
// the full base instructions, so it can be several KB — 256KB is ample headroom.
// Degradation (accepted): if a first line somehow exceeds `maxBytes` there's no
// newline in the prefix, so the truncated slice fails to JSON-parse and that
// rollout is skipped (its narrative just won't auto-resume). Only reachable with a
// pathologically large base_instructions block; a larger cap trades memory for it.
function readFirstLine(path: string, maxBytes = 1 << 18): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const s = buf.toString("utf8", 0, n);
    const nl = s.indexOf("\n");
    return nl === -1 ? s : s.slice(0, nl);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// Parse a codex rollout's leading `session_meta` event into the fields we scope
// on. Returns undefined for anything that isn't a well-formed session_meta line.
function readCodexSessionMeta(
  path: string,
): { id: string; cwd: string; ts: number } | undefined {
  const line = readFirstLine(path);
  if (!line) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!obj || (obj as { type?: unknown }).type !== "session_meta") return undefined;
  const p = (obj as { payload?: Record<string, unknown> }).payload;
  if (
    !p ||
    typeof p.id !== "string" ||
    typeof p.cwd !== "string" ||
    typeof p.timestamp !== "string"
  ) {
    return undefined;
  }
  const ts = Date.parse(p.timestamp);
  if (!Number.isFinite(ts)) return undefined;
  return { id: p.id, cwd: p.cwd, ts };
}

// Return numeric-named children of a directory as { name, n } (e.g. the
// "2026"/"03"/"05" tiers of codex's sessions tree), skipping non-numeric names.
function numericEntries(dir: string): Array<{ name: string; n: number }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, n: Number(name) }))
    .filter((e) => Number.isInteger(e.n));
}

// Discover a codex session id for `foldPath` from its rollout store, laid out as
// `<sessionsDir>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Each rollout's first line
// is a `session_meta` event carrying { id, cwd, timestamp }. We pick *this*
// narrative's own rollout: cwd must equal the fold, and — given a spawn time
// `since` — the session must have started after it, taking the EARLIEST such
// start (the rollout created right after this spawn). The cwd + since scoping is
// what stops two codex narratives sharing a fold from cross-contaminating — the
// fold-wide-latest trap the claude adapter documents. Exported for testing
// against a fixture tree; production passes `~/.codex/sessions`.
//
// Known limitation (accepted, filesystem-discovery inherent): "earliest after
// `since`" assumes rollout-creation order matches spawn order. Two codex
// narratives spawned into the *same fold* near-simultaneously, where the
// later-spawned one writes its `session_meta` first, could cross-assign. It's a
// narrow race with no tighter handle available (codex owns its own id and we
// only learn it from disk); the single-narrative and staggered-spawn cases — the
// norm — are correct. Cf. the resume-rotation limitation on maybeCaptureSessionId.
export function discoverCodexSession(
  sessionsDir: string,
  foldPath: string,
  since?: number,
): string | undefined {
  const sinceDate = since !== undefined ? new Date(since) : undefined;
  const wantCwd = resolve(foldPath);
  let best: { id: string; ts: number } | undefined;

  for (const y of numericEntries(sessionsDir)) {
    if (sinceDate && y.n < sinceDate.getFullYear()) continue;
    const yDir = join(sessionsDir, y.name);
    for (const mo of numericEntries(yDir)) {
      if (sinceDate && y.n === sinceDate.getFullYear() && mo.n < sinceDate.getMonth() + 1) continue;
      const moDir = join(yDir, mo.name);
      for (const d of numericEntries(moDir)) {
        if (
          sinceDate &&
          y.n === sinceDate.getFullYear() &&
          mo.n === sinceDate.getMonth() + 1 &&
          d.n < sinceDate.getDate()
        ) {
          continue;
        }
        const dDir = join(moDir, d.name);
        let files: string[];
        try {
          files = readdirSync(dDir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
          const meta = readCodexSessionMeta(join(dDir, f));
          if (!meta) continue;
          if (resolve(meta.cwd) !== wantCwd) continue;
          if (since !== undefined && meta.ts <= since) continue;
          if (!best || meta.ts < best.ts) best = { id: meta.id, ts: meta.ts };
        }
      }
    }
  }
  return best?.id;
}

/** Default root of codex's rollout store. */
export function codexSessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

/** sessionId → rollout path. A rollout is named for the session it records and
 *  is never renamed, so the mapping is stable for the life of the process and
 *  worth caching: it is the only part of a usage or tool-log read that must
 *  walk the tree. Misses are not cached — a young session has no file yet. */
const rolloutPaths = new Map<string, string>();

/** Find the rollout recording `sessionId`, or undefined if there isn't one yet.
 *
 *  The filename ends with `-<sessionId>.jsonl`, which makes the scan a string
 *  test per entry, but the name is only a hint: `session_meta` is the
 *  authority, so a match is confirmed by reading the first line. Exported for
 *  the tool-log reader and for testing against a fixture tree. */
export function findCodexRollout(
  sessionId: string,
  sessionsRoot = codexSessionsRoot(),
): string | undefined {
  const key = `${sessionsRoot} ${sessionId}`;
  const cached = rolloutPaths.get(key);
  if (cached !== undefined) {
    try {
      statSync(cached);
      return cached;
    } catch {
      rolloutPaths.delete(key); // moved out from under us; fall through to rescan
    }
  }
  const suffix = `-${sessionId}.jsonl`;
  for (const y of numericEntries(sessionsRoot)) {
    const yDir = join(sessionsRoot, y.name);
    for (const mo of numericEntries(yDir)) {
      const moDir = join(yDir, mo.name);
      for (const d of numericEntries(moDir)) {
        const dDir = join(moDir, d.name);
        let files: string[];
        try {
          files = readdirSync(dDir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith(suffix)) continue;
          const path = join(dDir, f);
          if (readCodexSessionMeta(path)?.id !== sessionId) continue;
          rolloutPaths.set(key, path);
          return path;
        }
      }
    }
  }
  return undefined;
}

/** Codex's cumulative token counters, from the rollout's last `token_count`. */
interface CodexTotals {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
}

/** Memoized on the rollout's (size, mtime), so a cost-sampler tick against an
 *  unchanged file costs one `stat` and nothing else. */
const codexUsageCache = new Map<string, { sig: string; reading: CostReading | null }>();

/** Bytes of the tail searched for the last `token_count`, doubling up to the
 *  whole file if the window lands in a stretch without one. Codex emits a
 *  `token_count` per turn, so the first window almost always holds several; the
 *  growth path covers a turn that appended a very large tool result after the
 *  counter. */
const CODEX_TAIL_WINDOW_BYTES = 1 << 16;

/** Read the tail of a file as lines, dropping the leading partial line unless
 *  the window starts at byte 0. Slicing the *buffer* and decoding after is
 *  deliberate: a window boundary landing inside a multi-byte sequence would
 *  otherwise leave a replacement character in the JSON. Returns [] when the
 *  window holds no line boundary at all, which tells the caller to widen. */
function readTailLines(path: string, size: number, windowBytes: number): string[] {
  const start = Math.max(0, size - windowBytes);
  const length = size - start;
  if (length <= 0) return [];
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  let buf: Buffer;
  try {
    buf = Buffer.allocUnsafe(length);
    const n = readSync(fd, buf, 0, length, start);
    buf = buf.subarray(0, n);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
  if (start > 0) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) return [];
    buf = buf.subarray(nl + 1);
  }
  return buf.toString("utf8").split("\n");
}

/** Cumulative token usage for a codex session.
 *
 *  Reported in `TOK`, not `USD`, and that is not a placeholder. Codex records
 *  exact counters but no durable model-price attribution, and `priceMessage`
 *  knows Anthropic models only — an unmatched id falls through to a
 *  $10/$50-per-Mtok default tier. Pricing a GPT session through that would not
 *  approximate anything; it would invoice an OpenAI transcript at Opus rates.
 *  `formatCost` already renders non-USD units, so the card stays truthful.
 *
 *  No `readUsageMany` counterpart, deliberately: `total_token_usage` is
 *  cumulative *within one rollout* and starts at zero in a resumed session,
 *  which pays for its replayed context again as cache-read input. Summing
 *  per-session readings is therefore already correct — unlike claude, whose
 *  `--fork-session` copies priced history forward and must dedupe by id.
 *
 *  Only the last counter matters, so this searches a tail window rather than
 *  the file: O(window), not O(session). A rollout passes two megabytes within
 *  the hour and this runs on the daemon's only thread. */
export function readCodexUsage(
  sessionId: string,
  sessionsRoot = codexSessionsRoot(),
): CostReading | null {
  const path = findCodexRollout(sessionId, sessionsRoot);
  if (!path) return null;

  let size: number, sig: string;
  try {
    const st = statSync(path);
    size = st.size;
    sig = `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
  const cached = codexUsageCache.get(path);
  if (cached && cached.sig === sig) return cached.reading;

  let totals: CodexTotals | undefined;
  for (let window = CODEX_TAIL_WINDOW_BYTES; ; window *= 2) {
    for (const line of readTailLines(path, size, window)) {
      // Cheap reject before parse: nearly every line is a message, reasoning,
      // or tool traffic, and parsing them all is the cost this reader exists
      // to avoid.
      if (!line.includes('"token_count"')) continue;
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          payload?: { type?: string; info?: { total_token_usage?: CodexTotals } };
        };
        if (obj.type !== "event_msg" || obj.payload?.type !== "token_count") continue;
        const t = obj.payload.info?.total_token_usage;
        if (t) totals = t;
      } catch {
        // A line clipped by the window edge, or a partial final write.
      }
    }
    if (totals || window >= size) break;
  }

  const finish = (reading: CostReading | null): CostReading | null => {
    codexUsageCache.set(path, { sig, reading });
    return reading;
  };
  if (!totals) return finish(null);

  // Codex's `cached_input_tokens` is a *subset* of `input_tokens`, where claude
  // reports the two disjointly. Subtract so a breakdown means the same thing
  // whichever agent produced it, and so a consumer summing the fields doesn't
  // count the cached portion twice. Clamped because a negative input would be a
  // worse answer than a zero one.
  const rawInput = num(totals.input_tokens);
  const cacheRead = Math.min(num(totals.cached_input_tokens), rawInput);
  const output = num(totals.output_tokens);
  const total = num(totals.total_tokens) || rawInput + output;
  if (!total) return finish(null);
  return finish({
    amount: total,
    unit: "TOK",
    tokens: {
      input: rawInput - cacheRead,
      output,
      cacheRead,
      cacheWrite: num(totals.cache_write_input_tokens),
    },
  });
}

/** Drop cached codex rollout state. Tests only — production state is
 *  process-lifetime and self-invalidating on the file signature. */
export function resetCodexCaches(): void {
  rolloutPaths.clear();
  codexUsageCache.clear();
}

// Codex: resumes via `codex resume <session_id>`. Codex generates its own
// session id (no caller-assign flag like claude's `--session-id`), so the daemon
// *captures* it from codex's rollout store rather than assigning it.
const codexAdapter: AgentAdapter = {
  sessionIdOwnership: "capture",

  resumeArgs({ sessionId }) {
    if (!sessionId) return [];
    return ["resume", sessionId];
  },

  discoverSessionId(foldPath, since) {
    return discoverCodexSession(codexSessionsRoot(), foldPath, since);
  },

  readUsage({ sessionId }) {
    return readCodexUsage(sessionId);
  },
};

// Amp: no simple CLI resume — uses thread references (@T-<id>) in prompt
const ampAdapter: AgentAdapter = {
  resumeArgs() {
    return [];
  },
  discoverSessionId() {
    return undefined;
  },
};

// Copilot accepts a caller-assigned UUID with --session-id, avoiding the
// fold-wide `--continue` ambiguity when multiple narratives share a fold.
const copilotAdapter: AgentAdapter = {
  sessionIdOwnership: "assign",

  resumeArgs({ sessionId, newSessionId }) {
    const id = sessionId ?? newSessionId;
    return id ? ["--session-id", id] : [];
  },
  discoverSessionId() {
    return undefined;
  },
  readUsage({ sessionId }) {
    return readCopilotUsage(copilotSessionStoreDb(), sessionId);
  },
};

// Cline is launched with `--config /tmp/brane-cline-<nid>` (see
// ensureClineMcpConfig in commands/spawn.ts), so its whole store is private to
// one narrative — sessions live at
// `<dir>/data/sessions/<sid>/<sid>.messages.json`.
//
// Caveat, accepted: /tmp is cleared on reboot, so a narrative's cost history
// dies with it and the reading degrades to null. That's already the contract.
function clineSessionsDir(narrativeId: string): string {
  return join("/tmp", `brane-cline-${narrativeId}`, "data", "sessions");
}

function clineMessagesFile(narrativeId: string, sessionId: string): string {
  return join(clineSessionsDir(narrativeId), sessionId, `${sessionId}.messages.json`);
}

/** Sum one cline session's cost from its message log.
 *
 *  Per-message `metrics.cost` rather than the session record's
 *  `metadata.totalCost`: cline accumulates that total only on the turn-success
 *  path, so a session with errored turns (an MCP listen timeout, say) persists
 *  the message metrics but silently drops their cost from the total. Summing
 *  the messages is never lower and sometimes much higher.
 *
 *  The costs are cline's own, computed from its models.dev rate card, and are
 *  taken as authoritative — never re-priced. A narrative's provider can change
 *  across revives, so the rate that applied is knowable only to the harness
 *  that made the call. */
export function readClineSessionUsage(file: string): CostReading | null {
  return memoized(`cline:${file}`, [file], () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
    const messages = (parsed as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) return null;

    let cost = 0,
      input = 0,
      output = 0,
      cacheRead = 0,
      cacheWrite = 0;
    // Dedup within the file only. Cline never copies history between sessions
    // (each revive starts an empty log), so the cross-file seen-set that
    // claude's fork handling needs would here only risk *under*-counting two
    // genuinely distinct messages that happened to share an id.
    const seen = new Set<string>();
    for (const m of messages) {
      const metrics = (m as { metrics?: Record<string, unknown> })?.metrics;
      if (!metrics) continue;
      const id = (m as { id?: unknown }).id;
      if (typeof id === "string") {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      cost += num(metrics.cost);
      input += num(metrics.inputTokens);
      output += num(metrics.outputTokens);
      cacheRead += num(metrics.cacheReadTokens);
      cacheWrite += num(metrics.cacheWriteTokens);
    }
    return {
      amount: Math.round(cost * 1e6) / 1e6,
      unit: "USD",
      tokens: { input, output, cacheRead, cacheWrite },
    };
  });
}

/** Every session id present in a narrative's private cline store. */
function clineStoredSessions(narrativeId: string): string[] {
  try {
    return readdirSync(clineSessionsDir(narrativeId), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Cline CLI: resumes via `--taskId <id>` (but we don't discover task IDs)
const clineAdapter: AgentAdapter = {
  // Cline mints `<epochMs>_<rand5>` ids and starts a fresh session on every
  // revive, so brane captures them rather than assigning.
  sessionIdOwnership: "capture",

  resumeArgs() {
    return [];
  },

  // The config dir is per-narrative, so no fold scoping is needed — but `since`
  // still is, and cheaply: a cline session id is `<epochMs>_<rand5>`, so it
  // carries its own start time. Honouring it matters after a revive, when the
  // previous session is still the newest thing on disk for the moment it takes
  // the new one to appear; returning that incumbent would otherwise be taken
  // for the successor. Ids also sort lexicographically by start time, which
  // holds until epoch ms gains a digit in the year 33658.
  discoverSessionId(_foldPath, since, narrativeId) {
    if (!narrativeId) return undefined;
    return clineStoredSessions(narrativeId)
      .filter((id) => since === undefined || Number(id.split("_")[0]) >= since)
      .sort()
      .pop();
  },

  readUsage({ sessionId, narrativeId }) {
    if (!narrativeId) return null;
    return readClineSessionUsage(clineMessagesFile(narrativeId, sessionId));
  },

  // Sum every session in the narrative's private store, not just the ones
  // brane managed to record. The directory is brane-owned and strictly
  // per-narrative, so whatever is in it *is* this narrative's spend — which
  // keeps the badge correct for revives that happened before the daemon
  // learned to re-capture, and for any session captured late or not at all.
  // The recorded ids are still unioned in, so a session that has been moved
  // or pre-dates the current dir layout is never dropped.
  readUsageMany({ sessionIds, narrativeId }) {
    if (!narrativeId) return null;
    const ids = [...new Set([...clineStoredSessions(narrativeId), ...sessionIds])];
    const readings = ids.map((id) => readClineSessionUsage(clineMessagesFile(narrativeId, id)));
    return sumCostReadings(readings);
  },
};

// Crush keeps one SQLite database per *fold* (`<fold>/.crush/crush.db`, WAL),
// so unlike goose and cline its store is shared by every crush narrative in
// that fold — hence the fold + spawn-time scoping below. The data dir is
// configurable via crush's `options.data_directory`; only the default is
// handled, and a fold that overrides it simply reports no cost.
function crushDbPath(foldPath: string): string {
  return join(foldPath, ".crush", "crush.db");
}

/** Crush spawns synthetic sessions alongside real ones: `title-<parentId>` for
 *  title generation and `<messageID>$$<toolCallID>` for its `agent` tool. Both
 *  are spend, but neither is the narrative's own session, so discovery must
 *  skip them. Real sessions have a NULL parent. */
const CRUSH_REAL_SESSION =
  "parent_session_id IS NULL AND id NOT LIKE 'title-%' AND id NOT LIKE '%$$%'";

/** Discover the crush session a narrative spawned, by fold + start time.
 *
 *  Earliest session starting at or after `since`, matching the codex adapter's
 *  reasoning: the row created right after this spawn is ours, whereas
 *  newest-in-fold would drift to an unrelated later session. It inherits
 *  codex's known limitation too — two crush narratives spawned into one fold
 *  within the same moment could cross-assign — because crush owns its ids and
 *  we only learn them from disk.
 *
 *  The unit handling is the subtle part: crush's schema annotates `created_at`
 *  as milliseconds but writes seconds, so comparing a ms `since` against it
 *  directly matches nothing, forever, with no error to notice. Both sides are
 *  normalized to seconds; the truncation of `since` is deliberately the lenient
 *  direction, so a session created in the same second as the spawn still
 *  matches. */
export function discoverCrushSession(
  dbPath: string,
  since?: number,
): string | undefined {
  return (
    withReadonlyDb(dbPath, (db) => {
      const rows = db
        .prepare(`SELECT id, created_at FROM sessions WHERE ${CRUSH_REAL_SESSION} ORDER BY created_at ASC`)
        .all() as Array<{ id: string; created_at: number }>;
      const floor = since === undefined ? undefined : Math.floor(since / 1000);
      for (const r of rows) {
        if (floor !== undefined && epochSeconds(r.created_at) < floor) continue;
        return r.id;
      }
      return null;
    }) ?? undefined
  );
}

/** Read a crush session's cumulative USD cost. Crush computes and accumulates
 *  cost itself (`session.Cost += cost` per request), so brane sums the stored
 *  figure and never re-prices — the model and provider behind a session can
 *  change, and the harness's own number is authoritative.
 *
 *  Includes the session's direct children: crush's `agent` tool and its
 *  title-generation pass each run in their own session row, and that spend is
 *  the narrative's. (Only one level down — deeper nesting isn't something the
 *  live store exercises, so it isn't something this claims to handle.)
 *
 *  Deliberately returns no `tokens`: `prompt_tokens`/`completion_tokens` are
 *  overwritten with each request's usage rather than accumulated — they exist
 *  to gauge context size for auto-summarization — so reporting them as a
 *  session total would be a lie. Crush would need a usage ledger for that.
 *
 *  A $0 reading is meaningful and returned as-is: it means the fold's crush
 *  config priced the model at zero (crush's default for a custom provider that
 *  declares no `cost_per_1m_*` fields), not that usage is unknown. */
export function readCrushUsage(dbPath: string, sessionId: string): CostReading | null {
  return memoized(`crush:${dbPath}:${sessionId}`, [dbPath, `${dbPath}-wal`], () =>
    withReadonlyDb(dbPath, (db) => {
      const row = db
        .prepare(
          `SELECT SUM(cost) AS cost FROM sessions
            WHERE id = ? OR parent_session_id = ? OR id = 'title-' || ?`,
        )
        .get(sessionId, sessionId, sessionId) as { cost: number | null } | undefined;
      if (row?.cost == null) return null; // no such session
      return { amount: Math.round(row.cost * 1e4) / 1e4, unit: "USD" };
    }),
  );
}

// Crush (formerly OpenCode): no CLI session resume yet
const crushAdapter: AgentAdapter = {
  // Crush mints its own uuid per session and has no resume, so every revive
  // starts a fresh row; brane captures each one for cost aggregation.
  sessionIdOwnership: "capture",

  resumeArgs() {
    return [];
  },

  discoverSessionId(foldPath, since) {
    return discoverCrushSession(crushDbPath(foldPath), since);
  },

  readUsage({ sessionId, foldPath }) {
    return readCrushUsage(crushDbPath(foldPath), sessionId);
  },
};

// Default adapter for agents without session resumption
const defaultAdapter: AgentAdapter = {
  resumeArgs() {
    return [];
  },
  discoverSessionId() {
    return undefined;
  },
};

// Registry of agent adapters. Add new agents here.
const AGENTS: Record<string, AgentAdapter> = {
  claude: claudeAdapter,
  goose: gooseAdapter,
  gemini: geminiAdapter,
  codex: codexAdapter,
  amp: ampAdapter,
  copilot: copilotAdapter,
  cline: clineAdapter,
  crush: crushAdapter,
};

export const KNOWN_AGENTS = new Set(Object.keys(AGENTS));

// Agent types whose adapter can resolve per-message model/offset provenance.
// Used by the trace resolver to filter candidate events in SQL so it never
// materializes events authored by agents it could only skip in JS.
export const TRACE_RESOLVABLE_AGENTS: string[] = Object.entries(AGENTS)
  .filter(([, adapter]) => typeof adapter.resolveTrace === "function")
  .map(([type]) => type);

export function getAgentAdapter(agentType: string): AgentAdapter {
  return AGENTS[agentType] ?? defaultAdapter;
}
