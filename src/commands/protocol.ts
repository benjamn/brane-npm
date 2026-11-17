import { defineCommand } from "citty";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { resolveDaemonEndpoint, daemonRequest, warnIfVersionMismatch, type DaemonEndpoint } from "../daemon/client.js";
import { toPortablePath } from "../db/schema.js";
import { announcePresenceWait } from "./meld.js";
import { formatLineDiff, lineDiff, visibleText } from "../shared/line-diff.js";

/**
 * `brane protocol` — approve the `home` and `fold` protocols agents may
 * follow (docs/protocols.md#approval). A daemon client: the daemon holds the
 * approvals and asks the OS's presence prompt before it records one.
 */

/** One entry of `GET /api/protocols/pending` (src/daemon/protocol-routes.ts). */
export interface PendingProtocolRow {
  from: "fold" | "home";
  path: string;
  sha256: string;
  content: string;
  approved_content?: string;
}

interface ApprovalsReport {
  pending: PendingProtocolRow[];
  approved: Array<{ path: string; sha256: string; approved_at: number; approved_by: string }>;
}

async function report(endpoint: DaemonEndpoint): Promise<ApprovalsReport> {
  return daemonRequest<ApprovalsReport>(endpoint, "/api/protocols/pending");
}

/** What the operator is shown before approving: the whole file when it is
 *  new, the change when an earlier version was approved. */
export function approvalPreview(row: PendingProtocolRow): string {
  if (row.approved_content === undefined) return visibleText(row.content);
  return visibleText(formatLineDiff(lineDiff(row.approved_content, row.content)));
}

/** A path as typed (relative to here, `~/`, or absolute) in the daemon's
 *  portable form. */
function portable(arg: string): string {
  return toPortablePath(resolve(arg.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")));
}

function fail(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const pendingCommand = defineCommand({
  meta: { name: "pending", description: "List protocol files awaiting your approval, and what is approved" },
  async run() {
    try {
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      const r = await report(endpoint);
      if (r.pending.length === 0) console.log("No protocol files await approval.");
      for (const p of r.pending) {
        console.log(`pending  ${p.path}${p.approved_content !== undefined ? "  (changed since approved)" : ""}`);
      }
      const waiting = new Set(r.pending.map((p) => p.path));
      for (const a of r.approved) {
        const note = waiting.has(a.path) ? "; an edit awaits approval" : "";
        console.log(`approved ${a.path}  (${new Date(a.approved_at).toISOString()}, by ${a.approved_by}${note})`);
      }
      if (r.pending.length > 0) console.log("\nRead and approve one with `brane protocol approve <path>`.");
    } catch (err) {
      fail(err);
    }
  },
});

const approveCommand = defineCommand({
  meta: {
    name: "approve",
    description: "Show a pending protocol file (or what changed in it), then approve that exact text",
  },
  args: {
    path: { type: "positional", description: "The protocol file, e.g. ~/.brane/protocols/review.md", required: true },
    yes: { type: "boolean", description: "Approve without asking here (the presence prompt still asks)", default: false },
  },
  async run({ args }) {
    try {
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      const want = portable(args.path);
      const row = (await report(endpoint)).pending.find((p) => p.path === want);
      if (!row) {
        console.error(`${want} is not awaiting approval (\`brane protocol pending\` lists what is).`);
        process.exit(1);
      }
      console.log(`── ${row.path}${row.approved_content !== undefined ? " — changes since you approved it" : ""} ──\n`);
      console.log(approvalPreview(row));
      console.log(`\n── sha256 ${row.sha256} ──`);
      if (!args.yes) {
        if (!process.stdin.isTTY) fail("Not a terminal: pass --yes to approve what is shown above.");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question("Approve this text for brane's agents? [y/N] ")).trim().toLowerCase();
        rl.close();
        if (answer !== "y" && answer !== "yes") {
          console.log("Not approved.");
          return;
        }
      }
      announcePresenceWait();
      const done = await daemonRequest<{ path: string; sha256: string }>(endpoint, "/api/protocols/approve", {
        method: "POST",
        body: { path: row.path, sha256: row.sha256 },
      });
      console.log(`Approved ${done.path}. It is in force until it changes.`);
    } catch (err) {
      fail(err);
    }
  },
});

const revokeCommand = defineCommand({
  meta: { name: "revoke", description: "Withdraw an approval; the file is ignored until approved again" },
  args: { path: { type: "positional", description: "The protocol file", required: true } },
  async run({ args }) {
    try {
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      const r = await daemonRequest<{ path: string; revoked: boolean }>(endpoint, "/api/protocols/revoke", {
        method: "POST",
        body: { path: portable(args.path) },
      });
      console.log(r.revoked ? `Withdrew the approval of ${r.path}.` : `${r.path} had no approval.`);
    } catch (err) {
      fail(err);
    }
  },
});

export const protocolCommand = defineCommand({
  meta: { name: "protocol", description: "Approve the home and fold protocols agents may follow (pending, approve, revoke)" },
  subCommands: { pending: pendingCommand, approve: approveCommand, revoke: revokeCommand },
});
