/**
 * Who may start the daemon, and where a running one came from.
 *
 * **Stop means stop.** `brane daemon stop` records the operator's intent in
 * `meta.daemon_stopped` before it signals the daemon. While that row stands,
 * nothing starts a daemon implicitly: not an MCP bridge reconnecting, not a
 * `brane` command that would otherwise start one, and not a `daemon start
 * --foreground` spawned by one of those (the daemon checks at startup, which
 * also covers bridges still running older code). Only the operator's explicit
 * `brane daemon start` or `restart` clears it.
 *
 * **Implicit starts never come from an agent.** A daemon inherits its
 * confinement from whatever started it: a sandbox, macOS's attribution of a
 * process to the app that launched it, proxy settings in its environment.
 * Every agent it later spawns or revives inherits the same, through tmux. So
 * an agent's session (its CLI or its MCP bridge) never starts one, stopped or
 * not; the operator does, from a terminal of their choosing.
 *
 * **Provenance.** The daemon records where it came from (`meta.daemon_origin`)
 * from its own environment at startup, and `brane daemon status` compares it
 * with the tmux server's, which is what agents actually inherit from.
 * docs/daemon-api.md, "Starting and stopping".
 */

import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";

export const STOPPED_KEY = "daemon_stopped";
export const ORIGIN_KEY = "daemon_origin";

/** Set by whatever spawns a daemon: how it was started, in the operator's
 *  words (`brane daemon start`). Absent: something older started it. */
export const VIA_ENV = "BRANE_DAEMON_VIA";
/** Set by a daemon that hands off to its successor in place (`daemon
 *  restart`): the pid it took over from. */
export const HANDOFF_ENV = "BRANE_DAEMON_HANDOFF_FROM";
/** Set by whatever spawns `daemon start --foreground` (a detached start, a
 *  command starting one as needed, a daemon handing off in place): this
 *  process was spawned, not typed, so it neither clears a stop nor counts as
 *  the operator asking. */
export const SPAWNED_ENV = "BRANE_DAEMON_DETACHED";

/** The variables a spawner hands one daemon, which that daemon drops on
 *  startup, from its own environment and from the tmux server's global one:
 *  left in place, they would reach every agent's pane, and a `daemon start
 *  --foreground` typed there would pass for one spawned
 *  (claude-ykehtq5h:7, finding 2). */
export const LAUNCH_ENV = [SPAWNED_ENV, VIA_ENV, HANDOFF_ENV] as const;

export interface StopRecord {
  /** ISO time the operator stopped it. */
  at: string;
  /** The daemon it stopped, if one was running. */
  pid?: number;
}

function metaGet(db: Database.Database, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

function metaSet(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

/** Record that the operator stopped the daemon. */
export function recordStop(db: Database.Database, pid: number | undefined, now = new Date()): StopRecord {
  const record: StopRecord = { at: now.toISOString(), ...(pid !== undefined ? { pid } : {}) };
  metaSet(db, STOPPED_KEY, JSON.stringify(record));
  return record;
}

/** The operator asked for a daemon: forget the stop. */
export function clearStop(db: Database.Database): void {
  db.prepare("DELETE FROM meta WHERE key = ?").run(STOPPED_KEY);
}

export function readStop(db: Database.Database): StopRecord | null {
  const raw = metaGet(db, STOPPED_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StopRecord>;
    return typeof parsed.at === "string" ? { at: parsed.at, ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}) } : { at: "an unknown time" };
  } catch {
    return { at: "an unknown time" };
  }
}

/** Whether this process runs inside an agent's session: it holds the token
 *  the session's launch minted for it. */
export function inAgentSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.BRANE_NARRATIVE_SECRET);
}

const START_HINT = "run `brane daemon start` in a terminal whose permissions agents should inherit";

/** Why no daemon may be started implicitly here, or null if one may. `who`
 *  says what is asking: a bridge never starts one; a CLI command does only
 *  outside an agent's session, and only while the operator has not stopped
 *  the daemon. */
export function implicitStartRefusal(
  db: Database.Database,
  who: "cli" | "bridge",
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const stop = readStop(db);
  if (stop) {
    return `brane's daemon was stopped with \`brane daemon stop\` at ${stop.at}, and stays stopped until the operator starts it: ${START_HINT}`;
  }
  if (who === "bridge") {
    return `brane's daemon is not running, and an MCP bridge never starts one (it would inherit this client's permissions): ${START_HINT}`;
  }
  if (inAgentSession(env)) {
    return `brane's daemon is not running, and an agent's session never starts one (it would inherit this session's permissions): ${START_HINT}`;
  }
  return null;
}

/** Why a daemon starting up should not run, or null. A daemon the operator
 *  asked for was cleared to start by its spawner (`clearStop`) before it was
 *  spawned, so a stop that still stands means something else spawned it. */
export function startupRefusal(db: Database.Database): string | null {
  const stop = readStop(db);
  return stop ? `the operator stopped brane's daemon at ${stop.at} (\`brane daemon stop\`); not starting until \`brane daemon start\`` : null;
}

/** Where a process came from, as far as its environment says: the app that
 *  launched its ancestry, the terminal program, tmux, ssh, an agent. */
export interface Origin {
  /** How it was started (`brane daemon start`), when the spawner said. */
  via?: string;
  /** macOS: the bundle id of the app that launched the ancestry
   *  (`com.apple.Terminal`, `com.microsoft.VSCode`). */
  app?: string;
  /** `$TERM_PROGRAM`: `Apple_Terminal`, `vscode`, `iTerm.app`, `tmux`. */
  term_program?: string;
  /** Started from inside a tmux session. */
  tmux?: boolean;
  /** Started over ssh. */
  ssh?: boolean;
  /** Started from VS Code's integrated terminal (or a process under it). */
  vscode?: boolean;
}

/** The markers in `env` that say where a process came from. Pure. */
export function originFromEnv(env: NodeJS.ProcessEnv): Origin {
  const origin: Origin = {};
  if (env[VIA_ENV]) origin.via = env[VIA_ENV];
  if (env.__CFBundleIdentifier) origin.app = env.__CFBundleIdentifier;
  if (env.TERM_PROGRAM) origin.term_program = env.TERM_PROGRAM;
  if (env.TMUX) origin.tmux = true;
  if (env.SSH_CONNECTION || env.SSH_TTY) origin.ssh = true;
  if (env.VSCODE_PID || env.VSCODE_IPC_HOOK_CLI || env.TERM_PROGRAM === "vscode") origin.vscode = true;
  return origin;
}

export interface DaemonOrigin extends Origin {
  pid: number;
  /** ISO time this process started. */
  at: string;
  /** The daemon this one took over from in place (`daemon restart`). */
  handoff_from?: number;
  /** The real path of the script it runs (its checkout's `dist/cli.js`),
   *  which a restart keeps. */
  script?: string;
}

export function recordOrigin(db: Database.Database, origin: DaemonOrigin): void {
  metaSet(db, ORIGIN_KEY, JSON.stringify(origin));
}

export function readOrigin(db: Database.Database): DaemonOrigin | null {
  const raw = metaGet(db, ORIGIN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DaemonOrigin;
  } catch {
    return null;
  }
}

/** One line for a person: where it came from, not how it is stored. Pure. */
export function describeOrigin(origin: Origin): string {
  const parts: string[] = [];
  if (origin.app) parts.push(origin.app);
  if (origin.term_program && origin.term_program !== "tmux") parts.push(`TERM_PROGRAM=${origin.term_program}`);
  if (origin.vscode && origin.app !== "com.microsoft.VSCode" && origin.term_program !== "vscode") parts.push("under VS Code");
  if (origin.tmux || origin.term_program === "tmux") parts.push("inside tmux");
  if (origin.ssh) parts.push("over ssh");
  const where = parts.length ? parts.join(", ") : "no terminal markers in its environment";
  return origin.via ? `${origin.via} — ${where}` : where;
}

/** Whether two origins plainly disagree about the app at the root of their
 *  ancestry: the one difference that changes what an agent may do. Pure. */
export function originsDiffer(a: Origin, b: Origin): boolean {
  if (a.app && b.app && a.app !== b.app) return true;
  if (Boolean(a.vscode) !== Boolean(b.vscode)) return true;
  if (Boolean(a.ssh) !== Boolean(b.ssh)) return true;
  return false;
}

/** Parse `tmux show-environment -g` output into an env. A `-NAME` line is
 *  an unset, and is left out. Pure. */
export function parseTmuxEnvironment(text: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("-")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/** The running tmux server's pid and the origin its global environment
 *  records — that of whatever process started it, which every session
 *  started in it inherits. Null when no server is running. */
export function tmuxServerOrigin(tmux: string): { pid: number; origin: Origin } | null {
  try {
    const pidOut = execFileSync(tmux, ["list-sessions", "-F", "#{pid}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const pid = parseInt(pidOut.split("\n")[0] ?? "", 10);
    if (!Number.isFinite(pid)) return null;
    const envOut = execFileSync(tmux, ["show-environment", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const origin = originFromEnv(parseTmuxEnvironment(envOut));
    // tmux sets TERM_PROGRAM in its global environment itself, for its
    // panes; what started the server is the rest.
    delete origin.via;
    delete origin.term_program;
    delete origin.tmux;
    return { pid, origin };
  } catch {
    return null;
  }
}

/** The arguments a daemon restarting in place gives its successor: its own
 *  script and subcommand, in the foreground, on `port`. Its own, never a
 *  caller's: the restart route is one request, and must not let whoever
 *  sends it choose what the daemon runs. `--token` is dropped (adopted once,
 *  and it would put a secret in `ps`), and so is any `--port`, which `port`
 *  replaces. Pure. */
export function successorArgs(execArgv: readonly string[], argv: readonly string[], port: string): string[] {
  const [, script, ...rest] = argv;
  const kept: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--port" || arg === "--token") {
      i++; // and its value
      continue;
    }
    if (arg.startsWith("--port=") || arg.startsWith("--token=")) continue;
    kept.push(arg);
  }
  if (!kept.includes("--foreground")) kept.push("--foreground");
  return [...execArgv, script, ...kept, "--port", port];
}

/** What `POST /api/daemon/restart` does with its body: the port to restart
 *  on, or the refusal. The current port unless one is named; a different one
 *  only for the operator's shell (`local`), since moving the daemon breaks
 *  every link to it (claude-ykehtq5h:7, finding 10). Pure. */
export function restartPort(
  body: string | null | undefined,
  currentPort: string | undefined,
  kind: "local" | "device" | "agent",
): { port: string } | { status: 400 | 403; error: string } {
  let requested: unknown;
  try {
    requested = body ? (JSON.parse(body) as { port?: unknown } | null)?.port : undefined;
  } catch {
    return { status: 400, error: "Body must be JSON" };
  }
  const port = requested === undefined || requested === null ? currentPort : String(requested);
  if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return { status: 400, error: `Not a port: ${String(requested ?? currentPort)}` };
  }
  if (port !== currentPort && kind !== "local") {
    return {
      status: 403,
      error: `Only the operator's shell moves the daemon to another port; restart it without one to keep ${currentPort ?? "its port"}`,
    };
  }
  return { port };
}

/** Why an in-place restart is refused here, or null. On a Fly machine the
 *  entrypoint `exec`s the daemon, so it is the machine's main process: a
 *  handoff exits it 0, which under restart policy `on-failure` stops the
 *  machine with its successor inside, and with no sleep routine (no
 *  manifest, no `tailscale down`, nothing revived on wake). `fly machine
 *  restart` stops it through the signal, which runs the routine, and starts
 *  it again (claude-46sy2xmw:8, finding 3; docs/sleep.md). */
export function restartRefusal(env: NodeJS.ProcessEnv): string | null {
  const app = env.FLY_APP_NAME?.trim();
  if (!app) return null;
  const machine = env.FLY_MACHINE_ID?.trim() || "<machine id>";
  return (
    "On a Fly machine the daemon is the machine's main process, so an in-place restart would stop the machine " +
    `instead. Restart the machine: \`fly machine restart ${machine} -a ${app}\``
  );
}

/** Whether a process's command line is a brane daemon's: what `daemon stop`
 *  checks before it signals a pid it read from the database, which a daemon
 *  that died may have left naming another process by now. Pure. */
export function isDaemonCommand(command: string): boolean {
  return /(^|\s)daemon\s+start(\s|$)/.test(command.trim());
}
