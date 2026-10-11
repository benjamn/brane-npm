import { execFile, execSync } from "node:child_process";

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
