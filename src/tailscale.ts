import { execFile, execSync } from "node:child_process";
import { tailnetHost } from "./shared/sleep.js";

interface TailscaleInfo {
  dnsName?: string;
  ips?: string[];
}

function getTailscaleStatus(): TailscaleInfo {
  try {
    const json = execSync("tailscale status --json", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).toString();
    const status = JSON.parse(json);
    const dnsName = (status?.Self?.DNSName as string | undefined)?.replace(/\.$/, "");
    return { dnsName, ips: parseTailscaleIps(json) };
  } catch {
    // Tailscale not installed or not running
    return {};
  }
}

/** Try to get the Tailscale DNS name (e.g., "myhost.tailnet.ts.net") */
export function getTailscaleHost(): string | undefined {
  return getTailscaleStatus().dnsName;
}

/** Get Tailscale IPs for this machine (e.g., ["100.x.y.z", "fd7a:..."]) */
export function getTailscaleIps(): string[] {
  return getTailscaleStatus().ips ?? [];
}

/**
 * `Self.TailscaleIPs` out of `tailscale status --json` output — or `[]`.
 *
 * Shared by the sync and async readers so they cannot disagree. Every way
 * the input can be wrong (not JSON, no `Self`, `TailscaleIPs` missing or
 * holding non-strings) yields an empty list rather than a throw: "no
 * Tailscale" is an ordinary state the daemon handles, and a malformed answer
 * must look like that state, never like a crash.
 */
export function parseTailscaleIps(stdout: string): string[] {
  try {
    const status = JSON.parse(stdout);
    const ips = status?.Self?.TailscaleIPs;
    return Array.isArray(ips) ? ips.filter((x: unknown): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Async twin of `getTailscaleIps` for callers on the daemon's event loop.
 * The sync form blocks for up to its 3 s timeout when the Tailscale
 * extension is hung — acceptable once at startup, not every minute for the
 * lifetime of the daemon. Resolves to `[]` on any failure, like the sync form.
 */
export function getTailscaleIpsAsync(timeoutMs = 3000): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "tailscale",
      ["status", "--json"],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : parseTailscaleIps(String(stdout))),
    );
  });
}

// ── The tailnet as this machine sees it ───────────────────────────────────
//
// `tailscale status --json` already knows, for every peer and without
// sending it a packet, whether control has it online, which path this
// machine has to it, and when they last shook hands. The app cannot ask its
// own device's Tailscale anything, so it used to learn "asleep" by dialing
// each machine and timing out, and a dial at an offline peer is not free on
// a phone (docs/sleep.md, Two addresses). An awake daemon can simply be
// asked. See `GET /api/tailnet`.

export interface TailnetPeer {
  /** MagicDNS name, lowercase, no trailing dot. */
  host: string;
  ips: string[];
  /** Control's view: connected to the coordination server right now. A
   *  machine that ran `tailscale down`, or is stopped, is false. */
  online: boolean;
  /** When control last saw it, if it is offline. */
  last_seen: string | null;
  /** This machine has a direct path to it at this moment. */
  direct: boolean;
  /** The relay region traffic would use, or is using, absent a direct path. */
  relay: string | null;
  /** The last WireGuard handshake between this machine and it, if any. */
  last_handshake: string | null;
}

export interface TailnetView {
  /** False when Tailscale did not answer; nothing else is then known. */
  available: boolean;
  /** `BackendState`: "Running", "Stopped", "NeedsLogin", … */
  state: string | null;
  /** Tailscale's own health warnings, verbatim. */
  health: string[];
  peers: TailnetPeer[];
}

const NO_TAILNET: TailnetView = { available: false, state: null, health: [], peers: [] };

function isoOrNull(value: unknown): string | null {
  // Go's zero time means "never".
  if (typeof value !== "string" || value === "" || value.startsWith("0001-01-01")) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

/** How hosts are compared here and in the app (src/shared/sleep.ts). */
export const normalizeTailnetHost = tailnetHost;

/** `tailscale status --json` as a `TailnetView`. Anything malformed is "not
 *  available", never a throw, for the reason `parseTailscaleIps` gives. */
export function parseTailnet(stdout: string): TailnetView {
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    return NO_TAILNET;
  }
  if (!status || typeof status !== "object") return NO_TAILNET;
  const s = status as Record<string, unknown>;
  const peers: TailnetPeer[] = [];
  const raw = s.Peer && typeof s.Peer === "object" ? Object.values(s.Peer as Record<string, unknown>) : [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as Record<string, unknown>;
    if (typeof p.DNSName !== "string" || p.DNSName === "") continue;
    const online = p.Online === true;
    peers.push({
      host: normalizeTailnetHost(p.DNSName),
      ips: strings(p.TailscaleIPs),
      online,
      last_seen: online ? null : isoOrNull(p.LastSeen),
      direct: typeof p.CurAddr === "string" && p.CurAddr !== "",
      relay: typeof p.Relay === "string" && p.Relay !== "" ? p.Relay : null,
      last_handshake: isoOrNull(p.LastHandshake),
    });
  }
  return {
    available: true,
    state: typeof s.BackendState === "string" ? s.BackendState : null,
    health: strings(s.Health),
    peers,
  };
}

export function getTailnetAsync(timeoutMs = 3000): Promise<TailnetView> {
  return new Promise((resolve) => {
    execFile(
      "tailscale",
      ["status", "--json"],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? NO_TAILNET : parseTailnet(String(stdout))),
    );
  });
}

/** How many hosts one request may ask about. */
export const TAILNET_HOSTS_MAX = 32;

export interface TailnetAnswer {
  available: boolean;
  state: string | null;
  health: string[];
  /** Only the hosts asked for, and only those this machine has as peers:
   *  the route answers a question, it does not list the tailnet. */
  peers: TailnetPeer[];
  /** The peer the request came from, when its address is a peer's: the
   *  daemon's view of the path to the device asking. Null behind userspace
   *  tailscaled, where every connection arrives from loopback. */
  client: TailnetPeer | null;
}

export function tailnetAnswer(view: TailnetView, hosts: readonly string[], clientAddress: string | null | undefined): TailnetAnswer {
  const wanted = new Set(hosts.slice(0, TAILNET_HOSTS_MAX).map(normalizeTailnetHost).filter((h) => h !== ""));
  const address = (clientAddress ?? "").replace(/^::ffff:/, "");
  return {
    available: view.available,
    state: view.state,
    health: view.health,
    peers: view.peers.filter((p) => wanted.has(p.host)),
    client: address === "" ? null : (view.peers.find((p) => p.ips.includes(address)) ?? null),
  };
}
