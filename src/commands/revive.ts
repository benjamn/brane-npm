import { defineCommand } from "citty";
import { resolveDaemonEndpoint, daemonRequest, warnIfVersionMismatch } from "../daemon/client.js";

/** What `POST /api/revive/:nid` hands back.
 *
 *  `nid` is *not* always the id that was asked for: reviving an absorbed
 *  narrative, or reviving with a different `--agent`, spawns a twin that
 *  continues from it — a new narrative, reported as `continued`.
 *
 *  `agent` is optional because a daemon older than this CLI won't send it;
 *  that degrades to a slightly quieter line rather than an error. */
interface ReviveResult {
  status: "revived" | "already_running" | "continued";
  nid: string;
  agent?: string;
}

export const reviveCommand = defineCommand({
  meta: {
    name: "revive",
    description: "Restart a dead agent session",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Session/narrative ID to revive",
    },
    prompt: {
      type: "string",
      description: "Custom prompt to inject after revival",
    },
    "no-prompt": {
      type: "boolean",
      description: "Suppress the initial prompt",
    },
    agent: {
      type: "string",
      description: "Continue under a different agent (spawns a twin of this narrative)",
    },
  },
  async run({ args }) {
    try {
      // Reviving goes through the daemon, exactly as the web app's revive menu
      // item and the `revive` MCP tool do — `POST /api/revive/:nid` is the
      // single revive path, and the CLI is one of its clients rather than a
      // second implementation. Everything below this call is printing.
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      const result = await daemonRequest<ReviveResult>(
        endpoint,
        `/api/revive/${encodeURIComponent(args.id)}`,
        { method: "POST", body: buildReviveBody(args) },
      );

      console.log(formatReviveResult(args.id, result));
      if (result.status === "already_running" && args.prompt && !args["no-prompt"]) {
        console.log(`Sent prompt to ${result.nid}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

/** Map CLI flags onto the `POST /api/revive/:nid` payload. Absent flags are
 *  omitted rather than sent as `undefined`/`false`, so the daemon's own
 *  defaults stay in charge of anything the operator didn't ask about. */
export function buildReviveBody(args: {
  prompt?: string;
  "no-prompt"?: boolean;
  agent?: string;
}): Record<string, unknown> {
  return {
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args["no-prompt"] ? { no_prompt: true } : {}),
    ...(args.agent ? { agent: args.agent } : {}),
  };
}

/** The one line `brane revive` prints for each outcome. Split out so the
 *  three-way distinction — which the old in-process CLI could not make at all
 *  — is testable without a daemon. */
export function formatReviveResult(requestedNid: string, result: ReviveResult): string {
  const suffix = result.agent ? ` (${result.agent})` : "";
  switch (result.status) {
    case "already_running":
      return `Session ${result.nid} is already running.`;
    case "continued":
      // A twin: `result.nid` is a *new* narrative that reads the requested
      // one's history. Printing the requested id here would name a pane that
      // isn't the one now running.
      return `Continued ${requestedNid} as ${result.nid}${suffix}`;
    default:
      return `Revived ${result.nid}${suffix}`;
  }
}
