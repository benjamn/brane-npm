/** Session affinity: pin a narrative's LLM traffic to one backend replica by
 *  attaching an `X-Session-Affinity: <nid>` header, so provider-side KV prefix
 *  caches stay warm for the life of a narrative instead of thrashing on every
 *  load-balanced hop. The narrative id is the right key: it survives revives,
 *  and brane is the only layer that sees both the id and the spawn.
 *
 *  Only Claude Code needs brane's help, and only when it talks to Fireworks
 *  (an `ANTHROPIC_BASE_URL` on a `fireworks.ai` host); every other claude spawn
 *  launches exactly as it did before. Claude Code reads
 *  `ANTHROPIC_CUSTOM_HEADERS` (newline-separated `Name: Value`) from its
 *  environment, and the hard part is the layers between brane and that
 *  environment:
 *
 *  - A settings file's `env` block is written *over* the inherited shell
 *    value, and settings `env` values are not `${VAR}`-expanded (verified
 *    against claude 2.1.278 with a SessionStart-hook probe) — so when a
 *    settings file defines the variable, nothing in the shell can add to it,
 *    and a shared fold file could only hold one literal nid. The punch-through
 *    is `claude --settings <path>`, which outranks every settings file
 *    (verified end-to-end against a header-logging listener), one file per
 *    narrative at `~/.brane/session-affinity/<nid>.json` carrying the winning
 *    file's blob plus the affinity line. The operator's own files are never
 *    written.
 *
 *  - When no settings file defines it, the value Claude Code would use is
 *    whatever the *session's* shell inherits — from the tmux server, which
 *    need not share the daemon's environment. So brane must not read it from
 *    `process.env` and pin it into a `--settings` file: that replaced headers
 *    the session had and the daemon didn't (reproduced: an `X-Shell` header
 *    exported where tmux started vanished from the wire). Instead the header is
 *    appended in the tmux command's env prefix, where the session's own shell
 *    expands whatever it inherited.
 *
 *  Crush is deliberately absent: it already sends `x-session-affinity` (a hash
 *  of its own session id) and that value wins over configured `extra_headers`.
 *  Other harnesses have no observed fireworks traffic.
 *
 *  Opt out with `brane config session-affinity.enabled false`. */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";
import { getConfig } from "./commands/config.js";
import { getBraneDir } from "./db/schema.js";

export const SESSION_AFFINITY_HEADER = "X-Session-Affinity";

/** What a launch needs from affinity: CLI args for the agent, and an env
 *  prefix for the tmux command (`VAR=value`, shell syntax, or ""). */
export interface SessionAffinityLaunch {
  args: string[];
  env: string;
}

function noAffinity(): SessionAffinityLaunch {
  return { args: [], env: "" };
}

/** Return `existing` (an `ANTHROPIC_CUSTOM_HEADERS` blob) with exactly one
 *  session-affinity line: ours, at the end. Any prior affinity line (matched
 *  case-insensitively on the header name, the same parse Claude Code performs)
 *  is replaced; every other line is preserved verbatim and in order. Pure. */
export function withSessionAffinity(existing: string | undefined, value: string): string {
  const lines = (existing ?? "").split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    const colon = line.indexOf(":");
    if (colon === -1) return true; // not a header line; keep as found
    return line.slice(0, colon).trim().toLowerCase() !== SESSION_AFFINITY_HEADER.toLowerCase();
  });
  lines.push(`${SESSION_AFFINITY_HEADER}: ${value}`);
  return lines.join("\n");
}

/** Shell env assignment that appends the affinity line to whatever
 *  `ANTHROPIC_CUSTOM_HEADERS` the session's shell inherited, with a newline
 *  between them only when there was something to append to. The newline is
 *  literal inside double quotes, which POSIX sh (tmux's `-c` shell) keeps.
 *  Narrative ids are `[a-z]+-[0-9a-z]+`, so the value needs no escaping. */
export function shellAffinityEnv(narrativeId: string): string {
  return `ANTHROPIC_CUSTOM_HEADERS="\${ANTHROPIC_CUSTOM_HEADERS:+\${ANTHROPIC_CUSTOM_HEADERS}\n}${SESSION_AFFINITY_HEADER}: ${narrativeId}"`;
}

/** Whether a base URL is Fireworks'. */
export function isFireworksBaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "fireworks.ai" || host.endsWith(".fireworks.ai");
  } catch {
    return false;
  }
}

type SettingsRead =
  | { kind: "absent" }
  | { kind: "broken" }
  | { kind: "ok"; config: Record<string, unknown> };

function readSettingsFile(path: string): SettingsRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { kind: "absent" };
  }
  try {
    const config = JSON.parse(raw);
    if (config && typeof config === "object" && !Array.isArray(config)) {
      return { kind: "ok", config };
    }
    return { kind: "broken" };
  } catch {
    return { kind: "broken" };
  }
}

function envFrom(read: SettingsRead, key: string): string | undefined {
  if (read.kind !== "ok") return undefined;
  const env = read.config.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Claude Code's user-level settings directory honors CLAUDE_CONFIG_DIR. */
function claudeConfigDir(homeDir: string): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homeDir, ".claude");
}

/** Where the per-narrative `--settings` file lives. One file per nid,
 *  rewritten on every launch that needs it. */
export function claudeSessionAffinityPath(
  narrativeId: string,
  opts: { braneDir?: string } = {},
): string {
  return join(opts.braneDir ?? getBraneDir(), "session-affinity", `${narrativeId}.json`);
}

/** Decide how a claude launch carries the affinity header, writing the
 *  per-narrative `--settings` file when that is the way.
 *
 *  Settings files are consulted in Claude Code's precedence (local > project >
 *  user). `ANTHROPIC_BASE_URL` falls back to the daemon's env for the gate
 *  only: a URL the session inherits but the daemon doesn't is missed, which
 *  costs affinity and nothing else.
 *
 *  - Not Fireworks → nothing.
 *  - A settings file defines `ANTHROPIC_CUSTOM_HEADERS` → `--settings` with
 *    that blob plus the affinity line. The file carries the operator's header
 *    values, credentials included, so it is kept `0600` in a `0700` directory.
 *  - Otherwise → the env prefix, expanded by the session's own shell. */
export function ensureClaudeSessionAffinity(
  foldPath: string,
  narrativeId: string,
  opts: { homeDir?: string; braneDir?: string } = {},
): SessionAffinityLaunch {
  const home = opts.homeDir ?? homedir();
  const files = [
    join(foldPath, ".claude", "settings.local.json"),
    join(foldPath, ".claude", "settings.json"),
    join(claudeConfigDir(home), "settings.json"),
  ].map(readSettingsFile);
  const firstDefined = (key: string) => {
    for (const read of files) {
      const value = envFrom(read, key);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const baseUrl = firstDefined("ANTHROPIC_BASE_URL") ?? process.env.ANTHROPIC_BASE_URL;
  if (!isFireworksBaseUrl(baseUrl)) return noAffinity();

  const fromSettings = firstDefined("ANTHROPIC_CUSTOM_HEADERS");
  if (fromSettings === undefined) return { args: [], env: shellAffinityEnv(narrativeId) };

  const desired = withSessionAffinity(fromSettings, narrativeId);
  const path = claudeSessionAffinityPath(narrativeId, opts);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const existing = readSettingsFile(path);
  if (existing.kind !== "ok" || envFrom(existing, "ANTHROPIC_CUSTOM_HEADERS") !== desired) {
    writeFileSync(path, JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: desired } }, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  // `mode` applies only on creation; tighten a file or directory made before.
  chmodSync(path, 0o600);
  return { args: ["--settings", path], env: "" };
}

/** Spawn/revive entry point. Mirrors `ensureHookConfig`'s contract: best
 *  effort, never fatal to a launch, idempotent across the spawns and revives
 *  that call it. The caller puts `args` on the agent's command line and `env`
 *  in the tmux command's env prefix. */
export function ensureSessionAffinityConfig(
  agent: string,
  foldPath: string,
  narrativeId: string,
  opts: { enabled?: boolean; homeDir?: string; braneDir?: string; db?: Database.Database } = {},
): SessionAffinityLaunch {
  const enabled = opts.enabled ?? getConfig("session-affinity.enabled", opts.db) !== "false";
  if (!enabled || agent !== "claude") return noAffinity();
  try {
    return ensureClaudeSessionAffinity(foldPath, narrativeId, opts);
  } catch (err) {
    console.error(`Warning: could not write session affinity config: ${err}`);
    return noAffinity();
  }
}
