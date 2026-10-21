/**
 * The credential routes' decisions, out of the server's closure so the suite
 * drives them: the presence check an unattested enrollment waits on, and
 * revoking a credential. The ceremonies themselves are
 * `verification-ceremony.ts`.
 */

import type { DbCredentialStore } from "../db/credentials.js";
import type { RouteAnswer } from "./gated-routes.js";
import type { PresenceGate } from "./presence-gate.js";
import type { TokenRecord } from "./token-ring.js";

/** Ask the operator at this machine to approve an enrollment from `device`.
 *  Unlike the shell's acts, a device is asked too: this is the one prompt a
 *  device token raises, because a software authenticator can claim "user
 *  verified" with nobody there (docs/passkeys.md, decision 14). The prompt's
 *  words are fixed; `device` reaches only the log and the app's banner. */
export async function askEnrollPresence(
  gate: Pick<PresenceGate, "check">,
  device: string,
  signal?: AbortSignal,
): Promise<RouteAnswer<{ error: string; presence: string }> | null> {
  const outcome = await gate.check("enroll", `device "${device}"`, signal);
  if (outcome.ok) return null;
  return {
    status: outcome.status,
    body: { error: outcome.error, presence: outcome.reason },
    ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
  };
}

/** `POST /api/credentials/:id/revoke`: a device (through the gate's
 *  fresh-class act) or this machine's shell. An agent never reaches it
 *  (`AGENT_ROUTES`), and is refused here as well. */
export function revokeCredentialRoute(
  store: Pick<DbCredentialStore, "revoke">,
  requester: Pick<TokenRecord, "kind">,
  id: string,
  now: number = Date.now(),
): RouteAnswer<{ revoked: string } | { error: string }> {
  if (requester.kind === "agent") return { status: 403, body: { error: "An agent cannot revoke a credential" } };
  if (!store.revoke(id, now)) return { status: 404, body: { error: `No live credential ${id}` } };
  return { status: 200, body: { revoked: id } };
}
