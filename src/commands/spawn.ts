import { defineCommand } from "citty";
import { randomBase36 } from "../ids.js";
import { mintAgentToken } from "../db/tokens.js";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, mkdirSync, chmodSync } from "node:fs";
import type Database from "better-sqlite3";
import qrcode from "qrcode-terminal";
import { openDatabase, getBraneId, getDaemonAddress, toPortablePath, fromPortablePath } from "../db/schema.js";
import { appendEvent } from "../db/events.js";
import { getAgentAdapter } from "../agents.js";
import { getConfig } from "./config.js";
import { resolveTmux, newTmuxSession } from "../tmux.js";
import { resolveDaemonEndpoint, daemonRequest, warnIfVersionMismatch } from "../daemon/client.js";
import { buildMeldUrl, meldLapseNote, mintDeviceToken } from "./meld.js";
import { spawnedContent } from "../shared/narrative-format.js";
import { ensureSessionAffinityConfig } from "../session-affinity.js";

/** Extract passthrough args after "--" from process.argv */
function extractPassthroughArgs(): string[] {
  const argv = process.argv;
  // Find "--" after the "spawn" subcommand
  const spawnIdx = argv.indexOf("spawn");
  if (spawnIdx === -1) return [];
  const ddIdx = argv.indexOf("--", spawnIdx + 1);
  if (ddIdx === -1) return [];
  return argv.slice(ddIdx + 1);
}

/** Locate an agent binary: `PATH` first, then brane's own `node_modules/.bin`
 *  (for dev deps like `amp` that are never installed globally). Exported so
 *  every launch path — spawn and revive alike — resolves agents identically;
 *  revive used to do its own `which` and lose the local-bin fallback. */
export function resolveAgentCommand(agent: string): string {
  try {
    return execFileSync("which", [agent], { encoding: "utf-8" }).trim();
  } catch {
    // Fall back to brane's own node_modules/.bin (for dev deps like amp)
    const braneRoot = resolve(process.argv[1], "../..");
    const localBin = join(braneRoot, "node_modules", ".bin", agent);
    try {
      statSync(localBin);
      return localBin;
    } catch {
      throw new Error(`Agent command not found: ${agent}`);
    }
  }
}

/** The kickoff prompt every fresh agent receives over tmux. Exported so the
 *  revive path sends the same words rather than a paraphrase. */
export const LIVE_LOOP_PROMPT =
  "Use your brane MCP server's read_protocol tool to read the 'LIVE_loop' protocol, then commence LIVE looping. All LIVE loop tools (narrate, listen, whoami, etc.) come from the brane MCP server.";

/**
 * Build the bootstrap prompt for a twin — an agent spawned to continue from a
 * predecessor narrative. The detailed behavior (read the inherited prefix
 * through the pinned seq, multi-listen on self + predecessor, coordinate with a
 * still-live predecessor) lives in the role-bound `twin` protocol; this prompt
 * just points the agent at it. `pinnedRef` is the predecessor in `nid:seq` form.
 */
function buildTwinPrompt(pinnedRef: string): string {
  return (
    `You are a twin: a brane agent spawned to continue from predecessor narrative ${pinnedRef}. ` +
    `Use your brane MCP server's read_protocol tool to read the 'LIVE_loop' protocol, then read_protocol("twin") and follow it. ` +
    `Your predecessor and the seq you were forked at are recorded in your own 'started' event's re (${pinnedRef}). ` +
    `All LIVE loop tools (narrate, listen, whoami, etc.) come from the brane MCP server.`
  );
}

/** Resolve the brane CLI path — prefer compiled JS over TS source.
 *  Returns { command, args } for running `brane mcp`. */
function resolveBraneMcpCommand(): { command: string; args: string[] } {
  let branePath = resolve(process.argv[1]);
  if (branePath.endsWith(".ts")) {
    const compiledPath = branePath
      .replace("/src/", "/dist/")
      .replace(/\.ts$/, ".js");
    try {
      readFileSync(compiledPath);
      branePath = compiledPath;
    } catch {
      // compiled version not found — will use tsx below
    }
  }
  const command = branePath.endsWith(".ts") ? "npx" : "node";
  const args = branePath.endsWith(".ts")
    ? ["tsx", branePath, "mcp"]
    : [branePath, "mcp"];
  return { command, args };
}

/** Per-server MCP tool timeout requested of every agent client.
 *
 *  `listen` is a long-poll held open as an MCP *tool call*, so the binding
 *  constraint on how long it can block is the **client's** per-call timeout,
 *  not the daemon's. When it elapses the client aborts the call itself
 *  (JSON-RPC -32001), which the agent sees as an error rather than a normal
 *  `{ timed_out: true }` return. Observed/documented defaults are low enough
 *  to break a long hold — codex 60s, copilot 60s, gemini 600s — so several
 *  agent types abort today at the daemon's 270s hold.
 *
 *  Writing this knob is **inert on its own**: it only *permits* a longer
 *  hold. `LISTEN_TIMEOUT_MS` in the daemon still decides how long `listen`
 *  actually blocks, and must not be raised for an agent type until that
 *  agent has been *observed* honoring the knob. A config field is a request;
 *  the client honoring it is a fact. (Copilot 1.0.55 accepted `timeout` and
 *  aborted at 60s anyway.)
 *
 *  Finite on purpose. Some clients treat 0 as "disable the abort entirely",
 *  which would let a wedged daemon hang an agent forever with no recovery. */
const MCP_TOOL_TIMEOUT_MS = 3_600_000;
const MCP_TOOL_TIMEOUT_SEC = MCP_TOOL_TIMEOUT_MS / 1000;

/** Ensure .mcp.json in the fold directory includes the brane MCP server.
 *  Narrative ID is NOT stored here — it's passed via tmux session env.
 *  `alwaysLoad: true` (Claude Code ≥ 2.1.121) bypasses the deferred-tool /
 *  ToolSearch flow so brane's tools are present from turn 1. Older Claude
 *  Code versions ignore unknown fields. */
function ensureMcpConfig(foldPath: string): void {
  const mcpJsonPath = join(foldPath, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};

  try {
    config = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
  } catch {
    // No existing config — start fresh
  }

  if (!config.mcpServers) config.mcpServers = {};

  const { command, args } = resolveBraneMcpCommand();

  // Skip write if brane entry already matches (idempotent across spawns)
  const existing = config.mcpServers.brane as
    | { command?: string; args?: string[]; env?: unknown; alwaysLoad?: boolean; timeout?: number }
    | undefined;
  if (
    existing &&
    existing.command === command &&
    JSON.stringify(existing.args) === JSON.stringify(args) &&
    !existing.env &&
    existing.alwaysLoad === true &&
    existing.timeout === MCP_TOOL_TIMEOUT_MS
  ) {
    return;
  }

  config.mcpServers.brane = { command, args, alwaysLoad: true, timeout: MCP_TOOL_TIMEOUT_MS };

  writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + "\n");
}

const BRANE_HOOK_URL_PATH = "/api/hooks/tool-use";

/** Ensure .claude/settings.local.json in the fold carries the PostToolUse hook
 *  that reports tool calls to the daemon. Claude-only for now — hook support
 *  varies per agent, and an agent without it spawns exactly as before.
 *
 *  Auth rides the tmux session env the hook process inherits (the same
 *  inheritance the MCP bridge uses): BRANE_NARRATIVE_ID names the narrative,
 *  BRANE_NARRATIVE_SECRET proves it against narratives.bind_token. The daemon
 *  bearer token never touches this file.
 *
 *  The daemon URL is the one hardcoded constant (hooks have no dynamic
 *  resolver the way the MCP bridge does). Port drift is healed here: every
 *  spawn/revive recomputes the URL and rewrites the entry when it's stale —
 *  the same idempotent-rewrite dance the MCP configs already do.
 *
 *  The matcher captures everything, narrate and listen included. It once
 *  excluded them as "the narrative recording itself" (claude-xlolbv6l:57),
 *  but that traded away the two calls that carry the loop's own shape: a
 *  `listen` is how long the agent stood idle, and a foreign `narrate` is a
 *  message to another narrative that is otherwise invisible from this one.
 *  Both are worth showing, and neither can be reconstructed if the hook
 *  never fired — so the exclusion moves to render, where it is reversible
 *  (claude-vhkt2ogz:5, claude-mvpe4t45:3). Self-narrate is captured and
 *  dropped by the client, since the event it produced is already on screen.
 *
 *  Both ends of every call are hooked. PostToolUse alone can only report a
 *  call once it's over, so a long one leaves the chat silent while the
 *  terminal is visibly busy (claude-mvpe4t45:37). PreToolUse names the tool as
 *  it starts, and the row fills in when the call returns — the same shape as
 *  an agent showing "calling narrate" before it actually invokes it
 *  (claude-mvpe4t45:46). */
/** The URL a hook process should POST a tool call to, or null when there's no
 *  running daemon to point it at.
 *
 *  When TLS is active the main port speaks HTTPS with a cert for the tailscale
 *  hostname, useless for 127.0.0.1 — hooks target the HTTP fallback port
 *  instead. Without TLS the main port is plain HTTP; the daemon_http_port row
 *  may still exist then (it survives shutdown as the next TLS run's stability
 *  hint), so gate on the live daemon_tls flag rather than the row's presence. */
function braneHookUrl(db: Database.Database): string | null {
  const info = getDaemonAddress(db);
  if (!info) return null;
  const tlsRow = db
    .prepare("SELECT value FROM meta WHERE key = 'daemon_tls'")
    .get() as { value: string } | undefined;
  const httpPortRow = db
    .prepare("SELECT value FROM meta WHERE key = 'daemon_http_port'")
    .get() as { value: string } | undefined;
  const port = tlsRow?.value === "true" && httpPortRow ? httpPortRow.value : info.port;
  return `http://127.0.0.1:${port}${BRANE_HOOK_URL_PATH}`;
}

export function ensureClaudeHookConfig(db: Database.Database, foldPath: string): void {
  const url = braneHookUrl(db);
  if (!url) return; // No running daemon to point the hook at — degrade silently.

  const settingsDir = join(foldPath, ".claude");
  const settingsPath = join(settingsDir, "settings.local.json");
  let config: { hooks?: Record<string, unknown[]> } = {};
  try {
    config = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    // No existing settings — start fresh
  }

  const desired = {
    // Match-all as a regex, not `"*"`: the vendor compiles this string and
    // partial-matches with it (the previous lookahead-only pattern depended on
    // exactly that), and `"*"` is not a valid regex on its own.
    matcher: ".*",
    hooks: [
      {
        type: "http",
        url,
        timeout: 10,
        headers: {
          "X-Brane-Narrative-Id": "$BRANE_NARRATIVE_ID",
          "X-Brane-Narrative-Secret": "$BRANE_NARRATIVE_SECRET",
        },
        allowedEnvVars: ["BRANE_NARRATIVE_ID", "BRANE_NARRATIVE_SECRET"],
      },
    ],
  };

  if (!config.hooks) config.hooks = {};
  let changed = false;
  for (const event of ["PreToolUse", "PostToolUse"]) {
    if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
    const entries = config.hooks[event] as Array<{ hooks?: Array<{ url?: string }> }>;

    // This file is genuinely the user's — merge around their entries, own only
    // ours, identified by the URL path.
    const idx = entries.findIndex((e) =>
      e?.hooks?.some((h) => typeof h?.url === "string" && h.url.endsWith(BRANE_HOOK_URL_PATH)),
    );
    if (idx !== -1 && JSON.stringify(entries[idx]) === JSON.stringify(desired)) continue;
    if (idx !== -1) entries[idx] = desired;
    else entries.push(desired);
    changed = true;
  }
  // Leave the user's file untouched when both entries are already current —
  // this runs on every spawn and revive.
  if (!changed) return;

  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(config, null, 2) + "\n");
}

/** The hook script every non-Claude harness runs.
 *
 *  Claude Code has an HTTP hook type that does the POST and the env
 *  interpolation for us — that's the `type: "http"` entry above. goose, cline
 *  and crush all execute *commands* instead, so for them the hook is this
 *  script: read the vendor's JSON payload on stdin, hand it to the daemon,
 *  say nothing.
 *
 *  Three properties are load-bearing:
 *
 *  - **It always exits 0.** In all three harnesses a hook's exit code is a
 *    verdict on the tool call: exit 2 blocks it in goose and crush, and crush
 *    reads 49 as "halt the whole turn". curl's own failure codes are in that
 *    space (7 for a refused connection, 28 for a timeout), so letting curl's
 *    status escape would eventually let a daemon restart cancel an agent's
 *    tool call. Recording is a bystander; it never gets a vote.
 *  - **It writes nothing to stdout.** cline parses a hook's stdout as JSON
 *    control output, so a stray byte reads as a malformed directive.
 *  - **Auth comes from the environment.** `BRANE_NARRATIVE_ID` and
 *    `BRANE_NARRATIVE_SECRET` are set on the tmux session (see braneTmuxEnv),
 *    and all three harnesses hand their whole environment to hook commands —
 *    the same inheritance the MCP bridge rides. The daemon's bearer token is
 *    never written to disk. */
function braneHookScript(url: string): string {
  return `#!/bin/sh
# Written by brane. Reports one tool call to the daemon, then gets out of the way.
# Rewritten on every spawn and revive — edits here will not survive.
curl -sS -m 10 -X POST '${url}' \\
  -H "X-Brane-Narrative-Id: \${BRANE_NARRATIVE_ID}" \\
  -H "X-Brane-Narrative-Secret: \${BRANE_NARRATIVE_SECRET}" \\
  -H 'Content-Type: application/json' \\
  --data-binary @- >/dev/null 2>&1
# Never let curl's exit code become a verdict on the tool call.
exit 0
`;
}

/** Write the hook script, idempotently, and return its path.
 *
 *  Same contract as the config writers: rewritten whenever it's stale (the
 *  daemon's port moves), left alone when it isn't, since this runs on every
 *  spawn and revive.
 *
 *  The chmod is separate from the write, and not redundant: `writeFileSync`'s
 *  `mode` applies only when it *creates* the file. Every rewrite after the
 *  first — a port drift, a change to the script itself — lands on an existing
 *  file and silently ignores the mode, so a script that ever lost its execute
 *  bit would never get it back, and the harness would simply stop being able to
 *  run the hook. */
function writeBraneHookScript(dir: string, name: string, url: string): string {
  const path = join(dir, name);
  const script = braneHookScript(url);
  try {
    if (readFileSync(path, "utf-8") === script && (statSync(path).mode & 0o111) === 0o111) {
      return path;
    }
  } catch {
    // Not written yet, or unreadable — write it.
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** Ensure a goose plugin in the fold reports tool calls to the daemon.
 *
 *  goose implements the Open Plugins hooks spec: a plugin directory holding
 *  `hooks/hooks.json`, discovered under `<fold>/.agents/plugins/*` when goose
 *  starts in that project (both strings are in the shipped binary). Events map
 *  to rules, rules to shell commands, and the payload arrives as JSON on stdin.
 *
 *  `PostToolUseFailure` is listed alongside the other two because goose reports
 *  a failed call as its own event rather than as a field — without it a failing
 *  tool would sit `pending` forever, since the plain `PostToolUse` never fires.
 *
 *  Unlike cline's, this file lives in the operator's fold. It is brane's own
 *  plugin directory rather than a shared config file, so owning it outright is
 *  honest — but it is still rewritten only when stale. */
export function ensureGooseHookConfig(db: Database.Database, foldPath: string): void {
  const url = braneHookUrl(db);
  if (!url) return;

  const pluginDir = join(foldPath, ".agents", "plugins", "brane");
  const hooksDir = join(pluginDir, "hooks");
  const scriptPath = writeBraneHookScript(hooksDir, "report-tool-use.sh", url);

  const rule = {
    // Regex over the tool name, matching everything — including the loop's own
    // narrate and listen, for the reasons in ensureClaudeHookConfig.
    matcher: ".*",
    hooks: [{ type: "command", command: scriptPath, timeout: 10 }],
  };
  const desired = {
    hooks: {
      PreToolUse: [rule],
      PostToolUse: [rule],
      PostToolUseFailure: [rule],
    },
  };

  const configPath = join(hooksDir, "hooks.json");
  const serialized = JSON.stringify(desired, null, 2) + "\n";
  try {
    if (readFileSync(configPath, "utf-8") === serialized) return;
  } catch {
    // Not written yet — write it.
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(configPath, serialized);
}

/** Ensure a brane-spawned cline session reports tool calls to the daemon.
 *
 *  cline discovers hooks as *executable files named after the event*, and its
 *  hooks directory follows `--config` — which brane already sets to a private
 *  per-narrative directory (see ensureClineMcpConfig). So unlike goose and
 *  claude, this touches nothing the operator owns: the scripts live beside the
 *  MCP settings brane already writes there, and a session that brane didn't
 *  spawn is unaffected.
 *
 *  `/tmp` is boot-volatile on macOS, which costs nothing here — the rows are in
 *  brane's database, and the next spawn or revive rewrites the scripts. */
export function ensureClineHookConfig(db: Database.Database, narrativeId: string): void {
  const url = braneHookUrl(db);
  if (!url) return;
  const hooksDir = join("/tmp", `brane-cline-${narrativeId}`, "hooks");
  // Both phases run the same script — the payload names which one it is, and
  // the daemon reads that (normalizeHookPayload) rather than the filename.
  for (const event of ["PreToolUse", "PostToolUse"]) {
    writeBraneHookScript(hooksDir, event, url);
  }
}

/** Install whatever tool-call capture the agent supports, or nothing.
 *
 *  Optional capability, always: a failure to write hook config must never fail
 *  a spawn (claude-xlolbv6l:84), and an agent with no hook support launches
 *  exactly as it did before. crush is absent on purpose — it has a PreToolUse
 *  hook but no PostToolUse event at all, and its pre payload carries no call id
 *  to pair the two halves with, so its completions come from its session log
 *  instead. */
export function ensureHookConfig(
  db: Database.Database,
  agent: string,
  foldPath: string,
  narrativeId: string,
): void {
  try {
    if (agent === "claude") ensureClaudeHookConfig(db, foldPath);
    else if (agent === "goose") ensureGooseHookConfig(db, foldPath);
    else if (agent === "cline") ensureClineHookConfig(db, narrativeId);
  } catch (err) {
    console.error(`Warning: could not write hook config: ${err}`);
  }
}

/** Build the tmux env-var prefix that hands a session its identity and its
 *  agent token. The bridge presents the token as its bearer on /ws/mcp (and
 *  as `&secret=`), where the daemon checks it by hash against the
 *  narrative's live agent token; the session's `brane` CLI and hooks present
 *  it too. Tokens are UUIDs, shell-safe, so no escaping is needed. Omitted
 *  only when the caller passes none: every launch mints one first. The line
 *  reaches tmux on stdin (`newTmuxSession`), never in a process's argv. */
export function braneTmuxEnv(narrativeId: string, bindToken?: string | null): string {
  const secret = bindToken ? ` BRANE_NARRATIVE_SECRET=${bindToken}` : "";
  return `BRANE_NARRATIVE_ID=${narrativeId}${secret}`;
}

/** The secret a launch hands its session as `BRANE_NARRATIVE_SECRET`: a
 *  fresh agent token for the narrative (`mintAgentToken`, src/db/tokens.ts),
 *  which revokes whatever token its previous launch held. It is what the
 *  session's MCP bridge, hooks and `brane` CLI present, and the daemon keeps
 *  only its hash — nothing about it is written to `narratives`. Called once
 *  per launch: spawn, revive, and an agent switch. */
export function ensureBindToken(db: Database.Database, narrativeId: string): string {
  return mintAgentToken(db, narrativeId);
}

/** Build the --with-extension string for goose's inline MCP configuration.
 *  Format: "BRANE_NARRATIVE_ID=<nid> [BRANE_NARRATIVE_SECRET=<tok>] command args..."
 *  Goose runs the bridge with this inline env, so the secret must ride here
 *  rather than relying on the surrounding tmux shell env. */
export function buildGooseExtensionArg(narrativeId: string, bindToken?: string | null): string {
  const { command, args } = resolveBraneMcpCommand();
  return `${braneTmuxEnv(narrativeId, bindToken)} ${command} ${args.join(" ")}`;
}

/** Ensure .gemini/settings.json in the fold directory includes the brane MCP server.
 *  Gemini reads project-level MCP config from .gemini/settings.json. */
function ensureGeminiMcpConfig(foldPath: string): void {
  const geminiDir = join(foldPath, ".gemini");
  const settingsPath = join(geminiDir, "settings.json");
  let config: { mcpServers?: Record<string, unknown> } = {};

  try {
    config = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    // No existing config — start fresh
  }

  if (!config.mcpServers) config.mcpServers = {};

  const { command, args } = resolveBraneMcpCommand();

  // Skip write if brane entry already matches
  const existing = config.mcpServers.brane as
    | { command?: string; args?: string[]; env?: unknown; timeout?: number }
    | undefined;
  if (
    existing &&
    existing.command === command &&
    JSON.stringify(existing.args) === JSON.stringify(args) &&
    !existing.env &&
    existing.timeout === MCP_TOOL_TIMEOUT_MS
  ) {
    return;
  }

  // Gemini's default per-tool timeout is 600s — below a long `listen` hold.
  config.mcpServers.brane = { command, args, timeout: MCP_TOOL_TIMEOUT_MS };

  // Ensure .gemini directory exists
  try {
    execFileSync("mkdir", ["-p", geminiDir], { stdio: "ignore" });
  } catch {}

  writeFileSync(settingsPath, JSON.stringify(config, null, 2) + "\n");
}

/** Replace a TOML table (header line through the line before the next table
 *  header, or EOF) with `replacement`; append if the table is absent.
 *
 *  Line-anchored on purpose. A naive /\[header\][^\[]*(?=\[|$)/s stops at the
 *  first `[` *anywhere*, including inside a value like `args = ["mcp"]`, which
 *  truncates the match mid-section and leaves the tail (`["mcp"]\nenv_vars…`)
 *  orphaned in the file as a bogus table header. Table headers only ever start
 *  at column 0, so match on that. */
export function replaceTomlTable(
  source: string,
  header: string,
  replacement: string,
): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === header);
  if (start === -1) {
    return source.trimEnd() + "\n\n" + replacement;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[[^\]]*\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const merged = [
    ...lines.slice(0, start),
    ...replacement.replace(/\n+$/, "").split("\n"),
    "",
    ...lines.slice(end),
  ];
  return merged.join("\n");
}

/** Ensure global ~/.codex/config.toml includes the brane MCP server.
 *  Project-level config requires trust, so we write to the global config.
 *  Uses env_vars to pass BRANE_NARRATIVE_ID from parent env to MCP servers. */
function ensureCodexMcpConfig(): void {
  const globalConfigPath = join(
    process.env.HOME || "/tmp",
    ".codex",
    "config.toml",
  );
  let existing = "";

  try {
    existing = readFileSync(globalConfigPath, "utf-8");
  } catch {
    return; // No global config — codex may not be installed
  }

  const { command, args } = resolveBraneMcpCommand();

  // codex's default per-tool timeout is 60s — well below the daemon's `listen`
  // hold, so an idle codex agent's long-poll aborts client-side today.
  const braneSection = [
    `[mcp_servers.brane]`,
    `command = "${command}"`,
    `args = ${JSON.stringify(args)}`,
    `env_vars = ["BRANE_NARRATIVE_ID", "BRANE_NARRATIVE_SECRET"]`,
    `tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SEC}`,
    ``,
  ].join("\n");

  // Check if brane MCP server is already configured
  if (existing.includes("[mcp_servers.brane]")) {
    // Verify command, args, timeout, and secret passthrough match — if so, skip.
    // BRANE_NARRATIVE_SECRET in the check forces a rewrite of pre-bind-token
    // configs so codex forwards the secret env var to the bridge.
    if (existing.includes(`command = "${command}"`) &&
        existing.includes("BRANE_NARRATIVE_SECRET") &&
        existing.includes(`tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SEC}`)) {
      return;
    }
    // Replace existing brane table (header through the next table header / EOF)
    writeFileSync(
      globalConfigPath,
      replaceTomlTable(existing, "[mcp_servers.brane]", braneSection),
    );
  } else {
    // Append brane MCP server section
    writeFileSync(globalConfigPath, existing.trimEnd() + "\n\n" + braneSection);
  }
}

/** Ensure a per-session MCP config JSON file for Copilot.
 *  Copilot does NOT inherit parent env vars into MCP subprocesses,
 *  so BRANE_NARRATIVE_ID must be explicit in the config's env field.
 *  Returns the absolute path to the config file. */
function ensureCopilotMcpConfig(_foldPath: string, narrativeId: string, bindToken?: string | null): string {
  const configPath = join("/tmp", `brane-copilot-mcp-${narrativeId}.json`);
  const { command, args } = resolveBraneMcpCommand();

  // copilot's default per-tool timeout is 60s. `timeout` is nominally honored
  // since copilot-cli#172 (closed 2026-04-06), but a post-fix report on 1.0.55
  // set it correctly and still aborted at 60s — so treat this as a request,
  // not a guarantee, and do not raise copilot's `listen` hold until measured.
  const config = {
    mcpServers: {
      brane: {
        type: "stdio",
        command,
        args,
        env: {
          BRANE_NARRATIVE_ID: narrativeId,
          ...(bindToken ? { BRANE_NARRATIVE_SECRET: bindToken } : {}),
        },
        timeout: MCP_TOOL_TIMEOUT_MS,
      },
    },
  };

  // 0600: it holds the session's agent token, and /tmp is shared.
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return configPath;
}

/** Ensure .amp/settings.json in the fold directory includes the brane MCP server.
 *  Amp reads workspace-level MCP config from .amp/settings.json using "amp.mcpServers" key. */
function ensureAmpMcpConfig(foldPath: string): void {
  const ampDir = join(foldPath, ".amp");
  const settingsPath = join(ampDir, "settings.json");
  let config: Record<string, unknown> = {};

  try {
    config = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    // No existing config — start fresh
  }

  const mcpServers = (config["amp.mcpServers"] ?? {}) as Record<string, unknown>;
  const { command, args } = resolveBraneMcpCommand();

  // Skip write if brane entry already matches
  const existing = mcpServers.brane as
    | { command?: string; args?: string[]; env?: unknown }
    | undefined;
  if (
    existing &&
    existing.command === command &&
    JSON.stringify(existing.args) === JSON.stringify(args) &&
    !existing.env
  ) {
    return;
  }

  mcpServers.brane = { command, args };
  config["amp.mcpServers"] = mcpServers;

  // Ensure .amp directory exists
  try {
    execFileSync("mkdir", ["-p", ampDir], { stdio: "ignore" });
  } catch {}

  writeFileSync(settingsPath, JSON.stringify(config, null, 2) + "\n");
}

/** Ensure a per-session cline config directory with MCP settings.
 *  Cline doesn't inherit parent env vars into MCP subprocesses,
 *  so BRANE_NARRATIVE_ID must be explicit in the config's env field.
 *  Auth files (secrets.json, globalState.json) are symlinked from
 *  the default ~/.cline/data/ directory.
 *  Returns the path to the config directory (for --config flag). */
function ensureClineMcpConfig(narrativeId: string, bindToken?: string | null): string {
  const configDir = join("/tmp", `brane-cline-${narrativeId}`);
  const dataDir = join(configDir, "data");
  const settingsDir = join(dataDir, "settings");
  const settingsPath = join(settingsDir, "cline_mcp_settings.json");

  const { command, args } = resolveBraneMcpCommand();

  const config = {
    mcpServers: {
      brane: {
        command,
        args,
        env: {
          BRANE_NARRATIVE_ID: narrativeId,
          ...(bindToken ? { BRANE_NARRATIVE_SECRET: bindToken } : {}),
        },
        // cline's per-tool timeout is in seconds, default 60 — below the
        // daemon's `listen` hold, and three consecutive aborted listens trip
        // cline's "max consecutive mistakes" breaker, ending the agent's turn.
        timeout: MCP_TOOL_TIMEOUT_SEC,
      },
    },
  };

  // Ensure directories exist
  try {
    execFileSync("mkdir", ["-p", settingsDir], { stdio: "ignore" });
  } catch {}

  // 0600 and a 0700 directory: it holds the session's agent token, and /tmp
  // is shared.
  writeFileSync(settingsPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(settingsPath, 0o600);
  chmodSync(configDir, 0o700);

  // Symlink auth files from default cline config. settings/providers.json is
  // the v3 provider store (API keys, base URLs) — without it, API-key providers
  // resolve to their default endpoints and only OAuth providers survive.
  const defaultDataDir = join(process.env.HOME || "/tmp", ".cline", "data");
  for (const file of [
    "secrets.json",
    "globalState.json",
    "settings/providers.json",
    "settings/models.json",
  ]) {
    const target = join(defaultDataDir, file);
    const link = join(dataDir, file);
    try {
      statSync(target);
      // Remove existing link/file before creating symlink
      try { execFileSync("rm", ["-f", link], { stdio: "ignore" }); } catch {}
      execFileSync("ln", ["-s", target, link], { stdio: "ignore" });
    } catch {
      // Source file doesn't exist — skip
    }
  }

  return configDir;
}

/** Re-establish a flag-based agent's per-session MCP config and return the
 *  launch flags that point the agent at it. Copilot and Cline read their
 *  brane MCP server from a config file passed on the command line, not from
 *  a persistent file in the fold — so a same-agent revive has to recreate it
 *  the way spawn's buildAgentArgs does. File-based agents (claude/gemini/
 *  codex/amp/crush) persist their config in the fold and need nothing here,
 *  so this returns []. */
export function reestablishMcpConfigArgs(
  agent: string,
  absoluteFoldPath: string,
  narrativeId: string,
  bindToken?: string | null,
): string[] {
  if (agent === "copilot") {
    return ["--additional-mcp-config", `@${ensureCopilotMcpConfig(absoluteFoldPath, narrativeId, bindToken)}`];
  }
  if (agent === "cline") {
    return ["--config", ensureClineMcpConfig(narrativeId, bindToken)];
  }
  return [];
}

/** Ensure .crush.json in the fold directory includes the brane MCP server.
 *  Crush reads MCP config from .crush.json using an "mcp" key. */
function ensureCrushMcpConfig(foldPath: string): void {
  const configPath = join(foldPath, ".crush.json");
  let config: Record<string, unknown> = {};

  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // No existing config — start fresh
  }

  const mcp = (config.mcp ?? {}) as Record<string, unknown>;
  const { command, args } = resolveBraneMcpCommand();

  // Skip write if brane entry already matches
  const existing = mcp.brane as
    | { command?: string; args?: string[]; env?: unknown; timeout?: number }
    | undefined;
  if (
    existing &&
    existing.command === command &&
    JSON.stringify(existing.args) === JSON.stringify(args) &&
    !existing.env &&
    existing.timeout === MCP_TOOL_TIMEOUT_SEC
  ) {
    return;
  }

  // crush's per-server MCP timeout is in seconds; without it the client cap
  // sits below a long daemon `listen` hold.
  mcp.brane = { type: "stdio", command, args, timeout: MCP_TOOL_TIMEOUT_SEC };
  config.mcp = mcp;

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** The model flag as this agent spells it, or nothing for agents without one.
 *  Split out of `buildAgentArgs` because the lifecycle line shows it too: the
 *  operator's model choice is part of the invocation a reader should see. */
export function modelArgs(agent: string, model?: string | null): string[] {
  if (!model) return [];
  switch (agent) {
    case "claude":
    case "codex":
      return ["--model", model];
    case "gemini":
    case "cline":
    case "crush":
      return ["-m", model];
    default:
      return [];
  }
}

export function buildAgentArgs(
  agent: string,
  opts: { model?: string; role?: string; narrativeId?: string; mcpConfigPath?: string; bindToken?: string | null; sessionId?: string },
): string[] {
  const args: string[] = [];

  if (agent === "claude") {
    args.push(...modelArgs(agent, opts.model));
    // The daemon owns the claude session id: it mints a uuid and pins it here
    // via `--session-id` so the value on the narrative row (written at INSERT)
    // is authoritative, rather than relying on the bridge to self-detect and
    // report one. Claude exports it as CLAUDE_CODE_SESSION_ID for the bridge.
    if (opts.sessionId) {
      args.push("--session-id", opts.sessionId);
    }
  } else if (agent === "goose") {
    args.push("session");
    args.push("--with-builtin", "developer");
    if (opts.narrativeId) {
      args.push("--with-extension", buildGooseExtensionArg(opts.narrativeId, opts.bindToken));
      args.push("-n", opts.narrativeId);
    }
  } else if (agent === "gemini") {
    args.push(...modelArgs(agent, opts.model));
  } else if (agent === "codex") {
    args.push("--full-auto", "--no-alt-screen");
    args.push("-c", "check_for_update_on_startup=false");
    args.push("-c", 'project_root_markers=[".codex", ".git"]');
    args.push(...modelArgs(agent, opts.model));
  } else if (agent === "amp") {
    // Amp is an interactive TUI — no special args needed
    // MCP config is read from .amp/settings.json
  } else if (agent === "copilot") {
    if (opts.sessionId) {
      args.push("--session-id", opts.sessionId);
    }
    if (opts.mcpConfigPath) {
      args.push("--additional-mcp-config", `@${opts.mcpConfigPath}`);
    }
  } else if (agent === "cline") {
    args.push("-y");
    if (opts.mcpConfigPath) {
      args.push("--config", opts.mcpConfigPath);
    }
    args.push(...modelArgs(agent, opts.model));
  } else if (agent === "crush") {
    args.push("-y");
    args.push(...modelArgs(agent, opts.model));
  }

  return args;
}

export interface SpawnOptions {
  db: Database.Database;
  agent: string;
  role?: string;
  model?: string;
  re?: string;
  foldPath: string; // portable path (e.g. "~/dev/brane")
  terminalSize?: { cols: number; rows: number };
  extraArgs?: string[]; // Passthrough argv appended to the agent command (e.g. --dangerously-skip-permissions)
}

export interface SpawnResult {
  narrativeId: string;
  foldPath: string;
  agentType: string;
  role: string;
}

/** Core spawn logic, usable from both CLI and daemon API. */
export function doSpawn(opts: SpawnOptions): SpawnResult {
  const { db, agent, model, re, extraArgs } = opts;

  // Validate agent name: alphanumeric, hyphens, underscores only
  if (!/^[a-zA-Z0-9_-]+$/.test(agent)) {
    throw new Error(`Invalid agent name: ${agent}`);
  }
  // A spawn with `re` is a twin: it continues from a predecessor narrative and
  // is governed by the role-bound `twin` protocol. Force role "twin" (overriding
  // any caller-supplied role) so the agent auto-reads that protocol on startup.
  const role = re ? "twin" : (opts.role ?? "worker");

  // Pin the predecessor reference to a specific seq so the fork point is
  // explicit and durable: the predecessor may still be live and append events
  // past it. If the caller already supplied a `nid:seq` ref, trust it; otherwise
  // resolve the predecessor's current MAX(seq) here (atomic, race-free).
  let pinnedRe: string | undefined;
  if (re) {
    if (re.includes(":")) {
      pinnedRe = re;
    } else {
      const row = db
        .prepare("SELECT MAX(seq) as max_seq FROM events WHERE narrative_id = ?")
        .get(re) as { max_seq: number | null };
      pinnedRe = `${re}:${row.max_seq ?? 0}`;
    }
  }

  const foldPath = opts.foldPath;
  const absoluteFoldPath = fromPortablePath(foldPath);

  // Verify fold is registered and inherit its brane_id (if set)
  const fold = db.prepare("SELECT path, brane_id FROM folds WHERE path = ?").get(foldPath) as
    | { path: string; brane_id: string | null }
    | undefined;
  if (!fold) {
    throw new Error(`Not a fold: ${foldPath}. Run \`brane fold\` first.`);
  }
  const braneId = fold.brane_id ?? getConfig("default.brane", db) ?? getBraneId(db);

  // Resolve agent command
  const agentCommand = resolveAgentCommand(agent);

  // Generate narrative ID
  const uniqueId = randomBase36(8);
  const narrativeId = `${agent}-${uniqueId}`;

  // Per-narrative bind secret: the bridge presents it on /ws/mcp so the daemon
  // can verify this connection genuinely owns `narrativeId` before trusting it.

  // The daemon owns the session id for agents that let it *assign* one: mint it
  // here and pass it via `--session-id` (below) so the value recorded on the row
  // is authoritative and never contested by a self-detecting client. Keyed off
  // the adapter capability, not the agent name — "assign" agents (currently only
  // claude) mint at spawn; "capture"/none agents get no id here (a capture agent
  // has its self-generated id recorded later; see the daemon's capture path).
  const sessionId =
    getAgentAdapter(agent).sessionIdOwnership === "assign" ? randomUUID() : null;

  // Record narrative in db — persist launch_args so revive can reuse them
  const launchArgsJson = extraArgs && extraArgs.length > 0 ? JSON.stringify(extraArgs) : null;
  db.prepare(
    `INSERT INTO narratives (id, brane_id, fold_path, agent_type, role, created_at, status, launch_args, bind_token, agent_session_id)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(narrativeId, braneId, foldPath, agent, role, Date.now(), launchArgsJson, null, sessionId);
  // The session's credential: an agent token, hashed in `tokens`, its
  // plaintext only in the env built below. `bind_token` stays null.
  const bindToken = mintAgentToken(db, narrativeId);

  // Log started event: the invocation as the operator chose it (binary, model
  // flag, passthrough args) and the role — a twin's line also names the
  // predecessor, pinned in `re` so the fork point is durable.
  appendEvent(db, narrativeId, "started", {
    content: spawnedContent(agent, role, {
      args: [...modelArgs(agent, model), ...(extraArgs ?? [])],
      from: pinnedRe,
    }),
    ...(pinnedRe ? { re: [pinnedRe] } : {}),
  });

  // Update fold's last_spawned
  db.prepare("UPDATE folds SET last_spawned = ? WHERE path = ?").run(Date.now(), foldPath);

  // Write MCP config for agents that use file-based config
  // (goose uses --with-extension inline instead)
  let copilotMcpConfigPath: string | undefined;
  if (agent === "gemini") {
    ensureGeminiMcpConfig(absoluteFoldPath);
  } else if (agent === "codex") {
    ensureCodexMcpConfig();
  } else if (agent === "amp") {
    ensureAmpMcpConfig(absoluteFoldPath);
  } else if (agent === "copilot") {
    copilotMcpConfigPath = ensureCopilotMcpConfig(absoluteFoldPath, narrativeId, bindToken);
  } else if (agent === "cline") {
    copilotMcpConfigPath = ensureClineMcpConfig(narrativeId, bindToken);
  } else if (agent === "crush") {
    ensureCrushMcpConfig(absoluteFoldPath);
  } else if (agent !== "goose") {
    ensureMcpConfig(absoluteFoldPath);
  }

  ensureHookConfig(db, agent, absoluteFoldPath, narrativeId);
  // Session affinity: CLI args (claude's per-narrative `--settings`) and/or an
  // env prefix, both of which must reach the tmux command.
  const affinity = ensureSessionAffinityConfig(agent, absoluteFoldPath, narrativeId, { db });

  // Build the command to run inside tmux
  const agentArgs = buildAgentArgs(agent, { model, role, narrativeId, mcpConfigPath: copilotMcpConfigPath, bindToken, sessionId: sessionId ?? undefined });
  agentArgs.push(...affinity.args);

  // Append caller-supplied passthrough args before the prompt (prompts are positional and must come last for claude/codex)
  if (extraArgs && extraArgs.length > 0) {
    agentArgs.push(...extraArgs);
  }

  // Pass the LIVE loop bootstrap prompt (or continuation prompt if re is set)
  const prompt = pinnedRe ? buildTwinPrompt(pinnedRe) : LIVE_LOOP_PROMPT;
  if (agent === "claude") {
    // Claude accepts prompt as positional arg
    agentArgs.push(prompt);
  } else if (agent === "codex") {
    // Codex accepts prompt as positional arg (like Claude)
    agentArgs.push(prompt);
  } else if (agent === "gemini") {
    // Gemini uses -i for interactive mode with initial prompt
    agentArgs.push("-i", prompt);
  }

  const agentCmd = [agentCommand, ...agentArgs]
    .map((a) => (a.includes(" ") || a.includes("'") ? `'${a.replace(/'/g, "'\\''")}'` : a))
    .join(" ");

  // Prefix with BRANE_NARRATIVE_ID + bind secret so the MCP bridge inherits both
  const tmuxCmd = [braneTmuxEnv(narrativeId, bindToken), affinity.env, agentCmd].filter(Boolean).join(" ");

  // Create tmux session
  try {
    newTmuxSession({ name: narrativeId, cwd: absoluteFoldPath, size: opts.terminalSize, command: tmuxCmd });
  } catch (err) {
    db.prepare("UPDATE narratives SET status = 'ended' WHERE id = ?").run(narrativeId);
    throw new Error(`Failed to create tmux session: ${err}`);
  }

  // For goose/copilot: inject LIVE loop prompt via tmux send-keys (no positional prompt support)
  if (agent === "goose" || agent === "copilot" || agent === "amp" || agent === "cline" || agent === "crush") {
    const submitKey = agent === "copilot" ? "S-Enter" : "Enter";
    setTimeout(() => {
      try {
        execFileSync(resolveTmux(), [
          "send-keys", "-t", narrativeId,
          prompt,
          submitKey,
        ], { stdio: "ignore" });
      } catch {
        // Session may not be ready yet — prompt injection is best-effort
      }
      // TUI agents (cline, crush) may need a follow-up Enter after paste settles
      if (agent === "cline" || agent === "crush") {
        setTimeout(() => {
          try {
            execFileSync(resolveTmux(), ["send-keys", "-t", narrativeId, "Enter"], { stdio: "ignore" });
          } catch {}
        }, 500);
      }
    }, 2000);
  }

  return { narrativeId, foldPath, agentType: agent, role };
}

/** Set up MCP config and build launch command for an agent in a fold.
 *  Used by revive when switching agent types. */
export function prepareAgentLaunch(
  db: Database.Database,
  agent: string,
  narrativeId: string,
  foldPath: string,
): { agentCommand: string; tmuxCmd: string } {
  const agentCommand = resolveAgentCommand(agent);
  const absoluteFoldPath = fromPortablePath(foldPath);
  const bindToken = ensureBindToken(db, narrativeId);

  // Set up MCP config
  let copilotMcpConfigPath: string | undefined;
  if (agent === "gemini") {
    ensureGeminiMcpConfig(absoluteFoldPath);
  } else if (agent === "codex") {
    ensureCodexMcpConfig();
  } else if (agent === "amp") {
    ensureAmpMcpConfig(absoluteFoldPath);
  } else if (agent === "copilot") {
    copilotMcpConfigPath = ensureCopilotMcpConfig(absoluteFoldPath, narrativeId, bindToken);
  } else if (agent === "cline") {
    copilotMcpConfigPath = ensureClineMcpConfig(narrativeId, bindToken);
  } else if (agent === "crush") {
    ensureCrushMcpConfig(absoluteFoldPath);
  } else if (agent !== "goose") {
    ensureMcpConfig(absoluteFoldPath);
  }

  ensureHookConfig(db, agent, absoluteFoldPath, narrativeId);
  const affinity = ensureSessionAffinityConfig(agent, absoluteFoldPath, narrativeId, { db });

  // Build agent args (fresh spawn, no resume)
  const agentArgs = buildAgentArgs(agent, {
    narrativeId,
    mcpConfigPath: copilotMcpConfigPath,
    bindToken,
  });
  agentArgs.push(...affinity.args);

  // Add LIVE loop prompt
  if (agent === "claude" || agent === "codex") {
    agentArgs.push(LIVE_LOOP_PROMPT);
  } else if (agent === "gemini") {
    agentArgs.push("-i", LIVE_LOOP_PROMPT);
  }

  const agentCmd = [agentCommand, ...agentArgs]
    .map((a) => (a.includes(" ") || a.includes("'") ? `'${a.replace(/'/g, "'\\''")}'` : a))
    .join(" ");

  const tmuxCmd = [braneTmuxEnv(narrativeId, bindToken), affinity.env, agentCmd].filter(Boolean).join(" ");
  return { agentCommand, tmuxCmd };
}

/** The narrative shape `POST /api/spawn` hands back. */
interface SpawnedNarrative {
  id: string;
  fold_path: string;
  role: string;
  agent_type: string;
}

export const spawnCommand = defineCommand({
  meta: {
    name: "spawn",
    description: "Spawn an agent in a new tmux session",
  },
  args: {
    agent: {
      type: "positional",
      required: true,
      description: "Agent to spawn (e.g., claude, goose, aider, lazygit)",
    },
    role: {
      type: "string",
      default: "worker",
      description: "Agent role (worker, coordinator, image-analyst)",
    },
    attach: {
      type: "boolean",
      description: "Attach to session after spawning",
    },
    model: {
      type: "string",
      description: "Model hint (e.g., haiku, sonnet, opus)",
    },
    re: {
      type: "string",
      description: "Parent narrative ID for prefix memory",
    },
    meld: {
      type: "boolean",
      description: "Print a meld URL + QR code that opens the new narrative on a mobile device",
    },
    "meld-host": {
      type: "string",
      description: "Override the host advertised in the meld URL (default: Tailscale DNS > 127.0.0.1)",
    },
    "meld-local": {
      type: "boolean",
      description: "Use a direct daemon URL in the meld output instead of brane.organelle.dev",
    },
  },
  async run({ args }) {
    const foldPath = toPortablePath(resolve(process.cwd()));
    const extraArgs = extractPassthroughArgs();

    try {
      // Spawning goes through the daemon, exactly as the web app's spawn
      // button does — `POST /api/spawn` is the single spawn path, and the CLI
      // is one of its clients rather than a second implementation. Everything
      // below this call is terminal-only presentation (QR code, attach).
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      // Minted before the spawn: from this machine it waits for the presence
      // check, and a declined prompt should leave nothing running.
      const deviceToken = args.meld ? await mintDeviceToken(endpoint) : undefined;
      const { narrative } = await daemonRequest<{ narrative: SpawnedNarrative }>(
        endpoint,
        "/api/spawn",
        {
          method: "POST",
          body: {
            agent: args.agent,
            fold_path: foldPath,
            role: args.role,
            ...(args.model ? { model: args.model } : {}),
            ...(args.re ? { re: args.re } : {}),
            ...(extraArgs.length > 0 ? { extra_args: extraArgs } : {}),
          },
        },
      );

      console.log(`Spawned ${narrative.agent_type} as ${narrative.id}`);
      console.log(`  fold: ${narrative.fold_path}`);
      console.log(`  role: ${narrative.role}`);
      if (args.model) console.log(`  model: ${args.model}`);
      if (args.re) console.log(`  re: ${args.re}`);

      if (deviceToken) {
        const meldDb = openDatabase();
        const { url, daemonHost, scheme, useLocal, isLoopbackFallback, tlsDegraded } = buildMeldUrl({
          db: meldDb,
          daemon: { port: endpoint.port, token: deviceToken },
          path: `/${narrative.id}`,
          host: args["meld-host"],
          local: args["meld-local"],
        });
        meldDb.close();

        console.log(`\nScan this QR code to open ${narrative.id}:\n`);
        qrcode.generate(url, { small: true }, (code: string) => {
          console.log(code);
        });
        console.log(`\n${url}\n`);
        console.log(`Daemon: ${daemonHost} (${scheme})`);
        if (!useLocal) console.log(`App: brane.organelle.dev`);
        console.log(meldLapseNote());
        if (isLoopbackFallback) {
          console.log(
            "\nNo Tailscale detected — this URL only works from this machine.",
          );
        } else if (tlsDegraded) {
          console.log(
            "\nWarning: Tailscale is up but the daemon has no TLS cert, so this URL uses plain HTTP.",
          );
          console.log(
            "Run `brane certify` to provision one — it'll tell you if \"HTTPS for your tailnet\" needs enabling.",
          );
        }
      }

      // Optionally attach
      if (args.attach) {
        execFileSync(resolveTmux(), ["attach-session", "-t", narrative.id], {
          stdio: "inherit",
        });
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
