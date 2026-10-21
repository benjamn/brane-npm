/**
 * Switching the gate on retires what was minted without proof
 * (docs/passkeys.md, "Switching on retires what was minted without proof").
 * While `verification` is `off`, a device that dialed `/ws/mcp` was handed
 * an agent token for an external narrative with no proof at all, and agent
 * tokens are never gated; left alone, it would keep acting for as long as it
 * stayed connected. So the moment the mode leaves `off`, those tokens are
 * revoked, and the holder re-dials under a ceremony.
 *
 * Less obvious than it looks:
 *
 * - **The daemon learns of the switch only by reading config.** `brane
 *   config` writes the database directly, past every route, and the gate
 *   reads its config lazily, only when an act arrives. An external working
 *   purely through MCP tool calls would never trigger that read, so this
 *   runs on a tick of its own, and once at startup.
 * - **The last mode seen is kept in `meta`**, so a switch made while the
 *   daemon was down is still a switch when it comes back up.
 * - **Only externals a device dialed.** `recordLauncher` sets `minted_by` on
 *   every spawn, run and revive too; a rule on `minted_by` alone would sign
 *   out every working agent the phone started, mid-task
 *   (claude-vxnhxcg9:16). `DbTokenStore.externalsOf` is exactly the
 *   narrower set.
 */

import type Database from "better-sqlite3";
import type { DbTokenStore } from "../db/tokens.js";
import type { VerificationMode } from "./verification-gate.js";

const SEEN_KEY = "verification.seen_mode";

/** How often the daemon re-reads the mode for the switch. */
export const SWITCH_TICK_MS = 2_000;

export interface SwitchOutcome {
  from: string;
  to: VerificationMode;
  /** Agent tokens revoked by this switch: close their sockets. */
  revoked: string[];
}

/** Compare the mode now with the last one seen; on `off` → anything else,
 *  revoke the device-dialed externals. Returns what happened, or null when
 *  the mode is unchanged. */
export function settleSwitch(
  db: Database.Database,
  mode: VerificationMode,
  tokens: Pick<DbTokenStore, "live" | "externalsOf" | "revoke">,
  now: number = Date.now(),
): SwitchOutcome | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SEEN_KEY) as { value: string } | undefined;
  const seen = row?.value ?? "off";
  if (seen === mode) return null;
  let revoked: string[] = [];
  if (seen === "off" && mode !== "off") {
    revoked = tokens.externalsOf(tokens.live("device").map((t) => t.id));
    if (revoked.length > 0) tokens.revoke(revoked, now);
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(SEEN_KEY, mode);
  return { from: seen, to: mode, revoked };
}
