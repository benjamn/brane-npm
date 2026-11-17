/**
 * The rename warning (docs/passkeys.md, open question 2, settled in phase
 * 4). A WebAuthn credential is bound to the RP ID it was enrolled for, the
 * daemon's TLS hostname (`<machine>.<tailnet>.ts.net`); rename the machine
 * or the tailnet and every passkey is orphaned: still enrolled, never able
 * to answer. Nothing can migrate them, so the daemon says so, at three
 * moments:
 *
 * - **When it learns its hostname**: at startup once the certificate is
 *   read, and on every certificate reload, it records the host in `meta`
 *   (`RP_ID_META_KEY`) and logs a warning if any live credential names
 *   another: once per distinct warning (`RenameWatch`), so a reload that
 *   says the same thing is quiet and a change in the counts is not. With
 *   the gate already on and nothing usable, the line says every device is
 *   locked out and that the way out is `brane config verification off`
 *   from the shell: enrolling is an act, so no device can add the
 *   credential that would let it act.
 * - **In `GET /api/status`** (`verification.rp_id`, `rp_mismatch`) and `GET
 *   /api/credentials` (`rp_id`), so the Devices view can say which
 *   credential was enrolled for which host.
 * - **At `brane config verification passkey`**, which refuses when no live
 *   credential matches the recorded host: the switch would lock every
 *   device out at once, which is exactly what the switch's other refusal
 *   exists to prevent. The CLI has no certificate, which is why the daemon
 *   records the host for it.
 */

import type Database from "better-sqlite3";

/** The `meta` key under which the daemon keeps the RP ID it last served. */
export const RP_ID_META_KEY = "verification.rp_id";

/** Record the host the daemon serves, for the CLI's switch. Nothing is
 *  written when there is no TLS, so the last known host stands. */
export function recordRpId(db: Database.Database, host: string | null): void {
  if (!host) return;
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(RP_ID_META_KEY, host);
}

export function recordedRpId(db: Database.Database): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(RP_ID_META_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Live credentials enrolled for a host other than `rpId`, counted by the
 *  host they were enrolled for. Empty when `rpId` is unknown: with no host
 *  to compare against nothing is an orphan yet. */
export function orphanedCredentials(live: ReadonlyArray<{ rp_id: string }>, rpId: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!rpId) return out;
  for (const c of live) if (c.rp_id !== rpId) out.set(c.rp_id, (out.get(c.rp_id) ?? 0) + 1);
  return out;
}

/** The warning for the daemon log, or null when every credential matches.
 *  `usable` is how many do: the line says whether the gate still has
 *  anything to verify with. `mode` is the gate's: with it on and nothing
 *  usable, every device is locked out now, and the switch the operator
 *  needs is `off`, from this machine's shell. */
export function renameWarning(orphans: ReadonlyMap<string, number>, rpId: string, usable: number, mode: string): string | null {
  if (orphans.size === 0) return null;
  const was = [...orphans].map(([host, n]) => `${n} for ${host}`).join(", ");
  const total = [...orphans.values()].reduce((a, b) => a + b, 0);
  const tail = usable > 0
    ? `${usable} enrolled for ${rpId} still can.`
    : mode === "off"
      ? "None is enrolled for it, so no device can verify here until one is added from the app's Devices view; `brane config verification passkey` refuses meanwhile."
      : `None is enrolled for it and verification is on, so every device is locked out: run \`brane config verification off\` from this machine's shell, add a credential for ${rpId} from the app's Devices view, then switch it back on.`;
  return (
    `[verification] this daemon serves ${rpId}, but ${total} credential(s) were enrolled for another host (${was}) ` +
    `and cannot verify here: a passkey is bound to the hostname it was made for. ${tail}`
  );
}

/** How many live credentials can verify on `rpId`: enrolled for it. Null
 *  while the host is unknown, when there is no ceremony to count for. */
export function usableCredentials(live: ReadonlyArray<{ rp_id: string }>, rpId: string | null): number | null {
  if (!rpId) return null;
  return live.filter((c) => c.rp_id === rpId).length;
}

/** What to log when the daemon learns its hostname: the warning, once per
 *  distinct text. A certificate reload that says the same thing is quiet;
 *  a change in the counts, or in what the operator can do about it, is
 *  said again. */
export class RenameWatch {
  private last: string | null = null;

  /** The line to log now, or null: nothing wrong, or nothing new. */
  check(live: ReadonlyArray<{ rp_id: string }>, rpId: string, mode: string): string | null {
    const orphans = orphanedCredentials(live, rpId);
    const warning = renameWarning(orphans, rpId, usableCredentials(live, rpId) ?? 0, mode);
    const fresh = warning !== null && warning !== this.last;
    this.last = warning;
    return fresh ? warning : null;
  }
}
