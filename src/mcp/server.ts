import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { connect as netConnect } from "node:net";

interface McpRequest {
  jsonrpc: "2.0";
  /** Absent on a notification, which must never be answered. */
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpToolDefinition[] = [
  {
    name: "narrate",
    description:
      "Post a narration to your narrative (or a foreign narrative). " +
      "Returns events based on cursor parameters, minus the narration just written (`seq` says where it landed) " +
      "— but those events are a RECEIPT, not a poll: " +
      "anything handed back arrived too late to shape the words you just committed. " +
      "Before composing anything substantive, read first with listen({ wait: false, after: <your cursor> }) " +
      "and interpret what it returns. " +
      "Only narrate when you have meaningful content (answers, questions, status updates). " +
      "Do NOT narrate filler like 'In loop' or 'Listening'. " +
      "When a narration ends your turn (an answer, a question, a report) pass `wait: true`: it posts, " +
      "then blocks exactly as listen would, in one call instead of two. Otherwise call listen immediately after. " +
      "While working, send a progress narration as a parallel tool call in the same turn as the work it " +
      "describes (the Bash, Read, Edit, …), never as a turn of its own: every turn re-reads your whole context. " +
      "If the narration would not render as written — unparseable LaTeX, a `$…$` run that is not " +
      "treated as math, an unclosed fence — the result carries a `warnings` array, each entry with a " +
      "`message` and the `fallback` text the operator will actually see. Warnings never block the " +
      "narration: judge from the fallback whether the meaning still arrived, and apply the fix to " +
      "what you write next rather than correcting the last one. Pass `strict: true` to refuse instead " +
      "of posting, when a particular narration must render exactly.",
    inputSchema: {
      type: "object",
      properties: {
        say: {
          type: "string",
          description: "The narration text (what you want to say)",
        },
        after: {
          oneOf: [
            { type: "number" },
            { type: "object", additionalProperties: { type: "number" } },
          ],
          description:
            "Cursor — the seq you've already seen, exclusive (returns events with seq > it). A cursor is a per-narrative watermark: pass a number to track your own narrative (0 = from the beginning), or an object mapping narrative IDs to seq to watch several at once, where the key \"self\" means your own narrative. before and tail accept the same two forms.",
        },
        before: {
          oneOf: [
            { type: "number" },
            { type: "object", additionalProperties: { type: "number" } },
          ],
          description:
            "Upper bound, exclusive (returns events with seq < it). Same forms as after; pair with after for a bounded window.",
        },
        tail: {
          oneOf: [
            { type: "number" },
            { type: "object", additionalProperties: { type: "number" } },
          ],
          description:
            "Return only the last N events. Same forms as after; pair with before to page backward.",
        },
        nid: {
          type: "string",
          description: "Target narrative ID for foreign narration (default: self)",
        },
        re: {
          type: "array",
          items: { oneOf: [{ type: "number" }, { type: "string" }] },
          description:
            "Back-references: array of seq numbers (same narrative) or 'narrative-id:seq' strings",
        },
        meta: {
          type: "object",
          description:
            "Optional metadata. Key: summary (what tells this session apart). Session IDs are " +
            "owned by the daemon and set at spawn/revive — there is no agent-set " +
            "session field.",
          properties: {
            summary: {
              type: "string",
              description:
                "What tells this session apart for the operator, then where it stands: " +
                "name the task, not a bare outcome like \"PR merged\"; newest theme first. " +
                "Reread it at every report.",
            },
          },
        },
        payloads: {
          type: "array",
          items: { type: "string" },
          description:
            "File paths to attach as payloads. Absolute paths on the local filesystem. " +
            "Files are copied into managed storage and served via the payloads API.",
        },
        strict: {
          type: "boolean",
          description:
            "Refuse to post this narration if it would not render as written (default: false). " +
            "The call fails with the same diagnostics `warnings` carries and nothing is appended, " +
            "so you can fix the source and narrate again. Opt in per narration — for an equation " +
            "or a table that has to land right — not as a habit: gating every narration on " +
            "typography costs the conversation its pace.",
        },
        wait: {
          type: "boolean",
          description:
            "After posting, block until new signals arrive, exactly as listen does (default: false), " +
            "and return listen's result with this narration left out. The mirror of listen's " +
            "`wait: false`. `after` takes any cursor listen does, several narratives included; anything " +
            "that landed since it comes back at once, as a receipt would. Omit `after` to wait for what " +
            "arrives next in your own narrative, and in the target of a foreign `nid`. With `before` or " +
            "`tail` it does not wait: the result says `wait_ignored`, and you call listen next.",
        },
      },
      required: ["say"],
    },
  },
  {
    name: "listen",
    description:
      "Block and wait for new signals. Stateless cursor-based long-polling. " +
      "Also your read-before-you-speak step: call with wait: false for an instant non-blocking check " +
      "of everything that landed since your cursor, and interpret it BEFORE you compose a narration. " +
      "Your own narrations never wake a waiting listen, but are returned with whatever does. " +
      "IMPORTANT: When this times out with no events, call listen again immediately — do NOT narrate. " +
      "You MUST keep calling listen in a loop. Never exit to your prompt while the session is active.",
    inputSchema: {
      type: "object",
      properties: {
        after: {
          oneOf: [
            { type: "number" },
            { type: "object", additionalProperties: { type: "number" } },
          ],
          description:
            "Cursor — the seq you've already seen, exclusive (returns events with seq > it). A cursor is a per-narrative watermark: pass a number to track your own narrative (0 = from the beginning), or an object mapping narrative IDs to seq to watch several at once, where the key \"self\" means your own narrative. before and tail accept the same two forms.",
        },
        before: {
          oneOf: [
            { type: "number" },
            { type: "object", additionalProperties: { type: "number" } },
          ],
          description:
            "Upper bound, exclusive (returns events with seq < it). Same forms as after; pair with after for a bounded window.",
        },
        tail: {
          oneOf: [
            { type: "number" },
            { type: "object", additionalProperties: { type: "number" } },
          ],
          description:
            "Return only the last N events. Same forms as after; pair with before to page backward.",
        },
        wait: {
          type: "boolean",
          description:
            "Whether to block and wait for signals (default: true). " +
            "Set to false for a non-blocking read that returns immediately.",
        },
        mentions: {
          enum: ["all", "dismiss"],
          description:
            "Rarely needed. \"all\" replays recent mentions of you whether or not they were settled — the recovery read, for when you suspect one was missed. " +
            "\"dismiss\" settles everything outstanding: use it for a mention you have judged irrelevant and do not intend to read, which would otherwise reappear in every receipt. " +
            "Omit for normal operation, where a mention settles by your reading the narrative it was written in.",
        },
      },
      required: [],
    },
  },
  {
    name: "whoami",
    description:
      "Get your narrative ID, brane ID, fold directory, agent type, and role, and the directory brane is installed in " +
      "(`install_dir`), where its own documentation lives.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "revive",
    description:
      "Restart a dead agent session. Idempotent — if already running, optionally delivers a prompt.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description: "Narrative/session ID to revive",
        },
        prompt: {
          type: "string",
          description: "Custom prompt to send to the revived agent",
        },
        no_prompt: {
          type: "boolean",
          description: "If true, suppress the initial prompt entirely",
        },
        agent: {
          type: "string",
          description: "Switch to a different agent type (e.g. claude, goose, gemini). Launches a fresh agent session continuing the same narrative.",
        },
      },
      required: ["session"],
    },
  },
  {
    name: "narrative_search",
    description:
      "Semantic search across narrative history. Returns events ranked by relevance. " +
      "Auto-indexes unindexed events on first call (may be slow if embedding model not cached).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (short phrases work best)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10)",
        },
        brane_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Brane IDs to search within (default: caller's brane only). " +
            "Pass multiple to search across branes.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "narrative_info",
    description:
      "Get info about narratives. Without nid: browse recently active narratives " +
      "(time-descending list with optional filtering). With nid: get detailed info " +
      "on specific narratives including event count, metadata, timestamps, and status. " +
      "The since/search/status/fold/archived filters apply to browse mode only (ignored when nid is given).",
    inputSchema: {
      type: "object",
      properties: {
        nid: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "Narrative ID(s) to get detailed info for. " +
            "When provided, returns full metadata for those specific narratives.",
        },
        since: {
          type: "string",
          description:
            "Time window for recent activity (e.g. 30m, 1h, 2d, 1w). Default: 24h.",
        },
        search: {
          type: "string",
          description: "Filter to narratives containing matching event content.",
        },
        status: {
          type: "string",
          description: "Filter by narrative status (active, ended).",
        },
        archived: {
          type: "boolean",
          description: "Include archived narratives (default: false).",
        },
        fold: {
          type: "string",
          description: "Filter by fold path (e.g. ~/dev/brane).",
        },
        limit: {
          type: "number",
          description: "Maximum number of narratives to return (default: 20, 0 = unlimited)",
        },
        brane_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Brane IDs to browse within (default: caller's brane only). " +
            "Pass multiple to browse across branes.",
        },
      },
    },
  },
  {
    name: "list_peers",
    description:
      "List active LIVE-loop agent peers. Returns peers grouped by fold: " +
      "same-fold peers first, then others. Excludes the caller.",
    inputSchema: {
      type: "object",
      properties: {
        include_inactive: {
          type: "boolean",
          description: "Include inactive/dead peers (default: false)",
        },
      },
    },
  },
  {
    name: "list_branes",
    description:
      "List all branes hosted by this daemon. Returns brane IDs with narrative " +
      "counts and last-activity timestamps. The caller's own brane is listed first; " +
      "remaining branes are ordered by recency. Use the returned brane_ids with " +
      "narrative_search or narrative_info to scope queries across branes.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_protocols",
    description: "List available protocol documents.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "read_protocol",
    description: "Read a protocol document by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Protocol name (e.g., 'LIVE_loop', 'ramify')",
        },
        no_prelude: {
          type: "boolean",
          description:
            "Skip the common protocol prelude (default: false). " +
            "Set to true if you have already read it in this session.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_wiki",
    description:
      "List wiki pages reachable from the caller's fold. Returns each page's " +
      "slug (its path under wiki/, with .md), title, human-authored description " +
      "(from frontmatter, else the first prose line), source, and whether it is " +
      "shared. A fold's wiki is `wiki/` plus an optional `wiki/shared/`: pages " +
      "under shared/ (slug `shared/foo.md`) are visible from every fold; pages " +
      "directly under wiki/ are visible only to the fold's own agents. The " +
      "install directory is a fold like any other, so brane's own shipped pages " +
      "arrive as that fold's shared/ pages. `source` is the fold's basename " +
      "(`~2`, `~3` when two folds share one) — provenance is always explicit. " +
      "Defaults to the caller's fold (all of it) plus the install fold's shared " +
      "pages; pass `all: true` to reach every registered fold's shared pages. " +
      "Companion to read_wiki and search_wiki.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            "Restrict to one source label (a fold basename), or 'all'. Naming a " +
            "non-default source widens the reachable set to include its shared pages.",
        },
        order: {
          type: "string",
          enum: ["slug", "title", "mtime"],
          description: "Sort key (default: slug).",
        },
        filter: {
          type: "string",
          description: "Case-insensitive substring filter over slug, title, and description.",
        },
        all: {
          type: "boolean",
          description: "Include every registered fold's shared pages, not just the caller's fold.",
        },
      },
    },
  },
  {
    name: "read_wiki",
    description:
      "Read a wiki page by slug, stamped with its source for transparent " +
      "provenance. Returns the page (or a single section via `anchor`), the " +
      "table of contents (heading anchors), and a citation string of the form " +
      "`slug` or `slug#anchor` — the wiki analogue of an `nid:seq` reference. " +
      "Paginates over the page's markdown chunks via `offset`/`limit`. If " +
      "`source` is omitted and the slug is unique across reachable wikis, it is " +
      "resolved automatically.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "Page slug, with or without the .md extension (e.g. 'live-loop', " +
            "'shared/premature-ontologies'). A bare name that isn't a local page " +
            "falls through to shared/<name>.md. Reading another fold's local page " +
            "errors with 'local, not shared' rather than not-found.",
        },
        source: {
          type: "string",
          description:
            "Source label (a fold basename). Optional when the slug is " +
            "unambiguous; required to disambiguate a slug present in several sources.",
        },
        anchor: {
          type: "string",
          description:
            "Return only the section under this heading anchor (GitHub-style slug, " +
            "with or without a leading '#').",
        },
        offset: {
          type: "number",
          description: "Chunk offset for pagination (default: 0).",
        },
        limit: {
          type: "number",
          description: "Max chunks to return (default: the whole page/section).",
        },
        window: {
          type: "number",
          description:
            "Opt into neighbor-aware reading: return one section's content plus " +
            "this many heading-only neighbors on each side (prev/next, with a " +
            "1-line preview) so you can walk the page section-by-section. " +
            "Pairs with `anchor` (omit `anchor` to start at the page top). " +
            "Default 3 when set, max 10. Overrides offset/limit.",
        },
        all: {
          type: "boolean",
          description: "Widen source resolution to every registered fold's wiki.",
        },
      },
      required: ["slug"],
    },
  },
  {
    name: "search_wiki",
    description:
      "Semantic + keyword search across wiki pages, like narrative_search but " +
      "over the curated wikis instead of the narrative event log. Returns the " +
      "top matching chunks (sections) grouped by article (page), the way " +
      "narrative_search returns messages that belong to a narrative: each " +
      "article carries its source, slug, and best-hit score, with a `hits` " +
      "array of the matching sections — each a chunk with its anchor and a " +
      "`slug#anchor` citation (the wiki analogue of an `nid:seq` reference). " +
      "`limit` bounds the number of chunk hits, not the number of articles. " +
      "The index self-syncs on call (re-embedding only changed sections). " +
      "Defaults to the caller's fold (local and shared pages) plus the install " +
      "fold's shared pages; pass `all: true` to search every registered fold's " +
      "shared pages. Another fold's local pages are never searchable from here.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (short phrases work best).",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of chunk hits (sections) to return, grouped by " +
            "article (default: 10).",
        },
        all: {
          type: "boolean",
          description: "Search every registered fold's shared pages, not just the caller's fold.",
        },
      },
      required: ["query"],
    },
  },
];

/**
 * Resolve a daemon WebSocket URL. Returns null if daemon is unavailable.
 * Passed to startMcpBridge so it can re-resolve on reconnection.
 */
/** Where the bridge dials: a URL, plus the daemon's Unix socket when the
 *  connection should go there instead of to the URL's host. The socket path
 *  never enters the URL, so a home directory with a space, a colon or
 *  non-ASCII in it dials as well as any other. */
export interface DaemonDial {
  url: string;
  socketPath?: string;
}
export type DaemonUrlResolver = () => Promise<string | DaemonDial | null>;

const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_RECONNECT_TIME_MS = 5 * 60_000; // Give up after 5 minutes

/**
 * Thin MCP stdio bridge. Handles MCP JSON-RPC protocol locally
 * and forwards tool calls to the daemon via WebSocket.
 *
 * Automatically reconnects to the daemon on disconnect with
 * exponential backoff, re-resolving the URL each attempt.
 */
/** Look up a pid's parent pid via `ps`. Returns 0 if unavailable. */
function parentPid(pid: number): number {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Pure parent-chain walk: starting at `startPid`, ask `lookupSession` for a
 * session id at each pid, climbing via `getParent` (up to `maxHops`) until one
 * is found or the chain ends. Extracted from IO so it can be unit-tested with
 * injected fakes.
 */
export function walkProcessTreeForSession(
  startPid: number,
  lookupSession: (pid: number) => string | undefined,
  getParent: (pid: number) => number,
  maxHops = 6,
): string | undefined {
  let pid = startPid;
  for (let hop = 0; hop < maxHops && pid > 1; hop++) {
    const sessionId = lookupSession(pid);
    if (sessionId) return sessionId;
    pid = getParent(pid);
  }
  return undefined;
}

/**
 * Parse a `~/.claude/sessions/<pid>.json` registry entry and return its
 * `sessionId` only if the entry's `cwd` matches `expectedCwd`. The cwd guard
 * defends against pid reuse: that registry holds stale files for since-exited
 * processes, so a recycled pid could otherwise point a bridge at an unrelated
 * session in a different directory — the exact wrong-tag the design avoids.
 * The bridge runs in the fold (the same cwd the Claude process recorded), so a
 * genuine ancestor always matches.
 */
export function sessionIdFromRegistryEntry(
  rawJson: string,
  expectedCwd: string,
): string | undefined {
  let entry: { sessionId?: string; cwd?: string };
  try {
    entry = JSON.parse(rawJson) as { sessionId?: string; cwd?: string };
  } catch {
    return undefined;
  }
  if (!entry.sessionId || !entry.cwd) return undefined;
  if (resolve(entry.cwd) !== resolve(expectedCwd)) return undefined;
  return entry.sessionId;
}

/** Read a Claude session id out of `~/.claude/sessions/<pid>.json`, if present. */
function lookupClaudeSession(pid: number): string | undefined {
  try {
    const path = join(homedir(), ".claude", "sessions", `${pid}.json`);
    return sessionIdFromRegistryEntry(readFileSync(path, "utf8"), process.cwd());
  } catch {
    return undefined;
  }
}

/**
 * Fallback for agent versions that don't export a session id into the
 * environment (e.g. Claude Code older than CLAUDE_CODE_SESSION_ID): recover the
 * session id by walking up the bridge's parent-process chain and looking each
 * ancestor pid up in Claude's live session registry
 * (`~/.claude/sessions/<pid>.json`). The bridge is spawned as a child of the
 * Claude Code process, so the owning pid is an ancestor — usually the immediate
 * parent, making this a zero-subprocess lookup in the common case.
 *
 * Best-effort and Claude-specific: for other agents the ancestor pids simply
 * aren't in this registry, so it returns undefined and the bridge degrades to
 * "no session id" exactly as before. Any error is swallowed.
 */
function resolveClaudeSessionFromProcessTree(maxHops = 6): string | undefined {
  return walkProcessTreeForSession(process.ppid, lookupClaudeSession, parentPid, maxHops);
}

export function startMcpBridge(resolveUrl: DaemonUrlResolver): void {
  // Best-effort initial guess. For spawned agents this is the real id (the
  // daemon set BRANE_NARRATIVE_ID in the tmux env). For unspawned clients it's
  // a placeholder the daemon will *replace* with a server-minted id, delivered
  // back via the `welcome` message — see the welcome handler below. We adopt
  // that authoritative id so reconnects reuse the same narrative.
  let narrativeId = process.env.BRANE_NARRATIVE_ID ?? `external-${Date.now().toString(36)}`;
  // The agent's own session ID, inherited from the parent agent process
  // (e.g. CLAUDE_CODE_SESSION_ID). Forwarded to the daemon so it can stamp
  // per-message provenance (meta.session) on every event this bridge writes.
  // When the env var is absent (older CLIs that predate it), fall back to the
  // process-tree + session-registry lookup so live capture still works.
  const agentSessionId =
    process.env.CLAUDE_CODE_SESSION_ID ?? resolveClaudeSessionFromProcessTree();
  // Per-narrative bind secret (set by the daemon in the tmux env at spawn/revive,
  // next to BRANE_NARRATIVE_ID). Forwarded as `&secret=` so the daemon can verify
  // this bridge genuinely owns `narrativeId` before binding to it.
  //
  // Absent on an unspawned client's *first* dial, which is the one connection
  // that has nothing to prove — the daemon mints it a narrative and returns
  // that narrative's secret in `welcome`, which we adopt below. Every
  // reconnect after that is authenticated like any other, which is what keeps
  // an external client on one narrative now that the unauthenticated grace
  // path is gone.
  let bindSecret = process.env.BRANE_NARRATIVE_SECRET;
  // Set once the daemon has *revoked* this session's token: a 4401 close,
  // which it sends only when a revoke or rotation retires the token. Nothing
  // this bridge holds can get it back in, so it stops dialing and says so on
  // every call. A bare 401 on the upgrade is not proof — a bridge that dialed
  // a daemon still running older code, or between a rebuild and a restart,
  // gets one too, and the next daemon may accept the same token — so that
  // only marks `refused`, and the bridge keeps retrying (claude-jrjh1e8w:13 #5).
  let revoked = false;
  let refused = false;
  const REFUSED_TEXT =
    "Error: the brane daemon is refusing this session's token (401); retrying. " +
    "If it was revoked, the operator can revive the session.";
  const REVOKED_TEXT =
    "Error: this session's brane token was revoked, so its tools no longer work. " +
    "Ask the operator to revive the session if it should continue.";

  // Pending tool calls: daemon callId → MCP request id
  const pendingCalls = new Map<string, number | string>();
  // …and which of them are narrates, whose failure needs different advice.
  const pendingNarrates = new Set<string>();
  let callCounter = 0;
  let ws: WebSocket | null = null;
  let wsReady = false;
  let stdinClosed = false;
  // Buffer messages until WS is open. A queued tool call carries its callId,
  // because a call that was never sent is not ambiguous the way a sent one is.
  const sendQueue: Array<{ msg: string; callId?: string }> = [];
  // Calls handed to a socket, whose fate a lost connection makes unknowable.
  const inFlight = new Set<string>();

  // Reconnection state
  let reconnectDelay = 1000;
  let reconnectStart = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function wsSend(msg: string, callId?: string): void {
    if (wsReady && ws) {
      ws.send(msg);
      if (callId !== undefined) inFlight.add(callId);
    } else {
      sendQueue.push({ msg, callId });
    }
  }

  /** Answers every call a lost connection has made ambiguous — those already
   *  handed to the socket — and nothing else. A call still in `sendQueue` was
   *  never sent: it stays queued and goes out on reconnect, exactly once.
   *  Failing it too, as this used to, answered the agent with an error *and*
   *  sent the call anyway on the next connect: a "please retry" that, taken
   *  up, ran it twice, and a waiting narrate parked on the daemon with nobody
   *  left to answer. */
  function failPendingCalls(): void {
    for (const [callId, mcpId] of pendingCalls) {
      if (!inFlight.has(callId)) continue;
      // A narrate may have been posted before the connection went — and one
      // with `wait: true` certainly was, since it can be parked for up to an
      // hour after writing. "Retry" would post it twice.
      const text = pendingNarrates.has(callId)
        ? "Error: daemon connection lost (reconnecting). Your narration may already have been posted — " +
          "check with listen({ wait: false }) before narrating it again."
        : "Error: daemon connection lost (reconnecting — please retry)";
      respond(mcpId, { content: [{ type: "text", text }], isError: true });
      pendingCalls.delete(callId);
      pendingNarrates.delete(callId);
    }
    inFlight.clear();
  }

  /** The client gave up on a call (MCP `notifications/cancelled`: Esc, or a
   *  killed background task). Forget it, so a late result is never sent to a
   *  client that has stopped expecting one, and tell the daemon — a parked
   *  listen otherwise stays parked, and its narrative keeps showing as waiting
   *  for direction, until the next event or the hour-long timeout. A call
   *  still queued was never sent, so it is simply dropped. */
  function cancelCall(mcpId: number | string | undefined): void {
    if (mcpId === undefined) return;
    let callId: string | undefined;
    for (const [c, m] of pendingCalls) {
      if (m === mcpId) { callId = c; break; }
    }
    if (callId === undefined) return;
    pendingCalls.delete(callId);
    pendingNarrates.delete(callId);
    const queued = sendQueue.findIndex((q) => q.callId === callId);
    if (queued >= 0) {
      sendQueue.splice(queued, 1);
      return;
    }
    if (inFlight.delete(callId)) {
      wsSend(JSON.stringify({ type: "tool_cancel", id: callId }));
    }
  }

  function connect(target: string | DaemonDial): void {
    const { url, socketPath } = typeof target === "string" ? { url: target, socketPath: undefined } : target;
    wsReady = false;
    const sessionParam = agentSessionId
      ? `&session=${encodeURIComponent(agentSessionId)}`
      : "";
    const secretParam = bindSecret
      ? `&secret=${encodeURIComponent(bindSecret)}`
      : "";
    let fullUrl = `${url}&nid=${encodeURIComponent(narrativeId)}${sessionParam}${secretParam}`;
    // The session's own token, when it has one, is what authenticates it —
    // whatever the resolver put in the URL. That is what
    // makes this agent its own revocable row. (An unspawned client's first
    // dial has none and presents nothing over the daemon's socket, as this
    // account; `welcome` then hands it one.)
    if (bindSecret) {
      const u = new URL(fullUrl);
      u.searchParams.set("token", bindSecret);
      fullUrl = u.toString();
    }
    // When connecting to wss://localhost with a Tailscale cert, the hostname
    // won't match — skip TLS verification for local daemon connections
    const wsOptions = socketPath
      ? { createConnection: () => netConnect(socketPath) }
      : fullUrl.startsWith("wss://localhost") ? { rejectUnauthorized: false } : {};
    ws = new WebSocket(fullUrl, wsOptions);

    ws.on("open", () => {
      wsReady = true;
      refused = false;
      reconnectDelay = 1000; // Reset backoff on success
      reconnectStart = 0;
      process.stderr.write("MCP bridge: connected to daemon\n");
      for (const { msg, callId } of sendQueue) {
        ws!.send(msg);
        if (callId !== undefined) inFlight.add(callId);
      }
      sendQueue.length = 0;
    });

    ws.on("unexpected-response", (_req, res) => {
      // A 401 on the upgrade: the token is not live. Only an agent token can
      // be revoked out from under a running bridge, so that is what it means.
      if (res.statusCode === 401) refused = true;
      ws?.terminate();
    });

    ws.on("error", (err) => {
      process.stderr.write(`MCP bridge: WebSocket error: ${err.message}\n`);
      // close event will fire next, triggering reconnection
    });

    ws.on("close", (code) => {
      wsReady = false;
      ws = null;
      // 4401: the daemon closed this socket because its token was revoked.
      if (code === 4401) revoked = true;
      if (stdinClosed && pendingCalls.size === 0) {
        process.exit(0);
      }
      failPendingCalls();
      if (revoked) {
        process.stderr.write("MCP bridge: this session's token was revoked; not reconnecting\n");
        for (const [callId, mcpId] of pendingCalls) {
          respond(mcpId, { content: [{ type: "text", text: REVOKED_TEXT }], isError: true });
          pendingCalls.delete(callId);
          pendingNarrates.delete(callId);
        }
        sendQueue.length = 0;
        return;
      }
      scheduleReconnect();
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "welcome" && typeof msg.narrative_id === "string") {
          // The daemon's id is authoritative — it may have minted a fresh
          // server-side id for an unspawned client. Adopt it so subsequent
          // reconnects (which carry narrativeId in the URL) reuse this narrative
          // instead of fragmenting into a new one each time.
          narrativeId = msg.narrative_id;
          // And its secret, for the same reason: without it the reconnect
          // carrying that id would be refused and minted a *different*
          // narrative, one per reconnect. Only overwrite from a string, so a
          // daemon too old to send the field leaves the env-supplied secret
          // (a spawned agent's) alone rather than clearing it.
          if (typeof msg.bind_secret === "string") bindSecret = msg.bind_secret;
        }

        if (msg.type === "tool_result") {
          const mcpId = pendingCalls.get(msg.id);
          if (mcpId !== undefined) {
            pendingCalls.delete(msg.id);
            pendingNarrates.delete(msg.id);
            inFlight.delete(msg.id);
            respond(mcpId, {
              content: [{ type: "text", text: JSON.stringify(msg.result, null, 2) }],
            });
          }
        }

        if (msg.type === "tool_error") {
          const mcpId = pendingCalls.get(msg.id);
          if (mcpId !== undefined) {
            pendingCalls.delete(msg.id);
            pendingNarrates.delete(msg.id);
            inFlight.delete(msg.id);
            respond(mcpId, {
              content: [{ type: "text", text: `Error: ${msg.error}` }],
              isError: true,
            });
          }
        }
      } catch {
        // Ignore malformed daemon messages
      }
    });
  }

  function scheduleReconnect(): void {
    if (stdinClosed) return;

    if (reconnectStart === 0) {
      reconnectStart = Date.now();
    } else if (Date.now() - reconnectStart > MAX_RECONNECT_TIME_MS) {
      process.stderr.write("MCP bridge: reconnection timed out after 5 minutes, exiting\n");
      process.exit(1);
    }

    process.stderr.write(
      `MCP bridge: reconnecting in ${Math.round(reconnectDelay / 1000)}s...\n`,
    );
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        const url = await resolveUrl();
        if (url) {
          connect(url);
        } else {
          // Daemon not available yet, retry with more backoff
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
          scheduleReconnect();
        }
      } catch {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        scheduleReconnect();
      }
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  // Initial connection
  resolveUrl().then((url) => {
    if (!url) {
      process.stderr.write("MCP bridge: daemon not available\n");
      process.exit(1);
    }
    connect(url);
  });

  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    let request: McpRequest;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }

    if (request.method === "initialize") {
      respond(request.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "brane",
          version: "0.1.0",
        },
      });
      return;
    }

    if (request.method === "notifications/initialized") {
      return;
    }

    if (request.method === "tools/list") {
      respond(request.id, { tools: TOOLS });
      return;
    }

    if (request.method === "tools/call") {
      const params = request.params as { name: string; arguments?: Record<string, unknown> };
      const toolName = params.name;
      const args = params.arguments ?? {};

      if (revoked || refused) {
        respond(request.id, { content: [{ type: "text", text: revoked ? REVOKED_TEXT : REFUSED_TEXT }], isError: true });
        return;
      }
      // Forward to daemon via WebSocket (buffered until connected)
      const callId = String(++callCounter);
      pendingCalls.set(callId, request.id);
      if (toolName === "narrate") pendingNarrates.add(callId);
      wsSend(JSON.stringify({ type: "tool_call", id: callId, tool: toolName, args }), callId);
      return;
    }

    if (request.method === "notifications/cancelled") {
      cancelCall((request.params as { requestId?: number | string } | undefined)?.requestId);
      return;
    }

    // A notification is never answered, known or not. Answering this one used
    // to hand the client an error with no id, which Claude Code logs as a
    // connection error ("Received a response for an unknown message ID").
    if (request.id === undefined || request.id === null) return;

    // Unknown method
    respondError(request.id, -32601, `Method not found: ${request.method}`);
  });

  rl.on("close", () => {
    stdinClosed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    if (pendingCalls.size === 0) {
      if (ws) ws.close();
      process.exit(0);
    }
    const drainCheck = setInterval(() => {
      if (pendingCalls.size === 0) {
        clearInterval(drainCheck);
        if (ws) ws.close();
        process.exit(0);
      }
    }, 50);
  });
}

function respond(id: number | string, result: unknown): void {
  const response = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(response + "\n");
}

function respondError(id: number | string, code: number, message: string): void {
  const response = JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  process.stdout.write(response + "\n");
}
