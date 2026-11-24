/**
 * Typing a revived agent's prompt into its pane, once the agent can take it.
 *
 * Revive used to type the prompt and Enter in one `send-keys`, on a fixed
 * 2 s timer. On a warm Mac the agent's UI is up by then. On a cold-booted
 * Fly machine it isn't (measured: boot revive after a wake), so the text
 * and the Enter sat in the tty's buffer and the agent read them as one
 * paste: the prompt landed in its input box and the Enter never submitted
 * it.
 *
 * Two changes. The wait ends when the agent's MCP bridge dials the daemon
 * (a spawned bridge dials at startup, `dialAtStartup` in src/mcp/server.ts),
 * which says the agent is running, plus a moment to settle, never sooner
 * than the old 2 s and never later than a ceiling, past which it types
 * anyway. And the Enter goes as its own key after a short gap, so it is a
 * keypress, not the tail of a paste.
 */

export const REVIVE_PROMPT_MIN_MS = 2_000;
export const REVIVE_PROMPT_SETTLE_MS = 1_500;
export const REVIVE_PROMPT_MAX_WAIT_MS = 60_000;
export const PROMPT_ENTER_GAP_MS = 300;

const waiters = new Map<string, Set<(connected: boolean) => void>>();

/** A bridge for `nid` connected: whoever waits on it may type now. */
export function bridgeConnected(nid: string): void {
  const set = waiters.get(nid);
  if (!set) return;
  waiters.delete(nid);
  for (const resolve of set) resolve(true);
}

/** Resolves true when `nid`'s bridge connects, false after `timeoutMs`. */
export function whenBridgeConnects(nid: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let set = waiters.get(nid);
    if (!set) waiters.set(nid, (set = new Set()));
    const done = (connected: boolean) => {
      clearTimeout(timer);
      set!.delete(done);
      if (set!.size === 0 && waiters.get(nid) === set) waiters.delete(nid);
      resolve(connected);
    };
    // Not unref'd: the daemon exits through process.exit, and an unref'd
    // ceiling would let a test's event loop drain before it fires.
    const timer = setTimeout(() => done(false), timeoutMs);
    set.add(done);
  });
}

/** How much longer to wait before typing, `elapsedMs` after the revive
 *  began: the old floor regardless, and after a connect the settle too. */
export function promptDelayMs(
  elapsedMs: number,
  connected: boolean,
  minMs = REVIVE_PROMPT_MIN_MS,
  settleMs = REVIVE_PROMPT_SETTLE_MS,
): number {
  const floor = Math.max(minMs - elapsedMs, 0);
  return connected ? Math.max(floor, settleMs) : floor;
}

export interface DeliverOptions {
  minMs?: number;
  settleMs?: number;
  maxWaitMs?: number;
  gapMs?: number;
  now?: () => number;
}

/** Wait for the agent, then type `prompt` and, separately, Enter.
 *  `sendKeys` runs `tmux send-keys` with these args; it may throw (the
 *  session ended meanwhile), which ends the delivery quietly. Call it
 *  before the agent can have connected: right after its session starts. */
export async function deliverRevivePrompt(
  nid: string,
  prompt: string,
  sendKeys: (args: string[]) => void,
  opts: DeliverOptions = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const started = now();
  const connected = await whenBridgeConnects(nid, opts.maxWaitMs ?? REVIVE_PROMPT_MAX_WAIT_MS);
  await pause(promptDelayMs(now() - started, connected, opts.minMs, opts.settleMs));
  try {
    sendKeys(["-t", nid, "-l", prompt]);
    await pause(opts.gapMs ?? PROMPT_ENTER_GAP_MS);
    sendKeys(["-t", nid, "Enter"]);
  } catch {
    return false;
  }
  return connected;
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
