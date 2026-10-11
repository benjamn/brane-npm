import { resolve } from "node:path";
import { defineCommand } from "citty";
import { resolveDaemonEndpoint, daemonRequest, warnIfVersionMismatch } from "../daemon/client.js";

/** Parse a duration string like "1h", "2d", "30m", "1w" into milliseconds. */
export function parseDuration(input: string): number {
  const match = input.match(/^(\d+)\s*(ms|s|m|h|d|w)$/);
  if (!match) throw new Error(`Invalid duration: "${input}". Use e.g. 30m, 1h, 2d, 1w`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return value * multipliers[unit];
}

/** Format a timestamp as a relative time string like "3m ago". */
export function timeSince(timestampMs: number, now: number = Date.now()): string {
  const seconds = Math.floor((now - timestampMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** One row of `GET /api/narratives/recent` — the browse shape of the
 *  `narrative_info` MCP tool. */
export interface RecentNarrative {
  id: string;
  agent_type: string;
  role: string;
  status: string;
  title: string | null;
  summary: string | null;
  last_activity: number;
  last_activity_ago: string;
  event_count: number;
}

export function formatRecentNarratives(rows: RecentNarrative[], since: string): string {
  if (rows.length === 0) return `No narratives active in the last ${since}.`;
  const lines: string[] = [];
  for (const row of rows) {
    const icon = row.status === "active" ? "●" : "○";
    const title = row.title ? `"${row.title}"` : `(${row.agent_type})`;
    const events = `${row.event_count} event${row.event_count === 1 ? "" : "s"}`;
    lines.push(`${icon} ${row.id}  ${title}  ${row.last_activity_ago}  (${events})`);
    if (row.summary) lines.push(`  Summary: ${row.summary}`);
  }
  return lines.join("\n");
}

/** Query string for `/api/narratives/recent`. A relative `--fold` is resolved
 *  against this shell's cwd, since the daemon's cwd means nothing here. */
export function buildRecentQuery(
  args: { since: string; search?: string; status?: string; limit: string; fold?: string; archived?: boolean },
  cwd: string,
): string {
  const q = new URLSearchParams();
  q.set("since", args.since);
  if (args.archived) q.set("archived", "1");
  if (args.search) q.set("search", args.search);
  if (args.status) q.set("status", args.status);
  q.set("limit", String(parseInt(args.limit, 10) || 20));
  if (args.fold) q.set("fold", args.fold.startsWith("~") ? args.fold : resolve(cwd, args.fold));
  return q.toString();
}

const memoryLog = defineCommand({
  meta: {
    name: "log",
    description: "Show recently active narratives with search/filtering",
  },
  args: {
    since: {
      type: "string",
      default: "24h",
      description: "Time window for recent activity (e.g. 30m, 1h, 2d, 1w)",
    },
    search: {
      type: "string",
      description: "Filter to narratives containing matching event content",
    },
    status: {
      type: "string",
      description: "Filter by narrative status (active, ended)",
    },
    limit: {
      type: "string",
      default: "20",
      description: "Maximum number of narratives to show",
    },
    fold: {
      type: "string",
      description: "Filter by fold path (absolute or portable, e.g. ~/dev/brane)",
    },
    archived: {
      type: "boolean",
      description: "Include archived narratives (absorbed history is archived by construction)",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    try {
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      const { narratives, since } = await daemonRequest<{ narratives: RecentNarrative[]; since: string }>(
        endpoint,
        `/api/narratives/recent?${buildRecentQuery(args, process.cwd())}`,
      );
      if (args.json) {
        console.log(JSON.stringify(narratives, null, 2));
        return;
      }
      console.log(formatRecentNarratives(narratives, since));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

interface SearchHit {
  narrative_id: string;
  seq: number;
  content: string;
  score: number;
}

export function formatSearchResults(results: SearchHit[]): string {
  if (results.length === 0) return "No results found.";
  const lines = [`Found ${results.length} results:`, ""];
  results.forEach((r, i) => {
    const preview = r.content.length > 120 ? r.content.slice(0, 120) + "..." : r.content;
    lines.push(`${i + 1}. ${r.narrative_id} (seq ${r.seq}) - Score: ${r.score.toFixed(2)}`);
    lines.push(`   "${preview}"`);
    lines.push(`   > brane attach ${r.narrative_id}`, "");
  });
  return lines.join("\n");
}

const memorySearch = defineCommand({
  meta: {
    name: "search",
    description: "Semantic search across narrative history",
  },
  args: {
    query: {
      type: "positional",
      required: true,
      description: "Search query",
    },
    limit: {
      type: "string",
      default: "10",
      description: "Maximum number of results",
    },
  },
  async run({ args }) {
    try {
      // The daemon's embedding model is already warm; loading a second copy
      // here cost every search a 30 s cold start. Indexing of new events is
      // the daemon's background job (and `brane memory index` on demand).
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      console.log(`Searching: "${args.query}"\n`);
      const { results } = await daemonRequest<{ results: SearchHit[] }>(endpoint, "/api/search", {
        method: "POST",
        body: { query: args.query, limit: parseInt(args.limit, 10) || 10 },
      });
      console.log(formatSearchResults(results));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

interface IndexResult {
  rebuild: boolean;
  narratives_scanned: number;
  narratives_indexed: number;
  chunks_created: number;
}

export function formatIndexResult(stats: IndexResult): string {
  return (
    `Done. Scanned ${stats.narratives_scanned} narratives, ` +
    `indexed ${stats.narratives_indexed}, ` +
    `created ${stats.chunks_created} chunks.`
  );
}

const memoryIndex = defineCommand({
  meta: {
    name: "index",
    description: "Re-index narrative content for semantic search",
  },
  args: {
    rebuild: {
      type: "boolean",
      description: "Rebuild entire index from scratch",
    },
  },
  async run({ args }) {
    try {
      // Runs through the daemon's indexer, queued behind any background
      // pass already in flight — two processes indexing the same cursors
      // was the race the in-process version had.
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      const stats = await daemonRequest<IndexResult>(endpoint, "/api/memory/index", {
        method: "POST",
        body: { rebuild: args.rebuild ?? false },
      });
      console.log(formatIndexResult(stats));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

export const memoryCommand = defineCommand({
  meta: {
    name: "memory",
    description: "Semantic memory search and indexing",
  },
  subCommands: {
    log: memoryLog,
    search: memorySearch,
    index: memoryIndex,
  },
});
