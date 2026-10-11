/**
 * What the daemon and the app agree on about token rotation, window-free so
 * both can import it. The mechanism itself lives in `src/daemon/token-ring.ts`.
 */

/** WebSocket close code the daemon sends to a viewer socket it is signing out
 *  because the token it authenticated with has been retired. A client that
 *  sees it must stop reconnecting — the credential it holds is dead, and a
 *  2 s retry loop against a 401 would run forever and silently. Anything
 *  else (1006 above all) is a network blip and reconnects as before. */
export const WS_CLOSE_TOKEN_ROTATED = 4401;

export function isSignedOutClose(code: number | undefined): boolean {
  return code === WS_CLOSE_TOKEN_ROTATED;
}
