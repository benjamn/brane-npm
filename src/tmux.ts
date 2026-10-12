import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
  createWriteStream,
  createReadStream,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir, platform, arch } from "node:os";
import { get as httpsGet } from "node:https";
import { createHash } from "node:crypto";

let cachedPath: string | undefined;

const TMUX_VERSION = "3.6a";
const BRANE_BIN = join(homedir(), ".brane", "bin");
const BUNDLED_TMUX = join(BRANE_BIN, "tmux");

// Map Node.js platform/arch to tmux-builds release-asset naming.
const PLATFORM_MAP: Record<string, string> = { darwin: "macos", linux: "linux" };
const ARCH_MAP: Record<string, string> = { arm64: "arm64", x64: "x86_64" };

// Pinned SHA-256 digests for tmux-builds v3.6a release assets, keyed by
// `${os}-${cpu}`. Sourced from the GitHub release API's asset `digest`
// field. If an upstream asset is ever re-uploaded or substituted, the
// hash check below fails closed and we refuse to extract/run it.
const SHA256: Record<string, string> = {
  "linux-arm64": "bb5afd9d646df54a7d7c66e198aa22c7d293c7453534f1670f7c540534db8b5e",
  "linux-x86_64": "c0a772a5e6ca8f129b0111d10029a52e02bcbc8352d5a8c0d3de8466a1e59c2e",
  "macos-arm64": "12b5b9f8696e1286897d946649c0a80d0169dd76e018d34476a1fbd34de89a0f",
  "macos-x86_64": "b9b12eaeba43acf5671acf3857d947525440b544185a8db34ea557199a090251",
};

/** Scan PATH for an executable — pure in-process, no subprocess spawn. */
function findInPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/** Resolve the tmux binary: system PATH first, then ~/.brane/bin/, then error. */
export function resolveTmux(): string {
  if (cachedPath) return cachedPath;

  // 1. System PATH (in-process scan, no subprocess)
  const systemTmux = findInPath("tmux");
  if (systemTmux) {
    cachedPath = systemTmux;
    return cachedPath;
  }

  // 2. Binary fetched lazily by ensureTmux() into ~/.brane/bin/
  try {
    accessSync(BUNDLED_TMUX, constants.X_OK);
    cachedPath = BUNDLED_TMUX;
    return cachedPath;
  } catch {}

  throw new Error(
    "tmux not found. Install it with: brew install tmux (macOS) or apt install tmux (Linux)",
  );
}

let ensurePromise: Promise<void> | undefined;

/**
 * Ensure a usable tmux exists, downloading a verified static binary into
 * ~/.brane/bin/ if neither a system tmux nor a previously-fetched one is
 * present. Best-effort and idempotent: single-flighted, never throws, and
 * never blocks the caller's success path — if it cannot provide tmux,
 * resolveTmux() will surface the actionable "install tmux" error when a
 * tmux-dependent operation is actually attempted.
 */
export function ensureTmux(): Promise<void> {
  if (!ensurePromise) ensurePromise = doEnsureTmux();
  return ensurePromise;
}

async function doEnsureTmux(): Promise<void> {
  // Already satisfiable — system tmux or a prior fetch.
  if (findInPath("tmux")) return;
  try {
    accessSync(BUNDLED_TMUX, constants.X_OK);
    return;
  } catch {}

  const os = PLATFORM_MAP[platform()];
  const cpu = ARCH_MAP[arch()];
  if (!os || !cpu) {
    console.error(
      `brane: no prebuilt tmux for ${platform()}-${arch()}; install tmux manually`,
    );
    return;
  }

  const key = `${os}-${cpu}`;
  const expected = SHA256[key];
  const url = `https://github.com/tmux/tmux-builds/releases/download/v${TMUX_VERSION}/tmux-${TMUX_VERSION}-${key}.tar.gz`;
  const tarball = join(BRANE_BIN, `tmux-${TMUX_VERSION}.tar.gz`);

  try {
    mkdirSync(BRANE_BIN, { recursive: true });
    console.error("brane: tmux not found, downloading static binary…");

    // Download (follows redirects — GitHub releases redirect to a CDN).
    await download(url, tarball);

    // Verify integrity before trusting the archive. Fail closed: on any
    // mismatch (or missing pin) delete the file and refuse to extract or
    // run an unverified binary.
    const actual = await sha256File(tarball);
    if (!expected || actual !== expected) {
      try { unlinkSync(tarball); } catch {}
      console.error(
        `brane: tmux archive failed SHA-256 verification (expected ${expected ?? "n/a"}, got ${actual}); refusing to install. Install manually: brew install tmux`,
      );
      return;
    }

    // Extract — the tarball contains a bare "tmux" at its root.
    const { execFileSync } = await import("node:child_process");
    execFileSync("tar", ["xzf", tarball, "-C", BRANE_BIN, "tmux"], {
      stdio: "ignore",
    });
    try { unlinkSync(tarball); } catch {}

    if (existsSync(BUNDLED_TMUX)) {
      chmodSync(BUNDLED_TMUX, 0o755);
      console.error(`brane: tmux ${TMUX_VERSION} installed to ${BUNDLED_TMUX}`);
    } else {
      console.error("brane: failed to extract tmux binary from archive");
    }
  } catch (err) {
    try { unlinkSync(tarball); } catch {}
    console.error(
      `brane: failed to download tmux (${(err as Error).message}). Install manually: brew install tmux`,
    );
  }
}

/** Compute the SHA-256 hex digest of a file by streaming it. */
function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** Download a URL to a file, following up to 5 redirects. */
function download(url: string, dest: string, redirects = 0): Promise<void> {
  if (redirects > 5) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    httpsGet(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        file.close();
        download(res.headers.location, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        file.close();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", (err) => {
      file.close();
      reject(err);
    });
  });
}

/** A tmux command-language word: single-quoted, nothing inside is special
 *  (`$`, `~`, `#`, `;`), and a `'` is closed, escaped and reopened. */
export function tmuxQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A request's `terminal_size`, if it is a usable grid: the size the
 *  requesting viewer's pane last measured, which a new session should start
 *  at. Anything else — absent, non-integer, out of range — is null, and the
 *  caller falls back to the last size applied to any session. */
export function parseTerminalSize(value: unknown): { cols: number; rows: number } | null {
  if (!value || typeof value !== "object") return null;
  const { cols, rows } = value as { cols?: unknown; rows?: unknown };
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 10000;
  return ok(cols) && ok(rows) ? { cols, rows } : null;
}

/** The `new-session` line `newTmuxSession` sends, as tmux will parse it. */
export function newSessionLine(opts: {
  name: string;
  cwd: string;
  size?: { cols: number; rows: number } | null;
  command: string;
}): string {
  const parts = ["new-session", "-d", "-s", tmuxQuote(opts.name), "-c", tmuxQuote(opts.cwd)];
  if (opts.size) parts.push("-x", String(opts.size.cols), "-y", String(opts.size.rows));
  parts.push(tmuxQuote(opts.command));
  return parts.join(" ");
}

/** Start a detached tmux session running `command`, without the command
 *  ever appearing in a process's arguments. A launch command carries the
 *  session's agent token (`BRANE_NARRATIVE_SECRET=…`), and arguments are
 *  readable by every user on the machine through `ps` — for the client's
 *  brief life, and for the tmux *server's* whole life when this call is the
 *  one that starts it, since the server is forked from that client and keeps
 *  its argv. So the command goes to `tmux source-file -` on stdin, and what
 *  `ps` shows is `tmux source-file -`. Throws if tmux refuses (a duplicate
 *  session name, say). */
export function newTmuxSession(opts: {
  name: string;
  cwd: string;
  size?: { cols: number; rows: number } | null;
  command: string;
  /** A tmux socket path (`-S`), for tests; the default server otherwise. */
  socket?: string;
}): void {
  // `source-file` alone needs a server already running, and tmux exits with
  // its last session, so the first launch after a reboot would fail
  // (claude-jrjh1e8w:22). `start-server` starts one if needed — with this
  // argv, which carries no secret — and is a no-op otherwise.
  const socketArgs = opts.socket ? ["-S", opts.socket] : [];
  execFileSync(resolveTmux(), [...socketArgs, "start-server", ";", "source-file", "-"], {
    input: newSessionLine(opts) + "\n",
    stdio: ["pipe", "ignore", "pipe"],
  });
}
