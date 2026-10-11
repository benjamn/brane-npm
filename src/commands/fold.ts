import { defineCommand } from "citty";
import { resolve } from "node:path";
import { resolveDaemonEndpoint, daemonRequest, warnIfVersionMismatch } from "../daemon/client.js";
import type { FoldRow } from "../folds.js";

interface FoldNarrative {
  id: string;
  agent_type: string;
  role: string;
  status: string;
  fold_path: string;
}

function describeFold(fold: FoldRow): string[] {
  const created = new Date(fold.created_at).toLocaleDateString();
  const spawned = fold.last_spawned
    ? new Date(fold.last_spawned).toLocaleDateString()
    : "never";
  return [
    `Fold: ${fold.path}${fold.archived ? "  (archived)" : ""}`,
    `  created: ${created}  last spawned: ${spawned}${fold.brane_id ? `  brane: ${fold.brane_id}` : ""}`,
  ];
}

/** The fold's line plus the narratives spawned from it — the listing the
 *  daemon already serves, filtered to this fold. */
export function formatFoldInfo(fold: FoldRow, narratives: FoldNarrative[]): string {
  const lines = describeFold(fold);
  const mine = narratives.filter((n) => n.fold_path === fold.path).slice(0, 10);
  if (mine.length > 0) {
    lines.push("", "  Narratives:");
    for (const n of mine) {
      const icon = n.status === "active" ? "●" : "○";
      lines.push(`    ${icon} ${n.id} (${n.agent_type}, ${n.role})`);
    }
  }
  return lines.join("\n");
}

export function formatFoldList(folds: FoldRow[]): string {
  if (folds.length === 0) {
    return "No folds registered. Run `brane fold` in a directory to register it.";
  }
  const lines = ["Registered folds:", ""];
  for (const fold of folds) {
    const created = new Date(fold.created_at).toLocaleDateString();
    const spawned = fold.last_spawned
      ? new Date(fold.last_spawned).toLocaleDateString()
      : "never";
    const braneTag = fold.brane_id ? `  brane: ${fold.brane_id}` : "";
    lines.push(`  ${fold.path}${fold.archived ? "  (archived)" : ""}`);
    lines.push(`    created: ${created}  last spawned: ${spawned}${braneTag}`, "");
  }
  return lines.join("\n");
}

export const foldCommand = defineCommand({
  meta: {
    name: "fold",
    description: "Register the current directory as a fold (spawn point)",
  },
  args: {
    directory: {
      type: "positional",
      description: "Directory to fold (default: current directory)",
      required: false,
    },
    list: {
      type: "boolean",
      description: "List all registered folds",
    },
    brane: {
      type: "string",
      description: "Associate this fold with a brane ID",
    },
  },
  async run({ args }) {
    try {
      // Registration is `POST /api/folds`, the same route the app's "add a
      // spawn point" uses. The daemon recognizes this CLI as a loopback
      // caller and grants it the reach the operator's shell always had;
      // a remote client is confined to $HOME.
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);

      if (args.list) {
        const { folds } = await daemonRequest<{ folds: FoldRow[] }>(endpoint, "/api/folds?archived=1");
        console.log(formatFoldList(folds));
        return;
      }

      const absolute = resolve(args.directory ?? process.cwd());
      const { fold, created } = await daemonRequest<{ fold: FoldRow; created: boolean }>(
        endpoint,
        "/api/folds",
        { method: "POST", body: { path: absolute, ...(args.brane ? { brane_id: args.brane } : {}) } },
      );

      if (created) {
        console.log(`Folded: ${fold.path} (brane: ${fold.brane_id})`);
        return;
      }
      // Already registered: the brane may have been rebound; show the fold.
      if (args.brane) console.log(`Updated brane: ${args.brane}`);
      const { narratives } = await daemonRequest<{ narratives: FoldNarrative[] }>(
        endpoint,
        "/api/narratives",
      );
      console.log(formatFoldInfo(fold, narratives));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
