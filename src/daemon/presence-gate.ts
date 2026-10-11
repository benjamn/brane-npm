/**
 * The presence gate: the few acts a process on this machine may not do on
 * its own say-so wait here for the operator to pass the OS's own prompt
 * (`src/presence.ts`). SECURITY.md, "Who the operator is": a process running
 * as this account is not the operator, and acts that reach off this machine
 * or cut the operator off are gated by the presence check.
 *
 * Gated acts, for this machine's shell (no token, over `daemon.sock`):
 *
 * - `meld`: minting a device token (`POST /api/tokens`), which extends reach
 *   off this machine;
 * - `meld-remote`: minting a device token for a daemon on another machine
 *   (`POST /api/tokens/remote`, `brane meld --remote`). This daemon stores
 *   nothing and could not stop a process that made its own token; what the
 *   gate holds is the sanctioned path, which then asks what `brane meld`
 *   asks;
 * - `revoke-device`: revoking a device token, which cuts the operator off a
 *   device — an agent loop could otherwise sign out their phone;
 * - `rotate`: signing out every other device (`POST /api/token/rotate`).
 *
 * A device token is the operator's delegate, minted by an operator act, and
 * is never prompted: the app's Meld sheet, Revoke and "Sign out other
 * devices" work as they always have. An agent's token is refused all three,
 * unasked (`gateStanding`). Who is asking is read from the token's kind,
 * never from the address — a device on this machine's browser is still a
 * device, and an agent is an agent over any transport.
 *
 * Less obvious than it looks:
 *
 * - **The prompt's words are fixed per act.** Nothing from a request reaches
 *   them, not even a device's label or user agent, which whoever minted it
 *   chose: an agent that could write the prompt could make it read like the
 *   one the operator expects ("Unlock 1Password").
 * - **One prompt at a time, and no queue.** A second gated request while one
 *   is up is refused at once (409). After a prompt that was not approved,
 *   further requests are refused for `cooldownMs` (429), so a loop cannot
 *   keep a dialog on screen until it is approved out of habit. A withdrawn
 *   prompt counts: give up and ask again is exactly that loop.
 * - **The asker can withdraw.** The route aborts the prompt when its client
 *   goes away (Ctrl-C on `brane meld`), so no dialog outlives its request.
 * - **A device can cancel; nothing can approve.** A remote approve would be
 *   a device minting a token, which the Meld sheet already does in the open.
 *   Only a device may cancel: anything on this machine that could cancel
 *   could cancel every prompt as it appeared, and with the cooldown keep
 *   `brane token rotate` from ever completing. The asker withdraws by
 *   disconnecting instead.
 */

import type { PresenceResult } from "../presence.js";
import type { TokenRecord } from "./token-ring.js";

export type GatedAct = "meld" | "meld-remote" | "revoke-device" | "rotate";

/** What the OS prompt says. macOS shows it as "osascript is trying to <it>",
 *  hence the lowercase verb phrase. */
export const PRESENCE_PROMPTS: Readonly<Record<GatedAct, string>> = {
  meld: "add a device to brane",
  "meld-remote": "add a device to brane on another machine",
  "revoke-device": "sign out a device from brane",
  rotate: "sign out every other device from brane",
};

/** How a caller holding `record` stands before a gated act: a device goes
 *  on, an agent is refused unasked, and anything else (this machine's shell)
 *  is asked. An agent that follows the rules therefore never puts a dialog
 *  in front of the operator — one that read like the operator's own
 *  `brane meld` would be approved out of habit. */
export function gateStanding(record: Pick<TokenRecord, "kind">): "pass" | "refuse" | "ask" {
  return record.kind === "device" ? "pass" : record.kind === "agent" ? "refuse" : "ask";
}

/** Whether a revoke of `id` (plus `also`) signs out a device, which is the
 *  gated part of revoking; stopping an agent is not. Unknown ids are not
 *  gated, so a request the route will refuse (404) never raises a prompt. */
export function revokeSignsOutDevice(
  store: { get(id: string): Pick<TokenRecord, "kind"> | null | undefined },
  ids: readonly string[],
): boolean {
  return ids.some((id) => store.get(id)?.kind === "device");
}

/** The prompt that is up right now, as pushed to every control socket. */
export interface PendingPresence {
  id: string;
  act: GatedAct;
  prompt: string;
  /** Who asked: `this machine (daemon.sock)`, … — for the log and the
   *  app's banner. */
  by: string;
  startedAt: number;
  expiresAt: number;
}

export type GateOutcome =
  | { ok: true }
  | {
      ok: false;
      status: 403 | 409 | 429;
      error: string;
      /** The presence result's reason, or `busy` / `cooldown` when no prompt
       *  was raised. */
      reason: Extract<PresenceResult, { ok: false }>["reason"] | "busy" | "cooldown" | "remote-cancel";
      retryAfterMs?: number;
    };

export type ConfirmPresence = (
  reason: string,
  opts: { timeoutMs: number; signal: AbortSignal },
) => Promise<PresenceResult>;

export interface PresenceGateOptions {
  confirm: ConfirmPresence;
  /** How long a gated request waits for an answer. */
  timeoutMs?: number;
  /** How long gated requests are refused after one that was not approved. */
  cooldownMs?: number;
  now?: () => number;
  newId?: () => string;
  /** Hears the pending prompt whenever it changes: an object while one is
   *  up, null when it closes. */
  onChange?: (pending: PendingPresence | null) => void;
  /** One line per attempt, whatever its outcome. */
  log?: (line: string) => void;
}

export const PRESENCE_TIMEOUT_MS = 45_000;
export const PRESENCE_COOLDOWN_MS = 15_000;

export class PresenceGate {
  private pending: (PendingPresence & { abort: AbortController; remoteCancel: boolean }) | null = null;
  private cooldownUntil = 0;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly opts: PresenceGateOptions) {
    this.timeoutMs = opts.timeoutMs ?? PRESENCE_TIMEOUT_MS;
    this.cooldownMs = opts.cooldownMs ?? PRESENCE_COOLDOWN_MS;
    this.now = opts.now ?? Date.now;
    let n = 0;
    this.newId = opts.newId ?? (() => `presence-${++n}`);
  }

  /** The prompt that is up, if any, without its handle. */
  current(): PendingPresence | null {
    if (!this.pending) return null;
    const { abort: _a, remoteCancel: _r, ...pending } = this.pending;
    return pending;
  }

  /** Ask the operator to approve `act` for `by`. Resolves once they answer,
   *  the prompt times out, it is canceled, or `signal` (the request's own
   *  lifetime) aborts. Never throws. */
  async check(act: GatedAct, by: string, signal?: AbortSignal): Promise<GateOutcome> {
    const prompt = PRESENCE_PROMPTS[act];
    const now = this.now();
    if (this.pending) {
      const up = this.pending;
      this.log(act, by, "refused: another prompt is up");
      // Name the prompt that is up and who raised it: its dialog may read
      // exactly like the one this caller expected, and approving it would
      // approve someone else's act.
      return {
        ok: false,
        status: 409,
        reason: "busy",
        error:
          `Another presence prompt is up ("${up.prompt}", asked by ${up.by}). ` +
          "If you did not start it, decline it at the machine or cancel it from a signed-in device, then try again",
      };
    }
    if (now < this.cooldownUntil) {
      const retryAfterMs = this.cooldownUntil - now;
      this.log(act, by, "refused: cooling down after a prompt that was not approved");
      return {
        ok: false,
        status: 429,
        reason: "cooldown",
        retryAfterMs,
        error: `A presence prompt was just declined, withdrawn or left unanswered; try again in ${Math.ceil(retryAfterMs / 1000)} s`,
      };
    }
    if (signal?.aborted) return { ok: false, status: 403, reason: "aborted", error: "The request was withdrawn" };

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const pending = {
      id: this.newId(),
      act,
      prompt,
      by,
      startedAt: now,
      expiresAt: now + this.timeoutMs,
      abort,
      remoteCancel: false,
    };
    this.pending = pending;
    this.opts.onChange?.(this.current());
    let result: PresenceResult;
    try {
      result = await this.opts.confirm(prompt, { timeoutMs: this.timeoutMs, signal: abort.signal });
    } catch (err) {
      result = { ok: false, method: null, reason: "failed", detail: err instanceof Error ? err.message : String(err) };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.pending = null;
      this.opts.onChange?.(null);
    }

    if (result.ok) {
      this.log(act, by, `approved (${result.method})`);
      return { ok: true };
    }
    const reason = pending.remoteCancel ? "remote-cancel" : result.reason;
    // After every prompt that was shown and not approved — a withdrawn one
    // too, or a loop could give up and ask again with no pause between
    // dialogs. Only `unavailable` showed nothing.
    if (reason !== "unavailable") this.cooldownUntil = this.now() + this.cooldownMs;
    this.log(act, by, `${reason}${result.detail ? `: ${result.detail}` : ""}`);
    return { ok: false, status: 403, reason, error: refusalMessage(reason, result.detail) };
  }

  /** Record an attempt refused without a prompt — an agent's token asking
   *  for an operator's act — so it leaves the same trace as one that was
   *  asked. An agent trying to add a device or sign out the operator's phone
   *  is the attempt most worth seeing. */
  refuse(act: GatedAct, by: string, why: string): void {
    this.log(act, by, `refused: ${why}`);
  }

  /** Close the prompt that is up. With `id`, only that prompt — so a stale
   *  Cancel tap cannot close a newer one. Returns whether one was closed.
   *  Who may call it is the route's to decide (`cancelPresenceRoute`). */
  cancel(id?: string): boolean {
    const p = this.pending;
    if (!p || (id !== undefined && id !== p.id)) return false;
    p.remoteCancel = true;
    p.abort.abort();
    return true;
  }

  private log(act: GatedAct, by: string, outcome: string): void {
    this.opts.log?.(`[presence] ${act} for ${by}: ${outcome}`);
  }
}

function refusalMessage(reason: string, detail?: string): string {
  switch (reason) {
    case "canceled":
      return "The presence prompt was declined at this machine";
    case "remote-cancel":
      return "The presence prompt was canceled from a signed-in device";
    case "timeout":
      return "Nobody answered the presence prompt in time";
    case "aborted":
      return "The request was withdrawn";
    case "unavailable":
      return `This machine cannot show a presence prompt${detail ? ` (${detail})` : ""}; this needs the operator at a machine that can, or a signed-in device`;
    default:
      return `The presence check failed${detail ? `: ${detail}` : ""}`;
  }
}
