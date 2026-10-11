import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { openDatabase, getDaemonAddress, getTokenFilePath } from "../db/schema.js";
import { ACCOUNT_HASH_PREFIX, readTokenFile, tokenFileStanding } from "../db/tokens.js";
import { readDaemonSocket } from "../daemon/client.js";
import { accountDirTrust } from "../daemon/local-socket.js";
import { resolveTmux } from "../tmux.js";
import { getTailscaleHost } from "../tailscale.js";

/**
 * `brane doctor` — is this install sound, on the machine it landed on?
 *
 * Two halves. The first is a handful of environment checks that are cheap to
 * run and expensive to discover by surprise: the Node this CLI runs under
 * against `engines`, whether tmux and Tailscale are reachable, and whether a
 * daemon is running — and if so, whether it is running *this* install's code
 * or some other checkout's. The second is the shipped test suite: `dist/test`
 * is in the tarball on purpose, so an install can prove itself. It runs under
 * the same `node` binary as this process, streams the reporter, and the
 * command exits with the suite's status. Neither half needs a daemon,
 * network, or the embedding model.
 */

const INSTALL_DIR = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string; engines?: { node?: string } };

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
}

const MARK: Record<Status, string> = { ok: "✓", warn: "–", fail: "✗" };

function checkNode(): Check {
  const want = pkg.engines?.node ?? ">=20";
  const min = Number(/(\d+)/.exec(want)?.[1] ?? "20");
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "node",
    status: major >= min ? "ok" : "fail",
    detail: `${process.version} at ${process.execPath} (engines ${want})`,
  };
}

function checkTmux(): Check {
  try {
    return { name: "tmux", status: "ok", detail: resolveTmux() };
  } catch {
    return {
      name: "tmux",
      status: "warn",
      detail: "not found — spawn will try to download a static binary into ~/.brane/bin; otherwise `brew install tmux`",
    };
  }
}

function checkTailscale(): Check {
  const host = getTailscaleHost();
  return host
    ? { name: "tailscale", status: "ok", detail: host }
    : {
        name: "tailscale",
        status: "warn",
        detail: "not detected — `brane meld` will only advertise 127.0.0.1 (same machine)",
      };
}

/** The daemon's argv[1], so we can say which checkout it is actually running. */
function daemonScript(pid: number): string | undefined {
  const res = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (res.status !== 0) return undefined;
  const parts = res.stdout.trim().split(/\s+/);
  return parts[1];
}

/** Why this shell could not talk to a running daemon, or null if it can.
 *  Running is one question and reach is another: an agent session presents
 *  its own token; anything else presents nothing at all over the daemon's
 *  socket, which the daemon lets in only while the brane dir keeps other
 *  accounts out. Pure, for src/test/socket-account.test.ts. */
export function shellReachProblem(opts: {
  secret: string | undefined;
  socketPath: string | undefined;
  braneDir: string;
}): string | null {
  if (opts.secret) return null;
  if (!opts.socketPath) {
    return (
      "it is not listening on its socket (daemon.sock), the only way this shell reaches it; " +
      "`brane daemon logs` says why (`[socket]`), and `brane daemon restart` retries"
    );
  }
  const trust = accountDirTrust(opts.braneDir);
  if (!trust.ok) {
    return `it will refuse this shell without a token: ${trust.reason}; run \`chmod 700 ${opts.braneDir}\``;
  }
  return null;
}

function checkDaemon(): Check {
  let db;
  try {
    db = openDatabase();
  } catch (err) {
    return { name: "daemon", status: "fail", detail: `could not open ~/.brane/brane.db: ${String(err)}` };
  }
  try {
    const info = getDaemonAddress(db);
    if (!info) return { name: "daemon", status: "warn", detail: "not running (any command that needs it will start one)" };
    const unreachable = shellReachProblem({
      secret: process.env.BRANE_NARRATIVE_SECRET,
      socketPath: readDaemonSocket(db),
      braneDir: dirname(db.name),
    });
    if (unreachable) return { name: "daemon", status: "fail", detail: `running, but ${unreachable}` };
    const pidRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_pid'").get() as
      | { value: string }
      | undefined;
    const pid = pidRow ? Number(pidRow.value) : NaN;
    // Which checkout is the daemon actually running? Its argv[1] is a
    // `dist/cli.js` — behind the `/opt/homebrew/bin/brane` symlink, usually —
    // and that checkout's package.json says which version, which the meta
    // table does not (it records a coarse compatibility version).
    let where = "";
    let status: Status = "ok";
    const script = Number.isFinite(pid) ? daemonScript(pid) : undefined;
    if (script) {
      let real = script;
      try {
        real = realpathSync(script);
      } catch {}
      const theirs = dirname(dirname(resolve(real)));
      if (theirs === INSTALL_DIR) {
        where = " — this install";
      } else {
        let theirVersion = "unknown version";
        try {
          theirVersion = (JSON.parse(readFileSync(join(theirs, "package.json"), "utf8")) as { version?: string }).version ?? theirVersion;
        } catch {}
        where = ` — a different checkout: ${theirs} (${theirVersion}; this install is ${pkg.version})`;
        status = "warn";
      }
    }
    return {
      name: "daemon",
      status,
      detail: `running, pid ${pid}, port ${info.port}${where}`,
    };
  } finally {
    db.close();
  }
}

/** What to say about a `.daemon_token` left by an older brane, which kept
 *  this machine's local token there. The daemon empties it at its first
 *  start and nothing presents it; removing the file is the operator's to do.
 *  `standing` is `empty` for that normal leftover, else how a token still in
 *  it stands (`tokenFileStanding`): the daemon could not empty it. Pure, for
 *  src/test/socket-account.test.ts. */
export function leftoverTokenFile(path: string, standing: "empty" | "live" | "dead"): Check {
  const remove = `rm ${path}`;
  return {
    name: "token file",
    status: "warn",
    detail:
      standing === "empty"
        ? `${path} is an empty leftover from an older brane; nothing uses it. Remove it: ${remove}`
        : standing === "dead"
          ? `${path} still holds a token from an older brane, which the daemon could not empty; the token no longer works. Remove it: ${remove}`
          : `${path} still holds a token that works (the one every device shared before tokens were hashed), which the daemon could not empty. Remove it: ${remove}`,
  };
}

/** The `token file` check for the `.daemon_token` at `path`, or null when
 *  there is nothing to say: no file, or one that still holds a token before
 *  this version's daemon has started once — nothing has retired it yet, and
 *  the daemon's first start will. Takes the database, for
 *  src/test/socket-account.test.ts. */
export function tokenFileCheck(db: Database.Database, path: string): Check | null {
  if (!existsSync(path)) return null;
  const token = readTokenFile(path);
  if (!token) return leftoverTokenFile(path, "empty");
  const hasAccountRow = db
    .prepare(`SELECT 1 FROM tokens WHERE kind = 'local' AND revoked_at IS NULL AND hash LIKE '${ACCOUNT_HASH_PREFIX}%'`)
    .get();
  if (!hasAccountRow) return null;
  return leftoverTokenFile(path, tokenFileStanding(db, token));
}

function checkTokenFile(): Check | null {
  let db;
  try {
    db = openDatabase();
  } catch {
    return null; // checkDaemon already reports a database that will not open
  }
  try {
    return tokenFileCheck(db, getTokenFilePath(db));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function printChecks(checks: Check[]): void {
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${MARK[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
  }
}

/** Run the shipped suite under this process's node; returns its exit status. */
function runSuite(): number {
  const dir = join(INSTALL_DIR, "dist", "test");
  if (!existsSync(dir)) {
    console.error(`✗ suite  dist/test not found under ${INSTALL_DIR} — run \`npm run build\` in a checkout, or reinstall the package`);
    return 1;
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => join(dir, f));
  if (files.length === 0) {
    console.error(`✗ suite  no test files in ${dir}`);
    return 1;
  }
  console.log(`\nRunning the shipped test suite: ${files.length} files under ${dir}\n`);
  const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
  if (res.error) {
    console.error(`✗ suite  could not start node --test: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Check this install (node, tmux, Tailscale, daemon) and run the shipped test suite against it",
  },
  args: {
    suite: {
      type: "boolean",
      description: "Run the shipped test suite (default: yes; --no-suite for checks only)",
      default: true,
    },
    "suite-only": {
      type: "boolean",
      description: "Skip the environment checks and only run the test suite",
      default: false,
    },
  },
  async run({ args }) {
    let failed = false;
    if (!args["suite-only"]) {
      console.log(`brane ${pkg.version} at ${INSTALL_DIR}\n`);
      const checks = [checkNode(), checkTmux(), checkTailscale(), checkDaemon(), checkTokenFile()].filter(
        (c): c is Check => c !== null,
      );
      printChecks(checks);
      failed = checks.some((c) => c.status === "fail");
    }
    if (args.suite) {
      const status = runSuite();
      if (status !== 0) failed = true;
    }
    process.exit(failed ? 1 : 0);
  },
});
