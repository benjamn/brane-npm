import { defineCommand } from "citty";
import { resolveDaemonEndpoint, daemonRequest, warnIfVersionMismatch } from "../daemon/client.js";
import { timeSince } from "./memory.js";

/** A narrative as `GET /api/narratives` returns it (resumption plumbing
 *  stripped server-side; only what the listing prints is named here). */
export interface ListedNarrative {
  id: string;
  brane_id: string;
  agent_type: string;
  role: string;
  fold_path: string;
  status: string;
  summary: string | null;
  created_at: number;
}

export interface ListedBrane {
  brane_id: string;
  is_home: boolean;
}

export const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List narratives grouped by brane",
  },
  args: {
    brane: {
      type: "string",
      description: "Filter to a specific brane ID",
    },
    archived: {
      type: "boolean",
      description: "Include archived narratives",
      default: false,
    },
    limit: {
      type: "string",
      description: "Max narratives per brane (0 = unlimited, default: 10)",
      default: "10",
    },
  },
  async run({ args }) {
    try {
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      const query = new URLSearchParams();
      if (args.archived) query.set("archived", "1");
      if (args.brane) query.set("brane_ids", args.brane);
      const qs = query.toString();
      const [{ narratives }, { branes }] = await Promise.all([
        daemonRequest<{ narratives: ListedNarrative[] }>(
          endpoint,
          `/api/narratives${qs ? `?${qs}` : ""}`,
        ),
        daemonRequest<{ branes: ListedBrane[] }>(endpoint, "/api/branes"),
      ]);
      console.log(
        formatNarrativeList(narratives, branes, { limit: parseInt(args.limit, 10) }),
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

/** Group by brane in first-seen order (the API lists newest first, so the
 *  brane with the newest narrative leads), home brane marked. */
export function formatNarrativeList(
  narratives: ListedNarrative[],
  branes: ListedBrane[],
  opts: { limit: number; now?: number },
): string {
  if (narratives.length === 0) {
    return "No narratives. Use `brane spawn <agent>` to start one.";
  }
  const homeBraneId = branes.find((b) => b.is_home)?.brane_id;
  const byBrane = new Map<string, ListedNarrative[]>();
  for (const n of narratives) {
    let group = byBrane.get(n.brane_id);
    if (!group) {
      group = [];
      byBrane.set(n.brane_id, group);
    }
    group.push(n);
  }

  const out: string[] = [];
  for (const [braneId, narrs] of byBrane) {
    const isHome = braneId === homeBraneId;
    const activeCount = narrs.filter((n) => n.status === "active").length;
    const label = isHome ? `${braneId} (home)` : braneId;
    const counts = `${activeCount} active, ${narrs.length} total`;
    out.push(`\n  ${isHome ? "●" : "○"} ${label}  [${counts}]`);

    const shown = opts.limit > 0 ? narrs.slice(0, opts.limit) : narrs;
    for (const n of shown) {
      const age = timeSince(n.created_at, opts.now);
      const statusIcon = n.status === "active" ? "●" : "○";
      const desc = n.summary
        ? n.summary.length > 50
          ? n.summary.slice(0, 47) + "..."
          : n.summary
        : `${n.agent_type}/${n.role}`;
      out.push(`    ${statusIcon} ${n.id}  ${desc}  ${age}`);
    }
    const remaining = narrs.length - shown.length;
    if (remaining > 0) {
      out.push(`    ... and ${remaining} more (--limit 0 to show all)`);
    }
  }
  out.push("");
  return out.join("\n");
}
