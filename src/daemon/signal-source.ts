/**
 * Who a `human_signal` is from, decided by the token that sent it, never by
 * the request. Both ways in — `POST /api/narratives/:id/signal` and the
 * control socket's `signal` message — used to take `source` from the body,
 * so any token holder could write the operator's kind of event under any
 * label, and an agent's token could post "web" signals into any narrative.
 *
 * A signal is the operator speaking. A device token is the operator's
 * delegate (the app), and this account over `daemon.sock` is the operator's
 * shell; an agent token is neither. An agent that wants to speak into
 * another narrative narrates into it, which the daemon records as an
 * `agent_signal` stamped with the agent's own narrative.
 */

import type { TokenRecord } from "./token-ring.js";
import type { Proof } from "./verification-gate.js";

/** The `source` stamped on a signal sent with each kind of token. "web" is
 *  what the app always sent, so existing bubbles and new ones read alike. */
export const SIGNAL_SOURCES = { device: "web", local: "local" } as const;

export const AGENT_SIGNAL_REFUSAL =
  "An agent's token cannot send a human_signal; narrate into the narrative instead (it arrives as an agent_signal)";

/** The source to stamp, or the refusal to send. */
export function signalStanding(record: Pick<TokenRecord, "kind">): { source: string } | { refused: string } {
  if (record.kind === "agent") return { refused: AGENT_SIGNAL_REFUSAL };
  return { source: SIGNAL_SOURCES[record.kind] };
}

/** What a signal request may set on its event: everything but who it is
 *  from. Payloads are stored separately and passed in as their paths. */
export interface SignalEventFields {
  content?: string;
  source: string;
  re?: Array<number | string>;
  payloads?: string[];
  /** The proof that let a gated device speak (docs/passkeys.md, "The record"). */
  meta?: { verified: Proof };
}

/** The fields a `human_signal` is appended with, given the token's standing
 *  and the request (an HTTP body, or a control-socket message). `content`
 *  and `re` come from the request; `source` never does, whatever it says.
 *  `proof` is what the verification gate let the sender through on, from
 *  `VerificationGate.proof`, never from the request; it is recorded in the
 *  event's `meta` so the log says which credential spoke as the operator. */
export function signalEventFields(
  standing: { source: string },
  request: { content?: unknown; re?: unknown },
  payloads?: string[],
  proof?: Proof | null,
): SignalEventFields {
  return {
    content: request.content as string | undefined,
    source: standing.source,
    re: request.re as Array<number | string> | undefined,
    ...(payloads ? { payloads } : {}),
    ...(proof ? { meta: { verified: proof } } : {}),
  };
}
