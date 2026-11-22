import { defineCommand } from "citty";
import { spawn, execFileSync } from "node:child_process";
import { openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase, getDbPath, ensureBraneDir, getBraneDir, getDaemonAddress, otherDaemon } from "../db/schema.js";
import {
  SPAWNED_ENV,
  VIA_ENV,
  clearStop,
  describeOrigin,
  implicitStartRefusal,
  inAgentSession,
  isDaemonCommand,
  originsDiffer,
  readOrigin,
  readStop,
  recordStop,
  tmuxServerOrigin,
} from "../daemon/lifecycle.js";
import { resolveTmux } from "../tmux.js";
import { startServer } from "../daemon/server.js";
import { legacyTokenWarning } from "../db/tokens.js";
import { withoutAgentEnv } from "../agent-env.js";
import { getTlsCertPath } from "./certify.js";
import { inspectCert } from "../tls.js";

function getLogPath(): string {
  return join(getBraneDir(), "daemon.log");
}

// During `daemon restart` the running daemon's `caffeinate -i` child is
// killed when the old daemon shuts down, and a fresh one isn't established
// until the new daemon boots far enough to call `keepAwake.start()`. That
// leaves a brief window (death-poll granularity + new-daemon startup) with
// no PreventUserIdleSystemSleep assertion held — and because releasing the
// assertion doesn't reset macOS's idle timer, a machine already idle past
// its sleep timeout becomes immediately sleep-eligible during that gap.
//
// To make the handoff break-free, the restart command itself spawns a
// short-lived bridging assertion before tearing down the old daemon. It is
// detached + unref'd so it outlives this CLI process, and self-expires via
// `-t` so it never lingers as a duplicate of the new daemon's own child.
// Darwin-only, matching KeepAwake; a no-op elsewhere.
const RESTART_BRIDGE_SECONDS = 30;

function spawnKeepAwakeBridge(): void {
  if (process.platform !== "darwin") return;
  try {
    const bridge = spawn(
      "caffeinate",
      ["-i", "-t", String(RESTART_BRIDGE_SECONDS)],
      { stdio: "ignore", detached: true },
    );
    bridge.on("error", () => {}); // caffeinate missing — best effort, ignore
    bridge.unref();
    console.log(
      `Holding idle-sleep bridge for ${RESTART_BRIDGE_SECONDS}s across restart (caffeinate pid ${bridge.pid})`,
    );
  } catch {
    // Best effort: if the bridge can't spawn, restart still proceeds.
  }
}

// Ask V8 to dump a heap snapshot when it's about to OOM and have Node
// write a diagnostic report on any fatal error, both into ~/.brane so
// they're easy to find after a crash.
export function buildDaemonEnv(via?: string): NodeJS.ProcessEnv {
  const diagnosticFlags = [
    "--heapsnapshot-near-heap-limit=1",
    "--report-on-fatalerror",
    `--report-directory=${getBraneDir()}`,
  ].join(" ");
  const existing = process.env.NODE_OPTIONS;
  // A daemon restarted from an agent's shell must not carry that agent's
  // session: its token and its harness's session id would ride into every
  // tmux server it starts, and from there into sessions that are not that
  // agent (claude-jrjh1e8w:10, claude-eiuzl79r:33). See src/agent-env.ts.
  const env = withoutAgentEnv(process.env);
  return {
    ...env,
    [SPAWNED_ENV]: "1",
    NODE_OPTIONS: existing ? `${existing} ${diagnosticFlags}` : diagnosticFlags,
    // How it was started, for `daemon status` (src/daemon/lifecycle.ts).
    ...(via ? { [VIA_ENV]: via } : {}),
  };
}

/** What an agent's session is told when it asks for a daemon to be started:
 *  a daemon inherits its starter's confinement, and every agent inherits the
 *  daemon's (src/daemon/lifecycle.ts). */
const AGENT_START_REFUSAL =
  "An agent's session does not start brane's daemon: it would inherit this session's permissions, " +
  "and pass them to every agent it starts. Ask the operator to run `brane daemon start` in a terminal.";

/** What an agent's session is told when it asks to stop the daemon. */
const AGENT_STOP_REFUSAL =
  "An agent's session does not stop brane's daemon: a stop stays until the operator starts it again, " +
  "cutting off their devices and parking every agent. Ask the operator to run `brane daemon stop`.";

/** Whether `pid` is a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait up to `ms` for `pid` to exit; whether it did. */
async function waitForExit(pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

/** Whether `pid` runs `brane daemon start`, by its command line: false when
 *  it plainly does not, undefined when `ps` cannot say. */
function isBraneDaemon(pid: number): boolean | undefined {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return isDaemonCommand(command);
  } catch {
    return undefined;
  }
}

/** Forget a daemon that is gone: every row it wrote about itself except its
 *  port, which the next start reuses. */
function forgetDaemonRows(db: Database.Database): void {
  db.prepare(
    "DELETE FROM meta WHERE key IN ('daemon_token', 'daemon_pid', 'daemon_version', 'daemon_tls', 'daemon_socket')",
  ).run();
}

/** Spawn `daemon start --foreground` from this CLI, detached. */
function spawnDaemon(via: string, port?: string): number | undefined {
  ensureBraneDir();
  const logFd = openSync(getLogPath(), "a");
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1], "daemon", "start", "--foreground", ...(port ? ["--port", port] : [])],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: buildDaemonEnv(via),
    },
  );
  child.unref();
  return child.pid;
}

/** Resolve the daemon port: explicit flag > previous port > 0 (OS-assigned) */
function resolvePort(explicit: string | undefined, db: Database.Database): number {
  if (explicit) return parseInt(explicit, 10);

  // Try to reuse previous port
  const prevRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_port'").get() as
    | { value: string }
    | undefined;
  if (prevRow) {
    return parseInt(prevRow.value, 10);
  }

  // Fall back to OS-assigned
  return 0;
}

const daemonStart = defineCommand({
  meta: {
    name: "start",
    description: "Start the brane daemon",
  },
  args: {
    port: {
      type: "string",
      description: "Port to listen on (default: previous port, then random)",
    },
    token: {
      type: "string",
      description:
        "Also accept this token, stored as a hashed device token. " +
        "Adopted once: after a rotation revokes it, passing it again does nothing",
    },
    bind: {
      type: "string",
      description: "Bind address (default: auto-detect localhost + Tailscale)",
    },
    foreground: {
      type: "boolean",
      description: "Run in foreground (default: detach)",
    },
  },
  async run({ args }) {
    // Spawned by a detached start (ours, `ensureDaemonRunning`, a daemon
    // handing off in place): whoever spawned it decided, and cleared any stop
    // first if it was asked to. Anything else is someone typing `brane daemon
    // start`. The daemon drops the marker at startup, so no pane inherits it.
    const spawned = Boolean(args.foreground && process.env[SPAWNED_ENV]);
    // Never in an agent's session, spawned or not: every spawner strips the
    // session's variables (`buildDaemonEnv`), so a daemon that still has them
    // was started from an agent's shell.
    if (inAgentSession(process.env)) {
      console.error(AGENT_START_REFUSAL);
      process.exitCode = 1;
      return;
    }
    const db = openDatabase();
    const port = resolvePort(args.port, db);
    // The operator asked for a daemon: a stop no longer stands. One spawned
    // by something else leaves it, and `claimDaemon` refuses to run.
    if (!spawned) clearStop(db);

    // Check if daemon is already running (cleans up stale entries). The
    // address is enough: a running daemon this shell cannot reach is still
    // running, and a second one would only lose the claim.
    // A daemon restarting in place has already written this process's pid as
    // the daemon's, so that one is no other daemon (`otherDaemon`).
    const existing = otherDaemon(db, process.pid);
    if (existing) {
      console.log(`Daemon already running. Exiting.`);
      db.close();
      return;
    }

    if (!args.foreground) {
      db.close();
      // Detach: re-spawn ourselves with --foreground in a detached child
      ensureBraneDir();
      const logFd = openSync(getLogPath(), "a");
      const child = spawn(
        process.execPath,
        [...process.execArgv, ...process.argv.slice(1), "--foreground"],
        {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: buildDaemonEnv("brane daemon start"),
        },
      );
      child.unref();
      console.log(`Daemon started in background (pid ${child.pid})`);
      return;
    }

    if (!spawned) process.env[VIA_ENV] = "brane daemon start --foreground";
    await startServer({ port, db, token: args.token, bind: args.bind });
  },
});

const daemonStop = defineCommand({
  meta: {
    name: "stop",
    description: "Stop the brane daemon, and keep it stopped until `brane daemon start`",
  },
  args: {
    timeout: {
      type: "string",
      description: "Seconds to wait for a clean shutdown before SIGKILL (default: 10)",
    },
  },
  async run({ args }) {
    // Refused in an agent's session, before anything is opened: a stop
    // sticks, so an agent's cleanup must not cut off every device and park
    // every agent (claude-ykehtq5h:7, finding 5). Not a lock: an agent runs
    // as the operator and could `kill` the daemon, which is why there is no
    // presence prompt either (claude-ykehtq5h:26).
    if (inAgentSession(process.env)) {
      console.error(AGENT_STOP_REFUSAL);
      process.exitCode = 1;
      return;
    }
    const db = openDatabase();
    const pidRow = db
      .prepare("SELECT value FROM meta WHERE key = 'daemon_pid'")
      .get() as { value: string } | undefined;
    const pid = pidRow ? parseInt(pidRow.value, 10) : undefined;
    // A pid left behind by a daemon that died (a reboot, a SIGKILL) can name
    // someone else's process by now: signal it only if it is a brane daemon
    // (claude-ykehtq5h:7, finding 7).
    const live = pid !== undefined && alive(pid);
    const running = live && isBraneDaemon(pid) !== false;
    if (live && !running) console.log(`pid ${pid} is no longer brane's daemon; leaving it alone.`);
    const keepsStopped = "It stays stopped until `brane daemon start`: agents' MCP bridges and `brane` commands will not start one.";

    // The intent first, before the signal: from here on nothing starts a
    // daemon implicitly (src/daemon/lifecycle.ts).
    recordStop(db, running ? pid : undefined);
    if (!running) {
      if (pid !== undefined) forgetDaemonRows(db);
      db.close();
      console.log(`No daemon running. ${keepsStopped}`);
      return;
    }
    db.close();
    try {
      process.kill(pid, "SIGTERM");
      console.log(`Sent SIGTERM to daemon (pid ${pid}); waiting for it to exit...`);
    } catch {
      // It exited between the check and the signal.
    }

    const timeoutMs = Math.max(1, Number(args.timeout ?? "10") || 10) * 1000;
    if (!(await waitForExit(pid, timeoutMs))) {
      console.log(`Still running after ${timeoutMs / 1000}s; sending SIGKILL.`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      if (!(await waitForExit(pid, 2_000))) {
        console.error(`Daemon (pid ${pid}) did not exit, even after SIGKILL.`);
        process.exitCode = 1;
        return;
      }
      // Killed, it could not clear its own rows. Clear them here, keeping
      // its port, which the next start reuses (claude-ykehtq5h:7, finding 8).
      const after = openDatabase();
      try {
        const row = after.prepare("SELECT value FROM meta WHERE key = 'daemon_pid'").get() as { value: string } | undefined;
        if (row && parseInt(row.value, 10) === pid) forgetDaemonRows(after);
      } finally {
        after.close();
      }
    }
    console.log(`Daemon stopped (pid ${pid}). ${keepsStopped}`);
  },
});

const daemonStatus = defineCommand({
  meta: {
    name: "status",
    description: "Show daemon status",
  },
  run() {
    const db = openDatabase();

    const pidRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_pid'").get() as
      | { value: string }
      | undefined;
    const portRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_port'").get() as
      | { value: string }
      | undefined;

    if (!pidRow) {
      const stop = readStop(db);
      console.log(stop ? `Daemon is stopped (\`brane daemon stop\` at ${stop.at}); \`brane daemon start\` starts it.` : "Daemon is not running.");
      return;
    }

    const pid = parseInt(pidRow.value, 10);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }

    console.log(`Daemon status: ${alive ? "running" : "dead (stale entry)"}`);
    console.log(`  pid:   ${pid}`);
    console.log(`  port:  ${portRow?.value ?? "unknown"}`);
    // This machine's CLI holds no token: it reaches the daemon over this
    // socket, which only this account can open.
    const socketRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_socket'").get() as
      | { value: string }
      | undefined;
    console.log(`  sock:  ${socketRow?.value ?? "none (this shell cannot reach it; see `brane daemon logs`)"}`);
    // Where the daemon came from, and where the tmux server did: an agent
    // inherits the tmux server's confinement, which is the daemon's only if
    // the daemon started that server (src/daemon/lifecycle.ts).
    const origin = alive ? readOrigin(db) : null;
    if (origin && origin.pid === pid) {
      const handoff = origin.handoff_from ? ` (restarted in place from pid ${origin.handoff_from})` : "";
      console.log(`  from:  ${describeOrigin(origin)}${handoff}`);
    } else if (alive) {
      console.log("  from:  unknown (started by an older brane)");
    }
    const tmuxServer = alive ? tmuxServerOrigin(resolveTmuxQuietly()) : null;
    if (tmuxServer) {
      console.log(`  tmux:  server pid ${tmuxServer.pid} — ${describeOrigin(tmuxServer.origin)}`);
      if (origin && origin.pid === pid && originsDiffer(origin, tmuxServer.origin)) {
        console.log(
          "\nNote: agents start in the tmux server, and it was started from somewhere else than this daemon, " +
            "so they get its permissions, not the daemon's. It exits with its last session.",
        );
      }
    }
    const legacyWarning = legacyTokenWarning(db);
    if (legacyWarning) console.log(`\nNote: ${legacyWarning}`);

    // TLS cert status — read directly from disk so we can report even if the
    // daemon isn't responsive. The daemon's own CertManager is the source of
    // truth for renewal scheduling; here we just surface the expiry.
    const cert = inspectCert(getTlsCertPath());
    if (cert) {
      const daysLeft = Math.floor((cert.notAfter.getTime() - Date.now()) / 86_400_000);
      const expiryLabel =
        daysLeft < 0 ? `EXPIRED ${-daysLeft}d ago`
        : daysLeft === 0 ? "expires today"
        : `${daysLeft}d remaining`;
      console.log(`  tls:   ${cert.notAfter.toISOString()} (${expiryLabel})`);
    } else {
      console.log(`  tls:   none (daemon will provision one if Tailscale is running)`);
    }

    if (!alive) {
      db.prepare(
        "DELETE FROM meta WHERE key IN ('daemon_token', 'daemon_pid', 'daemon_version', 'daemon_tls', 'daemon_socket')",
      ).run();
      console.log("\nCleaned up stale daemon entry.");
    }
  },
});

const daemonLogs = defineCommand({
  meta: {
    name: "logs",
    description: "Show daemon logs",
  },
  args: {
    follow: {
      type: "boolean",
      alias: "f",
      description: "Follow log output (like tail -f)",
    },
    lines: {
      type: "string",
      alias: "n",
      description: "Number of lines to show (default: 50)",
    },
  },
  run({ args }) {
    const logPath = getLogPath();
    const lines = args.lines ?? "50";
    const tailArgs = ["-n", lines];
    if (args.follow) tailArgs.push("-f");
    tailArgs.push(logPath);
    try {
      execFileSync("tail", tailArgs, { stdio: "inherit" });
    } catch {
      console.error(`No log file found at ${logPath}`);
    }
  },
});

const daemonRestart = defineCommand({
  meta: {
    name: "restart",
    description: "Restart the brane daemon in place, keeping its port and where it was started from",
  },
  args: {
    port: {
      type: "string",
      description: "Port to listen on (default: previous port, then random)",
    },
  },
  async run({ args }) {
    const db = openDatabase();
    const running = getDaemonAddress(db);
    const pidRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_pid'").get() as { value: string } | undefined;
    const oldPid = pidRow ? parseInt(pidRow.value, 10) : undefined;

    const hadSocket = Boolean(readSocketRow(db));
    if (!running) {
      // Nothing to restart in place: this is a start, and one only the
      // operator makes.
      if (inAgentSession(process.env)) {
        const refusal = implicitStartRefusal(db, "cli");
        db.close();
        console.error(refusal ?? AGENT_START_REFUSAL);
        process.exitCode = 1;
        return;
      }
      clearStop(db);
      const prevPort = args.port ?? (db.prepare("SELECT value FROM meta WHERE key = 'daemon_port'").get() as { value: string } | undefined)?.value;
      db.close();
      const pid = spawnDaemon("brane daemon restart", prevPort);
      console.log(`No daemon was running; started one (pid ${pid})`);
      return;
    }
    db.close();

    // Hold an idle-sleep assertion across the handoff *before* the old
    // daemon lets go, so there's no window where nothing prevents idle sleep.
    spawnKeepAwakeBridge();

    const outcome = await restartInPlace(args.port);
    if (outcome === "unsupported") {
      // A daemon older than `POST /api/daemon/restart`: stop it and start its
      // successor from here, as restarts used to. That successor inherits
      // this shell, so never an agent's.
      if (inAgentSession(process.env)) {
        console.error(
          "The running daemon predates in-place restart, and restarting it from an agent's session would give it " +
            "this session's permissions. Ask the operator to run `brane daemon stop`, then `brane daemon start` in a terminal.",
        );
        process.exitCode = 1;
        return;
      }
      console.log("The running daemon predates in-place restart; restarting it from this shell instead.");
      await legacyRestart(oldPid, args.port ?? running.port);
      return;
    }
    if (typeof outcome === "string") {
      console.error(`Restart failed: ${outcome}`);
      process.exitCode = 1;
      return;
    }
    const newPid = await waitForSuccessor(outcome.pid, hadSocket);
    if (newPid === undefined) {
      console.error(`The daemon (pid ${outcome.pid}) shut down, but its successor did not come up; see \`brane daemon logs\`.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Daemon restarted in place (pid ${outcome.pid} → ${newPid}, port ${outcome.port})`);
    const check = openDatabase();
    const origin = readOrigin(check);
    check.close();
    const theirs = origin?.pid === newPid ? origin.script : undefined;
    const ours = realpathOrSelf(process.argv[1]);
    if (theirs && theirs !== ours) {
      console.log(
        `Note: the daemon runs ${theirs}, not this CLI's ${ours}; a restart keeps the daemon's own. ` +
          "To run this one instead: `brane daemon stop`, then `brane daemon start` from here.",
      );
    }
  },
});

/** Ask the running daemon to restart in place. Its pid and port on success;
 *  "unsupported" only for a daemon too old to have the route (a 404);
 *  otherwise why it failed. A request that failed in transit is not a 404:
 *  the daemon may have taken it, and a restart from here would race its
 *  successor (claude-ykehtq5h:7, finding 1). */
async function restartInPlace(port: string | undefined): Promise<{ pid: number; port: string } | "unsupported" | string> {
  // Imported here: client.ts imports this module for `ensureDaemonRunning`.
  const { resolveDaemonEndpoint, sendToDaemon } = await import("../daemon/client.js");
  let res;
  try {
    const endpoint = await resolveDaemonEndpoint();
    res = await sendToDaemon(endpoint, "/api/daemon/restart", {
      method: "POST",
      headers: {
        ...(endpoint.token === null ? {} : { Authorization: `Bearer ${endpoint.token}` }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(port ? { port: Number(port) } : {}),
    });
  } catch (err) {
    return `could not ask the daemon (${err instanceof Error ? err.message : String(err)}); see \`brane daemon status\``;
  }
  const text = await res.text();
  let data: { pid?: unknown; port?: unknown; error?: unknown } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (res.status === 404) return "unsupported";
  if (res.status !== 202 || typeof data.pid !== "number") {
    return typeof data.error === "string" ? data.error : `the daemon answered ${res.status}`;
  }
  return { pid: data.pid, port: String(data.port ?? port ?? "") };
}

/** Wait for the daemon `oldPid` handed off to to claim the role, and, if
 *  the old one had a socket, to listen on its own: the successor's pid, or
 *  undefined if none came up. */
async function waitForSuccessor(oldPid: number, hadSocket: boolean): Promise<number | undefined> {
  let claimedAt: number | undefined;
  // Longer than the old daemon waits for the claim (`SUCCESSOR_CLAIM_MS`),
  // which includes starting a failed successor once more.
  for (let waited = 0; waited < 75_000; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
    const db = openDatabase();
    try {
      const address = getDaemonAddress(db);
      const pidRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_pid'").get() as { value: string } | undefined;
      const pid = pidRow ? parseInt(pidRow.value, 10) : NaN;
      if (!address) {
        if (!alive(oldPid)) return undefined; // the successor died
        continue;
      }
      // The old daemon wrote the successor's pid for it; the successor's
      // claim is its version, and its socket comes once it listens.
      if (pid === oldPid || !address.version) continue;
      claimedAt ??= waited;
      if (!hadSocket || readSocketRow(db) || waited - claimedAt > 10_000) return pid;
    } finally {
      db.close();
    }
  }
  return undefined;
}

function readSocketRow(db: Database.Database): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = 'daemon_socket'").get() as { value: string } | undefined)?.value;
}

/** Restart as it was done before the daemon could restart itself: SIGTERM
 *  it, then spawn a successor from this CLI. */
async function legacyRestart(pid: number | undefined, port: string | undefined): Promise<void> {
  if (pid !== undefined) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`Sent SIGTERM to daemon (pid ${pid})`);
      await waitForExit(pid, 10_000);
    } catch {
      // Already dead
    }
  }
  const child = spawnDaemon("brane daemon restart (from the shell, the old way)", port);
  console.log(`Daemon restarted (pid ${child})`);
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function resolveTmuxQuietly(): string {
  try {
    return resolveTmux();
  } catch {
    return "tmux";
  }
}

/** Start the daemon in the background, unless one is already running, and
 *  wait for it to be ready. Returns its address only: what a caller presents
 *  is its own business (`resolveCredential` in daemon/client.ts). */
export async function ensureDaemonRunning(): Promise<{ port: string; version?: string }> {
  ensureBraneDir();
  const check = openDatabase();
  const running = getDaemonAddress(check);
  // Implicitly, only from the operator's own shell, and never while they
  // have it stopped (src/daemon/lifecycle.ts).
  const refusal = running ? null : implicitStartRefusal(check, "cli");
  check.close();
  if (running) return running;
  if (refusal) throw new Error(refusal);
  spawnDaemon(`brane ${process.argv[2] ?? ""} (started it as needed)`.replace("  ", " "));

  // Poll for daemon to be ready (up to 5s)
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    // The daemon writes its port only after bootstrapping tokens and binding
    // its socket, so once the address is up the socket is too.
    const db = openDatabase();
    const address = getDaemonAddress(db);
    db.close();
    if (address) return address;
  }

  throw new Error("Daemon failed to start within 5s");
}

export const daemonCommand = defineCommand({
  meta: {
    name: "daemon",
    description: "Manage the brane daemon",
  },
  subCommands: {
    start: daemonStart,
    stop: daemonStop,
    restart: daemonRestart,
    status: daemonStatus,
    logs: daemonLogs,
  },
});
