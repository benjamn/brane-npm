import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import qrcode from "qrcode-terminal";
import type Database from "better-sqlite3";
import { getDaemonAddress, openDatabase } from "../db/schema.js";
import { getTailscaleHost } from "../tailscale.js";
import { connectionFragment } from "../shared/view-url.js";
import { UNUSED_TOKEN_LAPSE_MS } from "../daemon/token-ring.js";
import {
  daemonRequest,
  resolveDaemonEndpoint,
  warnIfVersionMismatch,
  type DaemonEndpoint,
} from "../daemon/client.js";

/** What the CLI prints before a request the daemon holds for the presence
 *  check (src/daemon/presence-gate.ts). The daemon is on this machine, so
 *  this process's platform names its prompt. On stderr, so it never lands in
 *  output a script captures. */
export function presenceWaitNote(platform: NodeJS.Platform = process.platform): string {
  const prompt =
    platform === "darwin" ? "Touch ID (or your login password)" : platform === "win32" ? "Windows Hello" : "the system's authentication prompt";
  return `Confirm with ${prompt} on this machine to continue…`;
}

/** Print `presenceWaitNote()` before a gated request, unless this is an
 *  agent's session: the daemon refuses an agent unasked, so there is nothing
 *  to wait for. */
export function announcePresenceWait(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.BRANE_NARRATIVE_SECRET) console.error(presenceWaitNote());
}

/** Ask the daemon for a fresh device token. The daemon keeps only its hash,
 *  so the QR this goes into is the one and only copy — every scan of every
 *  meld is its own device, revocable alone. From this machine the daemon
 *  first asks the operator to confirm at the OS prompt. */
export async function mintDeviceToken(endpoint: DaemonEndpoint, label?: string): Promise<string> {
  announcePresenceWait();
  const { token } = await daemonRequest<{ token: string }>(endpoint, "/api/tokens", {
    method: "POST",
    body: label ? { label } : {},
  });
  return token;
}

/** What `brane meld` and `brane spawn --meld` print under the QR. */
export function meldLapseNote(): string {
  return `This QR is valid for ${UNUSED_TOKEN_LAPSE_MS / 60_000} minutes; once scanned, the device stays signed in until revoked.`;
}

export interface MeldUrlOptions {
  db: Database.Database;
  daemon: { port: string; token: string };
  /** Path component to append (e.g. "/claude-abc123"). Leading slash optional. Defaults to "/". */
  path?: string;
  /** Override host (default: Tailscale DNS > 127.0.0.1) */
  host?: string;
  /** Force direct daemon URL instead of brane.organelle.dev */
  local?: boolean;
  /** Inject the detected Tailscale hostname instead of shelling out to
   *  `tailscale status` — used by tests to make this function deterministic.
   *  When the key is present (even as `undefined`) the live lookup is skipped. */
  tailscaleHost?: string;
}

export interface MeldUrlResult {
  url: string;
  daemonHost: string;
  scheme: "http" | "https";
  useLocal: boolean;
  isLoopbackFallback: boolean;
  /** Tailscale is up and we're advertising its hostname, but no TLS cert is
   *  available — so this URL silently falls back to plain HTTP. */
  tlsDegraded: boolean;
}

/** Build a meld URL pointing at the daemon (optionally targeting a specific
 *  in-app path). Shared by `brane meld` and `brane spawn --meld`. */
export function buildMeldUrl(opts: MeldUrlOptions): MeldUrlResult {
  const { db, daemon } = opts;
  const { port, token } = daemon;

  const tailscaleHost =
    "tailscaleHost" in opts ? opts.tailscaleHost : getTailscaleHost();
  const host = opts.host ?? tailscaleHost ?? "127.0.0.1";
  const isLoopbackFallback =
    !opts.host && !tailscaleHost && host === "127.0.0.1";

  const tlsRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_tls'").get() as
    | { value: string }
    | undefined;
  const tls = tlsRow?.value === "true";
  const useTls = tls && host === tailscaleHost;
  const useLocal = opts.local === true || !useTls;

  let effectivePort = port;
  if (useLocal && tls && !useTls) {
    const httpPortRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_http_port'").get() as
      | { value: string }
      | undefined;
    if (httpPortRow) effectivePort = httpPortRow.value;
  }

  const scheme: "http" | "https" = useTls ? "https" : "http";
  const portSuffix = useTls && effectivePort === "443" ? "" : `:${effectivePort}`;
  const daemonHost = `${host}${portSuffix}`;

  // Tailscale is present and we'd advertise its hostname, but there's no cert,
  // so we're silently emitting plain HTTP instead of the expected HTTPS.
  const tlsDegraded =
    !!tailscaleHost && host === tailscaleHost && !tls && opts.local !== true;

  let path = opts.path ?? "/";
  if (!path.startsWith("/")) path = "/" + path;

  const url = meldLink({ daemonHost, scheme, useLocal }, token, path);
  return { url, daemonHost, scheme, useLocal, isLoopbackFallback, tlsDegraded };
}

/** Where a meld URL points, without its token: what `brane meld
 *  --connection` prints, so `brane meld --remote` can put a token minted on
 *  the operator's machine into a URL for a daemon on another. */
export type MeldConnection = Omit<MeldUrlResult, "url">;

/** The one line `brane meld --connection` prints. */
export type MeldConnectionReply = ({ ready: true } & MeldConnection) | { ready: false; reason: string };

/** A meld URL for `token`, at the daemon `parts` describes. */
export function meldLink(
  parts: Pick<MeldUrlResult, "daemonHost" | "scheme" | "useLocal">,
  token: string,
  path = "/",
): string {
  // The daemon's address and token ride in the URL fragment, which the
  // browser never sends to any server — so the shared SPA's host (Cloudflare)
  // does not see the token, a pasted link's unfurler does not fetch it, and
  // the daemon's own request log does not record it. The app reads it from
  // `location.hash` and strips it once it has been used.
  const conn = { host: parts.daemonHost, token };
  return parts.useLocal
    ? `${parts.scheme}://${parts.daemonHost}${path}${connectionFragment(conn, false)}`
    : `https://brane.organelle.dev${path}${connectionFragment(conn, true)}`;
}

/** Ask this machine's daemon for a device token for a daemon on another
 *  machine, and its hash. The daemon stores neither, and first asks the
 *  operator to confirm at the OS prompt, as it does for `brane meld`. */
export async function mintRemoteDeviceToken(endpoint: DaemonEndpoint): Promise<{ token: string; hash: string }> {
  announcePresenceWait();
  return daemonRequest<{ token: string; hash: string }>(endpoint, "/api/tokens/remote", { method: "POST", body: {} });
}

/** What one run of the `--ask` command told us. `output` is its stdout, or
 *  null when the command itself failed (machine not reachable yet). Pure, so
 *  the suite pins every case:
 *
 *  - `address`: the daemon is up and reachable over Tailscale;
 *  - `wait`: not yet — no answer, no daemon, or no Tailscale name yet (a QR
 *    for 127.0.0.1 would be useless, and a wrong QR costs a restart);
 *  - `old`: the remote answered without the JSON line, so its brane
 *    predates `--connection` and ran a plain meld instead. */
export function readMeldReply(
  output: string | null,
): { kind: "address"; connection: MeldConnection } | { kind: "wait"; reason: string } | { kind: "old" } {
  if (output === null) return { kind: "wait", reason: "the remote machine is not answering yet" };
  for (const line of output.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.ready === false) return { kind: "wait", reason: typeof r.reason === "string" ? r.reason : "not ready" };
    if (r.ready !== true) continue;
    if (typeof r.daemonHost !== "string" || (r.scheme !== "http" && r.scheme !== "https") || typeof r.useLocal !== "boolean") continue;
    if (r.isLoopbackFallback) return { kind: "wait", reason: "the remote machine has no Tailscale name yet" };
    const { ready: _ready, ...connection } = r;
    return { kind: "address", connection: connection as unknown as MeldConnection };
  }
  return { kind: "old" };
}

/** The `--send` command with the hash in place of `{hash}`. A hash is 64 hex
 *  digits, so it needs no quoting in a shell command. */
const fillHashError = "--send must contain {hash}, where the token's hash goes";

export function fillHash(template: string, hash: string): string {
  if (!template.includes("{hash}")) throw new Error(fillHashError);
  return template.replaceAll("{hash}", hash);
}

/** How long `brane meld --remote` waits for the remote daemon's address. */
const REMOTE_MELD_WAIT_MS = 3 * 60_000;
/** `--send` waits for whatever its command waits for (`fly secrets set` waits
 *  for the machines to restart), which can outlast a couple of minutes. */
const REMOTE_SEND_TIMEOUT_MS = 10 * 60_000;
/** One `--ask` try; a slow `fly ssh` connect is retried, not waited out. */
const REMOTE_ASK_TIMEOUT_MS = 60_000;

/** Why `brane meld --remote` won't run here, or null if it will. The token is
 *  printed into the QR and the URL; in an agent's session that output is the
 *  agent's to read, and a device token is the operator's. This only saves a
 *  round trip: the gate is the daemon's, which refuses an agent's token and
 *  asks the shell for presence (`POST /api/tokens/remote`). */
export function refusesRemoteMeld(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.BRANE_NARRATIVE_SECRET
    ? "brane meld --remote prints a device token; run it from a shell outside an agent session."
    : null;
}

/** `brane meld --remote`: meld a device to a daemon on a machine that can
 *  show no presence prompt (a Fly machine, a VPS). The token is minted by
 *  this machine's daemon, behind its presence prompt; `--send` hands the
 *  remote only its hash, and `--ask` reads back only its address. Nothing
 *  here knows which host it is. */
async function meldRemote(args: { send?: string; ask?: string; small?: boolean }): Promise<void> {
  const refusal = refusesRemoteMeld();
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  if (!args.send || !args.ask) {
    console.error("brane meld --remote needs --send '<command with {hash}>' and --ask '<command that runs brane meld --connection there>'.");
    process.exit(1);
  }
  // Before the prompt, so a bad --send never asks the operator anything.
  if (!args.send.includes("{hash}")) {
    console.error(fillHashError);
    process.exit(1);
  }
  let token: string;
  let send: string;
  try {
    const endpoint = await resolveDaemonEndpoint();
    warnIfVersionMismatch(endpoint);
    const minted = await mintRemoteDeviceToken(endpoint);
    token = minted.token;
    send = fillHash(args.send, minted.hash);
  } catch (err) {
    console.error(`Failed to mint a device token: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log("Sending the remote daemon the new device token's hash...");
  const sent = spawnSync("sh", ["-c", send], { stdio: "inherit", timeout: REMOTE_SEND_TIMEOUT_MS });
  if (sent.status !== 0) {
    console.error(`--send failed (${sent.error?.message ?? `exit ${sent.status}`}); nothing was shown, so nothing is lost.`);
    process.exit(1);
  }

  console.log("Waiting for the remote daemon...");
  const deadline = Date.now() + REMOTE_MELD_WAIT_MS;
  let connection: MeldConnection | null = null;
  let waitingFor = "the remote daemon";
  // The last failed try's stderr, shown if we give up: the difference between
  // a wrong app name, an ssh login and a daemon that never came up.
  let lastError = "";
  while (!connection && Date.now() < deadline) {
    const asked = spawnSync("sh", ["-c", args.ask], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", timeout: REMOTE_ASK_TIMEOUT_MS });
    if (asked.status !== 0) lastError = (asked.stderr ?? "").trim() || (asked.error?.message ?? `exit ${asked.status}`);
    const reply = readMeldReply(asked.status === 0 ? asked.stdout : null);
    if (reply.kind === "old") {
      console.error("The remote runs a brane that predates `brane meld --connection`. Update it, then run this again.");
      process.exit(1);
    }
    if (reply.kind === "address") connection = reply.connection;
    else {
      waitingFor = reply.reason;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  if (!connection) {
    console.error(`Gave up waiting: ${waitingFor}.`);
    if (lastError) console.error(`The last --ask failed with:\n${lastError.split("\n").slice(-10).join("\n")}`);
    console.error("Run this again once it's up; the token sent this time was never shown, so nothing is lost.");
    process.exit(1);
  }

  const url = meldLink(connection, token);
  console.log(`\nScan this QR code to meld:\n`);
  qrcode.generate(url, { small: args.small ?? true }, (code: string) => {
    console.log(code);
  });
  console.log(`\n${url}\n`);
  console.log(`Daemon: ${connection.daemonHost} (${connection.scheme})`);
  // The clock started with the remote daemon's restart, not now.
  console.log(`This QR is valid for ${UNUSED_TOKEN_LAPSE_MS / 60_000} minutes from the remote daemon's start; once scanned, the device stays signed in until revoked.`);
  if (connection.tlsDegraded) {
    console.log("\nWarning: the remote daemon has no TLS cert, so this QR uses plain HTTP.");
  }
}

export const meldCommand = defineCommand({
  meta: {
    name: "meld",
    description: "Generate a QR code to connect a device to this brane",
  },
  args: {
    host: {
      type: "string",
      description: "Override the host (default: Tailscale DNS > 127.0.0.1)",
    },
    small: {
      type: "boolean",
      description: "Use small QR code (half-block characters)",
    },
    local: {
      type: "boolean",
      description: "Generate direct daemon URL instead of brane.organelle.dev",
    },
    connection: {
      type: "boolean",
      description: "Print where a meld URL would point, as JSON, and mint nothing (what `--ask` runs on the remote machine)",
    },
    remote: {
      type: "boolean",
      description: "Meld to a daemon on another machine: mint the token here, hand it only the hash (--send), read back its address (--ask)",
    },
    send: {
      type: "string",
      description: "With --remote: a shell command that gives the remote daemon BRANE_DEVICE_TOKEN_SHA256={hash} and restarts it",
    },
    ask: {
      type: "string",
      description: "With --remote: a shell command that runs `brane meld --connection` on the remote machine",
    },
  },
  async run({ args }) {
    if (args.remote) {
      await meldRemote(args);
      return;
    }
    if (args.connection) {
      // No token, so no presence check: an address is not a secret. Never
      // starts a daemon — over `fly ssh` it would die with the session. Always
      // one JSON line on stdout and exit 0, so the caller reads one channel
      // and depends on nothing about how ssh passes on exit codes.
      const db = openDatabase();
      try {
        const address = getDaemonAddress(db);
        const reply: MeldConnectionReply = address
          ? (({ url: _url, ...connection }) => ({ ready: true as const, ...connection }))(
              buildMeldUrl({ db, daemon: { port: address.port, token: "" }, host: args.host, local: args.local }),
            )
          : { ready: false, reason: "no daemon is running yet" };
        console.log(JSON.stringify(reply));
      } finally {
        db.close();
      }
      return;
    }
    let endpoint: DaemonEndpoint;
    let token: string;
    try {
      endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      token = await mintDeviceToken(endpoint);
    } catch (err) {
      console.error(`Failed to mint a device token: ${(err as Error).message}`);
      process.exit(1);
    }
    const daemon = { port: endpoint.port, token };

    const db = openDatabase();
    const { url, daemonHost, scheme, useLocal, isLoopbackFallback, tlsDegraded } = buildMeldUrl({
      db,
      daemon,
      host: args.host,
      local: args.local,
    });
    db.close();

    console.log(`\nScan this QR code to meld:\n`);
    qrcode.generate(url, { small: args.small ?? true }, (code: string) => {
      console.log(code);
    });
    console.log(`\n${url}\n`);
    console.log(`Daemon: ${daemonHost} (${scheme})`);
    if (!useLocal) {
      console.log(`App: brane.organelle.dev`);
    }
    console.log(meldLapseNote());
    if (isLoopbackFallback) {
      console.log(
        "\nNo Tailscale detected. This QR points at 127.0.0.1 and will only work from this machine.",
      );
      console.log(
        "For cross-device access, install Tailscale and run `brane certify`,",
      );
      console.log(
        "or pass `--host <address>` to advertise an address you trust.",
      );
    } else if (tlsDegraded) {
      console.log(
        "\nWarning: Tailscale is up but the daemon has no TLS cert, so this QR uses plain HTTP.",
      );
      console.log(
        "Run `brane certify` to provision one — it'll tell you if \"HTTPS for your tailnet\"",
      );
      console.log(
        "needs enabling at https://login.tailscale.com/admin/dns.",
      );
    }
  },
});
