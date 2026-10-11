/** CLI command: brane absorb <provider> <path> — a client of POST /api/absorb.
 *
 *  The import itself runs in the daemon (`src/absorb/run.ts`): payloads, the
 *  organelle search.db and the niche registry all resolve against the
 *  daemon's HOME, the same reason `brane cost backfill` delegates. What is
 *  left here is terminal-shaped: resolving the operator's relative paths
 *  against *this* shell's cwd, and printing the daemon's NDJSON stream —
 *  the pre-flight report, a `\r` progress line, the summary — as it arrives.
 */

import { resolve } from "node:path";
import { defineCommand, showUsage } from "citty";
import { resolveDaemonEndpoint, daemonRequest, daemonStream, warnIfVersionMismatch } from "../daemon/client.js";
import { listProviders } from "../absorb/index.js";
import type { AbsorbEvent, AbsorbRequest } from "../absorb/run.js";
import type { AbsorbSummary } from "../absorb/types.js";
import type { AbsorbSurvey } from "../absorb/sources.js";

/** What the daemon streams: an `AbsorbEvent`, or the terminal `error` line
 *  it appends when a run fails after the stream has opened. */
export type AbsorbStreamLine = AbsorbEvent | { type: "error"; error: string };

export interface AbsorbArgs {
  provider: string;
  path?: string;
  fold?: string;
  identity?: string;
  brane?: string;
  dryRun?: boolean;
  since?: string;
  session?: string;
  rebuild?: boolean;
}

/** A path the operator typed, made meaningful to a daemon whose cwd is not
 *  this shell's: `~/…` is left for the daemon to expand (it is portable
 *  by definition), anything else is resolved here. */
function absolutize(p: string, cwd: string): string {
  return p.startsWith("~") ? p : resolve(cwd, p);
}

/** The request body for `POST /api/absorb`. Only what the operator said is
 *  sent, so the daemon's defaults (organelle's `~/.organelle`, the derived
 *  brane id, the niche path as fold) stay in charge of everything else. */
export function buildAbsorbBody(args: AbsorbArgs, cwd: string): AbsorbRequest {
  return {
    provider: args.provider,
    ...(args.path ? { path: absolutize(args.path, cwd) } : {}),
    ...(args.fold ? { fold: absolutize(args.fold, cwd) } : {}),
    ...(args.identity ? { identity: args.identity } : {}),
    ...(args.brane ? { brane: args.brane } : {}),
    ...(args.dryRun ? { dry_run: true } : {}),
    ...(args.since ? { since: args.since } : {}),
    ...(args.session ? { session: args.session } : {}),
    ...(args.rebuild ? { rebuild: true } : {}),
  };
}

export const absorbCommand = defineCommand({
  meta: {
    name: "absorb",
    description:
      "Absorb conversation history: from LLM provider exports, or from agent session stores on this machine. `brane absorb survey` lists what this machine has.",
  },
  args: {
    provider: {
      type: "positional",
      required: false,
      description: `Source: ${listProviders().join(", ")} — or "survey" to list the session stores on this machine without reading them`,
    },
    path: {
      type: "positional",
      required: false,
      description:
        "Path to an extracted export directory (chatgpt), a niche directory (organelle, default ~/.organelle), or a session store (claude, default ~/.claude/projects).",
    },
    fold: {
      type: "string",
      description:
        "Target fold for absorbed conversations (required for chatgpt; defaults to the niche path for organelle). For a local source (claude) it is a filter: only sessions run in this directory.",
    },
    since: {
      type: "string",
      description: "Local sources only: sessions active in the last 30m/12h/7d/2w, or since an ISO date",
    },
    session: {
      type: "string",
      description: "Local sources only: a single session, by id or id prefix",
    },
    rebuild: {
      type: "boolean",
      description:
        "Local sources only: for sessions already absorbed into the target brane, drop their events and tool rows and import the file again (same narrative id; seqs renumbered). A narrative someone has signalled or narrated into is not rebuilt, only appended to. Composes with --fold, --since, --session, --dry-run.",
      default: false,
    },
    identity: {
      type: "string",
      description:
        "User identity label (e.g. email). Auto-detected when available.",
    },
    brane: {
      type: "string",
      description:
        'Target brane ID. Use "self" for home brane. Default: auto-generated from provider+identity.',
    },
    dryRun: {
      type: "boolean",
      alias: ["dry-run", "n"],
      description: "Parse and summarize without writing to the database",
      default: false,
    },
  },
  async run({ args }) {
    if (!args.provider) {
      // Usage, not a survey: a bare `brane absorb` should say what it can do
      // (claude-xiy9e8wq:15), and the survey is one of the things it names.
      await showUsage(absorbCommand);
      return;
    }
    if (args.provider === "survey") {
      try {
        const endpoint = await resolveDaemonEndpoint();
        warnIfVersionMismatch(endpoint);
        const survey = await daemonRequest<AbsorbSurvey>(endpoint, "/api/absorb/survey");
        for (const l of formatSurvey(survey)) console.log(l);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }
    const dryRun = args.dryRun as boolean;
    const body = buildAbsorbBody(
      {
        provider: args.provider,
        path: args.path,
        fold: args.fold,
        identity: args.identity,
        brane: args.brane,
        dryRun,
        since: args.since,
        session: args.session,
        rebuild: args.rebuild as boolean,
      },
      process.cwd(),
    );

    let failed = false;
    let progressShown = false;
    const clearProgress = () => {
      if (!progressShown) return;
      process.stdout.write("\r" + " ".repeat(80) + "\r");
      progressShown = false;
    };

    try {
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      await daemonStream<AbsorbStreamLine>(
        endpoint,
        "/api/absorb",
        { method: "POST", body },
        (line) => {
          switch (line.type) {
            case "info":
              console.log(line.message);
              break;
            case "progress":
              // A carriage-returned line only means something to a terminal;
              // piped or captured (a `!` command in an agent session), every
              // frame of it lands in the output ahead of the summary.
              if (!process.stdout.isTTY) break;
              process.stdout.write(formatProgress(line.done, line.title, dryRun));
              progressShown = true;
              break;
            case "summary":
              clearProgress();
              for (const l of formatSummary(line.summary, line.dry_run)) console.log(l);
              if (line.dry_run) {
                console.log(`\nRe-run without --dry-run to absorb these conversations.`);
              } else {
                for (const l of nextSteps(line.provider)) console.log(l);
              }
              break;
            case "error":
              clearProgress();
              console.error(line.error);
              failed = true;
              break;
          }
        },
      );
    } catch (err) {
      clearProgress();
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (failed) process.exit(1);
  },
});

/** The one-line, carriage-returned progress display. */
export function formatProgress(done: number, title: string | null, dryRun: boolean): string {
  const displayTitle = title
    ? title.length > 50
      ? title.slice(0, 47) + "..."
      : title
    : "(untitled)";
  return `\r  ${done} ${dryRun ? "scanned" : "absorbed"}: ${displayTitle}`.padEnd(80);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatSummary(summary: AbsorbSummary, dryRun: boolean): string[] {
  const lines: string[] = [];
  const verb = dryRun ? "Would absorb" : "Absorbed";
  const total = summary.conversations + summary.skipped + summary.appended;
  lines.push(
    `${verb}: ${summary.conversations} conversations, ${summary.messages} messages (${total} total parsed)`,
  );

  if (summary.appended > 0) {
    const aVerb = dryRun ? "Would update" : "Updated";
    lines.push(`${aVerb}: ${summary.appended} (new messages to append)`);
  }

  if (summary.skipped > 0) {
    lines.push(`Skipped: ${summary.skipped} (already absorbed)`);
  }
  if (summary.toolCalls) {
    lines.push(`Tool calls: ${summary.toolCalls}${dryRun ? " (would be recorded)" : ""}`);
  }
  if (summary.managed) {
    lines.push(`Managed by brane: ${summary.managed} (live narratives own these sessions; left alone)`);
  }
  if (summary.unchanged) {
    lines.push(`Unchanged: ${summary.unchanged} (not read; same size and mtime as last absorb)`);
  }
  if (summary.rebuilt) {
    lines.push(`${dryRun ? "Would rebuild" : "Rebuilt"}: ${summary.rebuilt} (events re-derived from source; narrative ids kept, seqs renumbered)`);
  }
  if (summary.locked) {
    lines.push(`${dryRun ? "Would not rebuild" : "Not rebuilt"}: ${summary.locked} (hold signals or narrations no import wrote; read as an ordinary re-run)`);
  }

  if (summary.assets > 0 || summary.unresolvedAssets > 0) {
    const totalAssets = summary.assets + summary.unresolvedAssets;
    const aVerb = dryRun ? "Would copy" : "Copied";
    lines.push(
      `Assets: ${summary.assets}/${totalAssets} resolved (${formatBytes(summary.assetsBytes)})${dryRun ? ` — ${aVerb.toLowerCase()} to ~/.brane/payloads/` : ""}`,
    );
    if (summary.unresolvedAssets > 0) {
      lines.push(`  Unresolved: ${summary.unresolvedAssets} (files not included in export)`);
    }
  }

  if (summary.oldest) {
    lines.push(
      `Oldest: ${new Date(summary.oldest.time).toISOString().slice(0, 10)} ${JSON.stringify(summary.oldest.title)}`,
    );
  }
  if (summary.newest) {
    lines.push(
      `Newest: ${new Date(summary.newest.time).toISOString().slice(0, 10)} ${JSON.stringify(summary.newest.title)}`,
    );
  }

  const modelEntries = Object.entries(summary.models).sort(
    ([, a], [, b]) => (b as number) - (a as number),
  );
  if (modelEntries.length > 0) {
    const modelStr = modelEntries.map(([m, c]) => `${m} (${c})`).join(", ");
    lines.push(`${summary.provider === "organelle" ? "Agent types" : "Models"}: ${modelStr}`);
  }
  return lines;
}

/** The bare `brane absorb` inventory: what this machine has, what an import
 *  would do with it, and what brane recognised but cannot read yet. */
export function formatSurvey(survey: AbsorbSurvey): string[] {
  const lines: string[] = [];
  lines.push(`Session stores under ${survey.home}:`);
  lines.push("");
  const supported = survey.sources.filter((s) => s.supported);
  const probes = survey.sources.filter((s) => !s.supported && s.found);
  for (const s of supported) {
    if (!s.found || !s.sessions) {
      lines.push(`  ${s.label.padEnd(36)} not found (${s.path})`);
      continue;
    }
    const n = s.sessions;
    const parts: string[] = [];
    if (n.new > 0) parts.push(`${n.new} new`);
    if (n.changed > 0) parts.push(`${n.changed} changed`);
    if (n.reparse > 0) parts.push(`${n.reparse} to re-read (newer parser)`);
    if (n.unchanged > 0) parts.push(`${n.unchanged} unchanged`);
    if (n.managed > 0) parts.push(`${n.managed} managed by brane`);
    lines.push(`  ${s.label.padEnd(36)} ${n.total} sessions, ${formatBytes(n.bytes)}, ${n.folds} director${n.folds === 1 ? "y" : "ies"}  (${s.path})`);
    if (parts.length > 0) lines.push(`  ${"".padEnd(36)} ${parts.join(", ")}`);
    if (n.oldest !== null && n.newest !== null) {
      lines.push(`  ${"".padEnd(36)} ${new Date(n.oldest).toISOString().slice(0, 10)} … ${new Date(n.newest).toISOString().slice(0, 10)}`);
    }
    if (n.new + n.changed + n.reparse > 0) {
      lines.push(`  ${"".padEnd(36)} brane absorb ${s.name} --dry-run`);
    }
  }
  if (probes.length > 0) {
    lines.push("");
    lines.push("Found, no extractor yet:");
    for (const s of probes) lines.push(`  ${s.label.padEnd(36)} ${s.path}`);
  }
  lines.push("");
  lines.push("Nothing was read or imported. An import reads the store and writes ~/.brane/brane.db; nothing leaves this machine.");
  return lines;
}

function nextSteps(provider: string): string[] {
  return [
    "",
    "Next:",
    `  brane meld                                      View in the app`,
    `  brane memory index                              Index for semantic search`,
    `  brane memory search "that thing we discussed"   Search your ${provider} history`,
  ];
}
