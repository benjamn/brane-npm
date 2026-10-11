// Tailscale re-probe policy for the daemon's listeners.
//
// `startServer` asks Tailscale for its addresses exactly once, at startup, and
// binds to whatever comes back. That is the right first move and the wrong
// last one: a `tailscale status` that times out — the extension wedged, the
// app still launching after a reboot — leaves the daemon bound to loopback
// only, and it stays that way for as long as it runs. Observed on 2026-08-30:
// three consecutive daemon starts logged "No Tailscale detected" while the
// Tailscale extension was hung, and the phone stayed locked out through the
// recovery until the operator happened to restart the daemon again
// (claude-9ya34xr8:13, :23).
//
// The policy here is window-free and pure so `src/test/tailscale-rebind.test.ts`
// can pin it: how long to wait before asking again, and which of the addresses
// an answer carries still need a listener.

/** First retry after a probe that found nothing. */
export const TAILSCALE_PROBE_INITIAL_MS = 5_000;
/** Ceiling for the not-found backoff. */
export const TAILSCALE_PROBE_MAX_MS = 60_000;
/** Cadence once Tailscale has been seen — catches address changes and a
 *  restart that came back with new IPs. */
export const TAILSCALE_PROBE_STEADY_MS = 60_000;

/**
 * Delay before the next probe.
 *
 * Not found: exponential backoff from `TAILSCALE_PROBE_INITIAL_MS`, doubling
 * up to `TAILSCALE_PROBE_MAX_MS`. A Tailscale that is starting up is usually
 * ready within seconds; one that is wedged is not, and there is no point
 * hammering a hung CLI.
 *
 * Found: `TAILSCALE_PROBE_STEADY_MS`, regardless of what came before.
 */
export function nextProbeDelay(previous: number | null, found: boolean): number {
  if (found) return TAILSCALE_PROBE_STEADY_MS;
  if (previous === null || previous <= 0) return TAILSCALE_PROBE_INITIAL_MS;
  return Math.min(previous * 2, TAILSCALE_PROBE_MAX_MS);
}

/**
 * Addresses a probe returned that the daemon has not bound yet, in the order
 * Tailscale reported them, without duplicates or blanks. An address that is
 * already bound is never returned — rebinding it would throw EADDRINUSE
 * against our own listener.
 */
export function addressesToBind(bound: Iterable<string>, probed: readonly string[]): string[] {
  const have = new Set(bound);
  const out: string[] = [];
  for (const raw of probed) {
    const addr = raw.trim();
    if (!addr || have.has(addr)) continue;
    have.add(addr);
    out.push(addr);
  }
  return out;
}
