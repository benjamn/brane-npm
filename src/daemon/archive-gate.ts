/**
 * Archiving takes a narrative out of the list, so a session that is still
 * running must not be archivable: an agent gone rogue would otherwise be one
 * PATCH from out of sight while it carries on. The app offers Archive only on
 * an ended narrative (`src/shared/narrative-menu.ts`); this is the daemon
 * refusing the same request from any client.
 *
 * "Running" is any sign of life, not just the status column: a row can read
 * `ended` while an agent is still on the bridge (the stale-row case the menu
 * also guards) or its tmux session is still up. Unarchiving is never gated.
 */
export interface ArchiveLiveness {
  status: string | null;
  mcpConnected: boolean;
  tmuxLive: boolean;
}

/** Why the narrative can't be archived yet, or null when it can. */
export function archiveRefusal({ status, mcpConnected, tmuxLive }: ArchiveLiveness): string | null {
  if (mcpConnected) return "its agent is still connected";
  if (tmuxLive) return "its session is still running";
  if (status !== "ended") return `its status is ${status ?? "unset"}, not ended`;
  return null;
}
