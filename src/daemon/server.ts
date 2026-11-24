import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { join, dirname, extname, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync, openSync, realpathSync } from "node:fs";
import { hostname as osHostname, userInfo as osUserInfo, homedir } from "node:os";
import { gzip } from "node:zlib";
import { pipeline } from "node:stream";
import type Database from "better-sqlite3";
import { readEventsSince, readEventsBefore, readEvents, appendEvent, getMaxSeq, getMinSeq, type NarrativeEvent } from "../db/events.js";
import {
  recordMentions,
  pendingMentions,
  allMentions,
  hasUnsentMentions,
  markSent,
  ackMentionsByRead,
  dismissMentions,
  mentionsInEvents,
} from "../db/mentions.js";
import { extractMentions } from "../mentions-scan.js";
import {
  recordToolUse,
  readToolUse,
  readToolUseWindow,
  readToolUsesSince,
  settleDaemonCall,
  toolUseCursor,
  excerptForPush,
  shapeToolUsesForPush,
  toolUseFromClaudeHook,
  normalizeHookPayload,
  type ToolUseRow,
} from "../db/tool-uses.js";
import {
  pollCrushToolLog,
  newCrushLogCursor,
  type CrushLogCursor,
} from "../crush-tool-log.js";
import {
  pollCopilotToolLog,
  newCopilotLogCursor,
  type CopilotLogCursor,
} from "../copilot-tool-log.js";
import {
  pollCodexToolLog,
  newCodexLogCursor,
  type CodexLogCursor,
} from "../codex-tool-log.js";
import { randomBase36 } from "../ids.js";
import { getBraneDir, getBraneId, getPayloadsDir, getTokenFilePath, fromPortablePath, toPortablePath, claimDaemon } from "../db/schema.js";
import { HANDOFF_ENV, LAUNCH_ENV, SPAWNED_ENV, VIA_ENV, originFromEnv, recordOrigin, restartPort, restartRefusal, startupRefusal, successorArgs } from "./lifecycle.js";
import { listProtocols, loadProtocolLibrary, protocolNamespaces, readProtocol, type NamespaceDir, type ProtocolLibrary } from "../protocols.js";
import { protocolSourceLabel } from "../shared/protocol-names.js";
import { liveApprovals } from "../db/protocol-approvals.js";
import { approvalRequest, approvalScopeFrom, approveProtocolRoute, protocolApprovalsReport, revokeProtocolRoute, type ApprovalScope } from "./protocol-routes.js";
import { TokenRing, type AuthResult, type TokenRecord } from "./token-ring.js";
import { signalEventFields, signalStanding } from "./signal-source.js";
import { AGENT_LOOPBACK_REFUSAL, AGENT_REVIVE_REFUSAL, agentRefusal, agentReviveRefusal } from "./agent-scope.js";
import {
  FREE_CONTROL_MESSAGES,
  FREE_TERMINAL_MESSAGES,
  VerificationGate,
  verificationStatus,
  verifyFrame,
  classifyRoute,
  type VerificationRefusal,
} from "./verification-gate.js";
import { archiveRefusal } from "./archive-gate.js";
import { DbTokenStore, bootstrapTokens, legacyTokenWarning, parseTokenHashes, liveAgentTokenId, mintAgentToken, recordLauncher, settleAgentLaunch, verifyAgentToken } from "../db/tokens.js";
import { closeSocketsOf, forgetSelfRoute, listTokensRoute, socketOwners, retireTokens } from "./token-routes.js";
import { getConfig, resolveAppHost } from "../commands/config.js";
import { doSpawn, buildGooseExtensionArg, reestablishMcpConfigArgs, braneTmuxEnv, ensureHookConfig, resolveAgentCommand, LIVE_LOOP_PROMPT, codexReviveArgs, codexSupportsNoDaemon, kickoffPrompt } from "../commands/spawn.js";
import { ensureSessionAffinityConfig } from "../session-affinity.js";
import { revivedContent, restartedContent } from "../shared/narrative-format.js";
import { parseRecolorSalt } from "../shared/speaker-color.js";
import { parseSeqModeParam, parseSeqParam } from "../shared/export-selection.js";
import { payloadResponse } from "./payload-serve.js";
import { VIDEO_PAYLOAD_MIME } from "../shared/payload-inline.js";
import { doRun, runHistory } from "../commands/run.js";
import { runAbsorb, AbsorbInputError, type AbsorbEvent, type AbsorbRequest } from "../absorb/run.js";
import { surveyAbsorbSources } from "../absorb/sources.js";
import { registerFold, FoldRegistrationError } from "../folds.js";
import { getAgentAdapter, sumCostReadings, type CostReading, type UsageEntriesReading } from "../agents.js";
import { repriceLedger } from "../cost/reprice.js";
import { initMemorySchema, searchHybrid } from "../memory/storage.js";
import { narrativeMatchRanges } from "../memory/match-ranges.js";
import { listWiki, locatePage, readWiki, readWikiSection, searchWiki, type WikiSource } from "../memory/wiki.js";
import { disposeEmbeddingModel, embedText, preloadEmbeddingModel } from "../memory/embeddings.js";
import { runIndex, hasUnindexedEvents, type IndexStats } from "../memory/index.js";
import { parseDuration, timeSince } from "../commands/memory.js";
import { getTlsCertPath, getTlsKeyPath } from "../commands/certify.js";
import { getTailscaleIps, getTailscaleIpsAsync } from "../tailscale.js";
import { addressesToBind, nextProbeDelay, TAILSCALE_PROBE_MAX_MS } from "./tailscale-rebind.js";
import { archivedBraneIds, braneArchiveRefusal, setBraneArchived, visibleUnscopedClause } from "../db/branes.js";
import { CertManager, type CertStatus } from "./cert-manager.js";
import { KeepAwake } from "./keep-awake.js";
import { bridgeConnected, deliverRevivePrompt } from "./revive-prompt.js";
import { Sleeper, ManifestRestorer, readSleepManifest, sleepActAnswer, bootRevive, bootReviveEnabled, listTmuxSessions, parseIdleMinutes, tailscaleDownWanted, takeExitRecord, wakeRecipe, writeExitRecord, endsSessions, runEndSessions, type LiveNarrative } from "./sleep.js";
import { resolveTmux, ensureTmux, newTmuxSession, parseTerminalSize, sgrMouseSequences } from "../tmux.js";
import { INHERITED_AGENT_ENV, unsetAgentEnvPrefix } from "../agent-env.js";
import { highlight } from "../highlight.js";
import { browseFold, openFoldSource, parseOffsetParam } from "../files/browse.js";
import { FindSlots, parseFindQuery, scanSource, type FindEvent } from "../files/find.js";
import { renderDiagram, MAX_SOURCE_BYTES as MAX_DIAGRAM_BYTES } from "../diagram/index.js";
import { nidHrefFor } from "../diagram/links.js";
import { exportNarrativeHtml } from "../export.js";
import { diagnoseMarkdown, type MarkdownDiagnostic } from "../markdown-diagnostics.js";
import { AwaitingTracker } from "./awaiting.js";
import { confirmPresence } from "../presence.js";
import { PresenceGate, type PendingPresence } from "./presence-gate.js";
import { cancelPresenceRoute, gatedMintRoute, gatedRemoteMintRoute, gatedRevokeRoute, gatedRotateRoute, type Caller, type RouteAnswer } from "./gated-routes.js";
import { accountDirTrust, connectionLabel, getSocketPath, isUnixConnection, listenOnLocalSocket } from "./local-socket.js";
import { DbCredentialStore, webauthnUserHandle } from "../db/credentials.js";
import { Ceremonies, type RelyingParty } from "./verification-ceremony.js";
import { verifyPageHeaders, VERIFY_PAGE_HTML } from "./verify-page.js";
import { askEnrollPresence, revokeCredentialRoute } from "./credential-routes.js";
import { trustStore } from "../webauthn/verify.js";
import { YUBICO_FIDO_INTERMEDIATES, YUBICO_FIDO_ROOTS } from "../webauthn/yubico-roots.js";
import { describeUserAgent } from "../user-agent.js";
import { SWITCH_TICK_MS, settleSwitch } from "./verification-switch.js";
import { certificateHost } from "./verification-ceremony.js";
import { RenameWatch, orphanedCredentials, recordRpId, usableCredentials } from "./verification-rename.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "..", "..", "expo", "dist");
const PROTOCOLS_DIR = join(__dirname, "..", "..", "protocols");
/** The directory brane is installed in — a git checkout, a global npm
 *  install, a node_modules copy. It is registered as a fold at startup
 *  (`ensureInstallFold`) so the package's own `wiki/shared/` reaches every
 *  fold through the same rule as anyone else's: shared pages are visible to
 *  all, local pages only to the fold's own agents. */
const INSTALL_DIR = resolve(join(__dirname, "..", ".."));

// Import basename for per-fold wiki source labels.
const baseName = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

/**
 * Register the install directory as a fold if it isn't one already. Idempotent;
 * never modifies an existing row (an operator who archived it, or moved it to
 * another brane, keeps that). Brane resolution mirrors `brane fold`: config
 * `default.brane` → home brane. Returns the portable path either way.
 */
export function ensureInstallFold(
  db: Database.Database,
  installDir: string = INSTALL_DIR,
  braneId: () => string = () => getConfig("default.brane", db) ?? getBraneId(db),
): string {
  const portable = toPortablePath(resolve(installDir));
  const existing = db.prepare("SELECT path FROM folds WHERE path = ?").get(portable);
  if (!existing) {
    db.prepare(
      "INSERT INTO folds (path, created_at, brane_id, archived) VALUES (?, ?, ?, 0)",
    ).run(portable, Date.now(), braneId());
  }
  return portable;
}

interface ReviveResult {
  status: "revived" | "already_running" | "continued";
  /** Not necessarily the nid that was asked for: `continued` reports the twin
   *  that now carries the work, not the narrative it continues from. */
  nid: string;
  /** The agent now running in `nid` — for utility narratives, the command's
   *  basename. Reported so clients can name it without a second query. */
  agent: string;
}

// Ask Claude Code whether a session is still live (running interactively or as
// a background agent). A plain `claude --resume` refuses such a session — it
// wants `--fork-session` to branch a copy instead. `claude agents --json`
// lists every live session with its `sessionId`; if ours is in there, we must
// fork. Best-effort: any failure (old CC without the subcommand, timeout, parse
// error) degrades to `false` so revive falls back to today's plain resume.
function isClaudeSessionLive(agentCommand: string, sessionId: string): boolean {
  try {
    const out = execFileSync(agentCommand, ["agents", "--json"], {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const sessions = JSON.parse(out) as Array<{ sessionId?: string }>;
    return Array.isArray(sessions) && sessions.some((s) => s?.sessionId === sessionId);
  } catch {
    return false;
  }
}

/** Boot revive's revive (src/daemon/sleep.ts): no request launched it, so
 *  the launch keeps the launcher the narrative had, on whatever the revive
 *  started (the narrative itself, or a twin continuing it), and revoking the
 *  device that first started it still cascades to the new agent token.
 *  `revive` is injectable for the suite. */
export function reviveKeepingLauncher(
  db: Database.Database,
  nid: string,
  prompt: string,
  revive: (db: Database.Database, nid: string, opts: { prompt: string }) => ReviveResult = reviveNarrative,
): ReviveResult {
  const row = db.prepare("SELECT launched_by FROM narratives WHERE id = ?").get(nid) as { launched_by: string | null } | undefined;
  const result = revive(db, nid, { prompt });
  if (row?.launched_by) recordLauncher(db, result.nid, row.launched_by);
  return result;
}

export function reviveNarrative(
  db: Database.Database,
  nid: string,
  opts: { prompt?: string; no_prompt?: boolean; agent?: string; byAgent?: boolean } = {},
): ReviveResult {
  const narrative = db.prepare("SELECT * FROM narratives WHERE id = ?").get(nid) as
    | { id: string; agent_type: string; role: string; fold_path: string; status: string; agent_session_id: string | null; brane_id: string; launch_args: string | null }
    | undefined;

  if (!narrative) {
    throw new Error(`Unknown narrative: ${nid}`);
  }
  // Before anything reaches tmux, alive or dead (src/daemon/agent-scope.ts).
  const agentRefused = opts.byAgent ? agentReviveRefusal(narrative.role) : null;
  if (agentRefused) throw new Error(agentRefused);

  // Check if already running
  let alive = false;
  try {
    execFileSync(resolveTmux(), ["has-session", "-t", nid], { stdio: "ignore" });
    alive = true;
  } catch {}

  if (alive) {
    if (opts.prompt && !opts.no_prompt) {
      execFileSync(resolveTmux(), ["send-keys", "-t", nid, opts.prompt, "Enter"], { stdio: "ignore" });
    }
    // Self-heal: if the DB says `ended` but tmux is actually alive, a prior
    // status-transition path (MCP close, capture error, etc.) marked this
    // narrative dead prematurely. Correct the record so the UI can reconnect.
    if (narrative.status === "ended") {
      db.prepare("UPDATE narratives SET status = 'active' WHERE id = ?").run(nid);
      if (_serverControlClients) broadcastStatus(_serverControlClients, nid, "active");
    }
    return { status: "already_running", nid, agent: narrative.agent_type };
  }

  const switchingAgent = opts.agent && opts.agent !== narrative.agent_type;
  const effectiveAgent = opts.agent ?? narrative.agent_type;
  const absoluteFoldPath = fromPortablePath(narrative.fold_path);

  // Utility narratives (`POST /api/run`): replay the original command in-place
  if (narrative.role === "utility" && !switchingAgent) {
    // Read the original command from the "started" event's meta
    const startedEvent = db.prepare(
      "SELECT meta FROM events WHERE narrative_id = ? AND type = 'started' ORDER BY seq ASC LIMIT 1",
    ).get(nid) as { meta: string | null } | undefined;

    let command: string[] | undefined;
    if (startedEvent?.meta) {
      try {
        const meta = JSON.parse(startedEvent.meta);
        if (Array.isArray(meta.command)) command = meta.command;
      } catch {}
    }

    if (!command || command.length === 0) {
      // Fallback: just run the agent_type (command basename) with no args
      command = [narrative.agent_type];
    }

    // Shell-escape the command for tmux
    const tmuxCmd = command
      .map((a) => (a.includes(" ") || a.includes("'") ? `'${a.replace(/'/g, "'\\''")}'` : a))
      .join(" ");

    try {
      // As in doRun: a utility session is no agent, and must not inherit one's
      // identity from the tmux server's env.
      newTmuxSession({
        name: nid,
        cwd: absoluteFoldPath,
        size: lastTerminalSize,
        command: `${unsetAgentEnvPrefix()} ${tmuxCmd}`,
      });
    } catch (err) {
      throw new Error(`Failed to restart command: ${err}`);
    }

    db.prepare("UPDATE narratives SET status = 'active' WHERE id = ?").run(nid);
    appendEvent(db, nid, "restarted", { content: restartedContent(command) });

    return { status: "revived", nid, agent: narrative.agent_type };
  }

  if (switchingAgent || narrative.role === "absorbed") {
    // Agent switch or activation of absorbed narrative: spawn a NEW narrative
    // that twins the predecessor (reads its history via the pinned re). doSpawn
    // forces role "twin" whenever `re` is set, so we don't pass a role here.
    const result = doSpawn({
      db,
      agent: effectiveAgent,
      re: nid,
      foldPath: narrative.fold_path,
      terminalSize: lastTerminalSize ?? undefined,
    });
    return { status: "continued", nid: result.narrativeId, agent: effectiveAgent };
  }

  // Same agent — use resume args

  // Point the fold's tool-call hooks at this daemon before anything else can
  // fail. The config names a port, and a daemon that came back on another
  // one (its old port was taken, or a Fly boot cleared the hint) leaves it
  // naming a dead one: every tool call then fails its hook, and the chat
  // stops showing tool rows. doSpawn does this for fresh sessions; a revive
  // builds its launch here, so it has to as well (claude-nkrks0of:23).
  ensureHookConfig(db, effectiveAgent, absoluteFoldPath, nid);

  const agentCommand = resolveAgentCommand(effectiveAgent);

  // The revived session's agent token. Minted with the previous one left
  // live until the launch succeeds (settleAgentLaunch, below): a revive that
  // loses a race to another must not cut off the session that won.
  const bindToken = mintAgentToken(db, nid, Date.now(), undefined, false);
  // Everything from here to the launch can throw; however it ends, the
  // outcome settles the token (claude-jrjh1e8w:13 #7).
  let launched = false;
  let newSessionId: string | undefined;
  let forkSession = false;
  let launchArgs: string[] = [];
  try {

    const adapter = getAgentAdapter(effectiveAgent);
    // Claude rotates to a successor on every resume; Copilot resumes the exact
    // UUID already on the row. A legacy assigned narrative with no stored id
    // still needs one minted for its first revive.
    newSessionId =
      adapter.sessionIdOwnership === "assign" &&
      (!narrative.agent_session_id || adapter.resumeCreatesNewSession)
        ? randomUUID()
        : undefined;
    // Liveness no longer changes the launch shape (a pinned resume always
    // forks); it only flavors the restarted-event message below, so the
    // operator can tell a branched-off-live-copy from an ordinary revive.
    forkSession =
      effectiveAgent === "claude" &&
      !!narrative.agent_session_id &&
      isClaudeSessionLive(agentCommand, narrative.agent_session_id);
    const resumeArgs = adapter.resumeArgs({
      sessionId: narrative.agent_session_id ?? undefined,
      foldPath: absoluteFoldPath,
      forkSession,
      newSessionId,
    });

    // Reuse any passthrough args captured at original spawn. Agent-switch
    // paths have already returned above via doSpawn(re:), so by the time we
    // get here effectiveAgent === narrative.agent_type and the flags apply.
    if (narrative.launch_args) {
      try {
        const parsed = JSON.parse(narrative.launch_args);
        if (Array.isArray(parsed)) {
          launchArgs = parsed.filter((a): a is string => typeof a === "string");
        }
      } catch {}
    }

    let cmdArgs: string[];
    if (effectiveAgent === "goose") {
      cmdArgs = [
        "session",
        "--with-builtin", "developer",
        "--with-extension", buildGooseExtensionArg(nid, bindToken),
        "-n", nid,
        ...resumeArgs,
        ...launchArgs,
      ];
    } else if (effectiveAgent === "gemini") {
      cmdArgs = [...resumeArgs, ...launchArgs];
      if (!opts.no_prompt) {
        const geminiPrompt = opts.prompt ?? LIVE_LOOP_PROMPT;
        cmdArgs.push("-i", geminiPrompt);
      }
    } else if (effectiveAgent === "codex") {
      // A spawn's root flags, then the passthrough, then `resume <id>`.
      cmdArgs = codexReviveArgs({ noDaemon: codexSupportsNoDaemon(agentCommand), launchArgs, resumeArgs });
    } else {
      // Re-establish flag-based MCP config (copilot/cline) that resume args omit
      const mcpArgs = reestablishMcpConfigArgs(effectiveAgent, absoluteFoldPath, nid, bindToken);
      cmdArgs = [...mcpArgs, ...resumeArgs, ...launchArgs];
    }

    // The same-agent revive path builds its command inline, so it refreshes
    // session affinity itself: claude's `--settings` args and/or an env prefix.
    const affinity = ensureSessionAffinityConfig(effectiveAgent, absoluteFoldPath, nid, { db });

    const agentCmd = [agentCommand, ...affinity.args, ...cmdArgs]
      .map((a: string) => (a.includes(" ") || a.includes("'") ? `'${a.replace(/'/g, "'\\''")}'` : a))
      .join(" ");

    const tmuxCmd = [braneTmuxEnv(nid, bindToken), affinity.env, agentCmd].filter(Boolean).join(" ");

    try {
      newTmuxSession({ name: nid, cwd: absoluteFoldPath, size: lastTerminalSize, command: tmuxCmd });
    } catch (err) {
      throw new Error(`Failed to revive tmux session: ${err}`);
    }
    launched = true;
  } finally {
    settleAgentLaunch(db, nid, bindToken, launched);
  }

  db.prepare("UPDATE narratives SET status = 'active' WHERE id = ?").run(nid);
  // The launch runs under a daemon-minted id — record it so the row tracks the
  // session the pane is actually running (the old id names the dead
  // predecessor, or a still-live original in the fork case).
  if (newSessionId) {
    db.prepare("UPDATE narratives SET agent_session_id = ? WHERE id = ?").run(newSessionId, nid);
    // Add the new id to the cumulative cost set now, rather than leaning on
    // getSessionIds' agent_session_id union fallback until the revived agent's
    // first bind — otherwise a second revive before that bind would drop it
    // from cost. (The union still covers the gap; this just makes the set
    // authoritative.)
    recordSessionId(db, nid, newSessionId);
  }
  appendEvent(db, nid, "restarted", {
    content: revivedContent(effectiveAgent, narrative.role, launchArgs, forkSession),
  });

  // Type the prompt once the agent can take it (skip for gemini — prompt is
  // in command args via -i): src/daemon/revive-prompt.ts.
  if (!opts.no_prompt && effectiveAgent !== "gemini") {
    const revivePrompt = opts.prompt ?? kickoffPrompt(effectiveAgent, LIVE_LOOP_PROMPT);
    void deliverRevivePrompt(nid, revivePrompt, (args) => {
      execFileSync(resolveTmux(), ["send-keys", ...args], { stdio: "ignore" });
    });
  }

  return { status: "revived", nid, agent: effectiveAgent };
}

export interface DaemonConfig {
  port: number;
  db: Database.Database;
  token?: string;
  bind?: string; // explicit bind address (overrides auto-detection)
}

interface NarrativeRow {
  id: string;
  brane_id: string;
  fold_path: string;
  agent_type: string;
  role: string;
  created_at: number;
  status: string;
  summary: string | null;
  archived: number | null;
  /** Time of the narrative's most recent event (ms). Present on list rows that
   *  join the events table; absent on plain `SELECT * FROM narratives`. */
  last_activity?: number | null;
}

/** What `GET /api/status` reports as `app_domain`: the config, reduced to a
 *  host exactly as `brane meld` reduces it (`resolveAppHost`), so an operator
 *  who stored it as a URL (`brane config app_domain https://staging.example/`)
 *  gets a working Isolate link from a daemon's bundle rather than
 *  `https://https://…`, and a blank value means the default on both sides.
 *  The app reads a missing field, from a daemon older than this, as "no way
 *  out". */
export function statusAppDomain(db: Database.Database): string {
  return resolveAppHost(getConfig("app_domain", db));
}

/** CORS for a browser on any origin. The token is the only credential, so
 *  the origin is not a trust decision: a page holding no token gets a 401
 *  whatever its origin, and a page holding one can act with it from any
 *  origin regardless of what is answered here — `?token=` is taken on any
 *  method and bodies are parsed as JSON whatever their `Content-Type`, so a
 *  `text/plain` POST needs no preflight. An origin allowlist would only
 *  hide responses and refuse WebSockets. So the answer is `*`, never a
 *  reflected origin, and never `Allow-Credentials`: brane sets no cookies,
 *  and credentials with a reflected origin is the one CORS combination that
 *  could ever be dangerous. This is what lets one daemon be fronted
 *  by `brane.organelle.dev`, a staging hostname, a fork's own deployment, or
 *  its own bundle, with nothing to configure. Which origin a device actually
 *  runs is recorded on its token and shown in the Devices list, not gated
 *  here (SECURITY.md, "Authentication"). */
export function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  if (req.headers.origin === undefined) return;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  // How long the browser may reuse this preflight's answer. Without it
  // Chrome caches for 5 seconds, which on a fast link is indistinguishable
  // from caching forever and on a slow one is indistinguishable from not
  // caching at all: nearly every request pays its own extra round trip.
  // Measured at 741ms RTT that was fatal rather than merely slow — see the
  // note on `apiUrl` in expo/lib/api.ts. The bodiless requests avoid the
  // preflight entirely now; this is for the ones that carry JSON and can't.
  // A day is the practical ceiling (Chrome caps at 2h, Firefox 24h), and
  // the answer being cached is safe: it does not authenticate anything,
  // it only says which methods and headers a page may use.
  res.setHeader("Access-Control-Max-Age", "86400");
}

/** Below this, compressing costs more than it saves — a gzip header is 20-odd
 *  bytes and the CPU is not free. Above it, JSON of brane's shape compresses
 *  roughly 8-12x. */
const GZIP_MIN_BYTES = 1_024;

/** The request this response answers, so `sendJson` can see `accept-encoding`.
 *  Threaded through a WeakMap rather than a parameter: `sendJson` has ~60 call
 *  sites, and an optional argument that must be remembered at each of them is a
 *  compression bug waiting to be introduced by the next handler. */
const requestFor = new WeakMap<ServerResponse, IncomingMessage>();

/** Tie a response to the request it answers. Called once at the top of the
 *  request handler; exported so a test can stand up a server that exercises
 *  the real `sendJson`, negotiation included. */
export function trackRequest(res: ServerResponse, req: IncomingMessage): void {
  requestFor.set(res, req);
}

function acceptsGzip(res: ServerResponse): boolean {
  const header = requestFor.get(res)?.headers["accept-encoding"];
  // Content-coding tokens are case-insensitive (RFC 7231 §3.1.2.1), and a
  // client that shouts GZIP means the same thing as one that whispers it.
  return typeof header === "string" && /\bgzip\b/i.test(header);
}

/** JSON out, gzipped when it's worth it and the client said it could.
 *
 *  Measured cause of a 15-second header on a phone: `/api/narratives` answered
 *  in 187ms and then spent 15,010ms in transfer, 934KB uncompressed over a
 *  ~60KB/s Tailscale path (claude-n1izig04:74). Nothing in the daemon was slow;
 *  the bytes were.
 *
 *  Async gzip, not `gzipSync`: this is a single-threaded server and a
 *  multi-megabyte synchronous compress would block every other request behind
 *  it — trading a transfer stall for a serving stall. A compression failure
 *  falls back to sending it plain, since a slow answer beats no answer. */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = Buffer.from(JSON.stringify(data), "utf-8");
  // Content-Length rather than chunked: a client can show progress against a
  // known total, and on a slow link that is the difference between "loading"
  // and "hung".
  const plain = () => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
    });
    res.end(body);
  };
  if (body.length < GZIP_MIN_BYTES || !acceptsGzip(res)) {
    plain();
    return;
  }
  gzip(body, (err, zipped) => {
    if (err) {
      plain();
      return;
    }
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Content-Length": String(zipped.length),
      // Caches and proxies must not hand a gzipped body to a client that
      // didn't ask for one.
      Vary: "Accept-Encoding",
    });
    res.end(zipped);
  });
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "text/javascript", // ES module: browsers enforce a JS MIME for import()
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  // Video the chat plays in place, from the table the app reads too.
  ...VIDEO_PAYLOAD_MIME,
  // Audio the Files view plays in place. Keep in step with `isAudioPath` in
  // expo/components/FilesView.tsx.
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
};

const MAX_PAYLOAD_BASE64 = 50 * 1024 * 1024; // ~50MB base64 ≈ 37.5MB decoded

interface PayloadInput {
  filename: string;
  data: string; // base64-encoded
}

/** Decode base64 payloads, write to disk, return relative paths for DB storage */
async function storePayloads(
  narrativeId: string,
  payloads: PayloadInput[],
): Promise<string[]> {
  const dir = getPayloadsDir(narrativeId);
  const now = Date.now();
  const paths: string[] = [];

  for (let i = 0; i < payloads.length; i++) {
    const { filename, data } = payloads[i];
    if (data.length > MAX_PAYLOAD_BASE64) {
      throw new Error(`Payload ${filename} exceeds 50MB limit`);
    }
    const ext = extname(filename) || ".bin";
    const storedName = `${now}_${i}${ext}`;
    const buf = Buffer.from(data, "base64");
    await writeFile(join(dir, storedName), buf);
    paths.push(`${narrativeId}/${storedName}`);
  }

  return paths;
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  // Map URL path to file — fall back to index.html for SPA routing
  let filePath = resolve(STATIC_DIR, urlPath === "/" ? "index.html" : urlPath.replace(/^\//, ""));

  // Prevent path traversal — resolved path must be exactly STATIC_DIR or under it
  if (filePath !== STATIC_DIR && !filePath.startsWith(STATIC_DIR + "/")) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const raw = await readFile(filePath);
    const ext = extname(filePath);
    const headers: Record<string, string> = {
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
    };
    if (ext === ".html" || urlPath === "/sw.js" || urlPath === "/manifest.json") {
      // HTML, service worker, and manifest must always revalidate
      headers["Cache-Control"] = "no-cache";
    } else if (urlPath.startsWith("/_expo/static/")) {
      // Hashed bundles are immutable — cache forever
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }
    res.writeHead(200, headers);
    res.end(raw);
  } catch {
    // SPA fallback: serve index.html for any unmatched route
    try {
      const index = await readFile(join(STATIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
      res.end(index);
    } catch {
      sendJson(res, 404, { error: "Not found" });
    }
  }
}


const FILE_LIST_CAP = 50_000;
/** Byte searches running at once, for the hex view's 🔎 (src/files/find.ts). */
const findSlots = new FindSlots();

const FILE_LIST_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
]);

// Recursively walk a fold, returning relative file paths. Skips dotfiles/dotdirs
// (consistent with /api/files directory listings) plus FILE_LIST_SKIP_DIRS.
// Caps at FILE_LIST_CAP entries and reports truncation.
async function walkFold(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const stack: string[] = [""]; // relative paths from root; "" = root itself
  while (stack.length > 0 && !truncated) {
    const rel = stack.pop() as string;
    const abs = rel ? resolve(root, rel) : root;
    let names: string[];
    try {
      names = await readdir(abs);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      if (FILE_LIST_SKIP_DIRS.has(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = resolve(abs, name);
      let st;
      try {
        st = await stat(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(childRel);
      } else if (st.isFile()) {
        files.push(childRel);
        if (files.length >= FILE_LIST_CAP) {
          truncated = true;
          break;
        }
      }
    }
  }
  files.sort();
  return { files, truncated };
}

const MAX_BODY_BYTES = 100 * 1024 * 1024; // 100 MB (must accommodate base64 payloads)

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/** Whether the request arrived over loopback — from a process on this
 *  machine, which is what the CLI is (`buildDaemonBaseUrl` always dials
 *  `127.0.0.1`). Routes that register folds give such a caller the reach the
 *  operator's shell has always had, and confine everyone else to `$HOME`;
 *  see `src/folds.ts`. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  // `daemon.sock` has no remote address; reaching it at all means this
  // machine, and this Unix account (src/daemon/local-socket.ts).
  if (isUnixConnection(req.socket)) return true;
  return isLoopbackAddress(req.socket.remoteAddress ?? "");
}

/** Who a request is. A presented token is checked as always. No token, over
 *  the daemon's socket: only this Unix account can have reached it, so the
 *  request acts as the account's `local` row — while `braneDir` still
 *  guarantees that (SECURITY.md, "Who the operator is"), and only for a
 *  request that is not a browser's: one with an `Origin`, or a `Host` other
 *  than `localhost`, came through something relaying to the socket (a port
 *  forward, socat) and is refused, so a relay does not hand a web page this
 *  account's standing. `onTrust` hears the reason a tokenless request was
 *  refused, or null when one was let in. An empty token is no token. No
 *  token anywhere else is refused. Records where the request came from,
 *  which the store keeps the first time a row is presented, so the Devices
 *  list can tell rows apart. */
export function authenticateRequest(
  ring: TokenRing,
  presented: string | null,
  req: IncomingMessage,
  braneDir: string,
  onTrust: (refusedBecause: string | null) => void,
  now: number = Date.now(),
): AuthResult {
  const userAgent = req.headers["user-agent"];
  const origin = req.headers.origin;
  const seen = {
    userAgent: typeof userAgent === "string" ? userAgent : null,
    remoteAddr: connectionLabel(req.socket),
    origin: typeof origin === "string" ? origin : null,
  };
  if (!presented && isUnixConnection(req.socket)) {
    const refusal = tokenlessRefusal(req, braneDir);
    onTrust(refusal);
    if (refusal) return { ok: false };
    return ring.authenticateAccount(now, seen);
  }
  return ring.authenticate(presented, now, seen);
}

/** Why a tokenless request on the socket may not act as this account, or
 *  null if it may. */
function tokenlessRefusal(req: IncomingMessage, braneDir: string): string | null {
  if (req.headers.origin !== undefined) return "a request with an Origin header (a browser's, through a relay)";
  const host = (req.headers.host ?? "").toLowerCase();
  // The value is not quoted: anything could be sent, and each distinct
  // reason gets its own log line.
  if (host !== "localhost") return "a request for a Host other than localhost (through a relay)";
  const trust = accountDirTrust(braneDir);
  return trust.ok ? null : trust.reason;
}

/** Why this request may not go on because it was made with an agent's token
 *  (src/daemon/agent-scope.ts), or null — always null for any other kind of
 *  token. Both the HTTP handler and the WebSocket upgrade ask it, right after
 *  authenticating. */
export function agentRequestRefusal(
  record: Pick<TokenRecord, "kind">,
  req: IncomingMessage,
  path: string,
): string | null {
  if (record.kind !== "agent") return null;
  return agentRefusal({ method: req.method ?? "GET", path, loopback: isLoopbackRequest(req) });
}

export function isLoopbackAddress(addr: string): boolean {
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return v4 === "::1" || /^127\.\d+\.\d+\.\d+$/.test(v4);
}

/** The query string of `GET /api/narratives/recent`, as `handleNarrativeInfo`
 *  browse args. `limit` must be an integer (0 = unlimited); `archived=1`
 *  includes archived rows; `brane_ids` is comma-separated and empty means
 *  every brane. Pure, so `src/test/thin-cli.test.ts` can pin it. */
export function parseRecentQuery(
  q: URLSearchParams,
): { args: Record<string, unknown>; braneIds: string[] } | { error: string } {
  const braneIds = (q.get("brane_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const limitRaw = q.get("limit");
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    return { error: "limit must be a non-negative integer" };
  }
  const args: Record<string, unknown> = {
    since: q.get("since") ?? undefined,
    search: q.get("search") ?? undefined,
    status: q.get("status") ?? undefined,
    fold: q.get("fold") ?? undefined,
    archived: q.get("archived") === "1",
    ...(limit !== undefined ? { limit } : {}),
  };
  return { args, braneIds };
}

/** Progress lines on the absorb stream are throttled to this interval; the
 *  final `summary` line carries the totals regardless. */
const ABSORB_PROGRESS_INTERVAL_MS = 50;

function extractToken(req: IncomingMessage, url: URL): string | null {
  // Check Authorization: Bearer header first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // Fall back to query parameter
  return url.searchParams.get("token");
}

/** Names of the tmux sessions running now — brane names each after its
 *  narrative. Empty when there is no tmux server (nothing is running). */
function liveTmuxSessions(): Set<string> {
  try {
    const out = execFileSync(resolveTmux(), ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function startServer(config: DaemonConfig): Promise<void> {
  const { port, db } = config;
  // Stopped by the operator, and not started by them since: whatever spawned
  // this daemon did so implicitly. Leave before doing anything (certificates,
  // tmux, the wiki); `claimDaemon` checks again, atomically.
  const stopped = startupRefusal(db);
  if (stopped) {
    console.error(`Not starting: ${stopped}.`);
    db.close();
    process.exit(1);
  }
  // Whatever started this daemon, it is no agent: drop an inherited agent
  // session, here and in a tmux server that already holds one in its global
  // env (one started from an agent's shell), so no session inherits it.
  for (const name of INHERITED_AGENT_ENV) delete process.env[name];
  // Hashes of device tokens minted on the operator's machine (`brane meld
  // --remote`), adopted below. Read once and dropped, so no session inherits it.
  const remoteTokenHashes = parseTokenHashes(process.env.BRANE_DEVICE_TOKEN_SHA256);
  if (process.env.BRANE_DEVICE_TOKEN_SHA256 && remoteTokenHashes.length === 0) {
    console.warn("[token] BRANE_DEVICE_TOKEN_SHA256 is set but holds no SHA-256 hex hash; nothing adopted");
  }
  delete process.env.BRANE_DEVICE_TOKEN_SHA256;
  // The same for how this daemon was launched (`LAUNCH_ENV`), which a tmux
  // server started by an older daemon holds; this process drops its own once
  // it has read them, below.
  for (const name of [...INHERITED_AGENT_ENV, ...LAUNCH_ENV]) {
    try {
      execFileSync(resolveTmux(), ["set-environment", "-g", "-u", name], { stdio: "ignore", timeout: 5_000 });
    } catch {}
  }
  // The install directory participates in the wiki as a fold like any other.
  // Done before anything reads wiki sources so the package wiki has a label.
  console.log(`[wiki] install fold: ${ensureInstallFold(db)}`);
  // Tokens are stored as hashes only (see token-ring.ts), and this machine
  // holds none: its CLI and MCP bridges present nothing over `daemon.sock`.
  // `.daemon_token` is where older branes kept a local token; it is read once
  // below, to retire that token, and then emptied. A pre-hashing install's
  // shared token is adopted as a device row on the first start, so nothing
  // that holds it is signed out.
  const tokenFile = getTokenFilePath(db);
  // `tokenRing` is the one authority: both auth checks consult it, and the
  // rotation swaps on first use of the new token — see token-ring.ts for why.
  const tokenStore = new DbTokenStore(db);
  const tokenRing = new TokenRing(tokenStore, () => randomUUID());
  // Operator verification (docs/passkeys.md): a device token must hold a
  // fresh proof before it acts. Dormant while `verification` is `off`.
  const verificationGate = new VerificationGate(db, tokenStore);
  // Every socket a revocation must close, tagged with the token row it
  // authenticated under, so a retirement or a per-device revoke closes exactly
  // the sockets the revoked tokens opened: every control/terminal socket, and
  // every MCP socket opened under a *device* token. That last one matters: a
  // device token can open `/ws/mcp` too, and that socket reaches every MCP
  // tool (narrate into any narrative, revive with a prompt), so leaving it out
  // would let a revoked token keep working for as long as it stayed connected.
  // Local MCP bridges are deliberately not here: closing them would fail
  // every parked `listen` for no gain — this account is not what a device
  // revoke or rotation retires.
  const viewerSockets = new Map<WebSocket, string[]>();
  const trackViewerSocket = (ws: WebSocket, owners: string[]) => {
    if (owners.length === 0) return;
    viewerSockets.set(ws, owners);
    ws.once("close", () => viewerSockets.delete(ws));
  };
  const finishRotation = (auth: { retired: { ids: string[] } }) => {
    const { closed } = retireTokens({ ...auth, viewerSockets });
    console.log(`[token] rotation complete; revoked ${auth.retired.ids.length} token(s), signed out ${closed} viewer socket(s)`);
  };
  // Each reason is logged once until a tokenless request is let in again,
  // so a directory that is fixed and later loosened is reported again.
  let untrustedWarned: string | null = null;
  const warnUntrustedSocket = (reason: string | null) => {
    if (untrustedWarned === reason) return;
    untrustedWarned = reason;
    if (reason === null) return;
    console.warn(`[socket] refusing requests without a token: ${reason}`);
  };
  /** `tokenRing.authenticate`, or null if the token store threw — reading
   *  it, or completing a rotation (whose pending token then survives, so the
   *  client's retry can finish it). Without this a throw here would be an
   *  uncaught exception in the request listener. */
  const authenticate = (presented: string | null, req: IncomingMessage) => {
    try {
      return authenticateRequest(tokenRing, presented, req, dirname(db.name), warnUntrustedSocket);
    } catch (err) {
      console.error("[token] could not check a token:", err);
      return null;
    }
  };
  /** Why an agent's token may not make this request (src/daemon/agent-scope.ts),
   *  or null — always null for any other kind of token. */
  const refuseAgent = (record: TokenRecord, req: IncomingMessage, path: string): string | null => {
    const refusal = agentRequestRefusal(record, req, path);
    if (refusal) console.warn(`[agent-scope] ${record.ownerNid ?? "?"}: ${req.method} ${path} refused (${connectionLabel(req.socket)})`);
    return refusal;
  };
  const braneId = getBraneId(db);

  let actualPort = port; // updated after bind when port is 0
  let actualHttpPort = 0; // HTTP fallback port (set when httpServer binds)

  // TLS cert lifecycle. CertManager owns provisioning, renewal, fs.watch,
  // and hot-reload via setSecureContext on whatever HTTPS servers we
  // eventually bind. We register an onReload closure now and populate the
  // server list once we've bound. ensureCert() may shell out to
  // `tailscale cert` on first run; we await it before deciding whether to
  // bind HTTPS at all so the daemon comes up correctly on a fresh install.
  const tlsServersForReload: Array<ReturnType<typeof createHttpsServer>> = [];
  // The cert/key a *new* HTTPS listener is built with. Startup fills it from
  // disk; every hot-reload replaces it, so a listener the Tailscale re-probe
  // loop creates months later starts on the current cert rather than the
  // one the daemon booted with (claude-9o0vgfvb:5, finding 5).
  let currentTlsOpts: { cert: Buffer; key: Buffer } | undefined;
  let lastCertStatus: CertStatus | null = null;
  // Set once the credential store exists: records the served hostname for
  // the CLI's switch and warns about credentials enrolled for another
  // (src/daemon/verification-rename.ts). Called where the cert is read.
  let noteRpId: (() => void) | null = null;
  const certMgr = new CertManager({
    certPath: getTlsCertPath(),
    keyPath: getTlsKeyPath(),
    onReload: (cert, key) => {
      currentTlsOpts = { cert, key };
      noteRpId?.();
      for (const s of tlsServersForReload) {
        try { s.setSecureContext({ cert, key }); } catch (err) {
          console.error(`Failed to hot-reload TLS cert on bound server: ${(err as Error).message}`);
        }
      }
    },
    onStateChange: (status) => {
      lastCertStatus = status;
      // Broadcast to control clients so the UI can banner.
      if (_serverControlClients) broadcastCertStatus(_serverControlClients, status);
    },
    log: (level, msg) => {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(`[tls] ${msg}`);
    },
  });
  const tls = await certMgr.ensureCert();
  lastCertStatus = certMgr.getStatus();
  if (tls) {
    console.log(
      `TLS active — serving over HTTPS (cert expires ${lastCertStatus.expiresAt?.toISOString() ?? "?"})`,
    );
  } else if (lastCertStatus.state === "failed") {
    console.warn(
      `TLS unavailable — ${lastCertStatus.lastErrorMessage}. Daemon will serve HTTP only.`,
    );
  } else {
    console.log("TLS not active (no Tailscale detected) — serving HTTP only.");
  }

  // Atomically claim daemon role (exclusive SQLite transaction)
  const claim = claimDaemon(db);
  if (!claim.claimed) {
    console.error("stopped" in claim ? `Not starting: ${claim.stopped}.` : `Another daemon is already running (pid ${claim.pid}). Exiting.`);
    db.close();
    process.exit(1);
  }
  // Where this daemon came from, read off the environment it inherited, so
  // `brane daemon status` can say (src/daemon/lifecycle.ts). A successor
  // started in place inherits its predecessor's environment, and so its
  // provenance; the variables naming how are dropped so no session sees them.
  const handoffFrom = parseInt(process.env[HANDOFF_ENV] ?? "", 10);
  const startedVia = process.env[VIA_ENV];
  recordOrigin(db, {
    ...originFromEnv(process.env),
    pid: process.pid,
    at: new Date().toISOString(),
    ...(Number.isFinite(handoffFrom) ? { handoff_from: handoffFrom } : {}),
    ...(process.argv[1] ? { script: realpathOr(process.argv[1]) } : {}),
  });
  for (const name of LAUNCH_ENV) delete process.env[name];

  // Migrate the token table only once this process *is* the daemon. During a
  // restart every disconnected MCP bridge may run `daemon start`, and the
  // losers must not each write an account row of their own.
  // Nothing authenticates before this point — the servers are not bound yet.
  let boot: ReturnType<typeof bootstrapTokens>;
  try {
    boot = bootstrapTokens(db, {
      tokenFile,
      configured: config.token,
      configuredHashes: remoteTokenHashes,
      liveSessions: liveTmuxSessions(),
    });
  } catch (err) {
    console.error(`[token] ${(err as Error).message}. Exiting.`);
    db.close();
    process.exit(1);
  }
  for (const label of boot.adopted) console.log(`[token] adopted a device token ("${label}")`);
  if (boot.retiredLocal) {
    console.log("[token] retired this machine's local token; its CLI now presents nothing, over daemon.sock");
  }
  if (boot.tokenFile === "emptied") {
    console.log(`[token] emptied ${tokenFile}, which is no longer used and can be removed`);
  } else if (boot.tokenFile !== "absent") {
    console.warn(`[token] could not empty ${tokenFile} (${boot.tokenFile.error}); it still holds a token, so remove it`);
  }
  const legacyWarning = legacyTokenWarning(db);
  if (legacyWarning) console.warn(`[token] ${legacyWarning}`);
  // Device tokens minted but never used lapse (UNUSED_TOKEN_LAPSE_MS).
  // Authentication already refuses them; this sweep marks their rows revoked
  // so a QR nobody scanned does not stay a live row.
  const sweepUnusedTokens = () => {
    try {
      const n = tokenStore.lapseUnused(Date.now());
      if (n) console.log(`[token] ${n} device token${n === 1 ? "" : "s"} lapsed unused`);
    } catch (err) {
      console.error("[token] sweeping unused tokens failed:", err);
    }
  };
  sweepUnusedTokens();
  setInterval(sweepUnusedTokens, 60_000).unref();

  // Lazily ensure tmux is available. No-op for the common case (system tmux
  // on PATH); only the tmux-less minority pays a one-time verified fetch,
  // kicked off here so it overlaps daemon startup. Fire-and-forget: it never
  // throws, and resolveTmux() surfaces an actionable error if a tmux op is
  // attempted before it completes.
  void ensureTmux();

  // Hold a system idle-sleep assertion for the daemon's lifetime so the
  // machine stays reachable for terminal mirroring, MCP, and mobile
  // control. macOS only; no-op elsewhere. Display sleep is unaffected.
  const keepAwake = new KeepAwake((msg) => console.log(`[keep-awake] ${msg}`));
  keepAwake.start();

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_tls', ?)").run(
    String(tls),
  );

  // Private IP checker: localhost + RFC 1918 + CGNAT + link-local
  function buildPrivateIpFilter(): (ip: string) => boolean {
    return (ip: string) => {
      const raw = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
      if (raw === "127.0.0.1" || ip === "::1") return true;
      const parts = raw.split(".").map(Number);
      if (parts.length === 4) {
        if (parts[0] === 10) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
        if (parts[0] === 169 && parts[1] === 254) return true;
      }
      return false;
    };
  }

  // Tailscale detection drives both the bind list and the IP filter.
  const tsIps = config.bind ? [] : getTailscaleIps();

  // Build connection filter: localhost + private IPs + Tailscale (unless --bind overrides)
  // Mutable on purpose: the re-probe loop below adds addresses Tailscale
  // reports after startup, and `isAllowedConnection` closes over the set.
  const tsIpSet = new Set<string>();
  let isAllowedConnection: ((ip: string) => boolean) | null = null;
  if (config.bind) {
    console.log(`Binding to explicit address: ${config.bind}`);
  } else {
    for (const ip of tsIps) {
      tsIpSet.add(ip);
      tsIpSet.add(`::ffff:${ip}`);
    }

    const isPrivateIp = buildPrivateIpFilter();
    isAllowedConnection = (ip: string) => {
      if (isPrivateIp(ip)) return true;
      if (tsIpSet.has(ip)) return true;
      return false;
    };

    if (tsIps.length > 0) {
      console.log(`Tailscale IPs: ${tsIps.join(", ")}`);
    } else {
      console.log("No Tailscale detected — daemon will bind only to loopback (127.0.0.1, ::1)");
      console.log("Install Tailscale for cross-device access, or pass --bind <address> to advertise a specific interface");
    }
  }

  // Bind addresses.
  // With --bind: operator override, one address.
  // Without: loopback (IPv4 + IPv6) plus any Tailscale IPs. Notably *not*
  // the machine's LAN IP — a LAN IP only listens when --bind is explicit.
  // This makes the daemon invisible to same-subnet port scans on hostile
  // networks (coffee shop, hotel wifi): the kernel rejects LAN-destined
  // SYNs at the socket layer, before any userspace filter runs.
  const bindAddresses: string[] = config.bind
    ? [config.bind]
    : ["127.0.0.1", "::1", ...tsIps];
  // Everything currently listened on; grows when the re-probe loop binds a
  // Tailscale address that appeared after startup.
  const boundAddresses = new Set<string>(bindAddresses);
  // Tailnet addresses whose primary listener is up but whose HTTP fallback
  // failed to bind. Kept apart from `boundAddresses` on purpose: the two
  // retries look alike and must never be merged — retrying the *primary* for
  // one of these would hit EADDRINUSE against our own listener, every probe,
  // forever (claude-9o0vgfvb:5, finding 2).
  const needFallback = new Set<string>();
  let tailscaleProbeTimer: NodeJS.Timeout | null = null;

  // On startup, MCP is not yet reconnected, but tmux sessions outlive the
  // daemon — an `active` narrative whose tmux session is still alive should
  // stay `active`. Only mark `ended` those whose tmux session is actually gone.
  {
    const activeRows = db.prepare("SELECT id FROM narratives WHERE status = 'active'").all() as Array<{ id: string }>;
    const markEnded = db.prepare("UPDATE narratives SET status = 'ended' WHERE id = ?");
    for (const { id } of activeRows) {
      try {
        execFileSync(resolveTmux(), ["has-session", "-t", id], { stdio: "ignore" });
      } catch {
        markEnded.run(id);
      }
    }
  }

  // WebSocket servers
  const controlWss = new WebSocketServer({ noServer: true });
  const controlClients = new Set<ControlClient>();
  // The presence gate (src/daemon/presence-gate.ts): meld, a device's
  // sign-out and rotation, asked from this machine's shell, wait for the
  // operator to pass the OS prompt; an agent's token is refused them. Every control socket hears when a prompt
  // opens and closes, so a device can cancel one it did not expect.
  const presenceGate = new PresenceGate({
    confirm: (reason, opts) => confirmPresence(reason, opts),
    onChange: (pending) => broadcastPresence(controlClients, pending),
    log: (line) => console.log(line),
  });
  /** Who is asking, as the gate's log and the app's banner name them. */
  const gateCaller = (record: TokenRecord, req: IncomingMessage): Caller => ({
    record,
    by: record.kind === "agent"
      ? `agent ${record.ownerNid ?? record.label}`
      : record.kind === "device"
        ? `device "${record.label}"`
        : `this machine (${connectionLabel(req.socket) ?? "?"})`,
  });
  /** A signal that fires if the client goes away before it is answered: a
   *  gated request held for the operator withdraws its prompt then. */
  const whileConnected = (res: ServerResponse): AbortSignal => {
    const withdrawn = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) withdrawn.abort();
    });
    return withdrawn.signal;
  };
  const sendAnswer = (res: ServerResponse, answer: RouteAnswer) => {
    if (res.headersSent || res.destroyed) return;
    if (answer.retryAfterMs !== undefined) res.setHeader("Retry-After", String(Math.ceil(answer.retryAfterMs / 1000)));
    sendJson(res, answer.status, answer.body);
  };
  // The ceremonies behind the verification gate (docs/passkeys.md): an
  // approval for the caller's own token, redeemed on the daemon's own page
  // (`GET /verify`) for a WebAuthn proof or a new credential. The RP ID is
  // the daemon's TLS hostname, so without a certificate there is no
  // ceremony at all.
  const credentialStore = new DbCredentialStore(db);
  // The host recorded is the one the ceremony would use (`relyingParty`):
  // a certificate provisioned after a blind start, while the protocol stays
  // HTTP, serves no ceremony, so it records nothing, as status reports
  // nothing.
  const renameWatch = new RenameWatch();
  noteRpId = () => {
    const host = relyingParty()?.rpId ?? null;
    recordRpId(db, host);
    if (!host) return;
    const warning = renameWatch.check(credentialStore.live(), host, verificationGate.config().mode);
    if (warning) console.warn(warning);
  };
  /** The served host, the credentials enrolled for another, and how many
   *  can verify here, for `/api/status` and the credentials list. */
  const rpReport = (): { rp_id: string | null; rp_mismatch: string[]; usable_credentials: number | null } => {
    const rpId = relyingParty()?.rpId ?? null;
    const live = credentialStore.live();
    return { rp_id: rpId, rp_mismatch: [...orphanedCredentials(live, rpId).keys()], usable_credentials: usableCredentials(live, rpId) };
  };
  const relyingParty = (): RelyingParty | null => {
    // The hostname the served certificate names: what the browser sees, so
    // what the RP ID must be. Read from the cert itself rather than from
    // Tailscale, which may be blind at this moment while the cert is fine.
    const host = currentTlsOpts ? certificateHost(currentTlsOpts.cert) : null;
    if (!tls || !host) return null;
    const origin = actualPort === 443 ? `https://${host}` : `https://${host}:${actualPort}`;
    return { rpId: host, origin, origins: [origin] };
  };
  const ceremonies = new Ceremonies({
    credentials: credentialStore,
    verifyToken: (id, opts) => tokenStore.verify(id, opts),
    isLiveDevice: (id) => tokenStore.get(id)?.kind === "device",
    windowMs: () => verificationGate.config().windowMs,
    rp: relyingParty,
    trust: trustStore(YUBICO_FIDO_ROOTS, YUBICO_FIDO_INTERMEDIATES),
    userHandle: () => webauthnUserHandle(db),
    confirmPresence: (by, signal) => askEnrollPresence(presenceGate, by, signal),
    describeToken: (id) => {
      const t = tokenStore.get(id);
      return t ? (describeUserAgent(t.user_agent) ?? t.label) : null;
    },
    onVerified: (tokenId, verifiedUntil) => broadcastVerified(controlClients, tokenId, verifiedUntil),
    log: (line) => console.log(line),
  });
  _serverDb = db;
  _serverControlClients = controlClients;
  const mcpWss = new WebSocketServer({ noServer: true });
  const mcpClients = new Set<McpBridgeClient>();
  const terminalWss = new WebSocketServer({ noServer: true });

  // Immediate notification for pending MCP listen calls
  const listenWaiters = new Map<string, Set<() => void>>();
  // Which narratives are parked in a blocking listen (or a waiting narrate) —
  // AGOG in the app. Its own control message rather than a `status`: an older
  // app reads any unknown status as the narrative's lifecycle status.
  const awaiting = new AwaitingTracker((nid, isAwaiting) => broadcastAwaiting(controlClients, nid, isAwaiting));
  function notifyListenWaiters(narrativeId: string): void {
    wakeListenWaiters(listenWaiters, narrativeId);
    // Every append funnels through here, so it's the one place to push the
    // brane-wide activity stream — event-driven, only on real state changes.
    broadcastActivity(db, controlClients, narrativeId);
  }

  const recordEventMentions = createMentionRecorder(db, notifyListenWaiters);

  // Sleep (src/daemon/sleep.ts, docs/sleep.md): the idle rule's clock, the
  // routine the idle rule, the Sleep act and a signal all run, and boot
  // revive. The clock counts control-socket clients, kept in step where
  // `/ws/control` is upgraded below.
  const braneDir = getBraneDir();
  const narrativeRole = db.prepare("SELECT role FROM narratives WHERE id = ?");
  /** Narratives with a tmux session right now, asked of tmux each call;
   *  null when tmux could not be asked, which never sleeps the host. */
  const liveNarratives = (): LiveNarrative[] | null => {
    const names = listTmuxSessions((args) =>
      execFileSync(resolveTmux(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 }),
    );
    if (!names) return null;
    const live: LiveNarrative[] = [];
    for (const name of names) {
      const row = narrativeRole.get(name) as { role: string } | undefined;
      if (row) live.push({ id: name, role: row.role });
    }
    return live;
  };
  const sleeper = new Sleeper({
    braneDir,
    liveNarratives,
    // Config first, so `brane config sleep.idle_minutes 0` switches off what
    // the image's environment switched on. Re-read every tick: the CLI
    // writes config to the database, and the daemon hears it only by reading.
    idleMinutes: () => parseIdleMinutes(getConfig("sleep.idle_minutes", db), process.env.BRANE_SLEEP_IDLE_MINUTES),
    bootRevive: () => bootReviveEnabled(process.env, getConfig("sleep.boot_revive", db)),
    tailscaleDown: (reason) => tailscaleDownWanted(reason, process.env, getConfig("sleep.tailscale_down", db)),
    endSessions: () => endsSessions(process.env),
    runEndSessions: () => runEndSessions(resolveTmux(), (m) => console.log(`[sleep] ${m}`)),
    announce: (nid, content) => {
      // A lifecycle row, like `restarted`: the daemon's voice, no source, so
      // it is an arrival for the agent's parked listen.
      const event = appendEvent(db, nid, "sleeping", { content });
      announceEvent(nid, event, "brane", notifyListenWaiters, recordEventMentions);
    },
    shutdown: () => doShutdown(),
    forceExit: () => process.exit(0),
    log: (m) => console.log(`[sleep] ${m}`),
  });
  takeExitRecord(braneDir, (m) => console.log(`[sleep] ${m}`));

  /** Boot revive (src/daemon/sleep.ts), on the first operator connection
   *  after boot rather than at boot: waking the host restores nothing, only
   *  someone actually connecting does (claude-qdjo1yqn:65, :67). */
  const manifestRestorer = new ManifestRestorer(async () => {
    try {
      await ensureTmux();
      await bootRevive({
        braneDir,
        enabled: bootReviveEnabled(process.env, getConfig("sleep.boot_revive", db)),
        alive: (nid) => {
          try {
            execFileSync(resolveTmux(), ["has-session", "-t", nid], { stdio: "ignore", timeout: 5_000 });
            return true;
          } catch {
            return false;
          }
        },
        revive: (nid, prompt) => reviveKeepingLauncher(db, nid, prompt),
        log: (m) => console.log(`[sleep] boot revive: ${m}`),
      });
    } catch (err) {
      console.error("[sleep] boot revive failed:", err);
    }
  }, () => sleeper.sleeping !== null);

  // Rendered diagrams, keyed on their source. A fence's source never changes
  // once an event is written — the log is append-only — so a conversation
  // re-read after a scroll re-renders nothing. `null` is cached too: refusing
  // a gantt chart is as worth remembering as drawing a flowchart. Bounded,
  // oldest-out, because a long narrative can hold arbitrarily many fences.
  //
  // A hit is not *quite* a pure function of the source: the SVG also depends
  // on which narratives exist, so a node naming one created after the render
  // stays unlinked until the entry is evicted. Harmless, and the alternative
  // — keying on the nid set, or invalidating on every spawn — costs more than
  // a missing link in a diagram is worth.
  const DIAGRAM_CACHE_MAX = 128;
  const diagramCache = new Map<string, { svg: string; labels: string[] } | null>();
  const diagramCacheSet = (key: string, value: { svg: string; labels: string[] } | null) => {
    diagramCache.set(key, value);
    while (diagramCache.size > DIAGRAM_CACHE_MAX) {
      const oldest = diagramCache.keys().next();
      if (oldest.done) break;
      diagramCache.delete(oldest.value);
    }
  };
  // Built per request rather than once: it memoises existence lookups, and a
  // narrative spawned after the daemon started must still resolve.
  const diagramHref = () => nidHrefFor(db);

  // Tool rows push *inline* on the control channel (claude-xlolbv6l:80) —
  // unlike events, which send a `new_events` hint and let the client refetch.
  // Tool calls arrive in bursts at 10–50× narration frequency, so
  // hint-then-fetch would turn every burst into a round-trip storm. Rows
  // coalesce last-write-wins per dedup_key (a call that starts and completes
  // inside one window emits a single frame, which the upsert key makes free)
  // and flush on whichever comes first: the timer or max_batch. flush_ms = 0
  // disables coalescing entirely (debugging). Slow clients degrade to a
  // `tool_uses_resync` hint instead of an unbounded socket buffer — the old
  // hint mechanism demoted to the overflow valve (claude-xlolbv6l:81).
  //
  // Both knobs go through numericConfig: a typo used to parse as NaN, and NaN
  // fails every comparison silently — `NaN <= 0` false takes the timer path,
  // `setTimeout(fn, NaN)` fires next tick, `size >= NaN` never trips. That's
  // coalescing switched off with no error anywhere (claude-8fkbabsx:9,
  // finding 6).
  const toolUseFlushMs = numericConfig(getConfig("tool_uses.flush_ms", db), 250, "tool_uses.flush_ms");
  const toolUseMaxBatch = numericConfig(getConfig("tool_uses.max_batch", db), 20, "tool_uses.max_batch");
  const toolUseBuffers = new Map<string, Map<string, ToolUseRow>>();
  const toolUseTimers = new Map<string, NodeJS.Timeout>();
  function flushToolUses(narrativeId: string): void {
    const timer = toolUseTimers.get(narrativeId);
    if (timer) {
      clearTimeout(timer);
      toolUseTimers.delete(narrativeId);
    }
    const buffer = toolUseBuffers.get(narrativeId);
    if (!buffer || buffer.size === 0) return;
    toolUseBuffers.delete(narrativeId);
    // Ordered by display key so clients can insert-merge in one pass, then
    // excerpted for the wire — both in `shapeToolUsesForPush`, where a test can
    // reach them. It used to be a `.sort().map(excerptForPush)` here, which
    // silently blanked every pushed row once that function grew a second
    // parameter for `map`'s index to land in (claude-bk6vwpc8:9).
    const rows = shapeToolUsesForPush([...buffer.values()]);
    const maxRev = Math.max(...rows.map((r) => r.rev));
    const msg = JSON.stringify({ type: "tool_uses", narrative: narrativeId, rows, rev: maxRev });
    const resync = JSON.stringify({ type: "tool_uses_resync", narrative: narrativeId, rev: maxRev });
    for (const client of controlClients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (!client.subscriptions.has(narrativeId)) continue;
      // A backgrounded phone mid-burst can't drain its socket; past this
      // threshold stop feeding it rows and hand it a cursor to catch up from.
      if (client.ws.bufferedAmount > 512 * 1024) {
        client.ws.send(resync);
      } else {
        client.ws.send(msg);
      }
    }
  }
  /** Correct a row for a tool the daemon served itself, once it really ends.
   *
   *  The hook is the only witness for tool calls the daemon knows nothing
   *  about, but `listen` is not one of those: the daemon *is* what resolves it.
   *  Claude Code backgrounds a call at 120s and fires `PostToolUse` there, so
   *  without this every long listen is stored as "completed in 120.0s" while
   *  still blocking (claude-n1izig04:35). Best-effort by construction — a row
   *  that can't be settled just keeps the hook's version, which is what it
   *  would have had anyway. */
  const settleOwnCall: SettleCall = (nid, name, startedAt, endedAt) => {
    try {
      const row = settleDaemonCall(db, nid, name, startedAt, endedAt);
      if (row) pushToolUse(row);
    } catch (err) {
      console.error(`[tool-use] settling ${name} for ${nid} failed: ${err}`);
    }
  };
  function pushToolUse(row: ToolUseRow): void {
    const nid = row.narrative_id;
    let buffer = toolUseBuffers.get(nid);
    if (!buffer) {
      buffer = new Map();
      toolUseBuffers.set(nid, buffer);
    }
    buffer.set(row.dedup_key, row);
    if (toolUseFlushMs <= 0 || buffer.size >= toolUseMaxBatch) {
      flushToolUses(nid);
      return;
    }
    if (!toolUseTimers.has(nid)) {
      toolUseTimers.set(nid, setTimeout(() => flushToolUses(nid), toolUseFlushMs));
    }
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
    // Registered before anything can answer, so every `sendJson` on this
    // response — including the early auth and error exits — can see whether
    // the client accepts gzip.
    trackRequest(res, req);
    setCorsHeaders(req, res);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `${tls ? "https" : "http"}://localhost:${port}`);
    const path = url.pathname;

    // Page: GET /verify — the ceremony page (docs/passkeys.md, The hop):
    // self-contained, on the daemon's own origin, holding no token. Its only
    // capability is the approval in its fragment, which no server sees.
    if (path === "/verify" && req.method === "GET") {
      res.writeHead(200, verifyPageHeaders());
      res.end(VERIFY_PAGE_HTML);
      return;
    }

    // Static files don't require auth (token is in hash fragment, read by client JS)
    if (!path.startsWith("/api/")) {
      serveStatic(res, path);
      return;
    }

    // The ceremony page's own routes. Answered before the token check: the
    // page holds no token, only an approval a signed-in device asked for,
    // bound to that device's token (src/daemon/verification-ceremony.ts).
    // Route: POST /api/verify/challenge — options and a fresh challenge for a verify approval.
    // Route: POST /api/verify/webauthn — an assertion: verifies the approval's token.
    // Route: POST /api/credentials/challenge — options and a fresh challenge for an enroll approval.
    // Route: POST /api/credentials — a new credential, behind the presence check unless attested.
    if (
      req.method === "POST" &&
      (path === "/api/verify/challenge" || path === "/api/verify/webauthn" || path === "/api/credentials/challenge" || path === "/api/credentials")
    ) {
      const signal = whileConnected(res);
      parseBody(req)
        .then(async (raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw || "{}");
          } catch {
            sendJson(res, 400, { error: "The body is not JSON" });
            return;
          }
          const approval = (body as { approval?: unknown } | null)?.approval;
          const answer =
            path === "/api/verify/challenge"
              ? ceremonies.challenge(approval, "verify")
              : path === "/api/credentials/challenge"
                ? ceremonies.challenge(approval, "enroll")
                : path === "/api/verify/webauthn"
                  ? ceremonies.finishVerify(body)
                  : await ceremonies.finishEnroll(body, signal);
          sendAnswer(res, answer);
        })
        .catch((err) => {
          if (!res.headersSent) sendJson(res, 400, { error: String(err) });
        });
      return;
    }

    // Route: POST /api/hooks/tool-use — agent-harness hook ingest.
    //
    // Sits *before* the bearer-token check on purpose: hook processes
    // authenticate per-narrative with the bind token they inherit from the
    // tmux session env (BRANE_NARRATIVE_ID + BRANE_NARRATIVE_SECRET — the same
    // inheritance the MCP bridge rides), so the daemon bearer token never has
    // to be written into a fold's hook config. Verification checks the secret
    // by hash against the narrative's live agent token: no minting, no grace path —
    // a hook that can't prove its narrative is simply refused, and fail-open
    // on the agent side means the tool call proceeds unrecorded. External
    // (unspawned) agents will need a session_id → session_ids fallback here;
    // deliberately not built until that phase (claude-vhkt2ogz:4).
    if (path === "/api/hooks/tool-use" && req.method === "POST") {
      const claimedNid = req.headers["x-brane-narrative-id"];
      const secret = req.headers["x-brane-narrative-secret"];
      if (typeof claimedNid !== "string" || typeof secret !== "string") {
        sendJson(res, 401, { error: "Missing narrative credentials" });
        return;
      }
      // The secret is an agent token, which works only from this machine
      // (src/daemon/agent-scope.ts); hooks dial 127.0.0.1.
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: AGENT_LOOPBACK_REFUSAL });
        return;
      }
      const bind = verifyNarrativeBind(db, claimedNid, secret);
      if (!bind) {
        sendJson(res, 403, { error: "Narrative bind refused" });
        return;
      }
      // 400 means "your payload was bad", 500 means "mine broke" — and the
      // difference is not cosmetic here. A single catch mapping everything to
      // 400 told a hook its request was malformed when the real cause was
      // SQLITE_BUSY, or a throw from pushToolUse *after* the row had already
      // committed: a 400 for a write that succeeded (claude-8fkbabsx:19).
      // Parse and validate first, then execute; each stage answers for itself.
      parseBody(req)
        .then((body) => {
          let opts;
          try {
            // Normalize before mapping. goose, crush and cline each name these
            // fields differently, and an un-normalized `event: "PreToolUse"`
            // falls through to the completion path — recording every call as
            // finished the instant it starts (see normalizeHookPayload).
            // Claude's payload already speaks the contract and passes through.
            const hook = normalizeHookPayload(JSON.parse(body));
            opts = toolUseFromClaudeHook(hook, {
              source: "hook",
              agentType: bind.agentType ?? undefined,
            });
          } catch (err) {
            sendJson(res, 400, { error: `Malformed payload: ${err}` });
            return;
          }
          if (!opts) {
            sendJson(res, 400, { error: "tool_name required" });
            return;
          }
          try {
            const toolUse = recordToolUse(db, claimedNid, opts);
            pushToolUse(toolUse);
            sendJson(res, 200, { rev: toolUse.rev });
          } catch (err) {
            console.error(`[hook] recording tool use for ${claimedNid} failed: ${err}`);
            sendJson(res, 500, { error: "Failed to record tool use" });
          }
        })
        // Body never arrived or was rejected (oversized, aborted) — the
        // request is at fault, so this stays a 400.
        .catch((err) => {
          sendJson(res, 400, { error: String(err) });
        });
      return;
    }

    // Auth check for API routes
    const presented = extractToken(req, url);
    const auth = authenticate(presented, req);
    if (!auth) {
      sendJson(res, 500, { error: "Could not check the token; try again" });
      return;
    }
    if (!auth.ok) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    if (auth.retired) finishRotation({ retired: auth.retired });
    const agentRefused = refuseAgent(auth.record, req, path);
    if (agentRefused) {
      sendJson(res, 403, { error: agentRefused });
      return;
    }
    // The verification gate: free routes pass; an act needs a verified
    // device token. Never 401, which the app reads as "signed out".
    const verifyRefused = verificationGate.refuseRoute(auth.record, req.method ?? "GET", path);
    if (verifyRefused) {
      sendJson(res, verifyRefused.status, verifyRefused.body);
      return;
    }
    // The record (docs/passkeys.md): a device's act under the gate is
    // logged with the proof that let it through. Reads are not acts; the
    // control socket logs its own signals; a terminal's keystrokes are
    // never logged. This is the gate's verdict, before the route runs: the
    // route may still refuse (a bad body, presence declined) or 404.
    if (classifyRoute(req.method ?? "GET", path).kind === "act") {
      const proof = verificationGate.proof(auth.record);
      if (proof) console.log(`[verification] passed the gate: ${req.method} ${path} for device "${auth.record.label}": verified by ${proof.by} (${proof.method}) at ${new Date(proof.at).toISOString()}`);
    }

    // Route: GET /api/status
    if (path === "/api/status" && req.method === "GET") {
      sendJson(res, 200, {
        brane_id: braneId,
        hostname: osHostname(),
        username: osUserInfo().username,
        pid: process.pid,
        port: actualPort,
        uptime_ms: Math.floor(process.uptime() * 1000),
        tls: serializeCertStatus(certMgr.getStatus()),
        keep_awake: keepAwake.getStatus(),
        // Addresses beyond loopback the daemon is actually listening on —
        // empty means "reachable from this machine only".
        listening_on: [...boundAddresses].filter((a) => a !== "127.0.0.1" && a !== "::1"),
        // The posture, and for a device its own window, so the app knows
        // whether a hop has landed when it comes back to the foreground.
        verification: {
          ...verificationStatus(verificationGate.config()),
          ...(auth.record.kind === "device" ? { verified_until: tokenStore.verification(auth.record.id, Date.now()).verifiedUntil } : {}),
          // The host credentials must be enrolled for, and any host live
          // credentials were enrolled for instead (a rename orphans them).
          ...rpReport(),
        },
        // Listening on the address over HTTPS, but the HTTP fallback (the
        // local/LAN path) is not up there yet.
        fallback_missing: [...needFallback],
        // The hostname that serves the shared app: where `brane meld` points
        // a QR, and where a daemon's own bundle offers to hop *out* to
        // (Isolate's way back). The app reads it from here rather than
        // carrying a host of its own, so a fork's daemon names the fork's
        // shell (src/shared/view-url.ts).
        app_domain: statusAppDomain(db),
        // How a sleeping host is woken, and the idle rule's inputs
        // (src/daemon/sleep.ts, docs/sleep.md).
        wake: wakeRecipe(),
        sleep: sleeper.status(),
        // The narratives parked awaiting direction (src/daemon/awaiting.ts):
        // the glows the switcher puts on this daemon's row, and the undead
        // count beside its sleep posture. Each is a tmux session, so each
        // is also a reason the host is not asleep.
        awaiting: awaiting.narratives(),
      });
      return;
    }

    // Route: POST /api/sleep — the operator's Sleep act. Answered before the
    // routine starts, since the routine closes this connection; an agent's
    // token never gets here (not in AGENT_ROUTES).
    if (path === "/api/sleep" && req.method === "POST") {
      const answer = sleepActAnswer(sleeper);
      if (answer.status === 202) {
        console.log(`[sleep] the operator asked for sleep (${connectionLabel(req.socket) ?? "?"}); ${answer.body.narratives.length} narrative(s) live`);
        res.once("finish", () => setImmediate(() => void sleeper.sleep("operator")));
      }
      sendJson(res, answer.status, answer.body);
      return;
    }

    // Route: GET /api/narratives?archived=1&brane_ids=a,b,c
    if (path === "/api/narratives" && req.method === "GET") {
      const includeArchived = url.searchParams.get("archived") === "1";
      const braneIdsParam = url.searchParams.get("brane_ids");
      const braneIds = braneIdsParam
        ? braneIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      const connectedNids = mcpConnectedNids(mcpClients);

      const where: string[] = [];
      const params: unknown[] = [];
      if (!includeArchived) {
        where.push("(archived = 0 OR archived IS NULL)");
      }
      if (braneIds.length > 0) {
        where.push(`brane_id IN (${braneIds.map(() => "?").join(",")})`);
        params.push(...braneIds);
      } else {
        // All branes: an archived brane's ended narratives stay out of it
        // (src/db/branes.ts). Naming the brane still lists them.
        const visible = visibleUnscopedClause(connectedNids);
        where.push(visible.sql);
        params.push(...visible.params);
      }
      // last_activity = time of the most recent event, so the UI can show a
      // recency timestamp on each card (more meaningful than created_at for
      // long-running narratives). Events are append-ordered, so the newest
      // event by seq carries the max time — and `ORDER BY seq DESC LIMIT 1`
      // rides the (narrative_id, seq) index for a single-row seek per
      // narrative, where `MAX(time)` would scan every event of each.
      const sql = `SELECT n.*, (
          SELECT time FROM events WHERE narrative_id = n.id ORDER BY seq DESC LIMIT 1
        ) AS last_activity FROM narratives n${
        where.length ? ` WHERE ${where.join(" AND ")}` : ""
      } ORDER BY created_at DESC`;

      // Resumption plumbing stays server-side. `session_ids` and
      // `agent_session_id` were the two largest fields in this response —
      // 112KB of the 934KB one phone measured — and no client renders either;
      // revive resolves them from the database (claude-n1izig04:74).
      const narratives = (db
        .prepare(sql)
        .all(...params) as Array<NarrativeRow & Record<string, unknown>>).map((row) => {
        const { session_ids: _s, agent_session_id: _a, ...n } = row;
        return { ...n, archived: n.archived === 1, mcp_connected: connectedNids.has(n.id), awaiting: awaiting.isAwaiting(n.id) };
      });
      sendJson(res, 200, { narratives });
      return;
    }

    // Route: GET /api/narratives/:id — one narrative, for the chat header.
    //
    // The header used to wait on the whole list, which on one phone meant 1,864
    // narratives and 934KB before a title could render (claude-n1izig04:76).
    // What it needs is a single row, and a single row is a single-key seek.
    // Route: GET /api/narratives/recent?since=24h&search=&status=&fold=&limit=20&archived=1&brane_ids=a,b
    // The browse half of the `narrative_info` MCP tool, over HTTP, for
    // `brane memory log` — the same function, so the CLI and an agent asking
    // "what was active today?" get the same answer. There is no caller brane
    // here, so the default scope is every brane rather than the caller's.
    if (path === "/api/narratives/recent" && req.method === "GET") {
      const parsed = parseRecentQuery(url.searchParams);
      if ("error" in parsed) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      try {
        sendJson(
          res,
          200,
          handleNarrativeInfo(db, parsed.args, mcpConnectedNids(mcpClients), parsed.braneIds),
        );
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const oneNarrativeMatch = path.match(/^\/api\/narratives\/([^/]+)$/);
    if (oneNarrativeMatch && req.method === "GET") {
      const row = db
        .prepare(
          `SELECT n.*, (
             SELECT time FROM events WHERE narrative_id = n.id ORDER BY seq DESC LIMIT 1
           ) AS last_activity FROM narratives n WHERE n.id = ?`,
        )
        .get(oneNarrativeMatch[1]) as (NarrativeRow & Record<string, unknown>) | undefined;
      if (!row) {
        sendJson(res, 404, { error: "No such narrative" });
        return;
      }
      const { session_ids: _s, agent_session_id: _a, ...narrative } = row;
      sendJson(res, 200, {
        narrative: {
          ...narrative,
          archived: narrative.archived === 1,
          mcp_connected: mcpConnectedNids(mcpClients).has(row.id),
          awaiting: awaiting.isAwaiting(row.id),
        },
      });
      return;
    }

    // Route: PATCH /api/narratives/:id/archive
    const archiveMatch = path.match(/^\/api\/narratives\/([^/]+)\/archive$/);
    if (archiveMatch && req.method === "PATCH") {
      const narrativeId = archiveMatch[1];
      parseBody(req).then((body) => {
        const { archived } = JSON.parse(body);
        // A running narrative can't be archived: hiding a live agent from the
        // list is exactly what a rogue one would want. See archive-gate.ts.
        if (archived) {
          const row = db.prepare("SELECT status FROM narratives WHERE id = ?").get(narrativeId) as { status: string | null } | undefined;
          if (!row) {
            sendJson(res, 404, { error: `No narrative ${narrativeId}` });
            return;
          }
          const refusal = archiveRefusal({
            status: row.status,
            mcpConnected: mcpConnectedNids(mcpClients).has(narrativeId),
            tmuxLive: liveTmuxSessions().has(narrativeId),
          });
          if (refusal) {
            sendJson(res, 409, { error: `Can't archive ${narrativeId}: ${refusal}. End it first.` });
            return;
          }
        }
        db.prepare("UPDATE narratives SET archived = ? WHERE id = ?").run(archived ? 1 : 0, narrativeId);
        // An archived narrative's agent token is a credential nobody needs:
        // revoke it. Its session is over, or the gate above would have
        // refused. Unarchiving brings nothing back; a revive mints a fresh
        // token.
        if (archived) {
          const agentRow = liveAgentTokenId(db, narrativeId);
          if (agentRow) {
            db.prepare("UPDATE tokens SET revoked_at = ? WHERE kind = 'agent' AND owner_nid = ? AND revoked_at IS NULL").run(Date.now(), narrativeId);
            // Any socket still holding it goes now, not at its next redial.
            closeSocketsOf(viewerSockets, [agentRow]);
          }
        }
        sendJson(res, 200, { id: narrativeId, archived: !!archived });
      }).catch((err) => {
        sendJson(res, 400, { error: String(err) });
      });
      return;
    }

    // Route: GET /api/narratives/:id/events?after=N&before=S&tail=T&limit=M
    const eventsMatch = path.match(/^\/api\/narratives\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const narrativeId = eventsMatch[1];
      const afterParam = url.searchParams.get("after") ?? url.searchParams.get("heard");
      const beforeParam = url.searchParams.get("before");
      const tailParam = url.searchParams.get("tail");
      const limitParam = url.searchParams.get("limit");

      const after = afterParam ? parseInt(afterParam, 10) : undefined;
      const before = beforeParam ? parseInt(beforeParam, 10) : undefined;
      const tail = tailParam ? parseInt(tailParam, 10) : (limitParam ? parseInt(limitParam, 10) : undefined);

      let events = readEvents(db, narrativeId, {
        after: after ?? 0,
        before,
        tail: !afterParam ? tail : undefined,
      });
      // When after + limit are both specified, cap the results
      if (afterParam && limitParam && !tailParam) {
        events = events.slice(0, parseInt(limitParam, 10));
      }
      const headSeq = getMaxSeq(db, narrativeId);
      const minSeq = getMinSeq(db, narrativeId);
      sendJson(res, 200, { nid: narrativeId, seq: headSeq, min_seq: minSeq, events });
      return;
    }

    // Route: GET /api/narratives/:id/tool_uses — tool-call rows. Two distinct
    // queries behind one path, chosen by whether `since_rev` is present:
    //
    // - **catch-up** (`since_rev`): rows written or mutated since the client's
    //   watermark, rev-ordered, resumed with `next_since_rev`;
    // - **window** (`after_seq_gte`/`after_seq_lt`): the half-open display band,
    //   display-ordered, resumed with `next_cursor`.
    //
    // Always limited — rows carry input/output verbatim and uncapped, so an
    // unbounded response can hand `JSON.stringify` an arbitrarily large string
    // on the daemon's only thread. Truncation is never silent: `truncated` says
    // there is more and the matching cursor says where to resume
    // (claude-8fkbabsx:9 finding 1, refined at claude-8fkbabsx:14).
    //
    // No `rev` in the response. The client's watermark must come from rows it
    // actually applied: `MAX(rev)` over the narrative is only correct after an
    // *unwindowed, untruncated* catch-up, and wrong — silently, permanently —
    // for every other shape of this request (finding 8).
    // Route: GET /api/narratives/:id/tool_uses/:dedup_key — one row, whole.
    // The list reads excerpt; this is where the full text lives, fetched when
    // the operator actually opens a row.
    const toolUseOneMatch = path.match(/^\/api\/narratives\/([^/]+)\/tool_uses\/([^/]+)$/);
    if (toolUseOneMatch && req.method === "GET") {
      const row = readToolUse(db, toolUseOneMatch[1], decodeURIComponent(toolUseOneMatch[2]));
      if (!row) {
        sendJson(res, 404, { error: "No such tool use" });
        return;
      }
      sendJson(res, 200, { nid: toolUseOneMatch[1], tool_use: row });
      return;
    }

    const toolUsesMatch = path.match(/^\/api\/narratives\/([^/]+)\/tool_uses$/);
    if (toolUsesMatch && req.method === "GET") {
      const narrativeId = toolUsesMatch[1];
      const intParam = (name: string): number | undefined => {
        const raw = url.searchParams.get(name);
        if (raw === null) return undefined;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : undefined;
      };
      const requested = intParam("limit");
      const limit =
        requested !== undefined && requested > 0
          ? Math.min(requested, TOOL_USES_MAX_LIMIT)
          : TOOL_USES_MAX_LIMIT;
      // Both reads ask for one row more than they return. `length === limit`
      // can't tell an exactly-full page from a truncated one, so it claims
      // "more" on every exact fill and costs a round trip to disprove
      // (claude-8fkbabsx:19). The probe row answers it outright.
      const sinceRev = intParam("since_rev");
      if (sinceRev !== undefined) {
        // Catch-up: rev-ordered, so a truncated page's last rev is a watermark
        // the client can safely keep. Resume by re-asking with `next_since_rev`.
        const probed = readToolUsesSince(db, narrativeId, { sinceRev, limit: limit + 1 });
        const capped = fitToolUses(probed, limit);
        sendJson(res, 200, {
          nid: narrativeId,
          tool_uses: capped.rows,
          truncated: capped.truncated,
          next_since_rev: capped.truncated ? capped.rows[capped.rows.length - 1].rev : null,
        });
        return;
      }
      const afterSeq = intParam("after_cursor_seq");
      const afterStartedAt = intParam("after_cursor_started_at");
      const afterDedupKey = url.searchParams.get("after_cursor_dedup_key");
      const probed = readToolUseWindow(db, narrativeId, {
        afterSeqGte: intParam("after_seq_gte") ?? 0,
        afterSeqLt: intParam("after_seq_lt"),
        limit: limit + 1,
        after:
          afterSeq !== undefined && afterStartedAt !== undefined && afterDedupKey !== null
            ? { afterSeq, startedAt: afterStartedAt, dedupKey: afterDedupKey }
            : undefined,
      });
      const capped = fitToolUses(probed, limit);
      const rows = capped.rows;
      const truncated = capped.truncated;
      const cursor = truncated ? toolUseCursor(rows) : null;
      sendJson(res, 200, {
        nid: narrativeId,
        tool_uses: rows,
        truncated,
        next_cursor: cursor && {
          after_seq: cursor.afterSeq,
          started_at: cursor.startedAt,
          dedup_key: cursor.dedupKey,
        },
      });
      return;
    }

    // Route: POST /api/narratives/:id/signal
    const signalMatch = path.match(/^\/api\/narratives\/([^/]+)\/signal$/);
    if (signalMatch && req.method === "POST") {
      const narrativeId = signalMatch[1];
      // Who the signal is from comes from the token, not the body.
      const standing = signalStanding(auth.record);
      if ("refused" in standing) {
        sendJson(res, 403, { error: standing.refused });
        return;
      }
      parseBody(req).then(async (body) => {
        const request = JSON.parse(body);
        const rawPayloads = request.payloads;
        let payloadPaths: string[] | undefined;
        if (Array.isArray(rawPayloads) && rawPayloads.length > 0) {
          payloadPaths = await storePayloads(narrativeId, rawPayloads);
        }
        const fields = signalEventFields(standing, request, payloadPaths, verificationGate.proof(auth.record));
        const event = appendEvent(db, narrativeId, "human_signal", fields);
        // Auto-unarchive narratives when signaled into
        db.prepare("UPDATE narratives SET archived = 0 WHERE id = ? AND archived = 1").run(narrativeId);
        announceEvent(narrativeId, event, fields.source, notifyListenWaiters, recordEventMentions);

        sendJson(res, 200, { event });
      }).catch((err) => {
        sendJson(res, 400, { error: String(err) });
      });
      return;
    }

    // Route: GET /api/payloads/:nid/:filename — serve stored payload files
    const payloadMatch = path.match(/^\/api\/payloads\/([^/]+)\/(.+)$/);
    if (payloadMatch && req.method === "GET") {
      const [, nid, filename] = payloadMatch;
      const payloadsDir = getPayloadsDir(nid);
      const filePath = resolve(payloadsDir, filename);
      if (!filePath.startsWith(payloadsDir)) {
        sendJson(res, 400, { error: "Invalid path" });
        return;
      }
      payloadResponse(filePath, filename, req.headers.range, MIME_TYPES).then((result) => {
        if ("error" in result) {
          for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
          sendJson(res, result.status, { error: result.error });
          return;
        }
        res.writeHead(result.status, result.headers);
        pipeline(result.stream, res, (err) => {
          if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
            console.warn(`[payloads] stream failed for ${nid}/${filename}:`, err);
          }
        });
      }).catch((err) => {
        sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    // Route: GET /api/files/list?nid=<nid> — flat list of all file paths under the fold
    if (path === "/api/files/list" && req.method === "GET") {
      const nid = url.searchParams.get("nid");
      if (!nid) {
        sendJson(res, 400, { error: "nid is required" });
        return;
      }
      const narrative = db
        .prepare("SELECT fold_path FROM narratives WHERE id = ?")
        .get(nid) as { fold_path: string | null } | undefined;
      if (!narrative || !narrative.fold_path) {
        sendJson(res, 404, { error: "Narrative not found or has no fold" });
        return;
      }
      const foldRoot = resolve(fromPortablePath(narrative.fold_path));
      walkFold(foldRoot).then(({ files, truncated }) => {
        sendJson(res, 200, { files, truncated });
      }).catch((err) => {
        sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    // Route: GET /api/files/find?nid=<nid>&path=<rel>&q=<query>[&from=N] —
    // search a file's bytes for the hex view. Answers as NDJSON: `hits`
    // batches in offset order, `progress`, and one closing `done` that says
    // why it stopped and where to resume. See src/files/find.ts for bounds.
    if (path === "/api/files/find" && req.method === "GET") {
      const nid = url.searchParams.get("nid");
      if (!nid) {
        sendJson(res, 400, { error: "nid is required" });
        return;
      }
      const needles = parseFindQuery(url.searchParams.get("q"));
      if ("error" in needles) {
        sendJson(res, 400, { error: needles.error });
        return;
      }
      const from = parseOffsetParam(url.searchParams.get("from"));
      if (from === undefined) {
        sendJson(res, 400, { error: "from must be a non-negative integer" });
        return;
      }
      const narrative = db
        .prepare("SELECT fold_path FROM narratives WHERE id = ?")
        .get(nid) as { fold_path: string | null } | undefined;
      if (!narrative || !narrative.fold_path) {
        sendJson(res, 404, { error: "Narrative not found or has no fold" });
        return;
      }
      const foldRoot = resolve(fromPortablePath(narrative.fold_path));
      // A reader who typed another letter has closed this request, and a
      // newer scan may take the slot: either way, stop reading. Listening
      // from the start, because opening an archive member can take a full
      // pass over the archive, and a request closed during it must not then
      // be admitted to scan for nobody.
      const stop = new AbortController();
      const onClose = () => stop.abort();
      res.on("close", onClose);
      openFoldSource(foldRoot, url.searchParams.get("path") ?? "").then(async (source) => {
        if (stop.signal.aborted) {
          res.off("close", onClose);
          return;
        }
        if ("error" in source) {
          res.off("close", onClose);
          sendJson(res, source.status, { error: source.error });
          return;
        }
        const slot = findSlots.admit();
        slot.signal.addEventListener("abort", onClose);
        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
        const emit = (event: FindEvent) => {
          if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(event) + "\n");
        };
        try {
          await scanSource(source, needles, from ?? 0, emit, { signal: stop.signal });
        } catch (err) {
          emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
        } finally {
          slot.release();
          res.off("close", onClose);
          res.end();
        }
      }).catch((err) => {
        res.off("close", onClose);
        if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    // Route: GET /api/files?nid=<nid>&path=<rel> — browse files inside a narrative's fold
    if (path === "/api/files" && req.method === "GET") {
      const nid = url.searchParams.get("nid");
      const relParam = url.searchParams.get("path") ?? "";
      if (!nid) {
        sendJson(res, 400, { error: "nid is required" });
        return;
      }
      const narrative = db
        .prepare("SELECT fold_path FROM narratives WHERE id = ?")
        .get(nid) as { fold_path: string | null } | undefined;
      if (!narrative || !narrative.fold_path) {
        sendJson(res, 404, { error: "Narrative not found or has no fold" });
        return;
      }
      const foldRoot = resolve(fromPortablePath(narrative.fold_path));
      const offset = parseOffsetParam(url.searchParams.get("offset"));
      if (offset === undefined) {
        sendJson(res, 400, { error: "offset must be a non-negative integer" });
        return;
      }
      browseFold(foldRoot, relParam, {
        raw: url.searchParams.get("raw") !== null,
        range: req.headers.range,
        offset,
        mimeTypes: MIME_TYPES,
      }).then((result) => {
        if ("json" in result) {
          sendJson(res, result.status, result.json);
          return;
        }
        // Raw bytes: an <img>/<iframe> src, or a download. Streamed, so a
        // large file costs no memory, and a member of an archive is decoded
        // only as it is sent.
        const { stream, contentType, size, range } = result.raw;
        res.statusCode = result.status;
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "no-cache");
        if (size !== null) {
          // A known size is what lets a browser seek in media, and what
          // Safari requires before it will play any (see parseRangeHeader).
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Content-Length", String(range ? range.end - range.start + 1 : size));
          if (range) res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
        }
        pipeline(stream, res, (err) => {
          if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
            console.warn(`[files] raw stream failed for ${relParam}:`, err);
          }
        });
      }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          sendJson(res, 404, { error: "Not found" });
        } else {
          sendJson(res, 500, { error: String(err) });
        }
      });
      return;
    }

    // Route: GET /api/narratives/:id/export?format=html — conversation as standalone HTML
    const exportMatch = path.match(/^\/api\/narratives\/([^/]+)\/export$/);
    if (exportMatch && req.method === "GET") {
      const nid = exportMatch[1];
      const format = url.searchParams.get("format") ?? "html";
      if (format !== "html") {
        sendJson(res, 400, { error: `Unsupported format: ${format}` });
        return;
      }
      // `palette` is the device's 🎨 Recolor salt (see shared/speaker-color);
      // absent or unreadable means the default palette.
      const palette = parseRecolorSalt(url.searchParams.get("palette"));
      // `seqs` is the chat's message selection (see shared/export-selection);
      // absent or unreadable means the whole conversation, which is what every
      // export was before a selection could be sent.
      const seqs = parseSeqParam(url.searchParams.get("seqs"));
      // `seqs_mode` says which side of that selection to export. Only the exact
      // word `except` inverts it — see the parser for why the tolerance runs
      // one way.
      const seqsMode = parseSeqModeParam(url.searchParams.get("seqs_mode"));
      exportNarrativeHtml(db, nid, { interactive: true, palette, seqs, seqsMode }).then((html) => {
        if (html === null) {
          sendJson(res, 404, { error: "Narrative not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(html);
      }).catch((err) => {
        console.warn(`[export] ${nid}:`, err);
        sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    // Route: POST /api/highlight — Shiki-highlight an arbitrary snippet.
    // Body: { content: string, lang: string }. Used by chat markdown code blocks.
    if (path === "/api/highlight" && req.method === "POST") {
      parseBody(req).then(async (body) => {
        let payload: { content?: unknown; lang?: unknown };
        try {
          payload = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: "Invalid JSON" });
          return;
        }
        const content = typeof payload.content === "string" ? payload.content : null;
        const lang = typeof payload.lang === "string" ? payload.lang : null;
        if (content === null || !lang) {
          sendJson(res, 400, { error: "content and lang are required" });
          return;
        }
        const hi = await highlight(content, lang).catch((err) => {
          console.warn(`[highlight] failed for ${lang}:`, err);
          return null;
        });
        sendJson(res, 200, { highlight: hi });
      }).catch((err) => sendJson(res, 500, { error: String(err) }));
      return;
    }

    // Route: POST /api/diagram — render a ```mermaid fence to static SVG.
    // Body: { source: string }. Shaped exactly like /api/highlight above, and
    // for the same reason: a diagram is rare and heavy, so it renders on the
    // daemon rather than shipping a layout engine to every browser.
    //
    // `{ diagram: null }` is a *successful* answer meaning "not a diagram I
    // draw" — a gantt chart, a syntax error, a graph past the size bounds.
    // The client falls back to the highlighted code block a mermaid fence
    // already renders as, which is why nothing here is a 4xx.
    if (path === "/api/diagram" && req.method === "POST") {
      parseBody(req).then(async (body) => {
        let payload: { source?: unknown };
        try {
          payload = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: "Invalid JSON" });
          return;
        }
        const source = typeof payload.source === "string" ? payload.source : null;
        if (source === null) {
          sendJson(res, 400, { error: "source is required" });
          return;
        }
        if (source.length > MAX_DIAGRAM_BYTES) {
          sendJson(res, 200, { diagram: null });
          return;
        }
        const cached = diagramCache.get(source);
        if (cached !== undefined) {
          sendJson(res, 200, { diagram: cached });
          return;
        }
        let out: { svg: string; labels: string[] } | null = null;
        try {
          out = renderDiagram(source, { hrefFor: diagramHref(), edgeHighlight: true });
        } catch (err) {
          console.warn("[diagram] failed:", err);
        }
        diagramCacheSet(source, out);
        sendJson(res, 200, { diagram: out });
      }).catch((err) => sendJson(res, 500, { error: String(err) }));
      return;
    }

    // Route: GET /api/branes?archived=1
    // Archived branes (src/db/branes.ts) are left out unless archived=1, which
    // the switcher's "Show N archived" asks for; each row says which it is.
    if (path === "/api/branes" && req.method === "GET") {
      const includeArchived = url.searchParams.get("archived") === "1";
      const hidden = archivedBraneIds(db);
      const rows = db.prepare(
        `SELECT brane_id,
                COUNT(*) as narrative_count,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
                SUM(CASE WHEN role = 'absorbed' THEN 1 ELSE 0 END) as absorbed_count,
                MAX(created_at) as last_activity
         FROM narratives
         GROUP BY brane_id
         ORDER BY last_activity DESC`,
      ).all() as Array<{
        brane_id: string;
        narrative_count: number;
        active_count: number;
        absorbed_count: number;
        last_activity: number;
      }>;
      // Per-brane running cost, one entry per unit — never summed across
      // units. Over the cached narratives.cost_* columns, archived rows
      // included: the list screen never loads those, so this is the only
      // place the total can be computed honestly. `metered` is how many of
      // the brane's narratives the figure actually covers.
      const costRows = db
        .prepare(
          `SELECT brane_id, cost_unit AS unit, SUM(cost_amount) AS amount, COUNT(*) AS metered
             FROM narratives WHERE cost_amount IS NOT NULL AND cost_unit IS NOT NULL
            GROUP BY brane_id, cost_unit ORDER BY metered DESC`,
        )
        .all() as Array<{ brane_id: string; unit: string; amount: number; metered: number }>;
      const costByBrane = new Map<string, Array<{ unit: string; amount: number; metered: number }>>();
      for (const c of costRows) {
        const list = costByBrane.get(c.brane_id) ?? [];
        list.push({ unit: c.unit, amount: Math.round(c.amount * 100) / 100, metered: c.metered });
        costByBrane.set(c.brane_id, list);
      }
      const branes = rows
        .filter((r) => includeArchived || !hidden.has(r.brane_id))
        .map((r) => ({
          ...r,
          is_home: r.brane_id === braneId,
          archived: hidden.has(r.brane_id),
          cost: costByBrane.get(r.brane_id) ?? [],
        }));
      sendJson(res, 200, { branes });
      return;
    }

    // Route: PATCH /api/branes/archive  { brane_id, archived }
    // Hide a brane, or bring it back. Refused for the home brane and for the
    // last brane not already archived (src/db/branes.ts). The operator's act:
    // not in AGENT_ROUTES.
    if (path === "/api/branes/archive" && req.method === "PATCH") {
      parseBody(req).then((body) => {
        let target: unknown, archived: unknown;
        try {
          ({ brane_id: target, archived } = JSON.parse(body));
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (typeof target !== "string" || target.trim() === "") {
          sendJson(res, 400, { error: "brane_id is required" });
          return;
        }
        if (typeof archived !== "boolean") {
          sendJson(res, 400, { error: "archived must be true or false" });
          return;
        }
        const refusal = braneArchiveRefusal(db, target, archived, braneId);
        if (refusal) {
          sendJson(res, refusal.status, { error: refusal.error });
          return;
        }
        setBraneArchived(db, target, archived);
        sendJson(res, 200, { brane_id: target, archived });
      }).catch((err) => {
        sendJson(res, 400, { error: String(err) });
      });
      return;
    }

    // Route: GET /api/folds?archived=1
    // Archived folds are hidden from the spawn dropdown by default; pass
    // archived=1 to include them (for the "show hidden" affordance).
    if (path === "/api/folds" && req.method === "GET") {
      const includeArchived = url.searchParams.get("archived") === "1";
      const folds = includeArchived
        ? db.prepare("SELECT * FROM folds ORDER BY created_at DESC").all()
        : db
            .prepare("SELECT * FROM folds WHERE archived = 0 OR archived IS NULL ORDER BY created_at DESC")
            .all();
      sendJson(res, 200, { folds });
      return;
    }

    // Route: POST /api/folds  { path, brane_id? }
    // Register a directory as a fold (spawn point). One implementation for
    // the app's "add a spawn point" affordance and for `brane fold`, which
    // is a client of this route. Accepts an absolute path or a ~/portable
    // path. Idempotent: re-adding an existing fold un-archives it (so "add"
    // doubles as "unhide") and, with `brane_id`, rebinds it. A remote client
    // is confined to `$HOME`; a loopback caller — the operator's own shell —
    // keeps full reach. See `registerFold`.
    if (path === "/api/folds" && req.method === "POST") {
      parseBody(req).then((body) => {
        let rawPath: unknown, braneId: unknown;
        try {
          ({ path: rawPath, brane_id: braneId } = JSON.parse(body));
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (typeof rawPath !== "string" || rawPath.trim() === "") {
          sendJson(res, 400, { error: "path is required" });
          return;
        }
        if (braneId !== undefined && (typeof braneId !== "string" || braneId.trim() === "")) {
          sendJson(res, 400, { error: "brane_id must be a non-empty string" });
          return;
        }
        try {
          const { fold, created } = registerFold(db, rawPath, {
            braneId: braneId as string | undefined,
            confineToHome: !isLoopbackRequest(req),
          });
          sendJson(res, created ? 201 : 200, { fold, created });
        } catch (err) {
          if (err instanceof FoldRegistrationError) {
            sendJson(res, err.status, { error: err.message });
            return;
          }
          throw err;
        }
      }).catch((err) => {
        sendJson(res, 400, { error: String(err) });
      });
      return;
    }

    // Route: PATCH /api/folds/archive  { path, archived }
    // Soft-hide (or unhide) a fold. Never deletes the row — "prune" is archival,
    // so spawn history and the fold's brane binding are preserved and reversible.
    if (path === "/api/folds/archive" && req.method === "PATCH") {
      parseBody(req).then((body) => {
        let rawPath: unknown, archived: unknown;
        try {
          ({ path: rawPath, archived } = JSON.parse(body));
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (typeof rawPath !== "string" || rawPath.trim() === "") {
          sendJson(res, 400, { error: "path is required" });
          return;
        }
        // Match whatever representation the row is stored as. The client echoes
        // the stored path verbatim (from GET), so an exact match on the raw input
        // is primary; we also try the portable/absolute normalizations so a
        // legacy row stored as an absolute path (rather than ~/portable) still
        // resolves. Matching only the normalized form silently failed on such
        // rows (UPDATE hit 0 → 404 → client reverted → fold never hid).
        const raw = rawPath.trim();
        const candidates = new Set<string>([raw]);
        try {
          const abs = resolve(fromPortablePath(raw));
          candidates.add(abs);
          candidates.add(toPortablePath(abs));
        } catch {
          /* leave candidates as the raw value */
        }
        const list = [...candidates];
        const result = db
          .prepare(`UPDATE folds SET archived = ? WHERE path IN (${list.map(() => "?").join(", ")})`)
          .run(archived ? 1 : 0, ...list);
        if (result.changes === 0) {
          sendJson(res, 404, { error: `Not a fold: ${raw}` });
          return;
        }
        sendJson(res, 200, { path: raw, archived: !!archived });
      }).catch((err) => {
        sendJson(res, 400, { error: String(err) });
      });
      return;
    }

    // Route: GET /api/spawn-history
    // Returns recently-used launch_args strings (JSON-encoded string[]),
    // deduplicated, most-recent first. Used by the spawn dialog to offer
    // recent CLI args as quick-fill choices.
    if (path === "/api/spawn-history" && req.method === "GET") {
      const rows = db.prepare(
        `SELECT launch_args, MAX(created_at) AS last_used, COUNT(*) AS use_count
         FROM narratives
         WHERE launch_args IS NOT NULL AND launch_args != ''
         GROUP BY launch_args
         ORDER BY last_used DESC
         LIMIT 20`,
      ).all() as Array<{ launch_args: string; last_used: number; use_count: number }>;
      const history = rows.flatMap((r) => {
        try {
          const args = JSON.parse(r.launch_args);
          if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return [];
          return [{ args, last_used: r.last_used, use_count: r.use_count }];
        } catch {
          return [];
        }
      });
      sendJson(res, 200, { history });
      return;
    }

    // Route: GET /api/run-history
    // The spawn dialog's Utility list — see runHistory() beside doRun.
    if (path === "/api/run-history" && req.method === "GET") {
      sendJson(res, 200, { history: runHistory(db) });
      return;
    }

    // Route: POST /api/spawn
    if (path === "/api/spawn" && req.method === "POST") {
      parseBody(req).then(async (body) => {
        const { agent, role, model, re, fold_path, extra_args, terminal_size } = JSON.parse(body);
        if (!agent) {
          sendJson(res, 400, { error: "agent is required" });
          return;
        }
        if (!fold_path) {
          sendJson(res, 400, { error: "fold_path is required" });
          return;
        }
        let extraArgs: string[] | undefined;
        if (extra_args !== undefined && extra_args !== null) {
          if (!Array.isArray(extra_args) || !extra_args.every((a) => typeof a === "string")) {
            sendJson(res, 400, { error: "extra_args must be an array of strings" });
            return;
          }
          if (extra_args.length > 0) extraArgs = extra_args;
        }
        await ensureTmux();
        // Start at the requesting viewer's grid when it sent one: a session
        // resized right after launch redraws at each width, and the stale
        // frames land in the scrollback the mirror shows.
        const terminalSize = parseTerminalSize(terminal_size) ?? lastTerminalSize ?? undefined;
        const result = doSpawn({ db, agent, role, model, re, foldPath: fold_path, extraArgs, terminalSize });
        recordLauncher(db, result.narrativeId, auth.record.id);
        const connectedNids = mcpConnectedNids(mcpClients);
        sendJson(res, 200, {
          narrative: {
            id: result.narrativeId,
            status: "active",
            agent_type: result.agentType,
            role: result.role,
            fold_path: result.foldPath,
            created_at: Date.now(),
            mcp_connected: connectedNids.has(result.narrativeId),
          },
        });
      }).catch((err) => {
        // Unwrap to the bare message: this string is what both the web app's
        // spawn dialog and `brane spawn` print, so "Not a fold: ~/x. Run
        // `brane fold` first." should not arrive prefixed with "Error: ".
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    // Route: POST /api/run
    if (path === "/api/run" && req.method === "POST") {
      parseBody(req).then(async (body) => {
        const { command, fold_path, terminal_size } = JSON.parse(body);
        if (!command || !Array.isArray(command) || command.length === 0) {
          sendJson(res, 400, { error: "command is required (array of strings)" });
          return;
        }
        if (!fold_path) {
          sendJson(res, 400, { error: "fold_path is required" });
          return;
        }
        await ensureTmux();
        const terminalSize = parseTerminalSize(terminal_size) ?? lastTerminalSize ?? undefined;
        const result = doRun({ db, command, foldPath: fold_path, terminalSize });
        recordLauncher(db, result.narrativeId, auth.record.id);
        sendJson(res, 200, {
          narrative: {
            id: result.narrativeId,
            status: "active",
            agent_type: result.command[0].replace(/^.*\//, ""),
            role: "utility",
            fold_path: result.foldPath,
            created_at: Date.now(),
            mcp_connected: false,
          },
        });
      }).catch((err) => {
        sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    // Route: POST /api/revive/:nid
    const reviveMatch = path.match(/^\/api\/revive\/([^/]+)$/);
    if (reviveMatch && req.method === "POST") {
      const nid = reviveMatch[1];
      parseBody(req).then(async (body) => {
        const { prompt, no_prompt, agent } = body ? JSON.parse(body) : {} as Record<string, unknown>;
        try {
          await ensureTmux();
          const result = reviveNarrative(db, nid, {
            prompt: prompt as string,
            no_prompt: no_prompt as boolean,
            agent: agent as string | undefined,
            byAgent: auth.record.kind === "agent",
          });
          // The narrative actually launched: an agent switch continues as a new one.
          recordLauncher(db, result.nid ?? nid, auth.record.id);
          sendJson(res, 200, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const status = msg.startsWith("Unknown narrative") ? 404 : msg === AGENT_REVIVE_REFUSAL ? 403 : 500;
          sendJson(res, status, { error: msg });
        }
      }).catch((err) => {
        sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    // Route: POST /api/tokens — mint a device token. The daemon keeps only
    // the hash, so this response is the one and only copy: `brane meld` calls
    // it for every QR it prints, which is what gives each device its own
    // token, revocable alone.
    if (path === "/api/tokens" && req.method === "POST") {
      const signal = whileConnected(res);
      parseBody(req).then(async (body) => {
        const answer = await gatedMintRoute({ gate: presenceGate, ring: tokenRing }, gateCaller(auth.record, req), body, signal);
        if (answer.status === 200) {
          console.log(`[token] minted device token "${(answer.body as { label: string }).label}" for ${connectionLabel(req.socket) ?? "?"}`);
        }
        sendAnswer(res, answer);
      }).catch((err) => {
        if (!res.headersSent) sendJson(res, 400, { error: String(err) });
      });
      return;
    }

    // Route: POST /api/tokens/remote — a device token and its hash for a
    // daemon on another machine (`brane meld --remote`). Stores nothing; gated
    // like a local meld, so the remote path asks what `brane meld` asks.
    if (path === "/api/tokens/remote" && req.method === "POST") {
      const signal = whileConnected(res);
      gatedRemoteMintRoute({ gate: presenceGate }, gateCaller(auth.record, req), signal).then((answer) => {
        if (answer.status === 200) console.log(`[token] minted a device token for a remote daemon for ${connectionLabel(req.socket) ?? "?"}; kept nothing`);
        sendAnswer(res, answer);
      }).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    // Route: GET /api/tokens — the Devices list: every live token, with
    // where it was first presented from and whether it is the requester.
    if (path === "/api/tokens" && req.method === "GET") {
      const listed = listTokensRoute(tokenStore, auth.record, Date.now(), new Set([...viewerSockets.values()].flat()), {
        labelOf: (id) => credentialStore.labelOf(id),
        gated: verificationGate.config().mode !== "off",
      });
      sendJson(res, listed.status, listed.body);
      return;
    }

    // Route: POST /api/tokens/:id/revoke — revoke one device, and close the
    // sockets it opened with 4401 so it shows "signed out" at once. Bodiless.
    const revokeMatch = /^\/api\/tokens\/([^/]+)\/revoke$/.exec(path);
    if (revokeMatch && req.method === "POST") {
      let id: string;
      try {
        id = decodeURIComponent(revokeMatch[1]);
      } catch {
        sendJson(res, 400, { error: "Bad token id" });
        return;
      }
      // `?also=a,b`: devices it added, to revoke with it. In the query string,
      // not a body, so the request stays bodiless and needs no preflight.
      const also = (url.searchParams.get("also") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      // Planned before any prompt, gated only when it signs out a device,
      // and checked again after (src/daemon/gated-routes.ts).
      gatedRevokeRoute({ gate: presenceGate, ring: tokenRing, store: tokenStore }, gateCaller(auth.record, req), id, also, whileConnected(res))
        .then((answer) => {
          const revoked = answer.revoked;
          if (revoked?.status === 200) {
            const closed = closeSocketsOf(viewerSockets, revoked.body.ids);
            console.log(
              `[token] revoked ${revoked.body.kind} token "${revoked.body.label}"` +
                (revoked.body.also.length ? ` and ${revoked.body.also.length} token(s) it added` : "") +
                ` from ${connectionLabel(req.socket) ?? "?"}; ` +
                `signed out ${closed} viewer socket(s)` +
                (revoked.body.abandonedRotation ? "; abandoned the rotation it had begun" : ""),
            );
          }
          sendAnswer(res, answer);
        })
        .catch((err) => {
          if (!res.headersSent) sendJson(res, 500, { error: String(err) });
        });
      return;
    }


    // Route: POST /api/daemon/restart — restart in place. The daemon starts
    // its own successor (its own node, script and arguments, never ones the
    // request names), which therefore inherits this daemon's environment and
    // whatever confinement it runs under, not the caller's: a restart from an
    // agent's sandboxed shell or from VS Code gives agents the same freedoms
    // the operator's own `brane daemon start` did. The claim passes straight
    // to the successor, so no bridge sees a moment without a daemon. Not for
    // a device: from a phone, a utility session's shell can run
    // `brane daemon restart`. Body `{ port? }`, answered 202 `{ pid }`
    // before shutdown begins; src/daemon/lifecycle.ts.
    if (path === "/api/daemon/restart" && req.method === "POST") {
      if (auth.record.kind === "device") {
        sendJson(res, 403, { error: "Restart the daemon from this machine: `brane daemon restart`" });
        return;
      }
      const onFly = restartRefusal(process.env);
      if (onFly) {
        sendJson(res, 409, { error: onFly });
        return;
      }
      parseBody(req).then((body) => {
        const currentPort = (db.prepare("SELECT value FROM meta WHERE key = 'daemon_port'").get() as { value: string } | undefined)?.value;
        const decided = restartPort(body, currentPort, auth.record.kind);
        if ("error" in decided) {
          sendJson(res, decided.status, { error: decided.error });
          return;
        }
        const { port } = decided;
        console.log(`[restart] in place, on port ${port}, asked by ${auth.record.kind === "agent" ? `agent ${auth.record.label}` : "this account"}`);
        res.on("finish", () => setImmediate(() => doShutdown({ port })));
        sendJson(res, 202, { pid: process.pid, port });
      });
      return;
    }

    // Route: POST /api/token/forget — this device signs itself out, for the
    // app's "Delete permanently" (src/daemon/token-routes.ts). Bodiless. Its
    // sockets close after the answer is on its way.
    if (path === "/api/token/forget" && req.method === "POST") {
      const answer = forgetSelfRoute(tokenStore, tokenRing, auth.record);
      sendJson(res, answer.status, answer.body);
      if (answer.status === 200) {
        const closed = closeSocketsOf(viewerSockets, answer.body.ids);
        console.log(
          `[token] device "${answer.body.label}" signed itself out from ${connectionLabel(req.socket) ?? "?"}; ` +
            `closed ${closed} viewer socket(s)` +
            (answer.body.abandonedRotation ? "; abandoned the rotation it had begun" : ""),
        );
      }
      return;
    }

    // Route: POST /api/token/rotate — "sign out other devices". For a device
    // it mints a pending token and returns it; nothing else changes until a
    // request presents that token, which is when the requester's old token
    // and every other device token are revoked (their viewer sockets closed
    // with 4401). For this account (the shell on daemon.sock), which holds no
    // token to swap, every device is signed out in this one request.
    // A pending token nobody uses lapses after ROTATION_GRACE_MS, so a lost
    // response leaves everything as it was. A second call within the window
    // *replaces* the pending token rather than re-issuing it — the old-token
    // holder this exists to evict can call this route too, and must never be
    // handed the new credential. A replacement before use is therefore worth
    // a loud log line: it is either an operator double-tap or someone racing.
    if (path === "/api/token/rotate" && req.method === "POST") {
      // Agents get 403; anyone else but a device waits for the presence
      // check, which comes before `beginRotation` (src/daemon/gated-routes.ts).
      gatedRotateRoute({ gate: presenceGate, ring: tokenRing }, gateCaller(auth.record, req), whileConnected(res))
        .then((answer) => {
          const rotation = answer.rotation;
          if (rotation) {
            const remote = connectionLabel(req.socket) ?? "?";
            if (rotation.replaced) {
              console.warn(`[token] pending rotation REPLACED before use, by a rotate from ${remote}`);
            }
            console.log(
              `[token] rotation begun from ${remote}; ` +
                `old token stays valid until first use of the new one or ${new Date(rotation.expiresAt).toISOString()}`,
            );
          }
          if (answer.signedOut) {
            const closed = closeSocketsOf(viewerSockets, answer.signedOut.ids, "token rotated");
            if (answer.signedOut.replaced) {
              console.warn("[token] a pending rotation was voided by this machine signing out every device");
            }
            console.log(
              `[token] this machine (${connectionLabel(req.socket) ?? "?"}) signed out every device: ` +
                `revoked ${answer.signedOut.ids.length} token(s), signed out ${closed} viewer socket(s)`,
            );
          }
          sendAnswer(res, answer);
        })
        .catch((err) => {
          if (!res.headersSent) sendJson(res, 500, { error: String(err) });
        });
      return;
    }


    // Route: POST /api/verify/begin — an approval for this device's own
    // token, for the ceremony page. Free, bodiless: the token it is bound to
    // is the one this request authenticated with, never one a body names.
    if (path === "/api/verify/begin" && req.method === "POST") {
      sendAnswer(res, ceremonies.begin(auth.record.id, "verify"));
      return;
    }

    // Route: POST /api/credentials/begin — an approval to enroll a credential.
    // The enroll act: fresh class, so with the gate on an existing credential
    // approves every new one. Bodiless.
    if (path === "/api/credentials/begin" && req.method === "POST") {
      sendAnswer(res, ceremonies.begin(auth.record.id, "enroll"));
      return;
    }

    // Route: GET /api/credentials — the enrolled credentials, no key material,
    // and the host they must be enrolled for, so the list can mark the ones
    // a rename orphaned.
    if (path === "/api/credentials" && req.method === "GET") {
      sendJson(res, 200, { credentials: credentialStore.list(), rp_id: relyingParty()?.rpId ?? null });
      return;
    }

    // Route: POST /api/credentials/:id/revoke — the credential can no longer
    // verify. An act (revoke-credential, fresh class); revoked, never deleted.
    const credRevoke = path.match(/^\/api\/credentials\/([^/]+)\/revoke$/);
    if (credRevoke && req.method === "POST") {
      const answer = revokeCredentialRoute(credentialStore, auth.record, decodeURIComponent(credRevoke[1]));
      if (answer.status === 200) console.log(`[verification] credential ${credRevoke[1]} revoked by ${auth.record.kind} "${auth.record.label}"`);
      sendAnswer(res, answer);
      return;
    }

    // Route: POST /api/verify/end — the app went to the background, or the
    // operator locked it: this device's window ends now. Free, bodiless, and
    // a no-op for anything but a device token.
    if (path === "/api/verify/end" && req.method === "POST") {
      const ended = auth.record.kind === "device" ? tokenStore.endVerification(auth.record.id) : false;
      sendJson(res, 200, { ended });
      return;
    }

    // Route: POST /api/presence/cancel?id= — close the presence prompt that
    // is up. Only a device may (src/daemon/gated-routes.ts); there is no
    // approve. Bodiless, like every app request that can be.
    if (path === "/api/presence/cancel" && req.method === "POST") {
      const id = url.searchParams.get("id") ?? undefined;
      const answer = cancelPresenceRoute(presenceGate, auth.record, id);
      if ((answer.body as { canceled?: boolean }).canceled) {
        console.log(`[presence] prompt ${id ?? "(current)"} canceled by device "${auth.record.label}"`);
      }
      sendAnswer(res, answer);
      return;
    }


    // Route: POST /api/cost/backfill — sweep the usage ledger over every
    // narrative with a bound session. Runs here rather than in the CLI because
    // the readers resolve transcripts against the daemon's HOME and memoize
    // in the daemon's process, exactly like the 20s sampler.
    if (path === "/api/cost/backfill" && req.method === "POST") {
      parseBody(req).then((body) => {
        const { dry_run } = body ? (JSON.parse(body) as { dry_run?: boolean }) : {};
        const result = backfillCostLedger(db, { dryRun: !!dry_run });
        if (!dry_run) {
          for (const s of result.samples) {
            if (s.after !== null && s.after !== s.before) {
              broadcastMeta(controlClients, s.nid, { cost_amount: s.after, cost_unit: s.unit });
            }
          }
        }
        sendJson(res, 200, { dry_run: !!dry_run, ...result });
      }).catch((err) => {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    // Route: POST /api/cost/reprice — re-price recorded ledger rows under the
    // current table (src/cost/reprice.ts). The one path that rewrites a
    // ledger amount, so it runs only when the operator asks; never at startup.
    if (path === "/api/cost/reprice" && req.method === "POST") {
      parseBody(req).then((body) => {
        const { dry_run } = body ? (JSON.parse(body) as { dry_run?: boolean }) : {};
        const result = repriceLedger(db, { dryRun: !!dry_run });
        if (!dry_run) {
          for (const n of result.narratives) {
            if (n.column_after !== null && n.column_after !== n.column_before) {
              broadcastMeta(controlClients, n.nid, { cost_amount: n.column_after, cost_unit: "USD" });
            }
          }
          console.log(
            `[cost] repriced ${result.changed} ledger rows across ${result.narratives.length} narratives` +
              ` (${result.recovered} cache splits recovered, ${result.unrecoverable} unrecoverable)`,
          );
        }
        sendJson(res, 200, result);
      }).catch((err) => {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    // Route: GET /api/absorb/survey — the inventory a bare `brane absorb`
    // prints: every session store brane can look for under the daemon's
    // HOME, with per-session counts (new / changed / unchanged / managed)
    // for the ones it can read. Reads no message content and writes
    // nothing; the operator's "what would this do" before any import.
    if (path === "/api/absorb/survey" && req.method === "GET") {
      try {
        sendJson(res, 200, surveyAbsorbSources(db, process.env.HOME!));
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Route: POST /api/absorb — import conversation history; `brane absorb`
    // is a client. Runs here for the reason backfill does: payloads, the
    // organelle search.db and the niche registry all resolve against the
    // daemon's HOME. The response is NDJSON, one `AbsorbEvent` per line, so
    // a long import shows progress rather than a hung request. Input errors
    // are answered as a plain 400 before the stream opens; a failure after
    // that ends the stream with an `error` line.
    if (path === "/api/absorb" && req.method === "POST") {
      parseBody(req).then(async (body) => {
        let request: AbsorbRequest;
        try {
          request = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!request || typeof request.provider !== "string") {
          sendJson(res, 400, { error: "provider is required" });
          return;
        }
        let streaming = false;
        let lastProgressAt = 0;
        const emit = (event: AbsorbEvent) => {
          if (event.type === "progress") {
            const now = Date.now();
            if (now - lastProgressAt < ABSORB_PROGRESS_INTERVAL_MS) return;
            lastProgressAt = now;
          }
          if (!streaming) {
            streaming = true;
            res.writeHead(200, {
              "Content-Type": "application/x-ndjson",
              "Cache-Control": "no-cache",
            });
          }
          res.write(JSON.stringify(event) + "\n");
        };
        try {
          const summary = await runAbsorb(db, request, emit, { confineFoldsToHome: !isLoopbackRequest(req) });
          res.end();
          // Search should work right after an import, not after the next
          // 5-minute background tick. Not awaited: the operator has their
          // summary; the pass is the daemon's business.
          if (!request.dry_run && summary.conversations + summary.appended > 0) {
            memoryIndexer?.run(false).catch((err) => {
              console.error("post-absorb memory indexing failed:", err);
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (streaming) {
            res.write(JSON.stringify({ type: "error", error: message }) + "\n");
            res.end();
          } else {
            const status =
              err instanceof AbsorbInputError || err instanceof FoldRegistrationError ? err.status : 500;
            sendJson(res, status, { error: message });
          }
        }
      }).catch((err) => {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    // Route: POST /api/memory/index { rebuild? } — `brane memory index`.
    // Goes through the daemon's own indexer handle, so it queues behind an
    // inflight background pass instead of racing it on the same cursors,
    // and it uses the embedding model the daemon already has warm.
    if (path === "/api/memory/index" && req.method === "POST") {
      parseBody(req).then(async (body) => {
        let rebuild: unknown;
        try {
          ({ rebuild } = body ? (JSON.parse(body) as { rebuild?: unknown }) : {});
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!memoryIndexer) {
          sendJson(res, 503, { error: "memory indexer is not running" });
          return;
        }
        const stats = await memoryIndexer.run(!!rebuild);
        sendJson(res, 200, { rebuild: !!rebuild, ...stats });
      }).catch((err) => {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    // Route: POST /api/search
    if (path === "/api/search" && req.method === "POST") {
      parseBody(req).then(async (body) => {
        const { query, limit, brane_ids } = JSON.parse(body);
        if (!query) {
          sendJson(res, 400, { error: "query is required" });
          return;
        }

        initMemorySchema(db);

        const queryVector = await embedText(query);
        const results = searchHybrid(db, queryVector, query, limit ?? 10, brane_ids);
        // Where each hit matched, so the app can mark it in the snippet. The
        // MCP tool leaves these out: an agent reads the whole content anyway.
        const matches = narrativeMatchRanges(db, query, results);

        // Collect unique narrative IDs and fetch their metadata
        const nids = [...new Set(results.map((r) => r.narrative_id))];
        const connectedNids = mcpConnectedNids(mcpClients);
        const narrativeMap = new Map<string, NarrativeRow>();
        for (const nid of nids) {
          const row = db.prepare("SELECT * FROM narratives WHERE id = ?").get(nid) as NarrativeRow | undefined;
          if (row) narrativeMap.set(nid, row);
        }

        sendJson(res, 200, {
          query,
          results: results.map((r) => ({
            narrative_id: r.narrative_id,
            seq: r.seq,
            content: r.content,
            score: Math.round(r.score * 100) / 100,
            matches: matches.get(`${r.narrative_id}:${r.seq}`) ?? [],
          })),
          narratives: nids
            .filter((nid) => narrativeMap.has(nid))
            .map((nid) => {
              const n = narrativeMap.get(nid)!;
              return { ...n, mcp_connected: connectedNids.has(nid) };
            }),
        });
      }).catch((err) => {
        sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    // Route: GET /api/protocols
    // The protocol library, for clients that need to know which `/command`
    // names exist — the chat linkifier only links commands that resolve.
    // `?nid=` scopes it to that narrative's fold, through the same resolver its
    // `read_protocol` uses, so the chat links exactly what the agent can read.
    if (path === "/api/protocols" && req.method === "GET") {
      sendJson(res, 200, listProtocols(protocolLibraryFor(db, url.searchParams.get("nid")), toPortablePath));
      return;
    }

    // Route: GET /api/protocols/pending
    // Every `home` and `fold` protocol file awaiting the operator's approval,
    // with its text (and, when it changed, the text approved before), and
    // every live approval. docs/protocols.md#approval.
    if (path === "/api/protocols/pending" && req.method === "GET") {
      sendJson(res, 200, protocolApprovalsReport(db, protocolApprovalScope(db)));
      return;
    }

    // Route: POST /api/protocols/approve { path, sha256 }
    // Put a `home` or `fold` protocol file in force, pinned to the text the
    // operator read. Agents never (off AGENT_ROUTES); a device through the
    // verification gate; this machine's shell after the presence check.
    if (path === "/api/protocols/approve" && req.method === "POST") {
      const signal = whileConnected(res);
      parseBody(req)
        .then(async (raw) => {
          const request = approvalRequest(raw, url.searchParams);
          if ("error" in request) {
            sendJson(res, 400, { error: request.error });
            return;
          }
          const body = request.body;
          const caller = gateCaller(auth.record, req);
          const answer = await approveProtocolRoute(
            { db, gate: presenceGate, scope: protocolApprovalScope(db) },
            caller,
            body,
            signal,
          );
          if (answer.status === 200) {
            console.log(`[protocols] ${caller.by} approved ${(answer.body as { path: string }).path}`);
          }
          sendAnswer(res, answer);
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return;
    }

    // Route: POST /api/protocols/revoke { path }
    // Withdraw an approval: the file is ignored again until re-approved.
    if (path === "/api/protocols/revoke" && req.method === "POST") {
      parseBody(req)
        .then((raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw || "{}");
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const answer = revokeProtocolRoute({ db, scope: protocolApprovalScope(db) }, body);
          if (answer.status === 200) {
            console.log(`[protocols] ${gateCaller(auth.record, req).by} revoked approval of ${(answer.body as { path: string }).path}`);
          }
          sendAnswer(res, answer);
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return;
    }

    // Route: POST /api/wiki/search
    // Wiki semantic search for the web client. No caller narrative, so sources
    // are resolved from the active brane(s) (package wiki + that brane's folds).
    if (path === "/api/wiki/search" && req.method === "POST") {
      parseBody(req).then(async (body) => {
        const { query, limit, brane_ids } = JSON.parse(body);
        if (!query) {
          sendJson(res, 400, { error: "query is required" });
          return;
        }
        const sources = resolveWikiSourcesForBranes(db, brane_ids);
        const results = await searchWiki(db, sources, query, limit ?? 10);
        sendJson(res, 200, { query, results });
      }).catch((err) => {
        sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    // Route: GET /api/wiki/read
    // Neighbor-aware section read: returns one section's content plus a window
    // of the surrounding headings (prev/next) so a reader can walk the page.
    // Params: slug (required), source?, anchor?, window?, brane_ids? (csv),
    // nid? (adds that narrative's fold protocols as source `protocols:fold`).
    if (path === "/api/wiki/read" && req.method === "GET") {
      try {
        const slug = url.searchParams.get("slug");
        if (!slug) {
          sendJson(res, 400, { error: "slug is required" });
          return;
        }
        const braneIdsParam = url.searchParams.get("brane_ids");
        const braneIds = braneIdsParam ? braneIdsParam.split(",").filter(Boolean) : undefined;
        const sources = resolveReadableSourcesForBranes(db, braneIds, url.searchParams.get("nid"));

        let source = url.searchParams.get("source") ?? undefined;
        if (!source) {
          // Auto-resolve when the slug is unambiguous across reachable sources,
          // mirroring handleReadWiki.
          const haystack = sources.filter((s) => locatePage(s, slug).status !== "missing");
          if (haystack.length === 1) {
            source = haystack[0].source;
          } else if (haystack.length > 1) {
            sendJson(res, 400, {
              error: `Page "${locatePage(haystack[0], slug).filename}" exists in multiple sources: ${haystack
                .map((s) => s.source)
                .join(", ")}. Pass "source" to disambiguate.`,
            });
            return;
          } else {
            source = installWikiLabel(sources);
          }
        }

        const anchor = url.searchParams.get("anchor") ?? undefined;
        const windowParam = url.searchParams.get("window");
        const window = windowParam != null ? Number(windowParam) : undefined;
        const result = readWikiSection(sources, source, slug, { anchor, window });
        if (result && typeof result === "object" && "error" in result) {
          sendJson(res, 404, { error: String((result as { error: string }).error) });
        } else {
          sendJson(res, 200, result);
        }
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // Route: GET /api/wiki/asset?source=&path=&brane_ids=
    // Serves a binary asset (e.g. an image) from within a wiki source dir,
    // traversal-confined to that dir, so relative images in wiki pages render.
    if (path === "/api/wiki/asset" && req.method === "GET") {
      try {
        const sourceLabel = url.searchParams.get("source");
        const relParam = url.searchParams.get("path") ?? "";
        if (!sourceLabel || !relParam) {
          sendJson(res, 400, { error: "source and path are required" });
          return;
        }
        const braneIdsParam = url.searchParams.get("brane_ids");
        const braneIds = braneIdsParam ? braneIdsParam.split(",").filter(Boolean) : undefined;
        const src = resolveReadableSourcesForBranes(db, braneIds, url.searchParams.get("nid")).find((s) => s.source === sourceLabel);
        if (!src) {
          sendJson(res, 404, { error: `Unknown wiki source: ${sourceLabel}` });
          return;
        }
        if (relParam.startsWith("/") || relParam.startsWith("\\")) {
          sendJson(res, 400, { error: "Absolute paths not allowed" });
          return;
        }
        const root = resolve(src.dir);
        const target = resolve(root, relParam.split("#")[0].split("?")[0]);
        if (target !== root && !target.startsWith(root + "/")) {
          sendJson(res, 400, { error: "Path escapes wiki source" });
          return;
        }
        readFile(target).then((data) => {
          res.writeHead(200, {
            "Content-Type": MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
            "Cache-Control": "no-cache",
          });
          res.end(data);
        }).catch((err) => {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") sendJson(res, 404, { error: "Not found" });
          else sendJson(res, 500, { error: String(err) });
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // Unknown API route
    sendJson(res, 404, { error: "Not found" });
  };

  // Create one primary server per bind address — all share the same
  // request handler and upgrade logic. Node's http.Server.listen() can only
  // be called once per instance, so multi-address binding requires N
  // instances on the same port (different IPs). The kernel routes each
  // inbound connection to the instance bound to its destination IP.
  const tlsOpts = tls
    ? { cert: readFileSync(getTlsCertPath()), key: readFileSync(getTlsKeyPath()) }
    : undefined;
  currentTlsOpts = tlsOpts;
  noteRpId?.();
  // `tls` decides the protocol for the daemon's whole life; `currentTlsOpts`
  // supplies only the cert material. Keying the protocol on the latter would
  // let a listener created after a blind-start cert provision come up HTTPS
  // beside loopback listeners still speaking HTTP (claude-9o0vgfvb:22, #9).
  // `tls === true` implies `tlsOpts` was read from disk above, so
  // `currentTlsOpts` is always set on this branch.
  const createPrimary = () =>
    tls ? createHttpsServer(currentTlsOpts!, requestHandler) : createHttpServer(requestHandler);
  const servers = bindAddresses.map(() => createPrimary());

  // When running HTTPS, also start an HTTP fallback per bind address for
  // local/LAN access (TLS certs are only valid for the Tailscale hostname,
  // not raw IPs). HTTP fallbacks are restricted to private/local IPs only
  // via both kernel-level binding and the userspace IP filter.
  const httpServers: Array<ReturnType<typeof createHttpServer>> = [];
  const httpIpFilter = tls ? (isAllowedConnection ?? buildPrivateIpFilter()) : null;
  if (tls) {
    for (let i = 0; i < bindAddresses.length; i++) {
      httpServers.push(createHttpServer(requestHandler));
    }
  }


  // WebSocket upgrade handling — attached to every server (primary + HTTP fallback)
  // so the handler runs against whichever listener accepted the connection.
  const upgradeHandler = (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `${tls ? "https" : "http"}://localhost:${port}`);
    const path = url.pathname;
    // Auth check
    const presented = extractToken(req, url);
    const auth = authenticate(presented, req);
    if (!auth) {
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!auth.ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (refuseAgent(auth.record, req, path)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    // The control and terminal upgrades are free (each message is judged on
    // its own below); `/ws/mcp` places its own check, since a reconnect that
    // presents its secret is an agent, not a mint.
    if (path !== "/ws/mcp" && verificationGate.refuseRoute(auth.record, "GET", path)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (auth.retired) finishRotation({ retired: auth.retired });
    // No Origin check: the token above is the credential, and the origin it
    // was presented from is now on its row for the Devices list to show
    // (`authenticateRequest`). Every browser sends one on an upgrade, so
    // this is the request that names which copy of the app a device runs.

    // WS: /ws/control — single real-time channel
    if (path === "/ws/control") {
      controlWss.handleUpgrade(req, socket, head, (ws) => {
        trackViewerSocket(ws, socketOwners("control", auth.record));
        handleControlSocket(ws, auth.record, db, controlClients, mcpClients, notifyListenWaiters, recordEventMentions, awaiting, presenceGate.current(), verificationGate);
        // The last sleep's agents come back when an operator connects, not
        // when the host wakes (src/daemon/sleep.ts, ManifestRestorer).
        if (manifestRestorer.onConnect(auth.record.kind)) console.log(`[sleep] an operator connected (${auth.record.kind}); restoring the manifest`);
        // The idle rule's clock. handleControlSocket added the client and
        // registered its own close listener first, so by the time this one
        // runs the set no longer holds it.
        sleeper.clientsChanged(controlClients.size);
        ws.on("close", () => sleeper.clientsChanged(controlClients.size));
      });
      return;
    }

    // WS: /ws/mcp — MCP bridge connections (agents)
    if (path === "/ws/mcp") {
      const nid = url.searchParams.get("nid");
      if (!nid) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      const agentSession = url.searchParams.get("session") ?? undefined;
      const bindSecret = url.searchParams.get("secret") ?? undefined;
      const remoteAddr = connectionLabel(req.socket) ?? "unknown";
      // A client-supplied nid that names an existing narrative is only trusted
      // when the connection also presents the secret matching that narrative's
      // bind_token (resolveMcpBind). This blocks a crossed BRANE_NARRATIVE_ID
      // from binding as a narrative it doesn't own. Unknown nids are unspawned
      // clients — their self-chosen id is discarded for a fresh server-minted
      // one. Either way the bridge adopts the effective id from `welcome`.
      //
      // resolveMcpBind runs synchronous INSERTs here, in the upgrade handler's
      // call stack. A throw (e.g. SQLITE_BUSY under write contention) would
      // otherwise be an unhandled exception in this event listener — blast
      // radius the whole daemon — and would also leak the raw socket. Contain
      // it: tear down just this connection and move on.
      try {
        // An agent token is its own proof of which narrative it is: it may
        // bind as its owner and nothing else. A bridge presenting one for a
        // different nid is refused outright, never minted a fresh narrative,
        // which would hand a revocable credential a way around its own row.
        if (auth.record.kind === "agent") {
          if (!auth.record.ownerNid || nid !== auth.record.ownerNid) {
            console.error(`[mcp-ws] agent token for ${auth.record.ownerNid ?? "?"} claimed ${nid}; refused (remote=${remoteAddr})`);
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }
          const ownNid = auth.record.ownerNid;
          mcpWss.handleUpgrade(req, socket, head, (ws) => {
            trackViewerSocket(ws, socketOwners("mcp", auth.record));
            handleMcpBridgeSocket(ws, db, braneId, mcpClients, controlClients, ownNid, listenWaiters, settleOwnCall, crushToolSampler, copilotToolSampler, codexToolSampler, notifyListenWaiters, recordEventMentions, agentSession, awaiting);
          });
          return;
        }
        // A device dialing with no valid secret is about to be minted an
        // agent token, which is never gated: a mint, in the fresh class
        // (docs/passkeys.md). A reconnect presenting its secret is an agent.
        if (!(bindSecret && verifyAgentToken(db, nid, bindSecret))) {
          const refused = verificationGate.refuseRoute(auth.record, "GET", "/ws/mcp");
          if (refused) {
            console.error(`[mcp-ws] device "${auth.record.label}" dialed unverified; refused (${refused.body.verification})`);
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }
          // A mint, so the record keeps what proved it (docs/passkeys.md).
          const proof = verificationGate.proof(auth.record);
          if (proof) console.log(`[verification] GET /ws/mcp by device "${auth.record.label}": verified by ${proof.by} (${proof.method}) at ${new Date(proof.at).toISOString()}`);
        }
        const bind = resolveMcpBind(db, braneId, nid, bindSecret, auth.record.id);
        if (bind.rejected) {
          const { claimedNid, reason } = bind.rejected;
          console.error(
            `[mcp-ws] bind REJECTED: claimed=${claimedNid} reason=${reason} minted=${bind.nid} session=${agentSession ?? "?"} remote=${remoteAddr}`,
          );
          // Observability: record the rejected claim on the *claimed* narrative
          // so its owner and the operator can see the intrusion attempt. Never
          // fatal — the connection still proceeds under the minted id.
          try {
            appendEvent(db, claimedNid, "binding_rejected", {
              content: `Rejected MCP bind claiming ${claimedNid} (${reason}); connection minted as ${bind.nid}`,
              meta: { claimed_nid: claimedNid, minted_nid: bind.nid, reason, claim_session: agentSession, remote: remoteAddr },
            });
          } catch {}
        }
        const effectiveNid = bind.nid;
        // The socket belongs to the token that dialed it *and* to the agent
        // token of the narrative it bound as (socketOwners): revoking either
        // closes it — the device, or the agent.
        const agentRow = liveAgentTokenId(db, effectiveNid);
        mcpWss.handleUpgrade(req, socket, head, (ws) => {
          trackViewerSocket(ws, socketOwners("mcp", auth.record, agentRow));
          handleMcpBridgeSocket(ws, db, braneId, mcpClients, controlClients, effectiveNid, listenWaiters, settleOwnCall, crushToolSampler, copilotToolSampler, codexToolSampler, notifyListenWaiters, recordEventMentions, agentSession, awaiting, bind.secret);
        });
      } catch (err) {
        console.error(`[mcp-ws] upgrade failed for nid=${nid}:`, err);
        try { socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n"); } catch {}
        socket.destroy();
      }
      return;
    }

    // WS: /ws/terminal/:nid — terminal mirroring
    const termMatch = path.match(/^\/ws\/terminal\/([^/]+)$/);
    if (termMatch) {
      const nid = termMatch[1];
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        trackViewerSocket(ws, socketOwners("terminal", auth.record));
        handleTerminalSocket(ws, nid, () => verificationGate.refuseAct(auth.record, "terminal"));
      });
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  };
  // Everything a listener needs besides `listen()` itself, in one place, so
  // a server created after startup (see the Tailscale re-probe loop) is wired
  // identically to the ones created at startup.
  const wirePrimary = (s: (typeof servers)[number]) => {
    // If we're on HTTPS, give the CertManager the bound server so it can
    // setSecureContext() on hot-reload.
    if (tls) tlsServersForReload.push(s as ReturnType<typeof createHttpsServer>);
    // Connection-level IP filter for the primary servers.
    if (isAllowedConnection) {
      const checkIp = isAllowedConnection;
      s.on("connection", (socket) => {
        const remote = socket.remoteAddress;
        if (remote && !checkIp(remote)) {
          socket.destroy();
        }
      });
    }
    s.on("upgrade", upgradeHandler);
  };
  const wireHttp = (h: (typeof httpServers)[number]) => {
    // HTTP fallback: always gets the private-IP filter, even with --bind.
    if (httpIpFilter) {
      h.on("connection", (socket) => {
        const remote = socket.remoteAddress;
        if (!remote || !httpIpFilter(remote)) {
          socket.destroy();
        }
      });
    }
    h.on("upgrade", upgradeHandler);
  };
  for (const s of servers) wirePrimary(s);
  for (const h of httpServers) wireHttp(h);

  // The Unix socket: plain HTTP (nothing crosses a network), no IP filter
  // (there is no IP; the 0700 directory is the filter), same handlers.
  const socketPath = getSocketPath(db);
  const unixServer = createHttpServer(requestHandler);
  unixServer.on("upgrade", upgradeHandler);
  let unixListening = false;

  // Start polling for event hints to push to control clients and MCP bridges
  const controlPoller = startControlPoller(db, controlClients);
  // The switch from `off`: the daemon hears it only by reading config, so
  // it checks on a tick of its own and once now (src/daemon/verification-switch.ts).
  const settleVerificationSwitch = () => {
    try {
      const outcome = settleSwitch(db, verificationGate.config().mode, tokenStore);
      if (!outcome) return;
      const closed = outcome.revoked.length > 0 ? closeSocketsOf(viewerSockets, outcome.revoked, "verification switched on") : 0;
      console.log(`[verification] mode ${outcome.from} → ${outcome.to}; revoked ${outcome.revoked.length} device-dialed agent token(s), closed ${closed} socket(s)`);
    } catch (err) {
      console.error("[verification] could not settle the mode switch:", err);
    }
  };
  settleVerificationSwitch();
  const verificationSwitchTicker = setInterval(settleVerificationSwitch, SWITCH_TICK_MS);
  const mcpPoller = startMcpPoller(db, mcpClients, settleOwnCall);
  const costSampler = startCostSampler(db, controlClients, mcpClients);
  const crushToolSampler = startCrushToolSampler(
    db,
    mcpClients,
    pushToolUse,
    numericConfig(getConfig("crush_tool_log.poll_ms", db), 2_000, "crush_tool_log.poll_ms"),
  );
  const copilotToolSampler = startCopilotToolSampler(
    db,
    mcpClients,
    pushToolUse,
    numericConfig(getConfig("copilot_tool_log.poll_ms", db), 2_000, "copilot_tool_log.poll_ms"),
  );
  const codexToolSampler = startCodexToolSampler(
    db,
    mcpClients,
    pushToolUse,
    numericConfig(getConfig("codex_tool_log.poll_ms", db), 2_000, "codex_tool_log.poll_ms"),
  );
  let memoryIndexer: MemoryIndexerHandle | null = null;

  type AnyServer = ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>;
  const listenOn = (srv: AnyServer, addr: string, portToUse: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      srv.once("error", onError);
      srv.listen(portToUse, addr, () => {
        srv.off("error", onError);
        const a = srv.address();
        resolve(typeof a === "object" && a && "port" in a ? a.port : portToUse);
      });
    });

  (async () => {
    // Bind the first primary server to discover the port; bind the rest to
    // that same port on their respective addresses.
    actualPort = await listenOn(servers[0], bindAddresses[0], port);
    for (let i = 1; i < servers.length; i++) {
      await listenOn(servers[i], bindAddresses[i], actualPort);
    }
    // The socket before the port: a client that finds the port can then
    // find the socket too. Never fatal: without it agents and devices are
    // still served over TCP, though this machine's shell, which holds no
    // token, cannot reach the daemon (warned below).
    unixListening = await listenOnLocalSocket(unixServer, db);
    if (unixListening) console.log(`listening on ${socketPath}`);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_port', ?)").run(
      String(actualPort),
    );
    console.log(
      `brane daemon (${braneId}) listening on port ${actualPort} (${tls ? "https" : "http"}) on ${bindAddresses.join(", ")}`,
    );
    if (!unixListening) {
      console.warn(
        "[socket] not listening: this machine's shell (the brane CLI outside an agent session) and new external MCP clients " +
          "cannot reach this daemon; agents and signed-in devices still can",
      );
    }
    console.log(`pid: ${process.pid}`);

    // Eagerly load the embedding model so first search is fast
    preloadEmbeddingModel();

    // Catch up on memory indexing in the background. Searches no longer
    // block on indexing — they hit whatever is already in memory_vec/fts.
    memoryIndexer = startMemoryIndexer(db);

    // HTTP fallback servers (when TLS is active). The port must be STABLE
    // across restarts, same as the main port: hook configs written into folds
    // (ensureClaudeHookConfig) hardcode it, and an ephemeral port would orphan
    // every one of them on the next restart — silently, because informational
    // hooks fail open. Reuse the last-known port (the meta row survives
    // shutdown as a hint); fall back to OS-assigned only if it's taken.
    if (httpServers.length > 0) {
      const prevHttpRow = db
        .prepare("SELECT value FROM meta WHERE key = 'daemon_http_port'")
        .get() as { value: string } | undefined;
      const preferredHttpPort = prevHttpRow ? numericConfig(prevHttpRow.value, 0) : 0;
      try {
        actualHttpPort = await listenOn(httpServers[0], bindAddresses[0], preferredHttpPort);
      } catch (err) {
        actualHttpPort = await listenOn(httpServers[0], bindAddresses[0], 0);
        // Never silent. Every fold's hook config hardcodes the old port, so
        // from here until each one is rewritten (next spawn/revive) hooks POST
        // into a closed port and fail open — tool rows just stop appearing,
        // indistinguishable from an agent that reports none. Say so out loud
        // (claude-8fkbabsx:9, finding 5).
        if (preferredHttpPort !== 0) {
          console.warn(
            `[daemon] HTTP fallback port ${preferredHttpPort} unavailable (${err}); ` +
              `bound ${actualHttpPort} instead. Fold hook configs still point at ` +
              `${preferredHttpPort} and will capture nothing until their next spawn/revive.`,
          );
        }
      }
      for (let i = 1; i < httpServers.length; i++) {
        await listenOn(httpServers[i], bindAddresses[i], actualHttpPort);
      }
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_http_port', ?)").run(
        String(actualHttpPort),
      );
      console.log(
        `HTTP fallback listening on port ${actualHttpPort} (local/LAN only) on ${bindAddresses.join(", ")}`,
      );
    }

    // Start the renewal loop + fs.watch once the servers are accepting
    // connections. Doing this here (rather than alongside ensureCert)
    // means a hot-reload during startup can never race the bind.
    certMgr.start();

    // The idle rule's timer, from boot: a wake nobody follows sleeps again.
    // Not once a sleep has begun: the routine stopped the timer for good.
    if (!sleeper.sleeping) sleeper.start();
    const waiting = readSleepManifest(braneDir);
    if (waiting) {
      console.log(
        `[sleep] a manifest from ${new Date(waiting.slept_at).toISOString()} (${waiting.narratives.length} narrative(s)) waits for an operator to connect`,
      );
    }


    // Tailscale re-probe. The startup probe above is one `tailscale status`
    // with a 3 s timeout; if the extension is wedged at that moment (it
    // hangs for hours at a time — claude-9ya34xr8:23) the daemon binds
    // loopback only and, without this, stays unreachable from every other
    // device until someone restarts it *again*. Keep asking, and bind the
    // addresses when they turn up. `--bind` is an explicit operator choice
    // and is left alone.
    if (!config.bind) {
      // Best-effort: a tailnet address that is up over HTTPS but has no HTTP
      // fallback still reaches the phone, which is the point of all this. So
      // a fallback failure is logged loudly, reported in /api/status, and
      // retried on later probes — never allowed to undo the primary.
      const bindFallback = async (addr: string) => {
        const h = createHttpServer(requestHandler);
        wireHttp(h);
        try {
          await listenOn(h, addr, actualHttpPort);
          httpServers.push(h);
          needFallback.delete(addr);
          console.log(`[tailscale] HTTP fallback listening on ${addr} (port ${actualHttpPort})`);
        } catch (err) {
          h.close();
          needFallback.add(addr);
          console.warn(
            `[tailscale] HTTPS is up on ${addr} but the HTTP fallback could not bind (${err}); ` +
              `LAN/local access via that address is unavailable until a later probe succeeds`,
          );
        }
      };
      const bindTailscaleAddress = async (addr: string) => {
        const s = createPrimary();
        wirePrimary(s);
        try {
          await listenOn(s, addr, actualPort);
        } catch (err) {
          // Undo the wiring. `wirePrimary` registered the server for TLS
          // hot-reload before it could listen; a failed bind must leave no
          // trace, or a flapping address grows that list once per probe
          // (claude-9o0vgfvb:5, finding 1).
          s.close();
          const i = tlsServersForReload.indexOf(s as ReturnType<typeof createHttpsServer>);
          if (i >= 0) tlsServersForReload.splice(i, 1);
          throw err;
        }
        // Record the address the moment the primary is up, so no later probe
        // can retry the primary against our own listener.
        servers.push(s);
        boundAddresses.add(addr);
        tsIpSet.add(addr);
        tsIpSet.add(`::ffff:${addr}`);
        console.log(`[tailscale] now listening on ${addr} (port ${actualPort})`);
        if (tls) await bindFallback(addr);
      };
      // `null` here means the first probe also uses the initial delay, so the
      // real sequence is 5, 5, 10, 20, 40, 60 s: one quick retry for a
      // Tailscale that is merely still launching before the backoff climbs.
      // `src/test/tailscale-rebind.test.ts` pins exactly this sequence.
      let probeDelay: number | null = null;
      let everSeen = tsIpSet.size > 0;
      let loggedBlind = false;
      const probe = async () => {
        if (shuttingDown) return;
        let ips: string[] = [];
        try {
          ips = await getTailscaleIpsAsync();
        } catch {
          ips = [];
        }
        for (const addr of addressesToBind(boundAddresses, ips)) {
          try {
            await bindTailscaleAddress(addr);
          } catch (err) {
            console.warn(`[tailscale] could not bind ${addr}: ${err}`);
          }
        }
        // Fallback-only retries — see the `needFallback` comment for why this
        // is a separate pass and not part of `addressesToBind`.
        for (const addr of [...needFallback]) {
          if (ips.includes(addr)) await bindFallback(addr);
        }
        if (ips.length > 0 && !everSeen) {
          everSeen = true;
          loggedBlind = false;
          if (!tls) {
            // The daemon came up with no usable cert (fresh install, or the
            // cert expired during the outage) and is HTTP-only for its whole
            // life — an http.Server cannot become HTTPS. Provision the cert
            // now so the *next* start is HTTPS, and say so, loudly.
            console.warn(
              "[tailscale] Tailscale appeared after a blind start, but this daemon is serving HTTP only — " +
                "provisioning the TLS cert now; restart the daemon (`brane daemon restart`) to serve HTTPS",
            );
            certMgr.renewNow().catch((err) => console.warn(`[tailscale] cert provisioning failed: ${err}`));
          }
        }
        if (ips.length === 0 && tsIpSet.size === 0 && !loggedBlind && probeDelay !== null && probeDelay >= TAILSCALE_PROBE_MAX_MS) {
          // Say it once when the backoff caps, not once a minute forever —
          // a machine that genuinely has no Tailscale would otherwise fill
          // daemon.log, which is the post-mortem's primary evidence.
          loggedBlind = true;
          console.log("[tailscale] still no Tailscale addresses — daemon reachable on loopback only (will keep checking every 60 s, silently)");
        }
        probeDelay = nextProbeDelay(probeDelay, ips.length > 0);
        // A probe that was in flight when shutdown began must not re-arm.
        if (shuttingDown) return;
        tailscaleProbeTimer = setTimeout(probe, probeDelay);
      };
      tailscaleProbeTimer = setTimeout(probe, nextProbeDelay(null, tsIpSet.size > 0));
    }
  })().catch((err) => {
    console.error("Failed to bind daemon listeners:", err);
    process.exit(1);
  });

  // Graceful shutdown
  let shuttingDown = false;
  /** How long a daemon that handed off waits for its successor's claim. */
  const SUCCESSOR_CLAIM_MS = 60_000;
  /** Shut down; with `handoff`, start a successor on `handoff.port` as the
   *  listeners close, and pass it the claim (`POST /api/daemon/restart`). */
  const doShutdown = (handoff?: { port: string }) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(handoff ? "\nRestarting brane daemon in place..." : "\nShutting down brane daemon...");
    keepAwake.stop();
    certMgr.stop();
    if (tailscaleProbeTimer) clearTimeout(tailscaleProbeTimer);
    sleeper.stop();
    clearInterval(controlPoller);
    clearInterval(verificationSwitchTicker);
    clearInterval(mcpPoller);
    clearInterval(costSampler);
    crushToolSampler.stop();
    copilotToolSampler.stop();
    codexToolSampler.stop();
    // Signal the indexer to break between batches before we await its
    // inflight pass; without this the AbortSignal check inside runIndex
    // is a no-op and the 5s race below always times out mid-embedBatch.
    memoryIndexer?.abort();
    const indexerInflight = memoryIndexer?.inflight() ?? Promise.resolve();
    if (memoryIndexer) clearInterval(memoryIndexer.interval);

    // 1. Drain all pending listen waiters so their wakeup callbacks
    //    (which hold closures over `db`) cannot fire after db.close().
    for (const [, waiters] of listenWaiters) {
      waiters.clear();
    }
    listenWaiters.clear();

    // Resolve pending listen calls with empty results for clean teardown.
    //
    // Deliberately *not* `pending.reply`: that would run the mention receipt,
    // marking mentions sent on the way out the door — to an agent that is
    // about to lose its bridge and will very likely never act on them. Leaving
    // them unsent costs one extra delivery after the restart, which is the
    // right way for this to fail.
    for (const client of mcpClients) {
      for (const [callId, pending] of client.pendingListens) {
        const emptyEvents: Record<string, unknown> = {};
        for (const key of Object.keys(pending.cursors)) {
          emptyEvents[key] = [];
        }
        if (client.ws.readyState === WebSocket.OPEN) {
          sendToolResult(client.ws, callId, {
            ...pending.extra,
            events: emptyEvents,
            waited_ms: Date.now() - pending.startTime,
            timed_out: true,
          });
        }
        // Settle before the database closes: a listen cut short by shutdown
        // still ended, and the row should say when rather than keep whatever
        // the hook guessed.
        settleOwnCall(client.narrativeId, pending.toolName, pending.startTime, Date.now());
      }
      client.pendingListens.clear();
    }

    // 2. Remove MCP WS close listeners to prevent db.prepare() calls
    //    (UPDATE narratives SET status) after db.close().
    for (const client of mcpClients) {
      client.ws.removeAllListeners("close");
      client.ws.close();
    }
    for (const client of controlClients) client.ws.close();
    for (const ws of terminalWss.clients) ws.close();

    // 3. Clean up daemon meta while DB is still open, then close all
    //    servers. DB stays open until every server.close() callback fires
    //    so any in-flight HTTP requests can complete safely.
    //    daemon_http_port deliberately survives shutdown: it's the stability
    //    hint the next startup binds to, keeping fold hook configs valid
    //    across restarts (same contract as the main port, which restart
    //    preserves via --port).
    //    Every listener stops listening first (`close` releases the port and
    //    removes the socket file now, and calls back once in-flight requests
    //    finish), so a successor can bind them.
    const listenersClosed = [
      ...servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      // This machine's CLI arrives here now, so its requests in flight are
      // waited for as the primaries' are. Closing also removes the file.
      ...(unixListening ? [new Promise<void>((resolve) => unixServer.close(() => resolve()))] : []),
    ];
    for (const h of httpServers) h.close();
    // A handoff is a clean exit the sleep routine never sees: say so, before
    // the successor starts and reads the record at its boot.
    if (handoff) {
      try {
        writeExitRecord(braneDir, { exited_at: Date.now(), reason: "restart", clean: true, pid: process.pid });
      } catch (err) {
        console.error("[restart] could not write the exit record:", err);
      }
    }
    const successor = handoff ? startSuccessor(handoff.port) : undefined;
    if (successor) {
      // The claim passes in one write: the successor's pid where ours was,
      // so `getDaemonAddress` never reads "no daemon" in between and nothing
      // starts one of its own (`claimDaemon` takes a row naming itself).
      db.transaction(() => {
        db.prepare("DELETE FROM meta WHERE key IN ('daemon_token', 'daemon_tls', 'daemon_version', 'daemon_socket')").run();
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_pid', ?)").run(String(successor.pid));
      })();
      console.log(`[restart] handed off to pid ${successor.pid}`);
    }
    const successorClaimed = successor && handoff ? seeSuccessorClaim(successor, handoff.port) : Promise.resolve();
    if (!successor) {
      db.prepare("DELETE FROM meta WHERE key IN ('daemon_token', 'daemon_pid', 'daemon_tls', 'daemon_version', 'daemon_socket')").run();
    }

    // Bound how long we wait for the in-flight indexer to settle. The
    // embedder thread holds native mutexes that must not be locked while
    // the runtime tears them down — but we also can't hang shutdown
    // indefinitely on a slow embedding.
    const indexerSettled = Promise.race([
      indexerInflight,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);

    Promise.all([
      ...listenersClosed,
      indexerSettled,
    ])
      .then(() => disposeEmbeddingModel())
      .catch(() => undefined)
      .then(() => successorClaimed)
      .catch((err) => console.error("[restart] watching the successor:", err))
      .then(() => {
        db.close();
        process.exit(0);
      });
  };
  /** After a handoff, stay (listening on nothing) until the successor claims
   *  the role. One that exits before claiming is started once more, with the
   *  claim passed again: nothing else may start a daemon with this one's
   *  provenance, so a failed restart would otherwise leave the machine with
   *  none until the operator is at a terminal (claude-apqiedkc:41). A second
   *  failure is recorded as no daemon, and logged. The operator's stop, or a
   *  claim that is no longer the successor's, ends the watch. The retry runs
   *  on the exit itself, not on a poll: until then the row names a dead pid,
   *  and any reader would clear it as stale. */
  function seeSuccessorClaim(first: Successor, port: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let current = first;
      let retried = false;
      let done = false;
      const pidNow = (): number | undefined => {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'daemon_pid'").get() as { value: string } | undefined;
        return row ? parseInt(row.value, 10) : undefined;
      };
      const claimed = (): boolean => Boolean(db.prepare("SELECT value FROM meta WHERE key = 'daemon_version'").get());
      const finish = (message?: string): void => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(deadline);
        if (message) console.log(message);
        resolve();
      };
      const onExit = (exited: Successor): void => {
        if (done || exited !== current) return;
        if (pidNow() !== current.pid || startupRefusal(db) || claimed()) return finish();
        const next = retried ? undefined : startSuccessor(port);
        retried = true;
        db.transaction(() => {
          if (pidNow() !== current.pid) return;
          if (next) {
            db.prepare("UPDATE meta SET value = ? WHERE key = 'daemon_pid'").run(String(next.pid));
          } else {
            db.prepare("DELETE FROM meta WHERE key IN ('daemon_token', 'daemon_pid', 'daemon_tls', 'daemon_version', 'daemon_socket')").run();
          }
        })();
        if (!next) {
          return finish(`[restart] successor pid ${current.pid} exited before taking over, twice; no daemon is running (see above)`);
        }
        console.error(`[restart] successor pid ${current.pid} exited before taking over; starting it once more, as pid ${next.pid}`);
        current = next;
        next.onExit(onExit);
      };
      const poll = setInterval(() => {
        if (pidNow() !== current.pid || startupRefusal(db)) return finish();
        if (claimed()) finish(`[restart] pid ${current.pid} took over`);
      }, 200);
      const deadline = setTimeout(
        () => finish(`[restart] successor pid ${current.pid} has not taken over after ${SUCCESSOR_CLAIM_MS / 1000}s; leaving it to it`),
        SUCCESSOR_CLAIM_MS,
      );
      first.onExit(onExit);
    });
  }
  interface Successor {
    pid: number;
    /** Call `cb` once it exits (at once, if it already has). */
    onExit(cb: (which: Successor) => void): void;
  }
  /** Spawn this daemon's successor, detached, with this process's own
   *  environment (and so its provenance). Its pid, or undefined if it could
   *  not be spawned, in which case shutdown goes on as a plain stop. */
  function startSuccessor(port: string): Successor | undefined {
    try {
      const logFd = openSync(join(getBraneDir(), "daemon.log"), "a");
      const child = spawn(process.execPath, successorArgs(process.execArgv, process.argv, port), {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          [SPAWNED_ENV]: "1",
          [HANDOFF_ENV]: String(process.pid),
          ...(startedVia ? { [VIA_ENV]: startedVia } : {}),
        },
      });
      let exited = false;
      const waiting: Array<(which: Successor) => void> = [];
      const exit = (): void => {
        if (exited) return;
        exited = true;
        for (const cb of waiting.splice(0)) cb(successor);
      };
      child.on("error", (err) => {
        console.error("[restart] successor failed:", err);
        exit();
      });
      child.on("exit", exit);
      child.unref();
      if (child.pid === undefined) return undefined;
      const successor: Successor = {
        pid: child.pid,
        onExit: (cb) => (exited ? cb(successor) : void waiting.push(cb)),
      };
      return successor;
    } catch (err) {
      console.error("[restart] could not start a successor; stopping instead:", err);
      return undefined;
    }
  }
  // A signal runs the sleep routine, bounded (src/daemon/sleep.ts): on a
  // Mac that is `brane daemon stop` (a restart is a handoff, not a signal),
  // and the routine then does no more than write the exit record before
  // doShutdown; on Fly it is the machine stopping, and the live narratives
  // are told and recorded first.
  const onSignal = () => {
    if (shuttingDown) return;
    void sleeper.sleep("signal");
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

// Control WebSocket: single real-time channel for all notifications.
// Clients subscribe to narratives and receive lightweight hints when
// new events appear. Actual event data is fetched via HTTP.
function handleControlSocket(
  ws: WebSocket,
  /** The token this socket authenticated with: who its signals are from,
   *  and whose verification each act is checked against. */
  sender: Pick<TokenRecord, "id" | "kind" | "label">,
  db: Database.Database,
  controlClients: Set<ControlClient>,
  mcpClients: Set<McpBridgeClient>,
  notifyListenWaiters: (nid: string) => void,
  recordEventMentions: RecordEventMentions,
  awaiting?: AwaitingTracker,
  /** The presence prompt up right now, so a device that connects mid-prompt
   *  hears of it too. */
  presence?: PendingPresence | null,
  /** The verification gate, when the daemon has one: an act from an
   *  unverified device is dropped and answered with a `verify` frame. */
  verification?: Pick<VerificationGate, "refuseAct" | "proof">,
): void {
  const client: ControlClient = {
    ws,
    tokenId: sender.id,
    subscriptions: new Map(),
    activity: false,
  };
  controlClients.add(client);

  // Send initial state with MCP connection info
  const connectedNids = mcpConnectedNids(mcpClients);
  const narratives = (db
    .prepare("SELECT id, status, agent_type, role, fold_path, created_at, summary FROM narratives ORDER BY created_at DESC")
    .all() as Array<{ id: string; status: string; agent_type: string; role: string; fold_path: string; created_at: number; summary: string | null }>)
    .map((n) => ({ ...n, mcp_connected: connectedNids.has(n.id), awaiting: awaiting?.isAwaiting(n.id) ?? false }));

  ws.send(
    JSON.stringify({
      type: "state",
      narratives,
    }),
  );
  if (presence) ws.send(JSON.stringify({ type: "presence", pending: presence }));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Per message, not per connection: a socket opened inside the window
      // must not keep acting after it. Subscriptions are free; `signal` and
      // any type not named free is an act.
      if (verification && !FREE_CONTROL_MESSAGES.has(msg.type)) {
        const refused = verification.refuseAct(sender, msg.type === "signal" ? "signal" : null);
        if (refused) {
          ws.send(JSON.stringify(verifyFrame(refused)));
          return;
        }
      }

      switch (msg.type) {
        // Subscribe to event hints for a narrative
        case "subscribe": {
          const narrativeId = msg.narrative as string;
          const after = (msg.after as number) ?? (msg.heard as number) ?? 0;
          // after < 0 → baseline at the current head, so only *future* events
          // produce hints (no replay of existing events on subscribe).
          client.subscriptions.set(narrativeId, after < 0 ? getMaxSeq(db, narrativeId) : after);
          break;
        }
        // Unsubscribe from a narrative
        case "unsubscribe": {
          const narrativeId = msg.narrative as string;
          client.subscriptions.delete(narrativeId);
          break;
        }
        // Subscribe to the brane-wide activity stream: one lightweight `activity`
        // frame per real state change, for the list's recency timestamps. A
        // single boolean replaces a control-WS subscription per visible card.
        case "subscribe_activity": {
          client.activity = true;
          break;
        }
        case "unsubscribe_activity": {
          client.activity = false;
          break;
        }
        // Send a signal to a narrative
        case "signal": {
          const narrativeId = msg.narrative as string;
          // Who the signal is from comes from the token, not the message.
          const standing = signalStanding(sender);
          if ("refused" in standing) {
            ws.send(JSON.stringify({ type: "signal_refused", narrative: narrativeId, error: standing.refused }));
            break;
          }
          if (narrativeId) {
            // Auto-unarchive narratives when signaled into
            db.prepare("UPDATE narratives SET archived = 0 WHERE id = ? AND archived = 1").run(narrativeId);
            const append = (payloadPaths?: string[]) => {
              const proof = verification?.proof(sender) ?? null;
              if (proof) console.log(`[verification] signal into ${narrativeId} by device "${sender.label}": verified by ${proof.by} (${proof.method}) at ${new Date(proof.at).toISOString()}`);
              const fields = signalEventFields(standing, msg, payloadPaths, proof);
              const event = appendEvent(db, narrativeId, "human_signal", fields);
              announceEvent(narrativeId, event, fields.source, notifyListenWaiters, recordEventMentions);
            };
            const rawPayloads = msg.payloads as PayloadInput[] | undefined;
            if (Array.isArray(rawPayloads) && rawPayloads.length > 0) {
              // Two-argument then: a throw from append() itself must not
              // land in the fallback and append the signal a second time.
              storePayloads(narrativeId, rawPayloads).then(
                (payloadPaths) => append(payloadPaths),
                (err) => {
                  console.error("Failed to store payloads:", err);
                  // Still deliver the signal text even if payload storage fails
                  append();
                },
              ).catch((err) => console.error("Failed to append signal:", err));
            } else {
              append();
            }
          }
          break;
        }
      }
    } catch {
      // Ignore malformed messages
    }
  });

  // Heartbeat
  const heartbeatInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "heartbeat", timestamp_ms: Date.now() }));
  }, 30000);

  ws.on("close", () => {
    controlClients.delete(client);
    clearInterval(heartbeatInterval);
  });
}

interface ControlClient {
  ws: WebSocket;
  /** The token the socket authenticated with: a `verified` frame goes to
   *  that token's sockets only. */
  tokenId: string;
  // narrative_id → after (cursor)
  subscriptions: Map<string, number>;
  // Opted into the brane-wide activity stream: receives one lightweight
  // `activity` frame whenever any narrative gets a new event (a real state
  // change), so the list can show recency without a subscription per card.
  activity: boolean;
}

// Compute the set of narrative IDs with active MCP connections
function mcpConnectedNids(mcpClients: Set<McpBridgeClient>): Set<string> {
  const nids = new Set<string>();
  for (const client of mcpClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      nids.add(client.narrativeId);
    }
  }
  return nids;
}

// Push a narrative status change to all connected control clients
function broadcastStatus(controlClients: Set<ControlClient>, narrativeId: string, status: string): void {
  const msg = JSON.stringify({ type: "status", narrative: narrativeId, status });
  for (const client of controlClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  }
}

// Push a narrative's awaiting edge — parked waiting for direction, or not.
function broadcastAwaiting(controlClients: Set<ControlClient>, narrativeId: string, awaiting: boolean): void {
  const msg = JSON.stringify({ type: "awaiting", narrative: narrativeId, awaiting });
  for (const client of controlClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  }
}

// Push the presence prompt that is up (or null once it closes), so every
// signed-in device sees what is waiting at the machine and can cancel it.
/** A proof just landed for `tokenId`: tell that token's own control
 *  sockets, so the app's lock sheet closes and retries the moment the hop
 *  succeeds, wherever the ceremony ran. Nobody else hears of it. */
function broadcastVerified(controlClients: Set<ControlClient>, tokenId: string, verifiedUntil: number): void {
  const msg = JSON.stringify({ type: "verified", verified_until: verifiedUntil });
  for (const client of controlClients) {
    if (client.tokenId === tokenId && client.ws.readyState === WebSocket.OPEN) client.ws.send(msg);
  }
}

function broadcastPresence(controlClients: Set<ControlClient>, pending: PendingPresence | null): void {
  const msg = JSON.stringify({ type: "presence", pending });
  for (const client of controlClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  }
}

// Push TLS cert state changes (renewal, failure, hot-reload) to all
// connected control clients so the web UI can surface a banner.
function broadcastCertStatus(controlClients: Set<ControlClient>, status: CertStatus): void {
  const msg = JSON.stringify({ type: "tls", ...serializeCertStatus(status) });
  for (const client of controlClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  }
}

function serializeCertStatus(status: CertStatus): Record<string, unknown> {
  return {
    state: status.state,
    expires_at: status.expiresAt?.toISOString() ?? null,
    last_error_reason: status.lastErrorReason,
    last_error_message: status.lastErrorMessage,
    next_attempt_at: status.nextAttemptAt?.toISOString() ?? null,
    host: status.host,
  };
}

// Push narrative metadata updates to all connected control clients. Carries
// any subset of {summary, cost}, so the same "meta" frame drives both the
// summary subtitle and the cost badge on the card.
function broadcastMeta(
  controlClients: Set<ControlClient>,
  narrativeId: string,
  fields: { summary?: string; cost_amount?: number; cost_unit?: string },
): void {
  const payload: Record<string, unknown> = { type: "meta", narrative: narrativeId };
  if (fields.summary !== undefined) payload.summary = fields.summary;
  if (fields.cost_amount !== undefined) payload.cost_amount = fields.cost_amount;
  if (fields.cost_unit !== undefined) payload.cost_unit = fields.cost_unit;
  const msg = JSON.stringify(payload);
  for (const client of controlClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  }
}

// Sample a narrative's cumulative cost from its agent's own usage log and
// persist it. Returns the reading only when it *changed*, so callers broadcast
// real deltas rather than every tick. Returns null when the agent can't report
// usage (no session, no readUsage) or the figure is unchanged.
/** Parse a stored `session_ids` JSON array into a string[], tolerating null and
 *  malformed values (returns []). */
function parseSessionIdArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Append `sessionId` to a narrative's cumulative `session_ids` set (dedup,
 *  order-preserving). Call this wherever `agent_session_id` (the *current*
 *  session) is written, so every session a narrative ever bound is retained for
 *  cross-session cost aggregation. No-op for empty ids or unknown narratives. */
export function recordSessionId(db: Database.Database, narrativeId: string, sessionId: string | undefined | null): void {
  if (!sessionId) return;
  const row = db
    .prepare("SELECT session_ids FROM narratives WHERE id = ?")
    .get(narrativeId) as { session_ids: string | null } | undefined;
  if (!row) return;
  const ids = parseSessionIdArray(row.session_ids);
  if (ids.includes(sessionId)) return;
  ids.push(sessionId);
  db.prepare("UPDATE narratives SET session_ids = ? WHERE id = ?").run(JSON.stringify(ids), narrativeId);
}

/** Successful discoveries, keyed by the narrative and the launch they were
 *  anchored at. Capture is attempted on every cost tick so it can retry the gap
 *  between an agent's MCP bind and the moment it writes its session row — but a
 *  *successful* discovery for a given anchor can't change, and codex's is a
 *  dated walk over its rollout tree that reads the head of every file. Caching
 *  only the hits keeps the retry loop free while leaving misses to retry: a new
 *  revive moves the anchor, so the next launch re-discovers exactly once.
 *  Process-local; a daemon restart just re-walks once per narrative. */
const captureCache = new Map<string, string>();

/** Time of a narrative's most recent revive, or undefined if it's never been
 *  revived. `reviveNarrative` appends exactly one "restarted" event per launch,
 *  so the event log already records this and no new column is needed. */
export function lastRestartTime(
  db: Database.Database,
  narrativeId: string,
): number | undefined {
  const row = db
    .prepare("SELECT MAX(time) AS t FROM events WHERE narrative_id = ? AND type = 'restarted'")
    .get(narrativeId) as { t: number | null } | undefined;
  return row?.t ?? undefined;
}

/** Capture a "capture"-strategy agent's self-generated session id onto its row.
 *  Codex, goose, cline and crush all mint their own ids and the bridge can't
 *  self-report them, so the daemon discovers each from the agent's own store —
 *  scoped per-narrative by the adapter — and pins it so revive can resume, and
 *  so cost has something to read. Records the id in the cumulative cost set too.
 *  Returns the captured id, or undefined if nothing changed. No-ops entirely
 *  for agents whose id the daemon assigns or doesn't own.
 *
 *  Discovery is anchored at the narrative's spawn time until it is revived, and
 *  at the **latest revive** afterwards. That re-anchoring is what makes cost
 *  survive a revive: agents that can't resume in place mint a whole new session
 *  each launch (crush has no resume at all; cline writes a fresh session dir per
 *  start), so a pointer captured once at first bind would name a session that
 *  stopped spending, and every post-revive dollar would go unread. It is also
 *  the fix this function previously deferred as untestable — it generalizes to
 *  any agent that rotates ids across resumes.
 *
 *  The no-clobber guarantee still holds where it matters: with `since` pinned to
 *  the last revive, discovery can only return a session that started *after*
 *  that launch, so a live pointer is never replaced by a stale sibling. A
 *  narrative that has never been revived keeps the original once-only behavior.
 *  Agents that do resume in place (goose reuses its named row) simply
 *  re-discover the same id and no write happens.
 *
 *  Safe to call repeatedly — the cost sampler does, every tick, which is what
 *  gives capture a retry loop for the gap between an agent's MCP bind and the
 *  moment it actually creates its session row.
 *
 *  `discover` is injectable for tests; in production it defers to the adapter,
 *  which reads the real session store. */
export function maybeCaptureSessionId(
  db: Database.Database,
  narrativeId: string,
  agentType: string | undefined,
  foldPathPortable: string | undefined,
  createdAt: number | undefined,
  currentSessionId: string | undefined | null,
  discover?: (foldPath: string, since?: number) => string | undefined,
): string | undefined {
  const adapter = getAgentAdapter(agentType ?? "");
  if (adapter.sessionIdOwnership !== "capture") return undefined;
  if (!foldPathPortable) return undefined;

  let since = createdAt;
  if (currentSessionId) {
    const revivedAt = lastRestartTime(db, narrativeId);
    // Already captured and never revived — the pointer is current by
    // construction, so leave it alone.
    if (revivedAt === undefined) return undefined;
    since = revivedAt;
  }

  // Injected discovery (tests) always runs for real — the cache is a
  // production concern only.
  const cacheKey = discover ? undefined : `${narrativeId}:${since}`;
  const resolveId = discover ?? ((fp: string, s?: number) => adapter.discoverSessionId(fp, s, narrativeId));
  const discovered =
    (cacheKey ? captureCache.get(cacheKey) : undefined) ??
    resolveId(fromPortablePath(foldPathPortable), since);
  if (!discovered || discovered === currentSessionId) return undefined;
  // Cache only an id we actually adopt. Caching whatever discovery returned
  // would poison the anchor in the window between a revive and the moment the
  // new session appears on disk: discovery can still see the *incumbent* there,
  // and pinning that under the fresh anchor means every later retry is a cache
  // hit on the session that already stopped spending, so the successor is never
  // picked up at all.
  if (cacheKey) captureCache.set(cacheKey, discovered);
  // Retire the outgoing session into the cumulative set before overwriting the
  // pointer. It normally landed there when it was captured, but a row whose
  // pointer was written by some other path would otherwise lose its whole
  // pre-revive spend the moment the successor is adopted — and silently, since
  // the badge would simply drop rather than error.
  recordSessionId(db, narrativeId, currentSessionId);
  db.prepare("UPDATE narratives SET agent_session_id = ? WHERE id = ?").run(discovered, narrativeId);
  recordSessionId(db, narrativeId, discovered);
  return discovered;
}

/** Follow an "assign" agent to the session it is running *now*, when that
 *  harness can change sessions in place (claude's `/clear`). The launch-time
 *  pointer names the session the daemon minted; after a `/clear` the same
 *  process writes a different transcript, and without this the ledger keeps
 *  reading the old one (whose spend has stopped) and revive resumes the
 *  conversation from before the `/clear`.
 *
 *  The adapter answers only from the agent process's own record (for claude,
 *  its `~/.claude/sessions/<pid>.json` entry, found through the pane's pid), so
 *  nothing a subagent, a nested harness, or a reconnecting bridge sends can
 *  move the pointer. The write is synchronous on the daemon's one thread, like
 *  revive's own pointer write, so the two cannot interleave; and `launchedAt`
 *  is the latest spawn or revive, so a registry entry left by the pane's
 *  previous process is never read as current.
 *
 *  Returns the adopted id, or undefined if nothing changed. `read` is
 *  injectable for tests. */
export function maybeFollowLiveSession(
  db: Database.Database,
  narrativeId: string,
  agentType: string | undefined,
  foldPathPortable: string | undefined,
  createdAt: number | undefined,
  currentSessionId: string | undefined | null,
  read?: (opts: { narrativeId: string; foldPath: string; launchedAt: number }) => string | undefined,
): string | undefined {
  const adapter = getAgentAdapter(agentType ?? "");
  if (adapter.sessionIdOwnership !== "assign") return undefined;
  const resolveLive = read ?? adapter.liveSessionId?.bind(adapter);
  if (!resolveLive || !foldPathPortable) return undefined;
  const launchedAt = lastRestartTime(db, narrativeId) ?? createdAt ?? 0;
  const live = resolveLive({ narrativeId, foldPath: fromPortablePath(foldPathPortable), launchedAt });
  if (!live || live === currentSessionId) return undefined;
  // Retire the outgoing session into the cumulative set before moving the
  // pointer, so its spend stays counted (see maybeCaptureSessionId).
  recordSessionId(db, narrativeId, currentSessionId);
  db.prepare("UPDATE narratives SET agent_session_id = ? WHERE id = ?").run(live, narrativeId);
  recordSessionId(db, narrativeId, live);
  console.log(`[cost] ${narrativeId}: following session ${currentSessionId ?? "(none)"} → ${live}`);
  return live;
}

/** Resolve every session id a narrative has been associated with: the stored
 *  `session_ids` set, unioned with the current `agent_session_id` (covers legacy
 *  rows with no set, and guards against a set that somehow missed the latest). */
export function getSessionIds(db: Database.Database, narrativeId: string): string[] {
  const row = db
    .prepare("SELECT agent_session_id, session_ids FROM narratives WHERE id = ?")
    .get(narrativeId) as { agent_session_id: string | null; session_ids: string | null } | undefined;
  if (!row) return [];
  const ids = parseSessionIdArray(row.session_ids);
  if (row.agent_session_id && !ids.includes(row.agent_session_id)) ids.push(row.agent_session_id);
  return ids;
}

// Defined alongside CostReading in agents.ts (adapters sum their own readings
// too, and importing back from the daemon would be a cycle); re-exported here
// so the daemon's cost surface stays in one place for callers and tests.
export { sumCostReadings };

/** Signature of the last ledger write per (narrative, session), so an unchanged
 *  transcript costs the reader's one stat and no INSERTs. In-memory only: a
 *  daemon restart re-walks each session once, and INSERT OR IGNORE makes that
 *  re-walk a no-op. */
const ledgerWritten = new Map<string, string>();

/** Record entry-level readings in the ledger. A key already present is left
 *  alone — whoever inserted it first keeps the credit — which is the whole
 *  mechanism: a message fork-copied into a later session, or into another
 *  narrative, is a no-op here, and so is the same message re-read after the
 *  file that originally held it is purged. */
export function recordUsageEntries(
  db: Database.Database,
  narrativeId: string,
  agentType: string,
  readings: UsageEntriesReading[],
): void {
  // The only things a conflict may change are facts the row didn't have —
  // rows written before those columns existed — never the credit or the
  // amount. The same message re-read carries the same model, split and speed.
  const insert = db.prepare(
    `INSERT INTO usage_ledger
       (key, narrative_id, session_id, agent_type, unit, amount, model, input, output, cache_read, cache_write,
        cache_write_1h, speed, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       model = COALESCE(model, excluded.model),
       cache_write_1h = COALESCE(cache_write_1h, excluded.cache_write_1h),
       speed = COALESCE(speed, excluded.speed)`,
  );
  const now = Date.now();
  db.transaction(() => {
    for (const r of readings) {
      const memo = `${narrativeId}:${r.sessionId}`;
      if (ledgerWritten.get(memo) === r.sig) continue;
      for (const e of r.entries) {
        insert.run(
          e.key,
          narrativeId,
          r.sessionId,
          agentType,
          r.unit,
          e.amount,
          e.model ?? null,
          e.tokens?.input ?? null,
          e.tokens?.output ?? null,
          e.tokens?.cacheRead ?? null,
          e.tokens?.cacheWrite ?? null,
          e.tokens?.cacheWrite1h ?? null,
          e.speed ?? null,
          now,
        );
      }
      ledgerWritten.set(memo, r.sig);
    }
  })();
}

/** Record a session-level reading as a high-water mark. For harnesses that
 *  only expose a cumulative per-session total there is nothing shared between
 *  sessions to mis-credit, so "never revise down" is exactly right: the only
 *  way the number falls is the harness losing the data. Token counts ride the
 *  same rule. */
export function recordUsageHighWater(
  db: Database.Database,
  narrativeId: string,
  agentType: string,
  sessionId: string,
  reading: CostReading,
): void {
  db.prepare(
    `INSERT INTO usage_ledger
       (key, narrative_id, session_id, agent_type, unit, amount, input, output, cache_read, cache_write, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       amount = MAX(amount, excluded.amount),
       input = MAX(COALESCE(input, 0), COALESCE(excluded.input, 0)),
       output = MAX(COALESCE(output, 0), COALESCE(excluded.output, 0)),
       cache_read = MAX(COALESCE(cache_read, 0), COALESCE(excluded.cache_read, 0)),
       cache_write = MAX(COALESCE(cache_write, 0), COALESCE(excluded.cache_write, 0))
     WHERE excluded.unit = unit`,
  ).run(
    `session:${agentType}:${sessionId}`,
    narrativeId,
    sessionId,
    agentType,
    reading.unit,
    reading.amount,
    reading.tokens?.input ?? null,
    reading.tokens?.output ?? null,
    reading.tokens?.cacheRead ?? null,
    reading.tokens?.cacheWrite ?? null,
    Date.now(),
  );
}

/** A narrative's cost as the ledger knows it: the sum of every row credited to
 *  it, in the unit those rows carry. A narrative has one agent and so one
 *  unit; should a stray mismatched unit ever appear, the unit with the most
 *  rows wins and the rest are ignored, mirroring sumCostReadings. */
export function ledgerTotal(db: Database.Database, narrativeId: string): CostReading | null {
  const row = db
    .prepare(
      `SELECT unit, SUM(amount) AS amount, COUNT(*) AS n,
              SUM(input) AS input, SUM(output) AS output,
              SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite,
              COUNT(input) AS withTokens
         FROM usage_ledger WHERE narrative_id = ?
        GROUP BY unit ORDER BY n DESC LIMIT 1`,
    )
    .get(narrativeId) as
    | { unit: string; amount: number; n: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; withTokens: number }
    | undefined;
  if (!row) return null;
  const amount = Math.round(row.amount * 1e6) / 1e6;
  if (!row.withTokens) return { amount, unit: row.unit };
  return {
    amount,
    unit: row.unit,
    tokens: {
      input: row.input ?? 0,
      output: row.output ?? 0,
      cacheRead: row.cacheRead ?? 0,
      cacheWrite: row.cacheWrite ?? 0,
    },
  };
}

/** What one sampling pass found for a narrative, for the backfill report. */
export interface CostSample {
  nid: string;
  agent_type: string;
  unit: string;
  /** Bound session ids, and how many of them the harness could still show us. */
  sessions: number;
  readable: number;
  /** Ledger rows this pass added (or would add, in a dry run), and their sum. */
  new_rows: number;
  new_amount: number;
  /** The cached column before, and after, this pass. Equal when nothing changed. */
  before: number | null;
  after: number | null;
}

/** Count what a set of entry readings would add to the ledger without writing
 *  it — the dry-run half of recordUsageEntries. */
function previewUsageEntries(db: Database.Database, readings: UsageEntriesReading[]): { rows: number; amount: number } {
  const exists = db.prepare("SELECT 1 FROM usage_ledger WHERE key = ?");
  let rows = 0,
    amount = 0;
  const seen = new Set<string>();
  for (const r of readings) {
    for (const e of r.entries) {
      if (seen.has(e.key) || exists.get(e.key)) continue;
      seen.add(e.key);
      rows++;
      amount += e.amount;
    }
  }
  return { rows, amount };
}

function previewUsageHighWater(db: Database.Database, agentType: string, sessionId: string, reading: CostReading): { rows: number; amount: number } {
  const row = db
    .prepare("SELECT amount, unit FROM usage_ledger WHERE key = ?")
    .get(`session:${agentType}:${sessionId}`) as { amount: number; unit: string } | undefined;
  if (!row) return { rows: 1, amount: reading.amount };
  if (row.unit !== reading.unit || reading.amount <= row.amount) return { rows: 0, amount: 0 };
  return { rows: 0, amount: reading.amount - row.amount };
}

function sampleNarrativeCost(db: Database.Database, narrativeId: string): CostReading | null {
  const sample = sampleNarrativeCostDetailed(db, narrativeId, { capture: true });
  if (!sample || sample.after === null || sample.after === sample.before) return null;
  return { amount: sample.after, unit: sample.unit };
}

/** One sampling pass. `capture` runs session-id discovery first (the live
 *  sampler wants that; a backfill over old narratives must not, since
 *  fold+time discovery against history could adopt a transcript that was
 *  never this narrative's). `dryRun` reads and reports but writes nothing.
 *  Returns null when the narrative has nothing the harness can still show. */
export function sampleNarrativeCostDetailed(
  db: Database.Database,
  narrativeId: string,
  opts: { capture?: boolean; dryRun?: boolean } = {},
): CostSample | null {
  const row = db
    .prepare(
      "SELECT agent_type, fold_path, created_at, agent_session_id, cost_amount, cost_unit FROM narratives WHERE id = ?",
    )
    .get(narrativeId) as
    | {
        agent_type: string | null;
        fold_path: string | null;
        created_at: number | null;
        agent_session_id: string | null;
        cost_amount: number | null;
        cost_unit: string | null;
      }
    | undefined;
  if (!row?.agent_type || !row.fold_path) return null;
  const adapter = getAgentAdapter(row.agent_type);
  if (!adapter.readUsage && !adapter.readUsageMany && !adapter.readUsageEntries) return null;

  // Retry capture on every tick, not just at MCP bind. A capture agent creates
  // its session row when it first talks to its model, which can be well after
  // the bridge connects — and after a revive it creates a brand new one. The
  // sampler is the natural retry loop: it already runs every 20s over exactly
  // the connected narratives, and capture is a no-op once the pointer matches.
  if (opts.capture) {
    maybeCaptureSessionId(
      db,
      narrativeId,
      row.agent_type,
      row.fold_path,
      row.created_at ?? undefined,
      row.agent_session_id,
    );
    maybeFollowLiveSession(
      db,
      narrativeId,
      row.agent_type,
      row.fold_path,
      row.created_at ?? undefined,
      row.agent_session_id,
    );
  }

  const sessionIds = getSessionIds(db, narrativeId);
  if (sessionIds.length === 0) return null;
  const foldPath = fromPortablePath(row.fold_path);

  // Write what the harness currently says into the ledger, then read the
  // narrative's total back *from the ledger*. The transcripts belong to the
  // harness and may be purged; the ledger is the copy that survives, and its
  // primary key is what dedupes a message that --fork-session copied into a
  // later transcript (see recordUsageEntries). Adapters that expose per-entry
  // usage write entry rows; the rest write a per-session high-water row from
  // their cumulative reading. Either way the adapter memoizes per session on
  // the transcript's (size, mtime), so N sessions cost N stats plus a
  // re-parse — and a ledger write — only for files that changed.
  const agentType = row.agent_type;
  let readable = 0;
  let newRows = 0,
    newAmount = 0,
    unit: string | undefined;
  const tally = (p: { rows: number; amount: number }) => {
    newRows += p.rows;
    newAmount += p.amount;
  };
  if (adapter.readUsageEntries) {
    let readings: UsageEntriesReading[] | null;
    try {
      readings = adapter.readUsageEntries({ sessionIds, foldPath, narrativeId });
    } catch {
      readings = null;
    }
    if (readings) {
      readable = readings.length;
      unit = readings[0]?.unit;
      // The preview is a PK lookup per message, so run it only over sessions
      // whose transcript changed since the last write — the same sig memo
      // recordUsageEntries skips on. An idle session stays at one stat.
      const changed = opts.dryRun
        ? readings
        : readings.filter((r) => ledgerWritten.get(`${narrativeId}:${r.sessionId}`) !== r.sig);
      if (changed.length) tally(previewUsageEntries(db, changed));
      if (!opts.dryRun) recordUsageEntries(db, narrativeId, agentType, readings);
    }
  } else if (adapter.readUsageMany) {
    // Before readUsage, deliberately: an adapter with both (cline) uses the
    // narrative-level reader to see sessions brane never captured, and its
    // store never shares history between sessions, so one narrative-keyed
    // high-water row is the right shape for it.
    let reading: CostReading | null;
    try {
      reading = adapter.readUsageMany({ sessionIds, foldPath, narrativeId });
    } catch {
      reading = null;
    }
    if (reading) {
      readable = sessionIds.length;
      unit = reading.unit;
      tally(previewUsageHighWater(db, agentType, narrativeId, reading));
      if (!opts.dryRun) recordUsageHighWater(db, narrativeId, agentType, narrativeId, reading);
    }
  } else if (adapter.readUsage) {
    for (const sessionId of sessionIds) {
      let reading: CostReading | null;
      try {
        reading = adapter.readUsage({ sessionId, foldPath, narrativeId });
      } catch {
        reading = null;
      }
      if (!reading) continue;
      readable++;
      unit ??= reading.unit;
      tally(previewUsageHighWater(db, agentType, sessionId, reading));
      if (!opts.dryRun) recordUsageHighWater(db, narrativeId, agentType, sessionId, reading);
    }
  }
  if (readable === 0 || unit === undefined) return null;

  const sample: CostSample = {
    nid: narrativeId,
    agent_type: agentType,
    unit,
    sessions: sessionIds.length,
    readable,
    new_rows: newRows,
    new_amount: Math.round(newAmount * 1e6) / 1e6,
    before: row.cost_amount,
    after: row.cost_amount,
  };
  if (opts.dryRun) {
    // What the column would become: the ledger as it stands plus the new rows,
    // under the same never-down rule as the write path.
    const current = ledgerTotal(db, narrativeId);
    const projected = (current?.unit === unit ? current.amount : 0) + newAmount;
    sample.after = Math.max(row.cost_unit === unit ? (row.cost_amount ?? 0) : 0, projected);
    sample.after = Math.round(sample.after * 1e6) / 1e6;
    return sample;
  }

  const ledger = ledgerTotal(db, narrativeId);
  if (!ledger) return sample;
  // The cached column predates the ledger for older narratives and was summed
  // from transcripts that may since have been purged, so a ledger that only
  // started seeing files today must never pull it down. With ledger rows
  // never removed or re-priced there is no legitimate downward move left, so
  // the max costs nothing and closes the transition.
  const total: CostReading =
    row.cost_unit === ledger.unit && row.cost_amount != null && row.cost_amount > ledger.amount
      ? { ...ledger, amount: row.cost_amount }
      : ledger;
  if (row.cost_amount === total.amount && row.cost_unit === total.unit) return sample;
  db.prepare(
    "UPDATE narratives SET cost_amount = ?, cost_unit = ?, cost_tokens = ? WHERE id = ?",
  ).run(
    total.amount,
    total.unit,
    total.tokens ? JSON.stringify(total.tokens) : null,
    narrativeId,
  );
  sample.unit = total.unit;
  sample.after = total.amount;
  return sample;
}

/** Walk every narrative with a bound session, oldest first, through one
 *  sampling pass each. Oldest first is the point: the ledger credits a message
 *  to the first narrative that inserts it, so an original must be walked
 *  before the twin that forked from it. Only narratives the harness could
 *  still show something for are reported. */
export function backfillCostLedger(
  db: Database.Database,
  opts: { dryRun?: boolean } = {},
): { scanned: number; samples: CostSample[] } {
  const rows = db
    .prepare(
      `SELECT id FROM narratives
        WHERE agent_session_id IS NOT NULL OR session_ids IS NOT NULL
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as Array<{ id: string }>;
  const samples: CostSample[] = [];
  for (const { id } of rows) {
    let sample: CostSample | null;
    try {
      sample = sampleNarrativeCostDetailed(db, id, { dryRun: opts.dryRun });
    } catch {
      sample = null;
    }
    if (sample) samples.push(sample);
  }
  return { scanned: rows.length, samples };
}

// Narratives whose last MCP bridge closed recently, and the time until which
// the sampler should keep reading them. A session's final turns land *after*
// the bridge tears down — Claude Code writes the closing assistant message
// once MCP is gone — so a connected-only sampler permanently missed them and
// the ledger only caught up on a manual backfill. In-memory, like
// `ledgerWritten`: a disconnect straddling a daemon restart loses its linger,
// and `brane cost backfill` remains the recovery for that.
const costLinger = new Map<string, number>();

/** How long a narrative stays sampled after its last bridge closes. The
 *  final message is usually written within seconds, but a slow teardown
 *  (compaction summary, a long last turn still streaming) can take a minute
 *  or more to reach the transcript — and with unsynchronized 20 s ticks the
 *  last guaranteed sample lands up to ~20 s before this deadline, so the
 *  window carries margin past that minute. Each extra tick on an unchanged
 *  transcript costs one stat. */
const COST_LINGER_MS = 120_000;

/** Called on a narrative's last-bridge close (the same 1→0 transition that
 *  broadcasts `mcp_disconnected`): keep sampling it for a little while. */
export function lingerCostSampling(nid: string, now = Date.now()): void {
  costLinger.set(nid, now + COST_LINGER_MS);
}

/** The set the sampler reads this tick: every connected narrative plus the
 *  recently disconnected, evicting linger entries that have expired or
 *  reconnected (a reconnect is sampled as connected; letting its stale
 *  deadline also survive would double-extend a later disconnect). Exported
 *  for tests; mutates `linger` as the eviction. */
export function costSampleTargets(
  connected: Set<string>,
  linger: Map<string, number> = costLinger,
  now = Date.now(),
): Set<string> {
  const targets = new Set(connected);
  for (const [nid, until] of linger) {
    if (connected.has(nid) || until <= now) {
      linger.delete(nid);
      continue;
    }
    targets.add(nid);
  }
  return targets;
}

// Periodically refresh cumulative cost for connected narratives — plus the
// just-disconnected, for the few ticks a session's final turns are still
// landing in its transcript — and push any change to control clients. Beyond
// the linger window a disconnected session isn't spending, so its cost is
// static until it reconnects. The adapter memoizes on the transcript's
// (size, mtime), so an unchanged file costs just a stat. 20s trades freshness
// for load.
function startCostSampler(
  db: Database.Database,
  controlClients: Set<ControlClient>,
  mcpClients: Set<McpBridgeClient>,
): NodeJS.Timeout {
  return setInterval(() => {
    for (const nid of costSampleTargets(mcpConnectedNids(mcpClients))) {
      const reading = sampleNarrativeCost(db, nid);
      if (reading) {
        broadcastMeta(controlClients, nid, {
          cost_amount: reading.amount,
          cost_unit: reading.unit,
        });
      }
    }
  }, 20_000);
}

// Read tool calls out of crush's own session log, for the one harness that
// cannot report them itself: crush has a PreToolUse hook but no PostToolUse
// event, and no call id in the pre payload to pair the halves with, so every
// call would strand as pending. Its database has both halves — and writes the
// first one while the call is still running — so the same pending -> completed
// shape arrives by the session_log lane instead of the hook lane.
//
/** The crush tool-log poller: armed by a crush bridge connecting, and it stops
 *  itself when the last one goes. */
interface CrushToolSampler {
  /** Called for every MCP bridge that connects. Starts the timer on the first
   *  crush one and is a single string comparison for everyone else. */
  armFor(agentType: string | undefined): void;
  stop(): void;
}

interface CopilotToolSampler {
  armFor(agentType: string | undefined): void;
  stop(): void;
}

/** Codex's reader, driven from **two** directions over one shared cursor.
 *
 *  Like crush and copilot it gets a timer, armed by the first codex bridge and
 *  stopped when the last leaves, because that is the only way to show a call
 *  *while it runs* rather than after the burst containing it ends.
 *
 *  Unlike them it is *also* flushed by the agent's own MCP calls, and that is
 *  worth keeping rather than folding into the timer. An agent in the LIVE loop
 *  cannot make progress without calling `narrate` or `listen`, so every such
 *  call is a free flush signal arriving at exactly the right instant: the
 *  moment before a narration is written. Flushing there means the calls that
 *  led to a narration are anchored *under* it rather than after it, and that a
 *  session going quiet leaves nothing dangling for up to a poll interval.
 *
 *  The two cannot collide. The cursor is a byte offset, so whichever runs first
 *  advances it and the other finds nothing; a tick over an unchanged rollout
 *  costs one `stat`.
 *
 *  Cursors live here rather than in the module, matching the other two, and are
 *  dropped when a narrative's last bridge goes. */
interface CodexToolSampler {
  /** Called for every MCP bridge that connects. Starts the timer on the first
   *  codex one and is a single string comparison for everyone else. */
  armFor(agentType: string | undefined): void;
  /** Flush this client's rollout inline, before its tool call is dispatched.
   *  A no-op, and one string comparison, for every non-codex agent. */
  flushFor(client: McpBridgeClient): void;
  /** Forget a narrative's cursor once its bridge is gone. A revive re-reads
   *  from zero, which the row-level guard in pollCodexToolLog makes cheap. */
  release(narrativeId: string): void;
  stop(): void;
}

/** Exported for tests — the arm/stop lifecycle and the shared cursor are the
 *  parts worth pinning, and neither is reachable without standing up a daemon
 *  otherwise. `pollMs <= 0` disables the timer and leaves the inline flush,
 *  which is both the config escape hatch and what the tests drive. */
export function startCodexToolSampler(
  db: Database.Database,
  mcpClients: Set<McpBridgeClient>,
  push: (row: ToolUseRow) => void,
  pollMs: number,
  /** Root of codex's rollout store. Overridden only by tests, against a
   *  fixture tree; production reads the real one. */
  sessionsRoot?: string,
): CodexToolSampler {
  const cursors = new Map<string, CodexLogCursor>();
  let timer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  /** Read one narrative's rollout onward from wherever its cursor stopped.
   *  Shared by the timer and the inline flush so there is exactly one place
   *  that knows how a codex narrative is read. */
  const drain = (narrativeId: string, sessionId: string): void => {
    let cursor = cursors.get(narrativeId);
    if (!cursor) {
      cursor = newCodexLogCursor();
      cursors.set(narrativeId, cursor);
    }
    for (const toolUse of pollCodexToolLog(db, narrativeId, sessionId, cursor, sessionsRoot)) {
      push(toolUse);
    }
  };

  const tick = (): void => {
    const connected = new Set<string>();
    for (const client of mcpClients) {
      if (client.agentType === "codex" && client.ws.readyState === WebSocket.OPEN) {
        connected.add(client.narrativeId);
      }
    }
    for (const nid of cursors.keys()) if (!connected.has(nid)) cursors.delete(nid);
    if (connected.size === 0) {
      // Nothing to watch. The next codex bridge to connect re-arms.
      stop();
      return;
    }
    const nids = [...connected];
    const rows = db
      .prepare(`SELECT id, agent_session_id FROM narratives WHERE id IN (${nids.map(() => "?").join(", ")})`)
      .all(...nids) as Array<{ id: string; agent_session_id: string | null }>;
    for (const row of rows) {
      if (row.agent_session_id) drain(row.id, row.agent_session_id);
    }
  };

  return {
    armFor(agentType) {
      // `pollMs <= 0` turns the timer off and leaves the inline flush running,
      // which is the difference from crush and copilot: for them that setting
      // disables capture entirely, here it falls back to the MCP-call-driven
      // behaviour, which is still complete — just less immediate.
      if (pollMs <= 0 || agentType !== "codex" || timer) return;
      timer = setInterval(tick, pollMs);
      // `unref` so a daemon shutting down is never held open by this — it is a
      // best-effort observer, not work anyone is waiting on.
      timer.unref?.();
    },
    flushFor(client) {
      if (client.agentType !== "codex") return;
      try {
        const row = db
          .prepare("SELECT agent_session_id FROM narratives WHERE id = ?")
          .get(client.narrativeId) as { agent_session_id: string | null } | undefined;
        if (row?.agent_session_id) drain(client.narrativeId, row.agent_session_id);
      } catch (err) {
        // Telemetry must never be able to fail the agent's own tool call.
        console.error(`[codex-log] flush for ${client.narrativeId} failed: ${err}`);
      }
    },
    release(narrativeId) {
      cursors.delete(narrativeId);
    },
    stop,
  };
}

/** Copilot persists both sides of every tool call in its session JSONL. Like
 * crush, poll only while a matching bridge is connected and stay read-only. */
function startCopilotToolSampler(
  db: Database.Database,
  mcpClients: Set<McpBridgeClient>,
  push: (row: ToolUseRow) => void,
  pollMs: number,
): CopilotToolSampler {
  if (pollMs <= 0) return { armFor: () => {}, stop: () => {} };
  const cursors = new Map<string, CopilotLogCursor>();
  let timer: NodeJS.Timeout | null = null;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    cursors.clear();
  };
  const tick = (): void => {
    const connected = new Set<string>();
    for (const client of mcpClients) {
      if (client.agentType === "copilot" && client.ws.readyState === WebSocket.OPEN) {
        connected.add(client.narrativeId);
      }
    }
    for (const nid of cursors.keys()) if (!connected.has(nid)) cursors.delete(nid);
    if (connected.size === 0) {
      stop();
      return;
    }
    const nids = [...connected];
    const rows = db
      .prepare(`SELECT id, agent_session_id FROM narratives WHERE id IN (${nids.map(() => "?").join(", ")})`)
      .all(...nids) as Array<{ id: string; agent_session_id: string | null }>;
    for (const row of rows) {
      if (!row.agent_session_id) continue;
      let cursor = cursors.get(row.id);
      if (!cursor) {
        cursor = newCopilotLogCursor();
        cursors.set(row.id, cursor);
      }
      for (const toolUse of pollCopilotToolLog(db, row.id, row.agent_session_id, cursor)) {
        push(toolUse);
      }
    }
  };
  return {
    armFor(agentType) {
      if (agentType !== "copilot" || timer) return;
      timer = setInterval(tick, pollMs);
      timer.unref?.();
    },
    stop,
  };
}

// This runs often when it runs at all, so almost all of its work is avoiding
// work — and none of that work should land on someone who doesn't use crush.
// Hence the layering:
//
//   - **No crush, ever: no timer.** The interval is not created at daemon
//     start; it is armed by the first crush bridge to connect and cleared when
//     the last one leaves. A daemon that never runs crush pays one string
//     comparison per MCP connection, and nothing recurring at all. Arming on
//     connect rather than resolving once at boot matters because a crush agent
//     can be spawned into a running daemon at any time.
//   - **Crush connected, idle:** one query covering every crush narrative at
//     once, then the reader's stat gate, so an unchanged log is never opened.
//   - **Crush working:** one read-only open, because something actually
//     happened.
//
// That gate is what pays for the interval. 2s rather than the cost sampler's
// 20s because the point of this poller is showing a call *while it runs*, and a
// pending row that surfaces twenty seconds in has missed most of what it was
// for. `crush_tool_log.poll_ms` tunes it; 0 turns it off.
function startCrushToolSampler(
  db: Database.Database,
  mcpClients: Set<McpBridgeClient>,
  push: (row: ToolUseRow) => void,
  pollMs: number,
): CrushToolSampler {
  if (pollMs <= 0) return { armFor: () => {}, stop: () => {} };
  const cursors = new Map<string, CrushLogCursor>();
  let timer: NodeJS.Timeout | null = null;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    cursors.clear();
  };
  const tick = (): void => {
    // The gate is in memory, not in SQL: every bridge resolves its narrative's
    // agent_type from the row once at connect, so a daemon with no crush agent
    // never queries anything — the tick walks a handful of open sockets and
    // returns. Only crush pays for crush.
    const connected = new Set<string>();
    for (const client of mcpClients) {
      if (client.agentType === "crush" && client.ws.readyState === WebSocket.OPEN) {
        connected.add(client.narrativeId);
      }
    }
    for (const nid of cursors.keys()) {
      // Drop state for sessions that went away, so this can't grow unbounded
      // across a long-lived daemon. Re-reading from the top on reconnect is
      // free: recordToolUse is idempotent.
      if (!connected.has(nid)) cursors.delete(nid);
    }
    // The last crush agent left. Stop entirely rather than keep ticking over an
    // empty set — the next one to connect arms this again.
    if (connected.size === 0) {
      stop();
      return;
    }

    const nids = [...connected];
    const rows = db
      .prepare(
        `SELECT id, fold_path, created_at, session_ids FROM narratives
          WHERE id IN (${nids.map(() => "?").join(", ")})`,
      )
      .all(...nids) as Array<{
      id: string;
      fold_path: string;
      created_at: number;
      session_ids: string | null;
    }>;

    for (const row of rows) {
      const nid = row.id;
      let cursor = cursors.get(nid);
      if (!cursor) {
        cursor = newCrushLogCursor();
        cursors.set(nid, cursor);
      }
      let sessionIds: string[] | undefined;
      try {
        const parsed = row.session_ids ? JSON.parse(row.session_ids) : null;
        if (Array.isArray(parsed)) sessionIds = parsed.filter((s) => typeof s === "string");
      } catch {
        // A malformed column falls back to discovery rather than stopping.
      }
      const written = pollCrushToolLog(
        db,
        nid,
        {
          foldPath: fromPortablePath(row.fold_path),
          sessionIds,
          narrativeCreatedAtMs: row.created_at,
        },
        cursor,
      );
      for (const toolUse of written) push(toolUse);
    }
  };

  return {
    armFor(agentType) {
      if (agentType !== "crush" || timer) return;
      timer = setInterval(tick, pollMs);
      // `unref` so a daemon shutting down is never held open by this — it is a
      // best-effort observer, not work anyone is waiting on.
      timer.unref?.();
    },
    stop,
  };
}

// Push a brane-wide activity ping to clients on the activity stream. One frame
// per real state change (a new event landed), carrying the new head seq and the
// server's wall-clock time so the list can stamp last_activity without a fetch.
// The head-seq lookup is skipped entirely when no client is on the stream.
function broadcastActivity(
  db: Database.Database,
  controlClients: Set<ControlClient>,
  narrativeId: string,
): void {
  let msg: string | null = null;
  for (const client of controlClients) {
    if (!client.activity || client.ws.readyState !== WebSocket.OPEN) continue;
    if (msg === null) {
      msg = JSON.stringify({
        type: "activity",
        narrative: narrativeId,
        seq: getMaxSeq(db, narrativeId),
        time: Date.now(),
      });
    }
    client.ws.send(msg);
  }
}

// Poll for new events across all subscribed narratives and push hints
function startControlPoller(
  db: Database.Database,
  controlClients: Set<ControlClient>,
): NodeJS.Timeout {
  return setInterval(() => {
    for (const client of controlClients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      for (const [narrativeId, lastSeenSeq] of client.subscriptions) {
        const headSeq = getMaxSeq(db, narrativeId);
        if (headSeq > lastSeenSeq) {
          try {
            client.ws.send(
              JSON.stringify({
                type: "new_events",
                narrative: narrativeId,
                head_seq: headSeq,
                count: headSeq - lastSeenSeq,
              }),
            );
            // Only advance cursor if send didn't throw
            client.subscriptions.set(narrativeId, headSeq);
          } catch {
            // Send failed — leave cursor so we retry next poll
          }
        }
      }
    }
  }, 500);
}

interface MemoryIndexerHandle {
  interval: NodeJS.Timeout;
  /** Signal shutdown to the active indexing pass; cooperative cancel. */
  abort(): void;
  /** Resolves once any currently-running indexing pass completes. */
  inflight(): Promise<void>;
  /** Run a pass on demand (`POST /api/memory/index`). Waits for any inflight
   *  pass first, then owns the next one — never two at once. */
  run(rebuild: boolean): Promise<IndexStats>;
}

// Periodically run incremental memory indexing in the background, with a
// single-flight guard so a slow run can't pile up against the next tick.
// An immediate pass runs on startup so a freshly restarted daemon catches
// up before the operator's first search. `abort()` + `inflight()` let
// shutdown cooperatively cancel the active pass between batches before
// `disposeEmbeddingModel()` releases the ONNX session, so the worker
// thread isn't mid-mutex when the native runtime tears down.
/** A runner that never overlaps. `run(arg)` waits out any pass already in
 *  flight — whatever became of it — then owns the next one, so a caller gets
 *  its *own* pass's result or rejection, never a predecessor's. Two callers
 *  released by the same pass re-check in turn: the first claims the slot
 *  synchronously in its continuation, so the second sees it taken and waits
 *  again. Exported so `src/test/thin-cli.test.ts` can pin exactly that. */
export function singleFlight<A, T>(
  pass: (arg: A) => Promise<T>,
): { run(arg: A): Promise<T>; busy(): boolean; inflight(): Promise<void> } {
  let inflight: Promise<void> | null = null;
  const run = async (arg: A): Promise<T> => {
    while (inflight) await inflight.catch(() => undefined);
    let result!: T;
    const mine = (async () => {
      try {
        result = await pass(arg);
      } finally {
        inflight = null;
      }
    })();
    inflight = mine;
    await mine;
    return result;
  };
  return {
    run,
    busy: () => inflight !== null,
    inflight: () => inflight?.catch(() => undefined) ?? Promise.resolve(),
  };
}

function startMemoryIndexer(db: Database.Database): MemoryIndexerHandle {
  const controller = new AbortController();
  const flight = singleFlight((rebuild: boolean) => runIndex(db, rebuild, controller.signal));
  const tick = () => {
    if (flight.busy()) return;
    if (controller.signal.aborted) return;
    if (!hasUnindexedEvents(db)) return;
    flight.run(false).catch((err) => {
      console.error("background memory indexing failed:", err);
    });
  };
  tick();
  return {
    interval: setInterval(tick, 5 * 60 * 1000),
    abort: () => controller.abort(),
    inflight: flight.inflight,
    run: flight.run,
  };
}

// ── MCP Bridge WebSocket ────────────────────────────────────────────────

export interface McpBridgeClient {
  ws: WebSocket;
  narrativeId: string;
  // The agent's own session ID (e.g. CLAUDE_CODE_SESSION_ID), forwarded by
  // the bridge at connect. Stamped onto every event this connection writes
  // (meta.session.id) — including foreign narrations, which correctly carry
  // the *author's* session rather than the host narrative's.
  agentSessionId?: string;
  // Agent type (claude, codex, goose, …) resolved once at connect. Selects
  // this connection's listen long-poll hold — see listenTimeoutFor().
  agentType?: string;
  // Track pending listen calls: callId → { cursors, startTime }
  pendingListens: Map<string, PendingListen>;
  // Told of every park and resolution in `pendingListens`, so the daemon can
  // say which narratives are waiting for direction. Absent in tests that
  // drive `startMcpListen` directly.
  awaiting?: AwaitingTracker;
}

interface PendingListen {
  cursors: Record<string, number>;
  startTime: number;
  /** The raw MCP name the call is captured under, for settling its row:
   *  `listen`, or `narrate` when it was asked to wait. */
  toolName: string;
  /** Fields the result carries besides the listen shape — a waiting
   *  narrate's `nid`, `seq` and `warnings`. */
  extra?: Record<string, unknown>;
  /** Everything this call would return right now, or null to keep waiting.
   *  Closes over `before`/`tail` and the mention predicate — the 500 ms poller
   *  used to re-derive its own answer from `cursors` alone, so a bounded
   *  listen resolved differently depending on which path happened to fire. */
  check: () => Record<string, unknown> | null;
  /** The one place a listen result is built, shared by the immediate check,
   *  the wakeup and the poller — including the mention receipt, which settles
   *  state and so must never be assembled twice or skipped on one path. */
  reply: (events: Record<string, unknown> | null, waitedMs: number, timedOut: boolean) => void;
  /** Unregisters this call's wakeup callbacks. A call that outlives its
   *  socket must run it, or its waiters stay in `listenWaiters` forever. */
  cleanup: () => void;
}

/**
 * Resolve the authoritative narrative id for an MCP bridge connection.
 *
 * If `clientNid` already names a narrative row, the connection is a spawned
 * agent (or a reconnect/revive) — trust it as-is. Otherwise the client is
 * unspawned and its self-chosen id is untrusted: mint a fresh server-side
 * `external-<8 base36>` id (crypto-random, collision-resistant, same shape as
 * spawned ids) and INSERT it so the session becomes a first-class narrative.
 *
 * Returning a server-generated id means an unspawned client can never *create*
 * a narrative with an id of its choosing, nor masquerade as a spawned agent
 * type. (Attaching to an *existing* id remains possible for any token-holder —
 * that is the pre-existing cross-narrative narration capability, gated by the
 * bearer token, and is unchanged here.)
 */
// Re-exported from ../ids.js so existing importers (and tests) keep working.
export { randomBase36 };

/**
 * Mint a fresh server-side external narrative (crypto-random `external-<8>` id,
 * same shape as spawned ids) and seed its `started` event. Used both for
 * genuinely unspawned clients and as the safe fallback when a claimed nid fails
 * bind verification — a rejected claimant never gets the id it asked for.
 */
export function mintExternalNarrative(db: Database.Database, braneId: string): string {
  return mintExternalNarrativeWithSecret(db, braneId).nid;
}

/** `mintExternalNarrative`, plus the agent token minted for it — the one
 *  moment its plaintext exists, which `welcome` hands to the bridge. */
export function mintExternalNarrativeWithSecret(
  db: Database.Database,
  braneId: string,
  mintedBy?: string,
): { nid: string; secret: string } {
  let nid = `external-${randomBase36(8)}`;
  // Vanishingly unlikely, but guarantee uniqueness against the PRIMARY KEY.
  while (db.prepare("SELECT 1 FROM narratives WHERE id = ?").get(nid)) {
    nid = `external-${randomBase36(8)}`;
  }
  // Externals carry a bind token like every other narrative. Before the grace
  // path was retired they didn't need one: a reconnecting external presented
  // the id it had adopted from `welcome` and no secret, and the `bind_token IS
  // NULL` branch waved it through. With that branch gone, a tokenless external
  // would be refused on every reconnect and minted afresh each time — the
  // bridge's "reconnects reuse the same narrative" comment would quietly stop
  // being true, and the litter this whole area exists to reduce would multiply.
  // So the daemon mints the secret here and hands it back in `welcome`. The
  // secret is an agent token: hashed in `tokens`, never kept in plaintext.
  db.prepare(
    `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status)
     VALUES (?, ?, 'external', 'external', ?, 'active')`,
  ).run(nid, braneId, Date.now());
  const secret = mintAgentToken(db, nid);
  if (mintedBy) recordLauncher(db, nid, mintedBy);
  appendEvent(db, nid, "started", { content: "Connected external MCP client" });
  return { nid, secret };
}

export function ensureMcpNarrative(db: Database.Database, braneId: string, clientNid: string): string {
  const exists = db.prepare("SELECT 1 FROM narratives WHERE id = ?").get(clientNid);
  if (exists) return clientNid;
  return mintExternalNarrative(db, braneId);
}

export interface McpBindResult {
  /** The narrative id this connection is authorized to bind to. */
  nid: string;
  /** True when a fresh external narrative was minted (unspawned client, or a
   *  rejected claim that fell through to the safe path). */
  minted: boolean;
  /** The minted narrative's agent token, when `minted`: handed to the bridge
   *  in `welcome`, the only time its plaintext exists. */
  secret?: string;
  /** Present only when an existing-narrative claim failed verification.
   *
   *  `no_bind_token` is its own reason rather than being folded into
   *  `secret_absent`: the client may well have presented a secret, and the
   *  refusal is a property of the *row* (spawned before #354, so there is
   *  nothing to check against). Reporting "secret absent" for a client that
   *  sent one would send whoever reads the log looking in the wrong place. */
  rejected?: { claimedNid: string; reason: "secret_absent" | "secret_mismatch" | "no_bind_token" };
}

/**
 * Decide which narrative an `/ws/mcp` connection may bind to. This is the
 * security gate that prevents a crossed `BRANE_NARRATIVE_ID` (or a second
 * process reusing an nid) from binding as a narrative it does not own.
 *
 * - Claimed id names no row → unspawned/external client: mint a fresh id
 *   (unchanged legacy behavior — self-chosen ids are never trusted).
 * - Claimed id names a row and the presented secret equals its `bind_token` →
 *   authenticated: bind to the claimed id.
 * - Otherwise (secret absent, wrong, or the row has no token at all) → refuse:
 *   mint a fresh external id and report the rejection. The claimed narrative is
 *   left completely untouched.
 *
 * The migration grace that used to sit in the middle of that list is gone. It
 * allowed an unauthenticated bind to any row whose `bind_token` was null —
 * every narrative spawned before #354 (2026-07-17) — and was documented from
 * the day it landed as something to remove after one release. It outlived that
 * by a long way: on the machine this was retired from it had waved through 110
 * binds across four narratives, all of them legitimate reconnects, while
 * leaving 607 tokenless rows bindable by any bearer-token holder with no
 * secret at all.
 */
export function resolveMcpBind(
  db: Database.Database,
  braneId: string,
  clientNid: string,
  secret: string | undefined,
  /** The token whose request dialed: recorded as a minted external's
   *  `minted_by`, so the external's agent token is in that token's cascade
   *  and retired with it by a rotation (claude-jrjh1e8w:13 #2). */
  dialer?: string,
): McpBindResult {
  const row = db.prepare("SELECT 1 FROM narratives WHERE id = ?").get(clientNid);

  if (!row) {
    const minted = mintExternalNarrativeWithSecret(db, braneId, dialer);
    return { nid: minted.nid, minted: true, secret: minted.secret };
  }
  // The secret is the narrative's agent token, checked by hash. An empty
  // string is never one (no token is minted empty), so `&secret=` with nothing
  // after it can't bind.
  if (secret && verifyAgentToken(db, clientNid, secret)) {
    return { nid: clientNid, minted: false };
  }
  const hasLiveToken =
    db.prepare("SELECT 1 FROM tokens WHERE kind = 'agent' AND owner_nid = ? AND revoked_at IS NULL").get(clientNid) !==
    undefined;
  const reason = !hasLiveToken ? "no_bind_token" : secret ? "secret_mismatch" : "secret_absent";
  const minted = mintExternalNarrativeWithSecret(db, braneId, dialer);
  return { nid: minted.nid, minted: true, secret: minted.secret, rejected: { claimedNid: clientNid, reason } };
}

/** Hard ceiling on rows returned by one `tool_uses` request, and the default
 *  when a client asks for none or asks for nonsense. */
export const TOOL_USES_MAX_LIMIT = 500;

/** Byte ceiling on one `tool_uses` response, which the row count never was.
 *
 *  Rows went out verbatim and uncapped, bounded only by a count — so one open
 *  of a busy narrative was a **3.65 MB** response, and on a ~60KB/s Tailscale
 *  path that request simply never finished: the rows stayed invisible on that
 *  client while a laptop on a fast link rendered them fine
 *  (claude-n1izig04:66/:74). A count cannot bound bytes when a single `Read`
 *  output can be half a megabyte.
 *
 *  Excerpting alone doesn't fix it either — 500 rows at the 16KB excerpt cap is
 *  still ~8MB — so the page stops at whichever comes first, and the cursor the
 *  response already carries says where to resume. */
export const TOOL_USES_MAX_BYTES = 512 * 1024;

/** Trim a probed page to what may actually go on the wire: excerpt every row,
 *  then stop at the row count or the byte budget, whichever binds first.
 *
 *  Always yields at least one row when the page has one. A row whose excerpt
 *  alone exceeds the budget would otherwise return an empty page with
 *  `truncated: true` and a cursor pointing at itself — a client politely
 *  paging forever through nothing. */
export function fitToolUses(
  probed: ToolUseRow[],
  limit: number,
): { rows: ToolUseRow[]; truncated: boolean } {
  const rows: ToolUseRow[] = [];
  let bytes = 0;
  for (const row of probed.slice(0, limit)) {
    const excerpted = excerptForPush(row);
    const size =
      (excerpted.input?.length ?? 0) + (excerpted.output?.length ?? 0) + (excerpted.error?.length ?? 0);
    if (rows.length > 0 && bytes + size > TOOL_USES_MAX_BYTES) {
      return { rows, truncated: true };
    }
    rows.push(excerpted);
    bytes += size;
  }
  return { rows, truncated: probed.length > limit };
}

/** Parse a numeric config value, falling back (loudly) on anything that isn't
 *  a finite number. Silent NaN is worse than a wrong number: it disables the
 *  behavior the knob exists to tune, with nothing in the log to say so. */
export function numericConfig(raw: string | undefined | null, fallback: number, name?: string): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    console.warn(`[config] ${name ?? "value"}=${JSON.stringify(raw)} is not a number; using ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * Verify a narrative credential pair presented by a *non-MCP* client — today
 * the agent-harness hook, which POSTs before the bearer-token check.
 *
 * Strict where `resolveMcpBind` is forgiving: no minting. (Neither accepts a
 * null `bind_token` any more — the bridge's migration grace is gone.) A bridge
 * that fails verification still has a
 * session to keep alive, so it falls through to a fresh external narrative;
 * a hook has nothing to salvage, so it is simply refused and the tool call
 * proceeds unrecorded. Returns the narrative's context on success, null on
 * every failure — one shape, so a caller can't accidentally treat "no such
 * narrative" as an authenticated bind (claude-8fkbabsx:9, finding 4).
 */
export function verifyNarrativeBind(
  db: Database.Database,
  claimedNid: string,
  secret: string,
): { nid: string; agentType: string | null } | null {
  const row = db
    .prepare("SELECT agent_type FROM narratives WHERE id = ?")
    .get(claimedNid) as { agent_type: string | null } | undefined;
  if (!row || !secret || !verifyAgentToken(db, claimedNid, secret)) return null;
  return { nid: claimedNid, agentType: row.agent_type };
}

/** Count live (OPEN) MCP clients currently bound to `nid`, optionally skipping
 *  one connection. Used to drive connect/disconnect status broadcasts off the
 *  0↔1 client-count transition rather than off every individual socket. */
export function boundClientCount(
  mcpClients: Set<McpBridgeClient>,
  nid: string,
  exclude?: McpBridgeClient,
): number {
  let n = 0;
  for (const c of mcpClients) {
    if (c === exclude) continue;
    if (c.narrativeId === nid && c.ws.readyState === WebSocket.OPEN) n++;
  }
  return n;
}

/* `resolveConcurrentBind` lived here and is gone with the grace path.
 *
 * It answered one question — may this connection bind to the narrative it
 * claims, when a live sibling is already bound there under a different agent
 * session? — and it had two answers. For an authenticated bind the answer was
 * always yes: post-#354 the secret *is* proof of identity, so a parent bridge,
 * a reconnecting bridge and a subagent bridge are facets of one agent and
 * coexist. Only an unauthenticated grace bind could be a crossed
 * `BRANE_NARRATIVE_ID` worth evicting, and there is no such bind any more.
 * What remained was a function whose sole parameter was permanently false, and
 * a session-conflict guard that could never fire — a trap for the next reader
 * rather than a protection. `git log -S resolveConcurrentBind` has it.
 */

function handleMcpBridgeSocket(
  ws: WebSocket,
  db: Database.Database,
  braneId: string,
  mcpClients: Set<McpBridgeClient>,
  controlClients: Set<ControlClient>,
  narrativeId: string,
  listenWaiters: Map<string, Set<() => void>>,
  settle: SettleCall,
  crushSampler: CrushToolSampler,
  copilotSampler: CopilotToolSampler,
  codexSampler: CodexToolSampler,
  notifyListenWaiters: (nid: string) => void,
  recordEventMentions: RecordEventMentions,
  agentSessionId?: string,
  awaiting?: AwaitingTracker,
  mintedSecret?: string,
): void {
  // Post-#354, presenting the correct per-narrative secret *is* proof of being
  // that agent, so every connection that reaches here binds to the narrative
  // resolveMcpBind handed it and concurrent connections coexist — the parent
  // bridge, a reconnecting bridge, and a subagent bridge are all facets of the
  // same agent. Unauthenticated claims never reach this point: they were
  // refused upstream and arrive bound to a freshly minted external id.
  const boundNid = narrativeId;

  const agentRow = db
    .prepare("SELECT agent_type, agent_session_id, fold_path, created_at FROM narratives WHERE id = ?")
    .get(boundNid) as
    | { agent_type?: string; agent_session_id?: string | null; fold_path?: string; created_at?: number }
    | undefined;
  const client: McpBridgeClient = {
    ws,
    narrativeId: boundNid,
    agentSessionId,
    agentType: agentRow?.agent_type,
    pendingListens: new Map(),
    awaiting,
  };
  // 0→1 transition: this connection is the first live client for the narrative.
  // A secondary connection (reconnect storm, subagent bridge) must not
  // re-broadcast `mcp_connected` — and, symmetrically, its later close must not
  // flash the narrative offline while a sibling still holds it.
  const firstForNarrative = boundClientCount(mcpClients, boundNid) === 0;
  mcpClients.add(client);
  // A revive waiting to type its prompt may now (src/daemon/revive-prompt.ts).
  bridgeConnected(boundNid);
  // One string comparison for every agent; starts the tool-log poller only for
  // the one harness that needs it, and only from the moment it connects.
  crushSampler.armFor(client.agentType);
  copilotSampler.armFor(client.agentType);
  codexSampler.armFor(client.agentType);
  db.prepare("UPDATE narratives SET status = 'active' WHERE id = ?").run(boundNid);
  // agent_session_id — the narrative's *current* session pointer — is owned by
  // the daemon (written at spawn / revive-fork from a uuid it minted itself). The
  // connection-supplied session id is retained on the client object above for
  // event stamping/observability only and is never written to the narrative row,
  // so no ordering of connections can clobber the pointer. We still record it in
  // the cumulative session set so #355's cross-session cost aggregation keeps
  // counting this session — that set is orthogonal to the row pointer.
  if (agentSessionId) {
    recordSessionId(db, boundNid, agentSessionId);
  }
  // Capture-strategy agents (e.g. codex) generate their own session id rather
  // than accepting a daemon-assigned one, and the bridge can't self-report it
  // (its detection is claude-specific). On the first bind where the pointer is
  // still unset, capture this narrative's session from the agent's own store so
  // revive has a real id to `resume`. See maybeCaptureSessionId for the scoping
  // and no-clobber guarantees.
  maybeCaptureSessionId(
    db,
    boundNid,
    agentRow?.agent_type,
    agentRow?.fold_path,
    agentRow?.created_at,
    agentRow?.agent_session_id,
  );
  // 0→1 transition only: a secondary connection (reconnect storm, subagent
  // bridge) must not re-broadcast `mcp_connected`.
  if (firstForNarrative) {
    broadcastStatus(controlClients, boundNid, "mcp_connected");
  }

  // Send welcome with brane_id, the authoritative narrative id, and that
  // narrative's bind secret.
  //
  // The secret is not a disclosure: this connection is bound to `boundNid`,
  // which post-grace means it either presented that secret already (a spawned
  // agent, reading it from its tmux env) or was just minted the narrative
  // outright (an external, which has no other way to learn it). A claim that
  // proved nothing never lands here — it is refused upstream and rebound to a
  // fresh external id, whose secret is then the one it legitimately owns.
  //
  // What it buys is the external reconnect: the bridge adopts both fields and
  // presents them on the next dial, so "reconnects reuse the same narrative"
  // becomes something proven rather than something the grace path allowed.
  //
  // Only a freshly minted narrative's secret can be sent: the daemon keeps
  // agent tokens as hashes, so it has the plaintext only at the moment it
  // minted it. A spawned agent's bridge already holds its own from the env.
  const boundSecret = mintedSecret;
  ws.send(JSON.stringify({ type: "welcome", brane_id: braneId, narrative_id: boundNid, bind_secret: boundSecret }));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log(`[mcp-ws] received type=${msg.type} tool=${msg.tool ?? "n/a"} id=${msg.id ?? "n/a"}`);
      if (msg.type === "tool_call") {
        handleMcpToolCall(client, db, msg.id, msg.tool, msg.args ?? {}, braneId, listenWaiters, settle, controlClients, mcpClients, notifyListenWaiters, recordEventMentions, codexSampler);
      } else if (msg.type === "tool_cancel") {
        cancelMcpCall(client, String(msg.id), settle);
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    mcpClients.delete(client);
    // A listen (or a waiting narrate) parked on this socket can no longer be
    // answered. Leaving it pending was worse than dropping it: its wakeups
    // stayed registered, and the next event ran its reply — settling mentions
    // into a socket that drops the send, so a mention was marked delivered,
    // and read, by an agent that never saw it. Retire each call exactly as the
    // shutdown flush does, minus the send: unregister, settle its tool row, no
    // mention receipt. Deleted from mcpClients above, the poller never sees it
    // again either.
    for (const pending of client.pendingListens.values()) {
      pending.cleanup();
      settle(client.narrativeId, pending.toolName, pending.startTime, Date.now());
      client.awaiting?.resolved(client.narrativeId, "closed");
    }
    client.pendingListens.clear();
    // Only the 1→0 transition (no live siblings left on this narrative) is a
    // real disconnect. A secondary connection closing while the owner stays
    // bound must not broadcast `mcp_disconnected` nor run the tmux/`ended`
    // check — that would flash the narrative offline mid-session.
    //
    // Edge (benign): if two siblings tear down near-simultaneously, each may see
    // the other already past OPEN (boundClientCount counts only OPEN sockets), so
    // both observe 0-remaining and both run this tail. The broadcasts and the
    // `ended` write are idempotent, so the worst case is a duplicate
    // `mcp_disconnected` — strictly better than the old broadcast-on-every-close.
    if (boundClientCount(mcpClients, boundNid) > 0) return;
    // Last bridge for this narrative is gone, so its rollout cursor is dead
    // weight. A revive re-reads from zero, which the row-level guard makes
    // cheap.
    codexSampler.release(boundNid);
    broadcastStatus(controlClients, boundNid, "mcp_disconnected");
    // The session's final turns are still landing in its transcript — keep
    // the cost sampler on it for a few more ticks (see costLinger above).
    lingerCostSampling(boundNid);
    // MCP disconnect ≠ tmux dead. The agent may have exited its LIVE loop,
    // context-compacted, or crashed inside the REPL while tmux stays alive
    // and revivable. Only flip to `ended` if the tmux session is actually gone.
    // Keyed to boundNid so a rejected/rebound intruder's disconnect can never
    // flip the real narrative to `ended`.
    let tmuxAlive = false;
    try {
      execFileSync(resolveTmux(), ["has-session", "-t", boundNid], { stdio: "ignore" });
      tmuxAlive = true;
    } catch {}
    if (!tmuxAlive) {
      db.prepare("UPDATE narratives SET status = 'ended' WHERE id = ?").run(boundNid);
      broadcastStatus(controlClients, boundNid, "ended");
    }
  });
}

/** How many mentions a single receipt carries. The rest stay owed and surface
 *  in later receipts — capping the display never drops one, because `markSent`
 *  covers every pending row rather than only the shown slice. */
function mentionReceiptLimit(db: Database.Database): number {
  return numericConfig(getConfig("mentions.receipt_limit", db), 10, "mentions.receipt_limit");
}

/** The mention half of a `listen` / `narrate` receipt.
 *
 *  Runs over the events that call is about to return, and does three things in
 *  an order that matters:
 *
 *  1. **Acknowledges.** Handing an agent the very event that mentions it is
 *     the acknowledgment — the evidence and the attention are the same act.
 *     Keyed on the seqs actually returned, never on the cursor bound: `before`
 *     truncates a range and `tail: N` skips the middle, so "seq > after" would
 *     settle mentions the agent was never shown.
 *  2. **Annotates.** An event that mentions someone says so inline, where the
 *     agent is already reading, rather than leaving it to correlate a separate
 *     array against seqs by hand.
 *  3. **Reports what is still owed**, and marks it sent.
 *
 *  Acking first is what keeps a mention delivered in this very batch from also
 *  being reported as outstanding.
 *
 *  `markSent` covers every pending row rather than the shown slice, so the
 *  capped remainder can't re-wake the agent the moment it parks again. And the
 *  fields are absent when empty — a call with no mentions in play gets the
 *  byte-identical result it always did. */
function mentionReceipt(
  db: Database.Database,
  selfNid: string,
  braneId: string,
  events: Record<string, unknown>,
  /** `"all"` replays every recent mention, settled or not — the recovery read,
   *  for an agent that suspects it missed one. `"dismiss"` settles everything
   *  outstanding: the escape hatch for a mention rightly judged irrelevant,
   *  which would otherwise reappear forever. */
  mode?: "all" | "dismiss",
): Record<string, unknown> {
  const delivered: Record<string, number[]> = {};
  for (const [key, list] of Object.entries(events)) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const nid = resolveNarrativeId(key, selfNid);
    (delivered[nid] ??= []).push(...list.map((e: any) => e.seq as number));
  }

  ackMentionsByRead(db, selfNid, delivered);

  const annotations = mentionsInEvents(db, delivered);
  if (Object.keys(annotations).length > 0) {
    for (const [key, list] of Object.entries(events)) {
      if (!Array.isArray(list)) continue;
      const nid = resolveNarrativeId(key, selfNid);
      for (const e of list as any[]) {
        const hit = annotations[`${nid}:${e.seq}`];
        if (hit) e.mentions = hit;
      }
    }
  }

  if (mode === "dismiss") dismissMentions(db, selfNid);

  const limit = mentionReceiptLimit(db);
  const rows =
    mode === "all"
      ? allMentions(db, selfNid, limit, braneId)
      : pendingMentions(db, selfNid, limit, braneId).rows;
  const total = pendingMentions(db, selfNid, limit, braneId).total;

  // Always, even on a recovery read: `sent_at` records that these reached the
  // agent, and it is the only thing standing between an unread mention and a
  // `listen` that resolves instantly forever.
  markSent(db, selfNid);

  return {
    ...(rows.length > 0 && { mentions: rows }),
    ...(total > rows.length && { mentions_pending: total }),
  };
}

/** Builds the mention recorder.
 *
 *  Scanning lives here rather than inside `appendEvent` for two reasons:
 *  `appendEvent` also writes `started`/`restarted`/`binding_rejected`, which
 *  are not anybody's prose, and a hook that low would be one more thing for a
 *  future append site to inherit silently. The returned function is called
 *  explicitly from the sites that write what an agent or an operator actually
 *  *said*.
 *
 *  (`brane absorb` never reaches either — it writes raw INSERTs — so years of
 *  imported history can't page a fleet of agents on import.)
 *
 *  A factory rather than a closure inside `startDaemon` so the real recorder,
 *  guards and all, is what the end-to-end tests drive. */
export function createMentionRecorder(
  db: Database.Database,
  notifyListenWaiters: (nid: string) => void,
): RecordEventMentions {
  const enabled = getConfig("mentions.enabled", db) !== "false";
  const narrativeExists = db.prepare("SELECT 1 FROM narratives WHERE id = ?");

  /** Records the mentions in one just-appended event and wakes whoever is new.
   *
   *  `hostNid` is the narrative the event landed in; `author` is who wrote it,
   *  which differs on a foreign narration and is the one the receipt should
   *  name. A mention of the host narrative itself is skipped: the event is
   *  already in that log and already woke it, so a row would be a duplicate
   *  with an extra wake attached. So is a mention of the author. */
  return function recordEventMentions(hostNid, event, author): void {
    if (!enabled || !event.content) return;
    let mentioned: string[];
    try {
      mentioned = extractMentions(
        event.content,
        // Not the host (the event is already in that log), and not the author:
        // a foreign narration that says `@<self>` would otherwise mention the
        // one narrative that wrote it — ending its own `narrate({ wait })` at
        // once, with a mention whose source the author's cursor never reads,
        // so it came back in every receipt until dismissed.
        (nid) => nid !== hostNid && nid !== author && narrativeExists.get(nid) !== undefined,
      );
    } catch (err) {
      // A malformed-markdown throw must never cost the narration itself.
      console.error("mention scan failed:", err);
      return;
    }
    if (mentioned.length === 0) return;
    const fresh = recordMentions(db, {
      mentionedNids: mentioned,
      srcNarrative: hostNid,
      srcSeq: event.seq,
      author,
      time: event.time,
    });
    // Only the rising edge wakes: a re-scan of an event already in the ledger
    // returns nothing here, which is what makes a re-scan safe to run against
    // live narratives.
    for (const nid of fresh) notifyListenWaiters(nid);
  };
}

/** Records the mentions carried by one just-appended conversational event.
 *  Built by `createMentionRecorder` and threaded to the handlers that write
 *  prose. */
export type RecordEventMentions = (
  hostNid: string,
  event: { seq: number; content?: string; time: number },
  author: string,
) => void;

/** Makes a just-appended conversational event visible: mentions first, then
 *  the wake.
 *
 *  The order is the whole point, and it is not interchangeable. A `listen`
 *  parked on this narrative is resolved *synchronously* inside
 *  `notifyListenWaiters` — the waiter's callback builds its receipt and calls
 *  `ackMentionsByRead` right there. Notify first and that ack runs against a
 *  mentions row that has not been inserted yet: it updates zero rows, the row
 *  lands `seen_at NULL`, and because the agent's cursor has now moved past the
 *  event, no ordinary forward read will ever return it again. The mention is
 *  delivered, read, and permanently unsettled — reappearing in every later
 *  receipt until someone reads backwards or dismisses it. Observed live in
 *  claude-9o0vgfvb:14 through claude-9o0vgfvb:17.
 *
 *  Recording first also gets the wakes right rather than merely later:
 *  `recordEventMentions` notifies the *mentioned* narratives itself, after the
 *  insert, so the sequence is insert → wake the mentioned → wake this
 *  narrative's watchers, and every waiter that can be handed the event finds
 *  the row already there.
 *
 *  One function rather than the order open-coded at each conversational
 *  append site: this bug was six independent chances to get two lines wrong,
 *  and a seventh site added later would have had nothing to remind it. */
export function announceEvent(
  hostNid: string,
  event: { seq: number; content?: string; time: number },
  author: string,
  notifyListenWaiters: (nid: string) => void,
  recordEventMentions?: RecordEventMentions,
): void {
  recordEventMentions?.(hostNid, event, author);
  notifyListenWaiters(hostNid);
}

/** Fires every wakeup parked on `nid`, leaving registration to the wakeups.
 *
 *  A wakeup that resolves its call unregisters itself (`cleanup`); one that
 *  finds no arrival stays registered for the next event. This used to clear the
 *  set after firing, which was harmless only while every event was an arrival.
 *  Once the caller's own narration stopped counting as one, it fired the
 *  caller's own wakeup, which found nothing and was then cleared, leaving the
 *  listen to the 500 ms poller. Iterates a copy, since a resolving wakeup
 *  deletes itself mid-loop. */
export function wakeListenWaiters(listenWaiters: Map<string, Set<() => void>>, nid: string): void {
  const waiters = listenWaiters.get(nid);
  if (!waiters) return;
  for (const cb of [...waiters]) cb();
}

function resolveNarrativeId(key: string, selfId: string): string {
  return key === "self" ? selfId : key;
}

/**
 * Normalize a cursor parameter (after, before, or tail) from narrate/listen calls.
 * Accepts: number, string (coerced to number), or object with numeric/string values.
 * Throws on truly invalid input so agents get a clear error.
 *
 * @param paramName - parameter name for error messages (e.g. "after", "before", "tail")
 * @param defaultValue - value to use when raw is null/undefined (default: { self: 0 })
 */
function normalizeCursors(raw: unknown, paramName: string, defaultValue?: Record<string, number>): Record<string, number> | undefined {
  if (raw == null) return defaultValue;

  // Simple numeric cursor
  if (typeof raw === "number") return { self: raw };

  // String that looks like a number — coerce it (common codex bug)
  if (typeof raw === "string") {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid ${paramName} value: "${raw}" is not a valid cursor number`);
    }
    return { self: n };
  }

  // Object map of narrative IDs → cursors
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const result: Record<string, number> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof val === "number") {
        result[key] = val;
      } else if (typeof val === "string") {
        const n = Number(val);
        if (!Number.isFinite(n)) {
          throw new Error(`Invalid ${paramName} value for "${key}": "${val}" is not a valid cursor number`);
        }
        result[key] = n;
      } else {
        throw new Error(`Invalid ${paramName} value for "${key}": expected number, got ${typeof val}`);
      }
    }
    return Object.keys(result).length > 0 ? result : defaultValue;
  }

  throw new Error(`Invalid ${paramName} parameter: expected number or object, got ${typeof raw}`);
}

/**
 * `whoami`'s result. The recovery surface: delivery elsewhere is at-most-once —
 * a tool result can be dropped by a socket closing mid-flight — so `whoami`
 * reports mentions *without* settling anything: it is the call a restarted
 * agent makes before it has any cursor, and the one to reach for when
 * something might have been missed.
 *
 * `install_dir` is where this daemon's package lives. The prelude points every
 * agent there for brane's own documentation (`AGENTS.md`, `docs/`, which ship
 * in the tarball); it is the one place an agent in another fold can learn it.
 */
export function whoamiResult(
  db: Database.Database,
  narrativeId: string,
  braneId: string,
  installDir: string = INSTALL_DIR,
): Record<string, unknown> {
  const row = db.prepare("SELECT fold_path, agent_type, role FROM narratives WHERE id = ?").get(narrativeId) as
    | { fold_path: string | null; agent_type: string | null; role: string | null }
    | undefined;
  const recent = allMentions(db, narrativeId, mentionReceiptLimit(db), braneId);
  const owed = pendingMentions(db, narrativeId, mentionReceiptLimit(db), braneId);
  return {
    narrative_id: narrativeId,
    brane_id: braneId,
    ...(row && {
      fold_dir: row.fold_path ? fromPortablePath(row.fold_path) : undefined,
      agent_type: row.agent_type ?? undefined,
      role: row.role ?? undefined,
    }),
    install_dir: resolve(installDir),
    // Absent when there are none, so a brane with no mentions in play
    // gets the response it always did.
    ...(recent.length > 0 && { mentions: recent }),
    ...(owed.total > 0 && { mentions_pending: owed.total }),
  };
}

function handleMcpToolCall(
  client: McpBridgeClient,
  db: Database.Database,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  braneId: string,
  listenWaiters: Map<string, Set<() => void>>,
  settle: SettleCall,
  controlClients: Set<ControlClient>,
  mcpClients: Set<McpBridgeClient>,
  notifyListenWaiters: (nid: string) => void,
  recordEventMentions: RecordEventMentions,
  codexSampler?: CodexToolSampler,
): void {
  // Flush codex's rollout inline, in addition to its timer: this is the moment
  // before a narration is written, so the calls that led to it anchor under it
  // rather than after it, and a session going quiet leaves nothing dangling for
  // up to a poll interval. Before the dispatch `try` and swallowing its own
  // failures, so an unreadable log never surfaces as a tool error on the
  // agent's own narrate or listen. See startCodexToolSampler.
  codexSampler?.flushFor(client);
  try {
    switch (tool) {
      case "narrate": {
        // `notifyListenWaiters`, not a local re-implementation: a second copy
        // here used to wake waiters without pushing `broadcastActivity`, so a
        // narration was invisible to the activity stream — and any later hook
        // added to one and not the other is an invisible half-feature.
        const meta = args.meta as Record<string, string> | undefined;
        const result = handleMcpNarrate(
          args,
          db,
          client.narrativeId,
          notifyListenWaiters,
          client.agentSessionId,
          recordEventMentions,
          braneId,
        ) as Record<string, unknown>;
        if (result.error) {
          sendToolError(client.ws, callId, result.error as string);
        } else if (result.park) {
          // Posted; now the listen half, on the same call. Everything that
          // arrived since the caller's cursor comes back at once, as a receipt
          // would; otherwise it parks like any listen.
          const { park, ...extra } = result as unknown as NarrateWaitPlan;
          startMcpListen(client, db, callId, { after: park.after }, listenWaiters, settle, braneId, {
            omit: park.omit,
            extra,
          });
        } else {
          sendToolResult(client.ws, callId, result);
        }
        // Broadcast metadata updates to control clients
        if (meta?.summary) {
          broadcastMeta(controlClients, client.narrativeId, { summary: meta.summary });
        }
        // A narration means the transcript just grew — refresh cost promptly
        // (instead of waiting for the periodic sampler) and push any change.
        const costReading = sampleNarrativeCost(db, client.narrativeId);
        if (costReading) {
          broadcastMeta(controlClients, client.narrativeId, {
            cost_amount: costReading.amount,
            cost_unit: costReading.unit,
          });
        }
        break;
      }
      case "listen": {
        // Start async listen — tracked in pendingListens
        startMcpListen(client, db, callId, args, listenWaiters, settle, braneId);
        break;
      }
      case "whoami": {
        sendToolResult(client.ws, callId, whoamiResult(db, client.narrativeId, braneId));
        break;
      }
      case "revive": {
        try {
          const result = reviveNarrative(db, args.session as string, {
            prompt: args.prompt as string | undefined,
            no_prompt: args.no_prompt as boolean | undefined,
            agent: args.agent as string | undefined,
            // Every MCP client is an agent: a spawned session or an external.
            byAgent: true,
          });
          sendToolResult(client.ws, callId, result);
        } catch (err) {
          sendToolError(client.ws, callId, err instanceof Error ? err.message : String(err));
        }
        break;
      }
      case "list_protocols": {
        // `commands` and `namespaces` are for the app's linkifier; an agent
        // reads this at startup, so it gets only what it uses.
        const { protocols, ignored } = listProtocols(protocolLibraryFor(db, client.narrativeId), toPortablePath);
        sendToolResult(client.ws, callId, { protocols, ignored });
        break;
      }
      case "read_protocol": {
        try {
          const read = readProtocol(protocolLibraryFor(db, client.narrativeId), args.name as string, {
            from: args.from as string | undefined,
            noPrelude: args.no_prelude === true,
            display: toPortablePath,
            installDir: INSTALL_DIR,
          });
          sendToolResult(client.ws, callId, read);
        } catch (err) {
          sendToolError(client.ws, callId, err instanceof Error ? err.message : String(err));
        }
        break;
      }
      case "narrative_search": {
        // Scope search to requested branes, falling back to caller's brane
        const searchBranes = resolveBraneIds(db, args, client.narrativeId);
        startNarrativeSearch(client.ws, db, callId, args, searchBranes);
        break;
      }
      case "narrative_info": {
        // Scope browse mode to requested branes, falling back to caller's brane
        const infoBranes = resolveBraneIds(db, args, client.narrativeId);
        sendToolResult(client.ws, callId, handleNarrativeInfo(db, args, mcpConnectedNids(mcpClients), infoBranes));
        break;
      }
      case "list_peers": {
        sendToolResult(client.ws, callId, handleListPeers(db, client.narrativeId, args));
        break;
      }
      case "list_branes": {
        sendToolResult(client.ws, callId, handleListBranes(db, client.narrativeId));
        break;
      }
      case "list_wiki": {
        const sources = resolveWikiSources(db, client.narrativeId, args);
        sendToolResult(client.ws, callId, {
          sources: sources.map((s) => ({
            source: s.source,
            fold_path: s.fold_path,
            shared_only: s.shared_only === true,
          })),
          pages: listWiki(sources, {
            source: args.source as string | undefined,
            order: args.order as "slug" | "title" | "mtime" | undefined,
            filter: args.filter as string | undefined,
          }),
        });
        break;
      }
      case "read_wiki": {
        const wikiResult = handleReadWiki(db, client.narrativeId, args);
        if (wikiResult && typeof wikiResult === "object" && "error" in wikiResult) {
          sendToolError(client.ws, callId, String((wikiResult as { error: string }).error));
        } else {
          sendToolResult(client.ws, callId, wikiResult);
        }
        break;
      }
      case "search_wiki": {
        const sources = resolveWikiSources(db, client.narrativeId, args);
        startWikiSearch(client.ws, db, callId, args, sources);
        break;
      }
      default:
        sendToolError(client.ws, callId, `Unknown tool: ${tool}`);
    }
  } catch (err) {
    sendToolError(client.ws, callId, String(err));
  }
}

/** What a `strict: true` narration gets back instead of being posted.
 *
 *  A tool error rather than a result field, so the bridge maps it to MCP
 *  `isError: true` and the caller sees a failed call to retry rather than a
 *  success to skim. It carries the whole diagnostic — the fallback included —
 *  because the caller has to rewrite the markdown from it, and a refusal that
 *  says only "no" costs a turn without buying anything.
 */
function formatStrictRefusal(warnings: MarkdownDiagnostic[]): string {
  const lines = warnings.map((w) => {
    const where = w.line === undefined ? "" : ` (line ${w.line})`;
    return `- ${w.kind}${where}: ${w.message} Renders as: ${w.fallback}`;
  });
  return [
    "Narration not posted: strict was requested and the markdown would not render as written.",
    ...lines,
    "Fix the source and narrate again — or narrate without `strict` to post it as-is.",
  ].join("\n");
}

/** What `handleMcpNarrate` returns when asked to wait: the narration has been
 *  written, and `park` is the listen the dispatcher starts in its place. */
export interface NarrateWaitPlan {
  nid: string;
  seq: number;
  warnings?: MarkdownDiagnostic[];
  park: {
    /** The cursor to listen on, with every key resolved to a number. */
    after: Record<string, number>;
    /** The narration just written, which is neither handed back nor the
     *  arrival that ends the wait — wherever it landed. */
    omit: { nid: string; seq: number };
  };
}

/** The cursor a `narrate({ wait: true })` parks on, or why it won't wait.
 *
 *  Any cursor `listen` accepts is accepted here, multi-narrative included,
 *  since the listen half is `listen` itself (claude-2il811nw:31). A key left
 *  `undefined` is resolved after the append to that narrative's head: an
 *  omitted `after` means "wait for what comes next", not narrate's usual `0`,
 *  which would hand back the whole narrative instead of waiting at all. With
 *  no `after`, that is the caller's own narrative, plus the target of a
 *  foreign narration — "ask, and wake me when either side answers".
 *
 *  `before` and `tail` read history, which has nothing to wait for. They
 *  don't refuse the call — that would cost the caller the narration and a
 *  turn to resend it — so the narrate posts as usual and says it didn't
 *  wait. */
/** A boolean tool argument, read the way `normalizeCursors` reads a cursor:
 *  some clients send `"true"` / `"false"` as strings. Read as a bare truthiness
 *  test, `listen({ wait: "false" })` blocked instead of reading, and read as
 *  `=== true`, `narrate({ wait: "true" })` quietly didn't wait. Anything
 *  else means the default. */
export function toolFlag(raw: unknown, fallback: boolean): boolean {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  return fallback;
}

export function narrateWaitCursor(
  args: Record<string, unknown>,
  selfNarrativeId: string,
): { after: Record<string, number | undefined> } | { ignored: string } {
  if (args.before !== undefined || args.tail !== undefined) {
    return { ignored: "`before`/`tail` read history, so this narrate did not wait: call `listen` next." };
  }
  const cursors = normalizeCursors(args.after ?? args.heard, "after");
  if (cursors) return { after: cursors };
  const after: Record<string, number | undefined> = { self: undefined };
  const target = args.nid as string | undefined;
  if (target !== undefined && target !== selfNarrativeId) after[target] = undefined;
  return { after };
}

export function handleMcpNarrate(
  args: Record<string, unknown>,
  db: Database.Database,
  selfNarrativeId: string,
  notifyListenWaiters: (nid: string) => void,
  agentSessionId?: string,
  /** Records the mentions carried by the event just appended. Optional so the
   *  handler stays directly testable; the daemon always supplies it. */
  recordEventMentions?: RecordEventMentions,
  /** The caller's brane, for stamping cross-brane mentions on the receipt.
   *  Absent in direct tests, which skips the mention half entirely. */
  braneId?: string,
): unknown {
  const say = args.say as string;
  const targetNarrative = (args.nid as string) ?? selfNarrativeId;
  const re = args.re as Array<number | string> | undefined;
  const meta = args.meta as Record<string, string> | undefined;
  const rawPayloads = args.payloads as string[] | undefined;

  // Diagnostics run before the first write, not after the append, because
  // `strict` can refuse: a refused narration must leave nothing behind — no
  // summary update, and above all no payload files copied into managed storage,
  // which nothing here is allowed to delete afterwards. See
  // src/markdown-diagnostics.ts for what it reports and why.
  const warnings = typeof say === "string" ? diagnoseMarkdown(say) : [];
  // Read as a flag, like `wait` below: `strict: "true"` used to fall through
  // `=== true` and post the very narration its author asked to have refused.
  if (toolFlag(args.strict, false) && warnings.length > 0) {
    return { error: formatStrictRefusal(warnings) };
  }
  // Every *validation* that can refuse the call is resolved before the first
  // write — all three cursors, the wait plan, and the foreign target — because
  // a refusal must leave nothing behind. (An I/O failure is not covered: a
  // payload path that exists but can't be read still throws from the copy
  // below, after the summary write.) A malformed `tail` used to throw only
  // after the narration was appended, handing the agent an error for words
  // already posted, which it would reasonably post again. An unknown foreign
  // target used to refuse after the summary was updated and payloads copied.
  //
  // `"true"` as well as `true`: the same clients that send cursors as strings
  // (see normalizeCursors) send this as one, and a dropped wait returns at
  // once, looking like an ordinary receipt.
  const wait = toolFlag(args.wait, false) ? narrateWaitCursor(args, selfNarrativeId) : undefined;
  const afterCursors = normalizeCursors(args.after ?? args.heard, "after", { self: 0 })!;
  const beforeCursors = normalizeCursors(args.before, "before");
  const tailCursors = normalizeCursors(args.tail, "tail");
  const isForeign = targetNarrative !== selfNarrativeId;
  if (isForeign && !db.prepare("SELECT 1 FROM narratives WHERE id = ?").get(targetNarrative)) {
    return { error: `Unknown narrative: ${targetNarrative}` };
  }

  // Store metadata if provided. `agent_session_id` is deliberately NOT written
  // here: it is owned by the daemon (minted at spawn / revive-fork), never by a
  // client-reported value. Accepting `meta.session_id` was a clobber path — the
  // bridge's env/process-tree self-detection is unreliable, so a stray value
  // could overwrite the daemon's authoritative id. Summary remains client-set.
  if (meta) {
    if (meta.summary) {
      db.prepare("UPDATE narratives SET summary = ? WHERE id = ?").run(meta.summary, selfNarrativeId);
    }
    // Retain the reported session in the cumulative set (for cross-session cost).
    if (meta.session_id) recordSessionId(db, selfNarrativeId, meta.session_id);
  }

  // Copy agent-provided file paths into managed payload storage
  let payloadPaths: string[] | undefined;
  if (Array.isArray(rawPayloads) && rawPayloads.length > 0) {
    const dir = getPayloadsDir(targetNarrative);
    const now = Date.now();
    payloadPaths = [];
    for (let i = 0; i < rawPayloads.length; i++) {
      const srcPath = rawPayloads[i];
      if (!existsSync(srcPath)) continue;
      const ext = extname(srcPath) || ".bin";
      const storedName = `${now}_${i}${ext}`;
      copyFileSync(srcPath, join(dir, storedName));
      payloadPaths.push(`${targetNarrative}/${storedName}`);
    }
    if (payloadPaths.length === 0) payloadPaths = undefined;
  }

  // Author-relative session pointer: the writing connection belongs to the
  // *author* (selfNarrativeId), so its session correctly attributes both
  // self-narrations and foreign narrations (which land in another narrative
  // but were authored here). offset/model are filled later by the indexer.
  const session = agentSessionId ? { id: agentSessionId } : undefined;

  let appended: NarrativeEvent;
  if (isForeign) {
    const event = (appended = appendEvent(db, targetNarrative, "agent_signal", {
      content: say,
      source: selfNarrativeId,
      re,
      payloads: payloadPaths,
      meta: session ? { session } : undefined,
    }));
    // The author, not the host: this landed in someone else's narrative but
    // was written here, and a mention's receipt has to name who said it.
    announceEvent(targetNarrative, event, selfNarrativeId, notifyListenWaiters, recordEventMentions);
  } else {
    const event = (appended = appendEvent(db, selfNarrativeId, "narration", {
      content: say,
      source: selfNarrativeId,
      re,
      payloads: payloadPaths,
      meta: session ? { session } : undefined,
    }));
    announceEvent(selfNarrativeId, event, selfNarrativeId, notifyListenWaiters, recordEventMentions);
  }

  if (wait && "after" in wait) {
    // No receipt here: the caller's listen half builds it, mentions
    // included, once there is something to return.
    const after: Record<string, number> = {};
    for (const [key, value] of Object.entries(wait.after)) {
      after[key] = value ?? getMaxSeq(db, resolveNarrativeId(key, selfNarrativeId));
    }
    return {
      nid: targetNarrative,
      seq: appended.seq,
      ...(warnings.length > 0 && { warnings }),
      park: { after, omit: { nid: targetNarrative, seq: appended.seq } },
    } satisfies NarrateWaitPlan & Record<string, unknown>;
  }

  // The receipt leaves out the event this call just wrote. The caller has
  // every word of it already — it is the `say` they sent — and `seq` below
  // says where it landed. Echoing it put each narration into the caller's
  // context twice, to be re-read on every later turn: across one month's
  // sessions, narrate receipts were 7.8M characters, most of them the
  // caller's own words handed back (claude-tnlxg5pg:21). Everything else in
  // range is still returned, since that is what a receipt is for.
  const withoutAppended = (nid: string, list: NarrativeEvent[]) =>
    nid === targetNarrative ? list.filter((e) => e.seq !== appended.seq) : list;
  const events: Record<string, unknown> = {};
  for (const key of Object.keys(afterCursors)) {
    const nid = resolveNarrativeId(key, selfNarrativeId);
    events[key] = withoutAppended(nid, readEvents(db, nid, {
      after: afterCursors[key],
      before: beforeCursors?.[key],
      tail: tailCursors?.[key],
    }));
  }
  // Also handle keys that appear only in before/tail but not after
  for (const key of new Set([...Object.keys(beforeCursors ?? {}), ...Object.keys(tailCursors ?? {})])) {
    if (!(key in afterCursors)) {
      const nid = resolveNarrativeId(key, selfNarrativeId);
      events[key] = withoutAppended(nid, readEvents(db, nid, {
        before: beforeCursors?.[key],
        tail: tailCursors?.[key],
      }));
    }
  }

  // Warnings ride back on the receipt, and only when there are any: a narration
  // that renders as written gets the byte-identical result it always did. They
  // are advisory unless the caller asked for `strict` — an agent that let this
  // gate its every narration would be trading the pace of the conversation for
  // typography, which is the wrong trade in a live loop.
  // Mentions ride back the same way, and carry more weight: an ignored warning
  // is a typographic blemish, an ignored mention is a dropped message.
  return {
    nid: targetNarrative,
    seq: getMaxSeq(db, targetNarrative),
    events,
    ...(warnings.length > 0 && { warnings }),
    // Only on a narrate that asked to wait and didn't — a receipt otherwise
    // reads exactly as one always has.
    ...(wait && "ignored" in wait && { wait_ignored: wait.ignored }),
    ...(braneId ? mentionReceipt(db, selfNarrativeId, braneId, events) : {}),
  };
}

export function startMcpListen(
  client: McpBridgeClient,
  db: Database.Database,
  callId: string,
  args: Record<string, unknown>,
  listenWaiters: Map<string, Set<() => void>>,
  settle: SettleCall,
  braneId: string,
  /** Set when a `narrate({ wait: true })` is parking after its append. */
  narrateWait?: { omit: { nid: string; seq: number }; extra: Record<string, unknown> },
): void {
  const toolName = narrateWait ? NARRATE_TOOL_NAME : LISTEN_TOOL_NAME;
  console.log(`[listen-enter] callId=${callId} after=${JSON.stringify(args.after)} nid=${client.narrativeId}`);
  const wait = toolFlag(args.wait, true);
  const mentionMode = args.mentions === "all" || args.mentions === "dismiss" ? args.mentions : undefined;

  const afterCursors = normalizeCursors(args.after ?? args.heard, "after", { self: 0 })!;
  const beforeCursors = normalizeCursors(args.before, "before");
  const tailCursors = normalizeCursors(args.tail, "tail");
  const cursors = afterCursors;

  const emptyEvents = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(cursors)) out[key] = [];
    return out;
  };
  const reply = (
    events: Record<string, unknown> | null,
    waitedMs: number,
    timedOut: boolean,
  ) => {
    const payload = events ?? emptyEvents();
    sendToolResult(client.ws, callId, {
      ...narrateWait?.extra,
      events: payload,
      waited_ms: waitedMs,
      timed_out: timedOut,
      // Same synchronous block as the send, always. `mentionReceipt` marks
      // these sent, and if that didn't happen before the result went out, the
      // agent's next listen would find them still unsent and resolve at once —
      // forever, at inference speed, with no operator in the loop.
      ...mentionReceipt(db, client.narrativeId, braneId, payload, mentionMode),
    });
  };

  // A mention resolves a listen exactly as an event does. Without this the
  // wake below finds nothing to return and parks again, and the mention waits
  // out the full hold — up to 3400s for claude.
  const mentionWaiting = () => mentionMode !== undefined || hasUnsentMentions(db, client.narrativeId);

  const read = () => checkForEvents(db, cursors, client.narrativeId, beforeCursors, tailCursors, narrateWait?.omit);

  /** Everything this call would return right now, or null to keep waiting. */
  const check = (): Record<string, unknown> | null => {
    const { events, arrived } = read();
    if (arrived) return events;
    return mentionWaiting() ? events : null;
  };

  const immediateResult = check();
  console.log(`[listen-check] callId=${callId} immediate=${!!immediateResult}`);
  if (immediateResult) {
    reply(immediateResult, 0, false);
    return;
  }

  // Non-blocking mode: return what is in range, even if it is only the
  // caller's own words — they end no wait, but a read still hands them back.
  if (!wait) {
    reply(read().events, 0, false);
    return;
  }

  // No events yet — register as pending listen with wakeup callback
  const startTime = Date.now();
  client.pendingListens.set(callId, {
    cursors,
    startTime,
    toolName,
    extra: narrateWait?.extra,
    check,
    reply,
    cleanup: () => cleanup(),
  });
  client.awaiting?.parked(client.narrativeId);

  // Register wakeup callbacks on all watched narratives
  const resolvedNids = Object.entries(cursors).map(
    ([key]) => resolveNarrativeId(key, client.narrativeId),
  );
  console.log(`[listen] registered callId=${callId} nids=${resolvedNids.join(",")}`);

  const wakeup = () => {
    console.log(`[wakeup] callId=${callId} pending=${client.pendingListens.has(callId)} wsOpen=${client.ws.readyState === WebSocket.OPEN}`);
    // Already resolved (by timeout or another wakeup)
    if (!client.pendingListens.has(callId)) return;
    // Nobody to answer. `reply` runs the mention receipt, which marks mentions
    // sent (and, for a source in the cursor, seen) in the same block as the
    // send — and `sendToolResult` drops the send on a closed socket. The close
    // handler retires this call; until it runs, answer nothing and settle
    // nothing, the same rule the poller already keeps.
    if (client.ws.readyState !== WebSocket.OPEN) return;

    const events = check();
    console.log(`[wakeup] events=${events ? "yes" : "no"}`);
    if (events) {
      client.pendingListens.delete(callId);
      cleanup();
      console.log(`[wakeup] sending tool_result for callId=${callId}`);
      reply(events, Date.now() - startTime, false);
      settle(client.narrativeId, toolName, startTime, Date.now());
      client.awaiting?.resolved(client.narrativeId, "delivered");
    }
  };

  const cleanup = () => {
    for (const nid of resolvedNids) {
      listenWaiters.get(nid)?.delete(wakeup);
    }
  };

  for (const nid of resolvedNids) {
    let waiters = listenWaiters.get(nid);
    if (!waiters) {
      waiters = new Set();
      listenWaiters.set(nid, waiters);
    }
    waiters.add(wakeup);
  }
}

/**
 * The agent's harness gave up on a call — the operator pressed Esc, or killed
 * a backgrounded tool task — and the bridge passed its MCP
 * `notifications/cancelled` on. If the call is parked, retire it as the close
 * handler does: unregister, settle its row, no reply (the harness stopped
 * listening for one), and no mention receipt. A cancelled listen is the
 * clearest evidence there is that the agent is no longer waiting for
 * direction, so the awaiting glow goes out now rather than at the next event
 * or the hour-long timeout.
 *
 * A call that isn't parked — already answered, or a tool that never parks —
 * is left alone: its work is done or finishing, and the bridge drops the
 * result. Returns whether a parked call was retired.
 */
export function cancelMcpCall(
  client: McpBridgeClient,
  callId: string,
  settle: SettleCall,
): boolean {
  const pending = client.pendingListens.get(callId);
  if (!pending) return false;
  client.pendingListens.delete(callId);
  pending.cleanup();
  settle(client.narrativeId, pending.toolName, pending.startTime, Date.now());
  client.awaiting?.resolved(client.narrativeId, "cancelled");
  console.log(`[listen] cancelled callId=${callId} nid=${client.narrativeId}`);
  return true;
}

function checkForEvents(
  db: Database.Database,
  afterCursors: Record<string, number>,
  selfNarrativeId: string,
  beforeCursors?: Record<string, number>,
  tailCursors?: Record<string, number>,
  /** One event to leave out — the narration a `narrate({ wait: true })`
   *  just wrote, which must neither be handed back nor count as the arrival
   *  that ends the wait. */
  omit?: { nid: string; seq: number },
): { events: Record<string, unknown>; arrived: boolean } {
  const events: Record<string, unknown> = {};
  let arrived = false;

  // Collect all narrative keys from all cursor maps
  const allKeys = new Set([
    ...Object.keys(afterCursors),
    ...Object.keys(beforeCursors ?? {}),
    ...Object.keys(tailCursors ?? {}),
  ]);

  for (const key of allKeys) {
    const nid = resolveNarrativeId(key, selfNarrativeId);
    let evts = readEvents(db, nid, {
      after: afterCursors[key],
      before: beforeCursors?.[key],
      tail: tailCursors?.[key],
    });
    if (omit && nid === omit.nid) {
      evts = evts.filter((e) => e.seq !== omit.seq);
    }
    events[key] = evts;
    // The caller's own events are returned but are never an arrival: its own
    // narration must not wake its parked listen, end its waiting narrate, or
    // make a blocking listen return at once. An agent whose cursor trails its
    // last narration (every agent, since #508's receipt omits it) would
    // otherwise be woken by its own words on every wait. `source` is
    // server-stamped, so the test is exact; lifecycle rows carry none and do
    // count. Anything else in range brings the caller's words back with it.
    if (evts.some((e) => e.source !== selfNarrativeId)) arrived = true;
  }

  return { events, arrived };
}

/** The caller's protocol namespaces, most local first: its fold's, the
 *  operator's `~/.brane/protocols`, and the built-ins (`protocolNamespaces`).
 *  See docs/protocols.md. */
function protocolNamespacesFor(foldAbs: string | undefined): NamespaceDir[] {
  return protocolNamespaces(foldAbs, join(getBraneDir(), "protocols"), PROTOCOLS_DIR);
}

/** A narrative's fold as an absolute path, if it has one. */
function narrativeFoldAbs(db: Database.Database, nid: string | null | undefined): string | undefined {
  if (!nid) return undefined;
  const row = db.prepare("SELECT fold_path FROM narratives WHERE id = ?").get(nid) as
    | { fold_path: string | null }
    | undefined;
  return row?.fold_path ? resolve(fromPortablePath(row.fold_path)) : undefined;
}

/** The library as the narrative `nid` sees it: what its `read_protocol`
 *  resolves, and so what the app links in its chat. No `nid`: home and the
 *  built-ins. Scanned on every call, so a new or edited file takes effect at
 *  once. */
function protocolLibraryFor(db: Database.Database, nid: string | null | undefined): ProtocolLibrary {
  const approvals = liveApprovals(db);
  return loadProtocolLibrary(protocolNamespacesFor(narrativeFoldAbs(db, nid)), {
    approved: (abs) => approvals.get(toPortablePath(abs))?.sha256,
    display: toPortablePath,
  });
}

/** Where protocol files may be approved: `~/.brane/protocols` and every
 *  registered fold's `.brane/protocols` (src/daemon/protocol-routes.ts). */
function protocolApprovalScope(db: Database.Database): ApprovalScope {
  return approvalScopeFrom(db, {
    homeDir: join(getBraneDir(), "protocols"),
    braneDir: PROTOCOLS_DIR,
    toPortable: toPortablePath,
    fromPortable: fromPortablePath,
  });
}

// ── Wiki (list / read / search) ─────────────────────────────────────────

/**
 * Source labels for every registered fold, assigned once in registration order
 * so a fold has the same label for every caller. A label is the fold's
 * basename; when two folds share one — a git checkout and a global install are
 * both `brane` — the later registration gets `name~2`, `name~3`, and so on.
 * Labels key the wiki index and the dedupe, so they must be unique and stable.
 *
 * `first` names a fold that claims its basename ahead of the others regardless
 * of when it was registered: the install directory, whose shared pages are
 * what every other fold cites. Without it an older fold that happened to share
 * the name — an archived port of the project, say — would push the canonical
 * install to `brane~2` in every citation.
 */
export function wikiFoldLabels(db: Database.Database, first?: string): Map<string, string> {
  const rows = db
    .prepare("SELECT path FROM folds ORDER BY created_at, path")
    .all() as Array<{ path: string }>;
  const ordered = rows.map((r) => resolve(fromPortablePath(r.path)));
  if (first !== undefined) {
    const idx = ordered.indexOf(resolve(first));
    if (idx > 0) ordered.unshift(...ordered.splice(idx, 1));
  }
  const taken = new Set<string>([PROTOCOL_SOURCE_LABEL]);
  const labels = new Map<string, string>();
  for (const abs of ordered) {
    if (labels.has(abs)) continue;
    const base = baseName(abs);
    let label = base;
    for (let n = 2; taken.has(label); n++) label = `${base}~${n}`;
    taken.add(label);
    labels.set(abs, label);
  }
  return labels;
}

/** A fold's wiki as a source, or null when the fold has no `wiki/`. `owned`
 *  is the caller's own fold: it sees local pages; everyone else sees only
 *  `shared/`. */
function foldWikiSource(
  abs: string,
  labels: Map<string, string>,
  owned: boolean,
): WikiSource | null {
  const dir = join(abs, "wiki");
  if (!existsSync(dir)) return null;
  return {
    source: labels.get(abs) ?? baseName(abs),
    dir,
    fold_path: toPortablePath(abs),
    ...(owned ? {} : { shared_only: true }),
  };
}

/** The label the install directory's wiki carries, for the read fallback
 *  that used to hardcode "brane". */
function installWikiLabel(sources: WikiSource[]): string {
  return sources.find((s) => s.dir === join(INSTALL_DIR, "wiki"))?.source ?? baseName(INSTALL_DIR);
}

/**
 * Resolve the wiki sources reachable for a caller: its own fold (owned — local
 * and shared pages alike) plus the install directory's wiki (shared pages only,
 * unless it *is* the caller's fold, as in a dev checkout). Widens to every
 * registered fold's shared pages when `args.all` is set or `args.source` names
 * something the defaults don't satisfy. Dedupes by directory, caller first, so
 * the owned view of a directory always wins over a shared-only view of it.
 */
function resolveWikiSources(
  db: Database.Database,
  callerNid: string,
  args: Record<string, unknown>,
): WikiSource[] {
  const labels = wikiFoldLabels(db, INSTALL_DIR);
  const sources: WikiSource[] = [];
  const seenDirs = new Set<string>();
  const push = (s: WikiSource | null): void => {
    if (s && !seenDirs.has(s.dir)) {
      seenDirs.add(s.dir);
      sources.push(s);
    }
  };

  const callerRow = db
    .prepare("SELECT fold_path FROM narratives WHERE id = ?")
    .get(callerNid) as { fold_path: string | null } | undefined;
  const callerAbs = callerRow?.fold_path ? resolve(fromPortablePath(callerRow.fold_path)) : undefined;
  if (callerAbs) push(foldWikiSource(callerAbs, labels, true));
  push(foldWikiSource(INSTALL_DIR, labels, callerAbs === INSTALL_DIR));

  const wantSource = typeof args.source === "string" ? args.source : undefined;
  const widen =
    args.all === true ||
    (wantSource !== undefined &&
      wantSource !== "all" &&
      !sources.some((s) => s.source === wantSource));
  if (widen) {
    for (const abs of labels.keys()) push(foldWikiSource(abs, labels, abs === callerAbs));
  }

  return sources;
}

/**
 * Resolve wiki sources for an HTTP request, which has no caller narrative to
 * key a fold off. The web client is the operator on their own daemon, so every
 * source is owned — local pages included; the shared/local split scopes what
 * *agents* in other folds can reach, not what the operator can see. Always
 * includes the install directory's wiki; adds every registered fold's wiki,
 * scoped to `braneIds` when given (the client passes its active brane,
 * mirroring how narratives are scoped). With no `braneIds`, every fold.
 */
function resolveWikiSourcesForBranes(
  db: Database.Database,
  braneIds: string[] | undefined,
): WikiSource[] {
  const labels = wikiFoldLabels(db, INSTALL_DIR);
  const sources: WikiSource[] = [];
  const seenDirs = new Set<string>();
  const push = (s: WikiSource | null): void => {
    if (s && !seenDirs.has(s.dir)) {
      seenDirs.add(s.dir);
      sources.push(s);
    }
  };

  push(foldWikiSource(INSTALL_DIR, labels, true));

  const rows =
    braneIds && braneIds.length > 0
      ? (db
          .prepare(
            `SELECT path FROM folds WHERE brane_id IN (${braneIds.map(() => "?").join(", ")})`,
          )
          .all(...braneIds) as Array<{ path: string }>)
      : (db.prepare("SELECT path FROM folds").all() as Array<{ path: string }>);
  for (const f of rows) push(foldWikiSource(resolve(fromPortablePath(f.path)), labels, true));

  return sources;
}

const PROTOCOL_SOURCE_LABEL = protocolSourceLabel("brane");

/** Every wiki source the app's reader may open: the wikis, plus each protocol
 *  namespace as its own source (`protocols`, `protocols:home`, and, given a
 *  narrative with a fold, `protocols:fold`), so the reader shows one file per
 *  page and a shadowed file stays openable. */
function resolveReadableSourcesForBranes(
  db: Database.Database,
  braneIds: string[] | undefined,
  nid?: string | null,
): WikiSource[] {
  const protocolSources = protocolNamespacesFor(narrativeFoldAbs(db, nid)).map(
    (ns): WikiSource => ({ source: protocolSourceLabel(ns.from), dir: ns.dir }),
  );
  return [...resolveWikiSourcesForBranes(db, braneIds), ...protocolSources];
}

function handleReadWiki(
  db: Database.Database,
  callerNid: string,
  args: Record<string, unknown>,
): unknown {
  const sources = resolveWikiSources(db, callerNid, args);
  const slug = args.slug as string;
  let source = args.source as string | undefined;

  // Source optional: if a single source has the page, use it; if several do,
  // ask the caller to disambiguate; mirror the page-not-found message otherwise.
  if (!source) {
    // A page that exists but is local to a fold the caller doesn't own still
    // counts here: choosing it yields the "local, not shared" error, which is
    // the informative answer, rather than a page-not-found.
    const haystack = sources.filter((s) => locatePage(s, slug).status !== "missing");
    if (haystack.length === 1) {
      source = haystack[0].source;
    } else if (haystack.length > 1) {
      return {
        error: `Page "${locatePage(haystack[0], slug).filename}" exists in multiple sources: ${haystack
          .map((s) => s.source)
          .join(", ")}. Pass "source" to disambiguate.`,
      };
    } else {
      source = installWikiLabel(sources);
    }
  }

  // `window` opts into neighbor-aware section reading (current section +
  // surrounding headings) instead of chunk offset/limit pagination.
  if (args.window !== undefined) {
    return readWikiSection(sources, source, slug, {
      anchor: args.anchor as string | undefined,
      window: args.window as number | undefined,
    });
  }

  return readWiki(sources, source, slug, {
    anchor: args.anchor as string | undefined,
    offset: args.offset as number | undefined,
    limit: args.limit as number | undefined,
  });
}

async function startWikiSearch(
  ws: WebSocket,
  db: Database.Database,
  callId: string,
  args: Record<string, unknown>,
  sources: WikiSource[],
): Promise<void> {
  try {
    const query = args.query as string;
    const limit = (args.limit as number) ?? 10;
    const results = await searchWiki(db, sources, query, limit);
    // Match offsets are for the app's snippets; an agent reads the content.
    for (const a of results) for (const h of a.hits) delete h.matches;
    sendToolResult(ws, callId, { query, results });
  } catch (err) {
    sendToolError(ws, callId, String(err));
  }
}

// ── Narrative Search & Log ──────────────────────────────────────────────

/** Resolve brane_ids from tool args, falling back to caller's brane. */
function resolveBraneIds(
  db: Database.Database,
  args: Record<string, unknown>,
  narrativeId: string,
): string[] {
  const explicit = args.brane_ids as string[] | undefined;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit;
  }
  const row = db.prepare(
    "SELECT brane_id FROM narratives WHERE id = ?",
  ).get(narrativeId) as { brane_id: string } | undefined;
  return row ? [row.brane_id] : [];
}

async function startNarrativeSearch(
  ws: WebSocket,
  db: Database.Database,
  callId: string,
  args: Record<string, unknown>,
  braneIds: string[],
): Promise<void> {
  try {
    const query = args.query as string;
    const limit = (args.limit as number) ?? 10;

    initMemorySchema(db);

    const queryVector = await embedText(query);
    const results = searchHybrid(db, queryVector, query, limit, braneIds);

    sendToolResult(ws, callId, {
      query,
      results: results.map((r) => ({
        narrative_id: r.narrative_id,
        seq: r.seq,
        content: r.content,
        score: Math.round(r.score * 100) / 100,
      })),
    });
  } catch (err) {
    sendToolError(ws, callId, String(err));
  }
}

interface LogRow {
  id: string;
  agent_type: string;
  role: string;
  status: string;
  title: string | null;
  summary: string | null;
  last_activity: number;
  event_count: number;
}

interface DetailRow {
  id: string;
  agent_type: string | null;
  role: string | null;
  status: string;
  summary: string | null;
  title: string | null;
  fold_path: string | null;
  created_at: number;
  archived: number;
  event_count: number;
  first_activity: number | null;
  last_activity: number | null;
}

function handleNarrativeInfo(
  db: Database.Database,
  args: Record<string, unknown>,
  connectedNids: Set<string>,
  braneIds: string[],
): unknown {
  // If nid is provided, return detailed info for specific narratives
  const rawNid = args.nid;
  if (rawNid !== undefined) {
    const nids: string[] = Array.isArray(rawNid) ? rawNid as string[] : [rawNid as string];
    const limit = (args.limit as number) ?? 50;
    const targetNids = nids.slice(0, limit);

    if (targetNids.length === 0) {
      return { narratives: [] };
    }

    const placeholders = targetNids.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT
        n.id,
        n.agent_type,
        n.role,
        n.status,
        n.summary,
        n.title,
        n.fold_path,
        n.created_at,
        COALESCE(n.archived, 0) as archived,
        COUNT(e.seq) as event_count,
        MIN(e.time) as first_activity,
        MAX(e.time) as last_activity
      FROM narratives n
      LEFT JOIN events e ON e.narrative_id = n.id
      WHERE n.id IN (${placeholders})
      GROUP BY n.id
    `).all(...targetNids) as DetailRow[];

    return {
      narratives: rows.map((row) => ({
        id: row.id,
        agent_type: row.agent_type,
        role: row.role,
        status: row.status,
        summary: row.summary,
        title: row.title,
        fold_path: row.fold_path ? fromPortablePath(row.fold_path) : null,
        created_at: row.created_at,
        archived: row.archived === 1,
        mcp_connected: connectedNids.has(row.id),
        event_count: row.event_count,
        first_activity: row.first_activity,
        last_activity: row.last_activity,
        last_activity_ago: row.last_activity ? timeSince(row.last_activity) : null,
      })),
    };
  }

  // No nid: browse recently active narratives
  const since = (args.since as string) ?? "24h";
  const rawLimit = (args.limit as number) ?? 20;
  const limit = rawLimit === 0 ? null : rawLimit; // 0 = unlimited
  const sinceMs = Date.now() - parseDuration(since);

  // Optional content search filter
  let searchNids: Set<string> | null = null;
  const search = args.search as string | undefined;

  if (search) {
    searchNids = new Set<string>();
    let usedFts = false;

    try {
      const ftsRows = db
        .prepare(
          `SELECT DISTINCT c.narrative_id
           FROM memory_fts
           JOIN memory_chunks c ON memory_fts.rowid = c.rowid
           WHERE memory_fts MATCH ?
           LIMIT 1000`,
        )
        .all(search) as Array<{ narrative_id: string }>;
      for (const row of ftsRows) {
        searchNids.add(row.narrative_id);
      }
      usedFts = true;
    } catch {
      // FTS table doesn't exist or query failed
    }

    if (!usedFts || searchNids.size === 0) {
      const likeRows = db
        .prepare(
          `SELECT DISTINCT narrative_id
           FROM events
           WHERE content LIKE ?
           LIMIT 1000`,
        )
        .all(`%${search}%`) as Array<{ narrative_id: string }>;
      for (const row of likeRows) {
        searchNids.add(row.narrative_id);
      }
    }

    if (searchNids.size === 0) {
      return { narratives: [], since, search };
    }
  }

  let sql = `
    SELECT
      n.id,
      n.agent_type,
      n.role,
      n.status,
      n.title,
      n.summary,
      MAX(e.time) as last_activity,
      (SELECT COUNT(*) FROM events WHERE narrative_id = n.id) as event_count
    FROM narratives n
    JOIN events e ON e.narrative_id = n.id
    WHERE e.time > ?
  `;
  const params: (string | number)[] = [sinceMs];

  // Scope to requested branes in browse mode
  if (braneIds.length > 0) {
    sql += ` AND n.brane_id IN (${braneIds.map(() => "?").join(", ")})`;
    params.push(...braneIds);
  } else {
    // Every brane, as `brane memory log` asks: archived branes' ended
    // narratives stay out, as they do from All branes (src/db/branes.ts).
    const visible = visibleUnscopedClause(connectedNids, "n");
    sql += ` AND ${visible.sql}`;
    params.push(...visible.params);
  }

  if (!args.archived) {
    sql += ` AND COALESCE(n.archived, 0) = 0`;
  }

  if (args.status) {
    sql += ` AND n.status = ?`;
    params.push(args.status as string);
  }

  if (args.fold) {
    const fold = args.fold as string;
    const portable = fold.startsWith("~") ? fold : toPortablePath(resolve(fold));
    sql += ` AND n.fold_path = ?`;
    params.push(portable);
  }

  if (searchNids) {
    const placeholders = Array.from(searchNids).map(() => "?").join(", ");
    sql += ` AND n.id IN (${placeholders})`;
    params.push(...searchNids);
  }

  sql += `
    GROUP BY n.id
    ORDER BY last_activity DESC
  `;
  if (limit !== null) {
    sql += `    LIMIT ?\n`;
    params.push(limit);
  }

  const rows = db.prepare(sql).all(...params) as LogRow[];

  return {
    narratives: rows.map((row) => ({
      id: row.id,
      agent_type: row.agent_type,
      role: row.role,
      status: row.status,
      title: row.title,
      summary: row.summary,
      last_activity: row.last_activity,
      last_activity_ago: timeSince(row.last_activity),
      event_count: row.event_count,
    })),
    since,
    ...(search ? { search } : {}),
  };
}

function handleListPeers(
  db: Database.Database,
  selfNarrativeId: string,
  args: Record<string, unknown>,
): unknown {
  const includeInactive = args.include_inactive === true;

  // Look up the caller's fold_path
  const self = db
    .prepare("SELECT fold_path FROM narratives WHERE id = ?")
    .get(selfNarrativeId) as { fold_path: string } | undefined;
  const selfFold = self?.fold_path ?? null;

  // Query all peers (excluding self)
  let sql = `
    SELECT id, agent_type, role, fold_path, status, summary
    FROM narratives
    WHERE id != ?
  `;
  const params: (string | number)[] = [selfNarrativeId];

  if (!includeInactive) {
    sql += ` AND status = 'active'`;
  }

  sql += ` ORDER BY created_at DESC`;

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    agent_type: string;
    role: string;
    fold_path: string;
    status: string;
    summary: string | null;
  }>;

  const peers: typeof rows = [];
  const other: typeof rows = [];

  for (const row of rows) {
    if (selfFold && row.fold_path === selfFold) {
      peers.push(row);
    } else {
      other.push(row);
    }
  }

  const format = (row: typeof rows[0]) => ({
    nid: row.id,
    agent_type: row.agent_type,
    role: row.role,
    status: row.status,
    fold: row.fold_path,
    summary: row.summary,
  });

  return {
    fold: selfFold,
    peers: peers.map(format),
    other: other.map(format),
  };
}

function handleListBranes(
  db: Database.Database,
  selfNarrativeId: string,
): unknown {
  const selfRow = db
    .prepare("SELECT brane_id FROM narratives WHERE id = ?")
    .get(selfNarrativeId) as { brane_id: string } | undefined;
  const homeBraneId = selfRow?.brane_id;

  const rows = db.prepare(
    `SELECT brane_id,
            COUNT(*) as narrative_count,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
            SUM(CASE WHEN role = 'absorbed' THEN 1 ELSE 0 END) as absorbed_count,
            MAX(created_at) as last_activity
     FROM narratives
     GROUP BY brane_id
     ORDER BY last_activity DESC`,
  ).all() as Array<{
    brane_id: string;
    narrative_count: number;
    active_count: number;
    absorbed_count: number;
    last_activity: number;
  }>;

  // Archived branes are listed too, flagged, so an agent can still reach one
  // on purpose (src/db/branes.ts).
  const hidden = archivedBraneIds(db);
  const flag = (id: string) => (hidden.has(id) ? { archived: true } : {});

  // Insert caller's home brane entry first so iteration order surfaces it,
  // then everything else in last_activity DESC order.
  const result: Record<string, unknown> = {};
  if (homeBraneId) {
    result.home = homeBraneId;
    const homeRow = rows.find((r) => r.brane_id === homeBraneId);
    if (homeRow) {
      const { brane_id, ...rest } = homeRow;
      result[brane_id] = { ...rest, ...flag(brane_id) };
    }
  }
  for (const r of rows) {
    if (r.brane_id === homeBraneId) continue;
    const { brane_id, ...rest } = r;
    result[brane_id] = { ...rest, ...flag(brane_id) };
  }
  return result;
}

// listen long-poll hold, per agent type.
//
// `listen` is a long-poll held open as an MCP *tool call*, so the ceiling on
// how long it can block is the CLIENT's per-call timeout, not the daemon's.
// When the hold exceeds that ceiling the client aborts the call itself
// (JSON-RPC -32001), which the agent sees as an error rather than a normal
// `{ timed_out: true }` return.
//
// claude: Claude Code's stdio idle timeout is raised to 1h by the per-server
// `timeout` brane writes into .mcp.json (src/commands/spawn.ts,
// MCP_TOOL_TIMEOUT_MS). So claude can hold ~1h; we pick 3400s — under both
// that client ceiling and the Anthropic prompt-cache TTL (1h, sliding, as
// measured from usage records: every cache write is ephemeral_1h), leaving
// ~200s margin for the wake→inference roundtrip so an idle self-wake lands as
// a cache *hit* rather than a cold re-encode.
//
// everyone else: keep the conservative 270s hold until the client is
// *observed* honoring its own timeout knob. codex/copilot default to ~60s and
// would abort a longer hold every idle cycle; raising a client's hold is a
// measured, per-type decision, never a global flip.
/** The tool name a `listen` is captured under — the raw MCP name the hook
 *  reports, not the `brane:listen` the UI renders. */
const LISTEN_TOOL_NAME = "mcp__brane__listen";
/** A `narrate({ wait: true })` parks under its own name, so its row settles. */
const NARRATE_TOOL_NAME = "mcp__brane__narrate";

/** Told when a call the daemon served itself actually ended, so the row can
 *  say so instead of keeping the hook's guess. Passed down rather than reached
 *  for: the write and its push live in the server closure, and everything
 *  below here only knows when a call finished. */
type SettleCall = (nid: string, name: string, startedAt: number, endedAt: number) => void;

const DEFAULT_LISTEN_TIMEOUT_MS = 270_000;
const LISTEN_TIMEOUT_BY_AGENT: Record<string, number> = {
  claude: 3_400_000,
  // cline: client allowance is the `timeout` (seconds) on the brane entry in
  // its per-session cline_mcp_settings.json — observed honored 2026-08-16.
  cline: 3_400_000,
  // crush: client allowance is the `timeout` (seconds) on the brane entry in
  // the fold's .crush.json. Raised on the same day; if crush is ever seen
  // aborting idle listens (-32001 every cycle), drop this back to 270s.
  crush: 3_400_000,
  // goose deliberately absent: `--with-extension` cannot express a timeout,
  // so its stdio extension cap stands; a longer hold would abort every idle
  // cycle. Raising goose requires registering brane as a config.yaml
  // extension with an explicit timeout.
};
export function listenTimeoutFor(agentType: string | undefined): number {
  return (
    (agentType ? LISTEN_TIMEOUT_BY_AGENT[agentType] : undefined) ??
    DEFAULT_LISTEN_TIMEOUT_MS
  );
}

// Poll for pending listen calls and resolve them when events arrive
function startMcpPoller(
  db: Database.Database,
  mcpClients: Set<McpBridgeClient>,
  settle: SettleCall,
): NodeJS.Timeout {
  return setInterval(() => {
    for (const client of mcpClients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      for (const [callId, pending] of client.pendingListens) {
        const elapsed = Date.now() - pending.startTime;

        // The listen's own check and reply, not a re-derivation: this used to
        // rebuild both from `cursors` alone, dropping `before`/`tail` — so a
        // bounded listen resolved differently depending on which path fired.
        const events = pending.check();
        if (events) {
          client.pendingListens.delete(callId);
          pending.cleanup();
          pending.reply(events, elapsed, false);
          settle(client.narrativeId, pending.toolName, pending.startTime, Date.now());
          client.awaiting?.resolved(client.narrativeId, "delivered");
          continue;
        }

        // Check for timeout
        if (elapsed >= listenTimeoutFor(client.agentType)) {
          client.pendingListens.delete(callId);
          pending.cleanup();
          pending.reply(null, elapsed, true);
          // A timeout is a real ending too, and the longest one there is —
          // so it is the case the hook's 120s stamp gets most wrong.
          settle(client.narrativeId, pending.toolName, pending.startTime, Date.now());
          client.awaiting?.resolved(client.narrativeId, "timeout");
        }
      }
    }
  }, 500);
}

function sendToolResult(ws: WebSocket, callId: string, result: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "tool_result", id: callId, result }));
  }
}

function sendToolError(ws: WebSocket, callId: string, error: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "tool_error", id: callId, error }));
  }
}

// ── Terminal Mirroring WebSocket ─────────────────────────────────────────

// Module-level refs set by startServer so the capture loop can update
// narrative status when a tmux session dies (especially for utility/run narratives).
let _serverDb: Database.Database | null = null;
let _serverControlClients: Set<ControlClient> | null = null;

// Shared capture loop per narrative — one tmux capture-pane interval fans
// out frames to all subscribed clients, regardless of how many are connected.

// Where tmux says the cursor is, translated into the frame's own coordinates:
// `line` indexes the lines of `content` (scrollback included), `col` is the
// column within that line. Absent entirely when the pane has hidden its
// cursor — a TUI with a dialog open, say — so a client never draws one the
// operator's own terminal wouldn't show.
export interface TerminalCursor {
  line: number;
  col: number;
}

interface TerminalClient {
  ws: WebSocket;
  nid: string;
  active: boolean; // whether client wants frames (start/stop)
  lastContent: string;
  lastLineCount: number;
  lastCursorKey: string;
  // When this client was last sent pane *content* (not a cursor-only message).
  // Drives the resync heartbeat — see TERMINAL_RESYNC_MS.
  lastSentAt: number;
  // Last viewport size this client requested, remembered across start/stop so
  // the window can be re-fitted to the remaining viewers when a client leaves.
  size: { cols: number; rows: number } | null;
}

/**
 * How long a viewer may go without being sent pane content before the capture
 * loop re-sends the current frame unprompted.
 *
 * The mirror is otherwise a fire-and-forget protocol: the daemon sends a
 * frame, records it in the client's `lastContent`, and — once the pane goes
 * quiet — never speaks again, because `content === cap.lastContent` returns
 * early. But `lastContent` records what was *sent*, not what was *rendered*.
 * Every way a browser can drop a frame (a backgrounded tab whose rAF never
 * ran, a socket that reconnected into a wiped `<pre>`, an early return in
 * `applyFrame`) therefore strands the viewer on a stale — or entirely
 * blank — screen, with a page reload as the only repair. That is not a
 * failure the operator should have to notice, let alone fix by hand.
 *
 * Re-sending the current frame every couple of seconds closes the whole class
 * without an ack protocol: any dropped frame self-heals within one interval.
 * The cost is one small message per viewer of an *idle* pane, and nothing at
 * all on the client, whose per-line diff finds no changed lines and touches
 * no DOM. A busy pane already sends more often than this and is unaffected.
 */
const TERMINAL_RESYNC_MS = 2000;

/** Whether a viewer is due an unprompted re-send. Pure, for the test. */
export function isResyncDue(
  lastSentAt: number,
  now: number,
  resyncMs: number = TERMINAL_RESYNC_MS,
): boolean {
  return now - lastSentAt >= resyncMs;
}

interface TerminalCapture {
  nid: string;
  clients: Set<TerminalClient>;
  interval: NodeJS.Timeout;
  lastContent: string;
  cursor: TerminalCursor | null;
  lastCursorKey: string;
  alternateOn: boolean;
  forceCapture: () => void;
  // Last window size applied by fitWindowToViewers, to skip no-op resizes.
  appliedSize: { cols: number; rows: number } | null;
}

const terminalCaptures = new Map<string, TerminalCapture>();

// Last known terminal dimensions from any client resize, used as default for new sessions
let lastTerminalSize: { cols: number; rows: number } | null = null;

// Everything about the pane that isn't in its text, in one line. Ordered and
// space-separated because every field is a number — nothing here can contain
// a space, so the parse cannot be ambiguous.
const TERMINAL_STATUS_FORMAT =
  "#{cursor_x} #{cursor_y} #{cursor_flag} #{alternate_on} #{pane_height}";

export interface TerminalStatus {
  cursorX: number;
  cursorY: number;
  // `cursor_flag` is the pane's own DECTCEM state. An application that hides
  // the cursor — Claude Code while a dialog is up, lazygit throughout — means
  // it, and drawing one anyway would put a cursor where the operator's real
  // terminal shows none.
  cursorVisible: boolean;
  alternateOn: boolean;
  paneHeight: number;
}

export function parseTerminalStatus(line: string): TerminalStatus | null {
  const parts = line.trim().split(" ");
  if (parts.length < 5) return null;
  const nums = parts.slice(0, 5).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [cursorX, cursorY, cursorFlag, alternateOn, paneHeight] = nums;
  return {
    cursorX,
    cursorY,
    cursorVisible: cursorFlag === 1,
    alternateOn: alternateOn === 1,
    paneHeight,
  };
}

/**
 * tmux reports `cursor_y` against the *visible pane*, but a frame carries the
 * scrollback above it — `capture-pane -S - -E -` returns `history_size +
 * pane_height` rows. The visible pane is therefore the last `pane_height` rows
 * of the capture, and that is the entire conversion.
 *
 * `capturedLines` is the row count *before* trailing blanks are trimmed, since
 * those blanks are part of the visible pane and the cursor may sit among them
 * (a freshly cleared screen puts it on the first one).
 */
export function terminalCursorFrom(
  status: TerminalStatus | null,
  capturedLines: number,
): TerminalCursor | null {
  if (!status || !status.cursorVisible || status.paneHeight <= 0) return null;
  const line = capturedLines - status.paneHeight + status.cursorY;
  if (line < 0) return null;
  return { line, col: status.cursorX };
}

function ensureTerminalCapture(nid: string): TerminalCapture {
  let cap = terminalCaptures.get(nid);
  if (cap) return cap;

  cap = {
    nid,
    clients: new Set(),
    interval: null!,
    lastContent: "",
    cursor: null,
    lastCursorKey: "",
    alternateOn: false,
    forceCapture: () => {},
    appliedSize: null,
  };

  const capture = () => {
    // Remove dead clients
    for (const c of cap!.clients) {
      if (c.ws.readyState !== WebSocket.OPEN) cap!.clients.delete(c);
    }
    // Any active subscribers?
    let hasActive = false;
    for (const c of cap!.clients) {
      if (c.active) { hasActive = true; break; }
    }
    if (!hasActive) {
      // No one watching — tear down this capture
      clearInterval(cap!.interval);
      terminalCaptures.delete(nid);
      return;
    }

    execFile(
      resolveTmux(),
      [
        // One tmux round trip for both halves of a frame. Splitting the cursor
        // into its own call would let a keystroke land between the two, and
        // paint the block a cell away from the character it belongs on — the
        // one artifact a cursor cannot have. `;` as its own argument is tmux's
        // command separator; the status line arrives first, pane text after.
        "display-message", "-t", nid, "-p", "-F", TERMINAL_STATUS_FORMAT,
        ";",
        "capture-pane", "-e", "-p", "-S", "-", "-E", "-", "-t", nid,
      ],
      { timeout: 2000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // capture-pane failed — could be transient (2s timeout, buffer issue)
          // on an alive-but-idle session. Confirm with has-session before marking
          // the narrative ended; only tear down the capture loop unconditionally.
          let tmuxAlive = false;
          try {
            execFileSync(resolveTmux(), ["has-session", "-t", nid], { stdio: "ignore" });
            tmuxAlive = true;
          } catch {}

          if (tmuxAlive) {
            // Transient capture failure; keep state intact and try again next tick.
            return;
          }

          // tmux session really is dead — notify all clients
          const terminated = JSON.stringify({ type: "terminated" });
          for (const c of cap!.clients) {
            if (c.ws.readyState === WebSocket.OPEN) c.ws.send(terminated);
            c.active = false;
          }
          clearInterval(cap!.interval);
          terminalCaptures.delete(nid);

          // Update narrative status in DB and broadcast to control clients
          if (_serverDb && _serverControlClients) {
            const narr = _serverDb.prepare("SELECT status FROM narratives WHERE id = ?").get(nid) as { status: string } | undefined;
            if (narr && narr.status !== "ended") {
              _serverDb.prepare("UPDATE narratives SET status = 'ended' WHERE id = ?").run(nid);
              broadcastStatus(_serverControlClients, nid, "ended");
            }
          }
          return;
        }

        // The status line comes off display-message; everything after the
        // first newline is the pane itself.
        const nl = stdout.indexOf("\n");
        const status = parseTerminalStatus(nl === -1 ? stdout : stdout.slice(0, nl));
        const paneText = nl === -1 ? "" : stdout.slice(nl + 1);
        if (status) cap!.alternateOn = status.alternateOn;

        const rawLines = paneText.split("\n");
        // capture-pane ends with a newline; drop the empty tail it leaves so
        // the row count below is the pane's real height plus its scrollback.
        if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

        const cursor = terminalCursorFrom(status, rawLines.length);

        // The blank rows at the bottom are the visible pane's unused space, and
        // they stay: they are what puts a just-cleared screen's prompt (^L,
        // `clear`) at the *top* of the viewer, with the old screen scrolled up
        // into history above it, as in a real terminal. Trimming them parked
        // the prompt at the bottom, right under the output it had cleared.
        // The window is sized to the smallest active viewer
        // (fitWindowToViewers), so the pane always fits and its blank rows
        // can never fill a viewer that is scrolled to the bottom.
        const content = rawLines.join("\n");

        const cursorKey = cursor ? `${cursor.line}:${cursor.col}` : "";
        cap!.cursor = cursor;

        const now = Date.now();
        const lineCount = rawLines.length;

        // Re-send the current frame to any viewer that hasn't been sent
        // content in a while, whatever the reason it fell behind — see
        // TERMINAL_RESYNC_MS. Runs on both paths below, so a pane that is idle
        // and a pane whose change this client was diffed out of are covered by
        // the same rule.
        const resyncStaleViewers = () => {
          let msg: string | null = null;
          for (const c of cap!.clients) {
            if (!c.active || c.ws.readyState !== WebSocket.OPEN) continue;
            if (!isResyncDue(c.lastSentAt, now)) continue;
            msg ??= JSON.stringify({
              type: "frame",
              data: content,
              totalLines: lineCount,
              alternate_on: cap!.alternateOn,
              cursor,
            });
            c.lastContent = content;
            c.lastLineCount = lineCount;
            c.lastCursorKey = cursorKey;
            c.lastSentAt = now;
            c.ws.send(msg);
          }
        };

        // Only send a frame when content actually changed. When the session is
        // idle (agent long-polling, no tmux output), the client receives nothing
        // and schedules no rAF callbacks, keeping the tab completely quiescent —
        // apart from the resync heartbeat, which is one message every two
        // seconds and no DOM work at all.
        if (content === cap!.lastContent) {
          // Content can hold still while the cursor moves — walking an arrow
          // key along a shell input line repaints not one character. That is
          // exactly when a cursor is worth most, so it gets its own message
          // rather than waiting for a frame that may never come.
          if (cursorKey !== cap!.lastCursorKey) {
            cap!.lastCursorKey = cursorKey;
            const msg = JSON.stringify({ type: "cursor", cursor });
            for (const c of cap!.clients) {
              if (!c.active || c.ws.readyState !== WebSocket.OPEN) continue;
              if (c.lastCursorKey === cursorKey) continue;
              c.lastCursorKey = cursorKey;
              c.ws.send(msg);
            }
          }
          resyncStaleViewers();
          return;
        }
        cap!.lastContent = content;
        cap!.lastCursorKey = cursorKey;

        const newLineCount = lineCount;

        // Fan out to each active client with per-client diff
        for (const c of cap!.clients) {
          if (!c.active || c.ws.readyState !== WebSocket.OPEN) continue;

          if (content === c.lastContent) continue;

          if (
            c.lastLineCount > 0 &&
            newLineCount > c.lastLineCount &&
            content.startsWith(c.lastContent.slice(0, c.lastContent.lastIndexOf("\n") + 1))
          ) {
            const appendedLines = rawLines.slice(c.lastLineCount - 1);
            c.ws.send(JSON.stringify({
              type: "append",
              data: appendedLines.join("\n"),
              lineOffset: c.lastLineCount - 1,
              totalLines: newLineCount,
              alternate_on: cap!.alternateOn,
              cursor,
            }));
          } else {
            c.ws.send(JSON.stringify({
              type: "frame",
              data: content,
              totalLines: newLineCount,
              alternate_on: cap!.alternateOn,
              cursor,
            }));
          }

          c.lastContent = content;
          c.lastLineCount = newLineCount;
          c.lastCursorKey = cursorKey;
          c.lastSentAt = now;
        }
        // Viewers the diff above skipped (`content === c.lastContent`) are the
        // ones most likely to be stranded, so they get the same heartbeat.
        resyncStaleViewers();
      },
    );
  };

  cap.forceCapture = capture;
  capture();
  cap.interval = setInterval(capture, 100);
  terminalCaptures.set(nid, cap);
  return cap;
}

/** `refuseAct` is the verification gate for this socket's token: asked
 *  before every message that is not free (keys, paste, mouse, clearing
 *  history), since a pane opened inside the window must not type after it. */
function handleTerminalSocket(ws: WebSocket, nid: string, refuseAct?: () => VerificationRefusal | null): void {
  const client: TerminalClient = {
    ws,
    nid,
    active: false,
    lastContent: "",
    lastLineCount: 0,
    lastCursorKey: "",
    lastSentAt: 0,
    size: null,
  };

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (refuseAct && !FREE_TERMINAL_MESSAGES.has(msg.type)) {
        const refused = refuseAct();
        if (refused) {
          ws.send(JSON.stringify(verifyFrame(refused)));
          return;
        }
      }
      switch (msg.type) {
        case "start": {
          client.active = true;
          // Check if the session is dead before starting a capture loop.
          // DB check catches the easy case; tmux has-session catches stale
          // "active" status after ungraceful shutdown (e.g. fly down).
          if (_serverDb) {
            const narr = _serverDb.prepare("SELECT status FROM narratives WHERE id = ?").get(nid) as { status: string } | undefined;
            if (narr && narr.status === "ended") {
              ws.send(JSON.stringify({ type: "terminated" }));
              break;
            }
            if (narr) {
              try {
                execFileSync(resolveTmux(), ["has-session", "-t", nid], { stdio: "ignore" });
              } catch {
                // tmux session doesn't exist — mark ended and notify client
                _serverDb.prepare("UPDATE narratives SET status = 'ended' WHERE id = ?").run(nid);
                if (_serverControlClients) broadcastStatus(_serverControlClients, nid, "ended");
                ws.send(JSON.stringify({ type: "terminated" }));
                break;
              }
            }
          }
          // Send current content immediately so client doesn't wait 100ms
          const cap = ensureTerminalCapture(nid);
          cap.clients.add(client);
          // A rejoining viewer (tab reactivated) may now be the smallest.
          if (client.size) fitWindowToViewers(nid);
          if (cap.lastContent && client.lastContent !== cap.lastContent) {
            client.lastContent = cap.lastContent;
            client.lastLineCount = cap.lastContent.split("\n").length;
            client.lastCursorKey = cap.lastCursorKey;
            client.lastSentAt = Date.now();
            ws.send(JSON.stringify({
              type: "frame",
              data: cap.lastContent,
              totalLines: client.lastLineCount,
              alternate_on: cap.alternateOn,
              cursor: cap.cursor,
            }));
          }
          break;
        }
        case "stop":
          client.active = false;
          // This viewer no longer constrains the window — grow back to the
          // remaining viewers' min immediately.
          fitWindowToViewers(nid);
          break;
        case "resize": {
          const cols = Number(msg.cols);
          const rows = Number(msg.rows);
          if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) break;
          client.size = { cols, rows };
          if (terminalCaptures.has(nid)) {
            fitWindowToViewers(nid);
          } else {
            // No capture loop yet (resize raced ahead of "start") — apply
            // directly so a lone client still gets its size honored.
            resizeTerminal(nid, cols, rows);
          }
          break;
        }
        case "keys":
          sendKeysToTmux(nid, msg.keys, msg.repeat);
          break;
        case "paste":
          sendPasteToTmux(nid, typeof msg.text === "string" ? msg.text : "");
          break;
        case "mouse":
          sendMouseToTmux(nid, msg);
          break;
        case "clear_history":
          clearTerminalHistory(nid);
          break;
        case "refresh": {
          // Client requests a clean full frame. The client has just wiped its
          // <pre> DOM, so if we wait for `forceCapture()` alone the capture
          // loop's `content === cap.lastContent` early-return can leave the
          // client blank when tmux is idle. Mirror the `start` handler and
          // send `cap.lastContent` immediately if we have it, then trigger a
          // capture as a backup for any pending change.
          client.lastContent = "";
          client.lastLineCount = 0;
          client.lastCursorKey = "";
          client.lastSentAt = 0;
          const cap = terminalCaptures.get(nid);
          if (cap?.lastContent) {
            client.lastContent = cap.lastContent;
            client.lastLineCount = cap.lastContent.split("\n").length;
            client.lastCursorKey = cap.lastCursorKey;
            client.lastSentAt = Date.now();
            ws.send(JSON.stringify({
              type: "frame",
              data: cap.lastContent,
              totalLines: client.lastLineCount,
              alternate_on: cap.alternateOn,
              cursor: cap.cursor,
            }));
          }
          cap?.forceCapture();
          break;
        }
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    client.active = false;
    const cap = terminalCaptures.get(nid);
    if (cap) {
      cap.clients.delete(client);
      // A departed viewer stops constraining the window (e.g. phone
      // disconnects → desktop grows back to full size).
      fitWindowToViewers(nid);
    }
  });
}

// Fit the tmux window to the smallest active viewer — tmux's own
// `window-size smallest` semantics, applied to web clients. Sizing was
// previously last-resize-wins, which let a large desktop window set a grid
// that a concurrently-watching phone could only clip (in alternate mode the
// pane is overflow:hidden, so the TUI's bottom rows — input box, status
// line — vanished). Taking min cols × min rows across active viewers makes
// clipping impossible: bigger viewers just see the smaller grid centered.
// Recomputed on resize, start, stop, and disconnect, so when the smallest
// viewer leaves, the window grows back to the remaining viewers' size
// without anyone having to jiggle their browser window.
function fitWindowToViewers(nid: string): void {
  const cap = terminalCaptures.get(nid);
  if (!cap) return;
  let cols = Infinity;
  let rows = Infinity;
  for (const c of cap.clients) {
    if (!c.active || c.ws.readyState !== WebSocket.OPEN || !c.size) continue;
    if (c.size.cols < cols) cols = c.size.cols;
    if (c.size.rows < rows) rows = c.size.rows;
  }
  // No active viewer has reported a size — leave the window as-is rather
  // than shrinking a working agent's terminal to some arbitrary default.
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
  if (cap.appliedSize && cap.appliedSize.cols === cols && cap.appliedSize.rows === rows) return;
  cap.appliedSize = { cols, rows };
  resizeTerminal(nid, cols, rows);
}

// The operator's "Clear scrollback": drop the pane's tmux history and leave
// the live screen alone. Scrollback is where a TUI's stale redraws pile up —
// Claude's trust dialog drawn at three widths before the session settled, its
// full-width rules now wider than the pane — and the mirror shows all of it
// (`capture-pane -S -`). Only ever on an explicit request, since it throws
// that history away. The forced capture sends the shorter frame at once; the
// client trims to `totalLines`, so the stale lines go with it.
function clearTerminalHistory(nid: string): void {
  execFile(resolveTmux(), ["clear-history", "-t", nid], { timeout: 2000 }, (err) => {
    if (!err) terminalCaptures.get(nid)?.forceCapture();
  });
}

function resizeTerminal(nid: string, cols: number, rows: number): void {
  if (!cols || !rows || cols < 1 || rows < 1) return;
  lastTerminalSize = { cols, rows };
  execFile(
    resolveTmux(),
    ["resize-window", "-t", nid, "-x", String(cols), "-y", String(rows)],
    { timeout: 2000 },
    (err) => {
      if (!err) {
        // Force an immediate capture so clients see the reflowed content
        // without waiting for the next 100ms tick. This is the "resize
        // handler" concept — a fresh frame after resize, not an innerHTML
        // wipe that would blank the terminal.
        terminalCaptures.get(nid)?.forceCapture();
      } else {
        // The resize never landed — forget the dedup record so the next
        // fitWindowToViewers pass retries instead of skipping as a no-op.
        const cap = terminalCaptures.get(nid);
        if (cap?.appliedSize && cap.appliedSize.cols === cols && cap.appliedSize.rows === rows) {
          cap.appliedSize = null;
        }
      }
    },
  );
}

// Key name patterns that tmux understands directly (not literal text)
const TMUX_SPECIAL_KEYS = new Set([
  "Enter", "Escape", "Tab", "BTab", "BSpace", "DC", "IC",
  "Up", "Down", "Left", "Right",
  "Home", "End", "PPage", "NPage",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "Space",
]);

function sendMouseToTmux(nid: string, msg: unknown): void {
  // Every field is validated in `sgrMouseSequences` before it reaches the
  // sequence; a message it does not recognise sends nothing.
  for (const seq of sgrMouseSequences(msg)) {
    execFile(resolveTmux(), ["send-keys", "-t", nid, "-l", seq], { timeout: 2000 }, () => {});
  }
}

// A key name tmux can interpret (vs. literal text to type). Strips any leading
// modifier prefixes (C-, S-, M- in any combination, e.g. `C-End`, `C-S-Up`)
// and checks that the remainder is a single character or a known special key.
function isTmuxKeyName(keys: string): boolean {
  const base = keys.replace(/^(?:[CSM]-)+/i, "");
  if (base === keys) {
    // No modifier prefix — a bare special key (Enter, End, …) is a key name,
    // but a bare single character should be typed literally.
    return TMUX_SPECIAL_KEYS.has(keys);
  }
  // Had a modifier prefix: chord over a single char (C-c) or special key (C-End).
  return base.length === 1 || TMUX_SPECIAL_KEYS.has(base);
}

// Pasted text goes through a tmux buffer rather than send-keys. Two reasons,
// and the first is the one that matters: `paste-buffer -p` wraps the text in
// bracketed-paste markers when the application asked for them, so Claude Code
// and every other TUI receives 40 pasted lines as *one paste* instead of 40
// submits. The second is prosaic — a paste can be far larger than an argv.
const BRANE_PASTE_BUFFER = "brane-paste";
// A ceiling, not a policy: enough for any real paste, small enough that a
// runaway client can't hand tmux a gigabyte.
const MAX_PASTE_BYTES = 1024 * 1024;

function sendPasteToTmux(nid: string, text: string): void {
  if (!text) return;
  const payload = Buffer.byteLength(text, "utf8") > MAX_PASTE_BYTES
    ? Buffer.from(text, "utf8").subarray(0, MAX_PASTE_BYTES).toString("utf8")
    : text;

  // The buffer is named and reused, so each paste overwrites the last rather
  // than pushing onto tmux's numbered stack.
  const load = execFile(
    resolveTmux(),
    ["load-buffer", "-b", BRANE_PASTE_BUFFER, "-"],
    { timeout: 5000 },
    (err) => {
      if (err) return;
      execFile(
        resolveTmux(),
        ["paste-buffer", "-b", BRANE_PASTE_BUFFER, "-t", nid, "-p"],
        { timeout: 5000 },
        () => {},
      );
    },
  );
  load.stdin?.end(payload);
}

// A repeated key is one tmux call (`send-keys -N`), not N of them. Tap-to-
// position sends a run of arrows, and a wide line would otherwise mean a
// hundred execs and a hundred round trips for one tap.
const MAX_KEY_REPEAT = 500;

function sendKeysToTmux(nid: string, keys: string, repeat?: unknown): void {
  if (!keys) return;

  const count = typeof repeat === "number" && Number.isInteger(repeat) && repeat > 1
    ? Math.min(repeat, MAX_KEY_REPEAT)
    : 1;

  if (isTmuxKeyName(keys)) {
    // Key names and modifier chords go directly so tmux interprets them.
    const args = ["send-keys", "-t", nid];
    if (count > 1) args.push("-N", String(count));
    args.push(keys);
    execFile(resolveTmux(), args, { timeout: 2000 }, () => {});
  } else {
    // Literal text — use -l flag to prevent interpretation
    execFile(resolveTmux(), ["send-keys", "-t", nid, "-l", keys], { timeout: 2000 }, () => {});
  }
}
