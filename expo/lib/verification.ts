/**
 * The lock sheet's store (docs/passkeys.md, "The hop"): what the app does
 * when the daemon's verification gate refuses this device.
 *
 * A refusal — a `403 { verification }` from any request, or a `verify` frame
 * from a socket — opens the sheet. The sheet asks for an approval at once,
 * so that the Verify tap can open the ceremony page *synchronously*:
 * `window.open` after an await is a popup the browser blocks
 * (`expo/lib/appHost.ts`). The page runs on the daemon's own origin, the
 * only one its passkeys answer on, so the hosted shell and the daemon's own
 * bundle hop alike. The sheet closes when the proof lands: the daemon's
 * `verified` frame on this device's control socket, or, when the app comes
 * back to the foreground, a status that says so. Every request that waited
 * on it then goes again, once (`expo/lib/api.ts`).
 *
 * Outside React, like the selection store: requests and sockets reach it
 * from anywhere, and only the sheet itself re-renders.
 */

import { useSyncExternalStore } from "react";
import { beginCeremony, endVerification, fetchStatus, setVerificationListener, type ConnectionParams } from "./api";
import { setTerminalVerifyHandler } from "./terminal";
import { noCredentialCanVerify, sameTabHopUrl, shouldEndOnHide, verifiedPerStatus, type StatusVerification, type VerificationKind } from "@shared/verification-hop";

export type LockPhase = "closed" | "preparing" | "ready" | "hopping" | "error";

export interface LockState {
  phase: LockPhase;
  kind: VerificationKind | null;
  host: string | null;
  error: string | null;
  /** Set when no credential can verify on this daemon (every one orphaned
   *  by a rename, or the last revoked): the sheet says so instead of
   *  offering Verify, and the way out is the shell. */
  lockedOut: string | null;
}

const CLOSED: LockState = { phase: "closed", kind: null, host: null, error: null, lockedOut: null };

let state: LockState = CLOSED;
let conn: ConnectionParams | null = null;
let url: string | null = null;
let waiters: Array<(ok: boolean) => void> = [];
const listeners = new Set<() => void>();

/** What the app knows of the active daemon's gate: its mode, this
 *  device's window, and whether any credential can verify there, from
 *  `/api/status` and `verified` frames. */
let active: { conn: ConnectionParams; mode: string | null; verifiedUntil: number | null; lockedOut: string | null } | null = null;

function set(next: Partial<LockState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function settle(ok: boolean): void {
  const w = waiters;
  waiters = [];
  url = null;
  conn = null;
  state = CLOSED;
  for (const l of listeners) l();
  for (const resolve of w) resolve(ok);
}

const sameConn = (a: ConnectionParams | null, b: ConnectionParams | null) => !!a && !!b && a.host === b.host && a.token === b.token;

/** Fetch the approval the next tap will use; with nothing that could
 *  answer it, say so instead. */
function prepare(): void {
  const c = conn;
  if (!c) return;
  url = null;
  const lockedOut = active && sameConn(active.conn, c) ? active.lockedOut : null;
  if (lockedOut) {
    set({ phase: "preparing", error: null, lockedOut });
    return;
  }
  set({ lockedOut: null });
  set({ phase: "preparing", error: null });
  beginCeremony(c, "verify").then(
    (r) => {
      if (!sameConn(conn, c)) return;
      url = r.url;
      set({ phase: "ready" });
    },
    (err: unknown) => {
      if (!sameConn(conn, c)) return;
      set({ phase: "error", error: err instanceof Error ? err.message : String(err) });
    },
  );
}

/** The gate refused `c`: open the sheet (or join the one open) and resolve
 *  once this device is verified (true) or the operator dismisses it
 *  (false). */
export function requireVerification(c: ConnectionParams, kind: VerificationKind): Promise<boolean> {
  return new Promise((resolve) => {
    if (state.phase !== "closed" && !sameConn(conn, c)) {
      // Another daemon's sheet is up: this one waits its turn by failing now.
      resolve(false);
      return;
    }
    waiters.push(resolve);
    if (state.phase === "closed") {
      conn = c;
      set({ kind, host: c.host });
      prepare();
    } else if (kind === "fresh" && state.kind !== "fresh") {
      set({ kind });
    }
  });
}

/** The Verify tap: open the ceremony page, synchronously. Where no window
 *  can be opened (a blocked popup), the hop goes in this same tab, and the
 *  page offers the way back. */
export function hop(): void {
  if (!url || state.phase !== "ready") return;
  const target = url;
  set({ phase: "hopping" });
  const w = window.open(target, "_blank");
  if (w) {
    // The page needs nothing from this one.
    try {
      w.opener = null;
    } catch {}
    return;
  }
  window.location.assign(sameTabHopUrl(target, window.location.href));
}

/** "Not now": the refused requests fail as they would have. */
export function dismiss(): void {
  settle(false);
}

/** Another try after the page was cancelled or an approval was spent. */
export function retry(): void {
  if (conn) prepare();
}

/** The daemon says this device is verified until `until`: from a `verified`
 *  frame, or a status. Closes the sheet for that daemon. */
export function noteVerified(c: ConnectionParams, until: number | null): void {
  if (active && sameConn(active.conn, c)) active = { ...active, verifiedUntil: until };
  if (until !== null && until > Date.now() && state.phase !== "closed" && sameConn(conn, c)) settle(true);
}

/** The active daemon changed, or its status arrived. */
export function noteStatus(c: ConnectionParams, verification: StatusVerification | undefined): void {
  const lockedOut = noCredentialCanVerify(verification);
  active = { conn: c, mode: verification?.mode ?? null, verifiedUntil: verification?.verified_until ?? null, lockedOut };
  if (verifiedPerStatus({ verification }, Date.now()) && state.phase !== "closed" && sameConn(conn, c)) settle(true);
  // The sheet is up and what it can offer changed: a credential arrived for
  // this host, or the last one went.
  else if (state.phase !== "closed" && state.phase !== "hopping" && sameConn(conn, c) && (state.lockedOut !== null) !== (lockedOut !== null)) prepare();
}

/** Read the active daemon's posture; a hop that landed while the app was
 *  away shows here. */
export function refreshStatus(c: ConnectionParams): void {
  fetchStatus(c).then(
    (status: { verification?: StatusVerification }) => noteStatus(c, status.verification),
    () => {},
  );
}

function onVisibility(): void {
  const now = Date.now();
  if (document.visibilityState === "hidden") {
    if (active && shouldEndOnHide({ mode: active.mode, verifiedUntil: active.verifiedUntil, hopping: state.phase === "hopping", now })) {
      endVerification(active.conn);
      active = { ...active, verifiedUntil: null };
    }
    return;
  }
  // Back from the ceremony page (or from anywhere): did a proof land?
  if (state.phase === "hopping" && conn) {
    const c = conn;
    fetchStatus(c).then(
      (status: { verification?: StatusVerification }) => {
        noteStatus(c, status.verification);
        // Still not verified: the page was cancelled, or is still open. Get
        // a fresh approval for the next tap.
        if (state.phase === "hopping" && sameConn(conn, c)) prepare();
      },
      () => {
        if (state.phase === "hopping" && sameConn(conn, c)) prepare();
      },
    );
  }
}

let installed = false;
/** Wire the store to the request layer and the page's visibility. Once. */
export function installVerification(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  setVerificationListener(requireVerification);
  setTerminalVerifyHandler((c, kind) => void requireVerification(c, kind));
  document.addEventListener("visibilitychange", onVisibility);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const get = () => state;

export function useLockState(): LockState {
  return useSyncExternalStore(subscribe, get, get);
}
