import { defineCommand } from "citty";
import {
  resolveDaemonEndpoint,
  daemonRequest,
  warnIfVersionMismatch,
  type DaemonEndpoint,
} from "../daemon/client.js";
import { announcePresenceWait } from "./meld.js";
import { originHost } from "../shared/app-origin.js";
import { proofName } from "../shared/verification-hop.js";

/** What `POST /api/token/rotate` answers this shell. */
export interface RotateResponse {
  /** How many devices were signed out. */
  signed_out: number;
  /** A rotation a device began was still pending and has just been voided by
   *  this one. Worth a look: a double-tap in the app, or a holder of a device
   *  token trying to get in ahead of you. */
  replaced: boolean;
}

/** Sign out every device. One request: this shell holds no token, so there
 *  is none to swap and nothing to confirm — once the operator passes the
 *  presence prompt the daemon revokes every device token before it answers
 *  (`signOutDevices`, src/daemon/token-ring.ts). A device's rotation is the
 *  two-step one (docs/token-rotation.md); an answer in that shape means the
 *  daemon is older than this CLI, and is reported rather than taken for a
 *  sign-out that did not happen. */
export async function rotateDaemonToken(endpoint: DaemonEndpoint): Promise<RotateResponse> {
  announcePresenceWait();
  const rotation = await daemonRequest<Partial<RotateResponse>>(endpoint, "/api/token/rotate", {
    method: "POST",
  });
  if (typeof rotation.signed_out !== "number") {
    throw new Error(
      "The daemon answered as an older brane does, and nobody was signed out; run `brane daemon restart` and try again",
    );
  }
  return { signed_out: rotation.signed_out, replaced: rotation.replaced === true };
}

export function formatRotateResult(rotation: RotateResponse): string {
  const n = rotation.signed_out;
  return [
    `Signed out ${n === 0 ? "no devices (none were signed in)" : n === 1 ? "1 device" : `${n} devices`}` +
      `${rotation.replaced ? " (a rotation a device began and never confirmed was pending; it is now void)" : ""}.`,
    "This shell and running agents are unaffected.",
    "Re-admit a device with `brane meld`.",
  ].join("\n");
}

const rotateCommand = defineCommand({
  meta: {
    name: "rotate",
    description: "Sign out every web client (device); this shell and running agents are unaffected",
  },
  async run() {
    try {
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      console.log(formatRotateResult(await rotateDaemonToken(endpoint)));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

/** One row of `GET /api/tokens` (`DeviceListing` in src/daemon/token-routes.ts). */
export interface TokenListRow {
  id: string;
  kind: "local" | "device" | "agent";
  owner_nid?: string | null;
  label: string;
  origin: "minted" | "adopted";
  created_at: number;
  last_used_at: number | null;
  device: string | null;
  remote_addr: string | null;
  last_device?: string | null;
  last_remote_addr?: string | null;
  app_origin?: string | null;
  last_app_origin?: string | null;
  elsewhere_at?: number | null;
  minted_by_device?: string | null;
  current: boolean;
  connected?: boolean;
  descendants?: string[];
  agents?: Array<{ id: string; status: string | null }>;
  unused: boolean;
  expires_at: number | null;
  /** The last proof of the operator on a device (docs/passkeys.md). */
  verified?: { at: number; until: number | null; by: string; by_id: string; method: string } | null;
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

/** The line that stands in for the agents' blocks. */
export function agentTokensLine(count: number): string {
  return count === 1
    ? "1 agent token (brane token list --agents to show it)"
    : `${count} agent tokens (brane token list --agents to show them)`;
}

/** The Devices list as text: one block per token, the id first so it can be
 *  pasted into `brane token revoke`. Agents' tokens are one per narrative
 *  session, so on a busy daemon they outnumber the devices several times
 *  over and bury them; unless `showAgents`, they are folded into one closing
 *  line. An agent's token seen from a second address is a finding, not
 *  routine, and keeps its block either way. */
export function formatTokenList(tokens: TokenListRow[], gated = false, showAgents = false): string {
  if (tokens.length === 0) return "No live tokens.";
  const folded = showAgents ? [] : tokens.filter((t) => t.kind === "agent" && t.elsewhere_at == null);
  const blocks = tokens
    .filter((t) => !folded.includes(t))
    .map((t) => {
      const name =
        t.kind === "local" ? "this machine (CLI)" : t.kind === "agent" ? `agent ${t.owner_nid ?? t.label}` : t.device ?? "unknown device";
      const marks = [
        t.current ? "this request" : null,
        t.origin === "adopted" ? "adopted from before hashing" : null,
        t.unused && t.expires_at !== null ? `unscanned, lapses ${formatTime(t.expires_at)}` : null,
      ].filter(Boolean);
      const seen = t.connected
        ? "connected now"
        : t.last_used_at !== null
          ? `last seen ${formatTime(t.last_used_at)}`
          : "never used";
      const lines = [
        `${t.id}  ${name}${marks.length ? ` [${marks.join("; ")}]` : ""}`,
        `    "${t.label}", created ${formatTime(t.created_at)}${t.minted_by_device ? ` by ${t.minted_by_device}` : ""}, ${seen}${t.remote_addr ? `, from ${t.remote_addr}` : ""}${t.app_origin ? `, via ${originHost(t.app_origin)}` : ""}`,
      ];
      if (t.verified) {
        const v = t.verified;
        lines.push(`    verified ${formatTime(v.at)} with ${proofName(v)} (${v.method})${v.until !== null ? `, until ${formatTime(v.until)}` : ", window ended"}`);
      } else if (gated && t.kind === "device" && !t.unused) {
        lines.push("    never verified");
      }
      if (t.descendants?.length) lines.push(`    added ${t.descendants.length} device(s): ${t.descendants.join(", ")} (revoke --cascade takes them too)`);
      const running = (t.agents ?? []).filter((a) => a.status !== "ended");
      if (running.length) lines.push(`    started ${running.length} running agent(s): ${running.map((a) => a.id).join(", ")}`);
      if (t.elsewhere_at != null) {
        const where = [t.last_device, t.last_remote_addr].filter(Boolean).join(" at ");
        lines.push(`    ! also used from another address${where ? ` (latest: ${where})` : ""}, ${formatTime(t.elsewhere_at)}`);
      }
      return lines.join("\n");
    });
  if (folded.length > 0) blocks.push(agentTokensLine(folded.length));
  return blocks.join("\n");
}

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List the daemon's live tokens: this machine's, one per melded device, and how many agents hold one",
  },
  args: {
    agents: { type: "boolean", description: "Also list each agent session's token, not only how many there are", default: false },
  },
  async run({ args }) {
    try {
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      const { tokens, gated } = await daemonRequest<{ tokens: TokenListRow[]; gated?: boolean }>(endpoint, "/api/tokens");
      console.log(formatTokenList(tokens, gated ?? false, args.agents));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

const revokeCommand = defineCommand({
  meta: {
    name: "revoke",
    description: "Sign out one melded device (ids from `brane token list`)",
  },
  args: {
    id: { type: "positional", description: "Token id", required: true },
    cascade: {
      type: "boolean",
      description: "Also revoke every device it added (see `brane token list`)",
      default: false,
    },
  },
  async run({ args }) {
    try {
      const endpoint = await resolveDaemonEndpoint();
      warnIfVersionMismatch(endpoint);
      const id = String(args.id);
      // Read first: what it is (an agent's revoke reads differently) and,
      // with --cascade, what it added. Revoked rows aren't listed afterwards.
      const { tokens } = await daemonRequest<{ tokens: TokenListRow[] }>(endpoint, "/api/tokens");
      const target = tokens.find((t) => t.id === id);
      const also = args.cascade ? target?.descendants ?? [] : [];
      const query = also.length ? `?also=${also.map(encodeURIComponent).join(",")}` : "";
      // Signing out a device waits for the operator; stopping an agent doesn't.
      if (target?.kind === "device" || also.length) announcePresenceWait();
      const { label } = await daemonRequest<{ revoked: string; label: string; also?: string[] }>(
        endpoint,
        `/api/tokens/${encodeURIComponent(id)}/revoke${query}`,
        { method: "POST" },
      );
      console.log(
        `Revoked "${label}"${also.length ? ` and ${also.length} token(s) it added` : ""}. ` +
          (target?.kind === "agent"
            ? "That agent's brane tools stop; end its session and revive it to bring it back."
            : "That device is signed out until it scans a fresh Meld QR."),
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

export const tokenCommand = defineCommand({
  meta: {
    name: "token",
    description: "Manage the daemon's bearer tokens",
  },
  subCommands: {
    list: listCommand,
    revoke: revokeCommand,
    rotate: rotateCommand,
  },
});
