import { defineCommand } from "citty";
import { resolveDaemonEndpoint, daemonRequest, warnIfVersionMismatch } from "../daemon/client.js";
import { formatCost } from "../shared/narrative-format.js";
import type { RepriceResult } from "../cost/reprice.js";

/** One narrative's line in the backfill report — the daemon's `CostSample`. */
interface BackfillSample {
  nid: string;
  agent_type: string;
  unit: string;
  sessions: number;
  readable: number;
  new_rows: number;
  new_amount: number;
  before: number | null;
  after: number | null;
}

interface BackfillResult {
  dry_run: boolean;
  scanned: number;
  samples: BackfillSample[];
}

const backfillCommand = defineCommand({
  meta: {
    name: "backfill",
    description: "Sweep the usage ledger over every narrative whose transcripts still exist",
  },
  args: {
    "dry-run": {
      type: "boolean",
      description: "Report what would be recorded without writing anything",
    },
    all: {
      type: "boolean",
      description: "List every readable narrative, not just the ones that would change",
    },
  },
  async run({ args }) {
    try {
      // The sweep runs in the daemon — readers resolve transcripts against its
      // HOME and memoize in its process — so this is a client of
      // POST /api/cost/backfill, in the same shape as `brane revive`.
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      const result = await daemonRequest<BackfillResult>(endpoint, "/api/cost/backfill", {
        method: "POST",
        body: { dry_run: !!args["dry-run"] },
      });
      console.log(formatBackfillResult(result, { all: !!args.all }));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

export function formatBackfillResult(result: BackfillResult, opts: { all?: boolean } = {}): string {
  const changed = result.samples.filter((s) => s.new_rows > 0 || s.new_amount > 0 || s.after !== s.before);
  const shown = opts.all ? result.samples : changed;
  const verb = result.dry_run ? "would record" : "recorded";
  const lines: string[] = [];
  for (const s of shown) {
    const delta = formatCost(s.new_amount, s.unit) ?? "0";
    const before = formatCost(s.before, s.unit) ?? "—";
    const after = formatCost(s.after, s.unit) ?? "—";
    lines.push(
      `${s.nid.padEnd(18)} ${s.agent_type.padEnd(8)} ${s.readable}/${s.sessions} sessions  +${s.new_rows} rows (${delta})  ${before} → ${after}`,
    );
  }
  // Per-unit totals of what this pass adds, never summed across units.
  const byUnit = new Map<string, number>();
  for (const s of result.samples) byUnit.set(s.unit, (byUnit.get(s.unit) ?? 0) + s.new_amount);
  const totals = [...byUnit].map(([u, a]) => formatCost(a, u)).filter(Boolean).join(" · ") || "nothing";
  lines.push(
    `${result.dry_run ? "[dry run] " : ""}${result.scanned} narratives scanned, ${result.samples.length} readable, ${changed.length} changed; ${verb} ${totals}`,
  );
  return lines.join("\n");
}

const repriceCommand = defineCommand({
  meta: {
    name: "reprice",
    description: "Re-price recorded ledger rows under the current price table",
  },
  args: {
    "dry-run": {
      type: "boolean",
      description: "Report what would change without writing anything",
    },
    all: {
      type: "boolean",
      description: "List every narrative that changes, not just the ten largest",
    },
  },
  async run({ args }) {
    try {
      // Rewrites the daemon's ledger, so it goes through the daemon like
      // backfill does — one writer, and the app hears about the new totals.
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      const result = await daemonRequest<RepriceResult>(endpoint, "/api/cost/reprice", {
        method: "POST",
        body: { dry_run: !!args["dry-run"] },
      });
      console.log(formatRepriceResult(result, { all: !!args.all }));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);

export function formatRepriceResult(result: RepriceResult, opts: { all?: boolean } = {}): string {
  const lines: string[] = [];
  for (const m of result.models) {
    const mark = m.changed ? "" : "  (unchanged)";
    lines.push(`${m.model.padEnd(20)} ${String(m.rows).padStart(6)} rows  ${usd(m.before)} → ${usd(m.after)}${mark}`);
  }
  // Largest corrections first; the full list only on request.
  const shown = opts.all ? result.narratives : result.narratives.slice(0, 10);
  if (shown.length) lines.push("");
  for (const n of shown) {
    lines.push(
      `${n.nid.padEnd(18)} ledger ${usd(n.ledger_before)} → ${usd(n.ledger_after)}  card ${usd(n.column_before)} → ${usd(n.column_after)}`,
    );
  }
  if (shown.length < result.narratives.length) {
    lines.push(`… ${result.narratives.length - shown.length} more (--all to list them)`);
  }
  const before = result.models.reduce((a, m) => a + m.before, 0);
  const after = result.models.reduce((a, m) => a + m.after, 0);
  const verb = result.dry_run ? "would change" : "changed";
  lines.push(
    `${result.dry_run ? "[dry run] " : ""}${result.scanned} priced rows, ${verb} ${result.changed} ` +
      `across ${result.narratives.length} narratives: ${usd(before)} → ${usd(after)}` +
      `; ${result.recovered} cache splits recovered` +
      (result.unrecoverable ? `, ${result.unrecoverable} unrecoverable (left as recorded)` : ""),
  );
  return lines.join("\n");
}

export const costCommand = defineCommand({
  meta: {
    name: "cost",
    description: "Cost ledger maintenance",
  },
  subCommands: {
    backfill: backfillCommand,
    reprice: repriceCommand,
  },
});
