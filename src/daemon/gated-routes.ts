/**
 * The four routes the presence gate holds, and its cancel route, as
 * functions of the gate, the token ring and store, and who is asking — out
 * of the server's closure so the suite can drive them
 * (`src/test/presence-gate.test.ts`). The server keeps what is about its
 * sockets: logging, and closing what a revoke signed out.
 *
 * Each one checks what it would refuse anyway, then asks, then acts — and
 * the act re-checks, since rows can change while a prompt is up.
 */

import { gateStanding, revokeSignsOutDevice, type GatedAct, type PresenceGate } from "./presence-gate.js";
import type { DbTokenStore } from "../db/tokens.js";
import { mintRemoteToken, type TokenRecord, type TokenRing } from "./token-ring.js";
import { mintDeviceTokenRoute, parseMintBody, planRevoke, revokeTokenRoute } from "./token-routes.js";

/** A route's answer: status, JSON body, and `Retry-After` when cooling down. */
export interface RouteAnswer<B = unknown> {
  status: number;
  body: B;
  retryAfterMs?: number;
}

/** Who is asking: their row, and how the log and the banner name them. */
export interface Caller {
  record: TokenRecord;
  by: string;
}

/** What an agent is told for each gated act: it is the operator's to do. */
const AGENT_REFUSALS: Readonly<Record<GatedAct, string>> = {
  meld:
    "An agent cannot add a device (spawn without --meld). The operator melds from a shell outside an agent session, or from the app's Meld sheet",
  "meld-remote": "An agent cannot add a device to a remote daemon; the operator runs `brane meld --remote` from a shell outside an agent session",
  "revoke-device": "An agent cannot sign out a device; the operator does, from a shell outside an agent session or from the app",
  rotate: "An agent's token is replaced by reviving its narrative, not rotated",
  enroll: "An agent cannot enroll a credential; the operator does, from a signed-in device",
};

/** Null when `caller` may go on — a device, or a prompt approved — else the
 *  refusal to send: an agent's at once, the shell's once the prompt says no. */
export async function askPresence(
  gate: Pick<PresenceGate, "check" | "refuse">,
  act: GatedAct,
  caller: Caller,
  signal?: AbortSignal,
): Promise<RouteAnswer<{ error: string; presence: string }> | null> {
  const standing = gateStanding(caller.record);
  if (standing === "pass") return null;
  if (standing === "refuse") {
    gate.refuse(act, caller.by, "an agent's token");
    return { status: 403, body: { error: AGENT_REFUSALS[act], presence: "agent" } };
  }
  const outcome = await gate.check(act, caller.by, signal);
  if (outcome.ok) return null;
  return {
    status: outcome.status,
    body: { error: outcome.error, presence: outcome.reason },
    ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
  };
}

/** `POST /api/tokens`, gated. A body the mint would refuse is refused before
 *  anyone is asked. */
export async function gatedMintRoute(
  deps: { gate: Pick<PresenceGate, "check" | "refuse">; ring: TokenRing },
  caller: Caller,
  rawBody: string | null | undefined,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<RouteAnswer> {
  const parsed = parseMintBody(rawBody, now());
  if ("error" in parsed) return { status: 400, body: parsed };
  const refused = await askPresence(deps.gate, "meld", caller, signal);
  if (refused) return refused;
  return mintDeviceTokenRoute(deps.ring, rawBody, now(), caller.record);
}

/** `POST /api/tokens/remote`, gated: a device token for a daemon on another
 *  machine, and its hash, for `brane meld --remote`. Nothing is stored here,
 *  so the 200 is the only copy of either. */
export async function gatedRemoteMintRoute(
  deps: { gate: Pick<PresenceGate, "check" | "refuse">; mint?: () => { token: string; hash: string } },
  caller: Caller,
  signal?: AbortSignal,
): Promise<RouteAnswer> {
  const refused = await askPresence(deps.gate, "meld-remote", caller, signal);
  if (refused) return refused;
  return { status: 200, body: (deps.mint ?? mintRemoteToken)() };
}

/** `POST /api/tokens/:id/revoke`, gated when it signs out a device; stopping
 *  an agent is not. Refusals the revoke would give come back unasked, and
 *  the revoke runs its own checks again after the prompt. */
export async function gatedRevokeRoute(
  deps: {
    gate: Pick<PresenceGate, "check" | "refuse">;
    ring: Pick<TokenRing, "abandonRotationBy">;
    store: Pick<DbTokenStore, "get" | "revoke" | "descendants" | "externalsOf">;
  },
  caller: Caller,
  id: string,
  also: readonly string[],
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<RouteAnswer & { revoked?: ReturnType<typeof revokeTokenRoute> }> {
  const plan = planRevoke(deps.store, caller.record, id, also);
  if ("status" in plan) return plan;
  if (revokeSignsOutDevice(deps.store, plan.ids)) {
    const refused = await askPresence(deps.gate, "revoke-device", caller, signal);
    if (refused) return refused;
  }
  const revoked = revokeTokenRoute(deps.store, deps.ring, caller.record, id, now(), also);
  return { status: revoked.status, body: revoked.body, revoked };
}

/** `POST /api/token/rotate`, gated. An agent's token is bound to its
 *  narrative and replaced by reviving it, so agents get 403 unasked, as on
 *  every gated act. The
 *  prompt comes before `beginRotation`: a second begin replaces a pending
 *  rotation, so a refused request must never reach it, or a loop could void
 *  the operator's own rotation without passing a prompt.
 *
 *  A device begins a rotation and completes it by presenting the token this
 *  returns. This account (the shell, over `daemon.sock`) holds no token to
 *  swap, so for it the devices are signed out here, in this one request,
 *  and the answer is `{ signed_out }` with no token in it. */
export async function gatedRotateRoute(
  deps: { gate: Pick<PresenceGate, "check" | "refuse">; ring: Pick<TokenRing, "beginRotation" | "signOutDevices"> },
  caller: Caller,
  signal?: AbortSignal,
): Promise<
  RouteAnswer & {
    rotation?: ReturnType<TokenRing["beginRotation"]>;
    signedOut?: ReturnType<TokenRing["signOutDevices"]>;
  }
> {
  const refused = await askPresence(deps.gate, "rotate", caller, signal);
  if (refused) return refused;
  if (caller.record.kind === "local") {
    const signedOut = deps.ring.signOutDevices(caller.record);
    return { status: 200, body: { signed_out: signedOut.devices, replaced: signedOut.replaced }, signedOut };
  }
  const rotation = deps.ring.beginRotation(caller.record);
  return {
    status: 200,
    body: { token: rotation.token, expires_at: rotation.expiresAt, replaced: rotation.replaced },
    rotation,
  };
}

/** `POST /api/presence/cancel?id=`: close the prompt that is up. Only a
 *  device may: it is how the operator, away from the machine, says "that one
 *  is not mine". Anything on this machine that could cancel could cancel
 *  every prompt as it appeared, and with the cooldown keep `brane token
 *  rotate` from ever completing; the asker withdraws by disconnecting. */
export function cancelPresenceRoute(
  gate: Pick<PresenceGate, "cancel">,
  record: TokenRecord,
  id: string | undefined,
): RouteAnswer<{ canceled: boolean } | { error: string }> {
  if (record.kind !== "device") {
    return { status: 403, body: { error: "Only a signed-in device can cancel a presence prompt" } };
  }
  return { status: 200, body: { canceled: gate.cancel(id) } };
}
