import { defineCommand } from "citty";
import { spawn, execFileSync } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase, getDbPath, ensureBraneDir, getBraneDir, getDaemonAddress } from "../db/schema.js";
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
export function buildDaemonEnv(): NodeJS.ProcessEnv {
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
    BRANE_DAEMON_DETACHED: "1",
    NODE_OPTIONS: existing ? `${existing} ${diagnosticFlags}` : diagnosticFlags,
  };
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
    const db = openDatabase();
    const port = resolvePort(args.port, db);

    // Check if daemon is already running (cleans up stale entries). The
    // address is enough: a running daemon this shell cannot reach is still
    // running, and a second one would only lose the claim.
    const existing = getDaemonAddress(db);
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
          env: buildDaemonEnv(),
        },
      );
      child.unref();
      console.log(`Daemon started in background (pid ${child.pid})`);
      return;
    }

    await startServer({ port, db, token: args.token, bind: args.bind });
  },
});

const daemonStop = defineCommand({
  meta: {
    name: "stop",
    description: "Stop the brane daemon",
  },
  run() {
    const db = openDatabase();

    const pidRow = db
      .prepare("SELECT value FROM meta WHERE key = 'daemon_pid'")
      .get() as { value: string } | undefined;

    if (!pidRow) {
      console.log("No daemon running.");
      return;
    }

    const pid = parseInt(pidRow.value, 10);
    try {
      process.kill(pid, "SIGTERM");
      console.log(`Sent SIGTERM to daemon (pid ${pid})`);
    } catch {
      console.log(`Daemon process ${pid} not found. Cleaning up stale entry.`);
      db.prepare(
        "DELETE FROM meta WHERE key IN ('daemon_token', 'daemon_pid', 'daemon_version', 'daemon_tls', 'daemon_socket')",
      ).run();
    }
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
      console.log("Daemon is not running.");
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
    description: "Restart the brane daemon",
  },
  args: {
    port: {
      type: "string",
      description: "Port to listen on (default: previous port, then random)",
    },
  },
  async run({ args }) {
    const db = openDatabase();

    // Capture the previous port before stopping. No token needs carrying:
    // this machine's CLI holds none, and the new daemon finds the device
    // tokens' hashes in the database.
    const prevPortRow = db
      .prepare("SELECT value FROM meta WHERE key = 'daemon_port'")
      .get() as { value: string } | undefined;
    const prevPort = args.port ?? prevPortRow?.value;

    // Hold an idle-sleep assertion across the handoff *before* killing the
    // old daemon, so there's no window where nothing prevents idle sleep.
    spawnKeepAwakeBridge();

    // Stop existing daemon if running
    const pidRow = db
      .prepare("SELECT value FROM meta WHERE key = 'daemon_pid'")
      .get() as { value: string } | undefined;

    if (pidRow) {
      const pid = parseInt(pidRow.value, 10);
      try {
        process.kill(pid, "SIGTERM");
        console.log(`Sent SIGTERM to daemon (pid ${pid})`);
        // Wait for it to die
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 100));
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
        }
      } catch {
        // Already dead
      }
    }
    db.close();

    // Start fresh daemon (detached)
    ensureBraneDir();
    const logFd = openSync(getLogPath(), "a");
    const startArgs = [...process.argv.slice(1)].filter(
      (a) => a !== "restart" && !a.startsWith("--port") && !a.startsWith("--token"),
    );
    // Replace "restart" with "start" in the args
    const idx = startArgs.indexOf("daemon");
    const childArgs = [
      ...process.execArgv,
      ...startArgs.slice(0, idx + 1),
      "start",
      "--foreground",
      ...(prevPort ? ["--port", prevPort] : []),
    ];
    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: buildDaemonEnv(),
    });
    child.unref();
    console.log(`Daemon restarted (pid ${child.pid})`);
  },
});

/** Start the daemon in the background, unless one is already running, and
 *  wait for it to be ready. Returns its address only: what a caller presents
 *  is its own business (`resolveCredential` in daemon/client.ts). */
export async function ensureDaemonRunning(): Promise<{ port: string; version?: string }> {
  ensureBraneDir();
  const check = openDatabase();
  const running = getDaemonAddress(check);
  check.close();
  if (running) return running;
  const logFd = openSync(getLogPath(), "a");

  const cliArgs = process.argv.slice(0, 2);
  const child = spawn(
    process.execPath,
    [...process.execArgv, cliArgs[1], "daemon", "start", "--foreground"],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: buildDaemonEnv(),
    },
  );
  child.unref();

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
