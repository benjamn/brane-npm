/**
 * Terminal mirroring WebSocket channel.
 *
 * Connects to ws://{host}/ws/terminal/{nid}?token={token} and streams
 * tmux output from the daemon. Sends keyboard input back as tmux key names.
 */

import type { ConnectionParams } from "./api";
import { isSignedOutClose } from "@shared/token-rotation";

/**
 * Where tmux says the cursor is, in the frame's own coordinates: `line` indexes
 * the lines of the frame content (scrollback included), `col` the column within
 * it. `null` means the pane has hidden its cursor and the client must not draw
 * one — see the daemon's TERMINAL_STATUS_FORMAT.
 */
export interface TerminalCursor {
  line: number;
  col: number;
}

export type TerminalFrame =
  | { type: "frame"; data: string; totalLines: number; alternate_on?: boolean; cursor?: TerminalCursor | null }
  | { type: "append"; data: string; lineOffset: number; totalLines: number; alternate_on?: boolean; cursor?: TerminalCursor | null }
  | { type: "terminated" };

/**
 * A cursor that moved without the pane's text changing — walking an arrow key
 * along a shell input line repaints nothing at all. It arrives on its own so
 * the block tracks the caret even when no frame is due.
 */
export interface TerminalCursorMessage {
  type: "cursor";
  cursor: TerminalCursor | null;
}

interface TerminalChannelOptions {
  conn: ConnectionParams;
  nid: string;
  onFrame: (frame: TerminalFrame) => void;
  onCursor?: (cursor: TerminalCursor | null) => void;
  onTerminated?: () => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export function createTerminalChannel(opts: TerminalChannelOptions) {
  const { conn, nid, onFrame, onCursor, onTerminated, onConnect, onDisconnect } = opts;
  const wsProtocol =
    typeof window !== "undefined" && window.location.protocol === "https:"
      ? "wss"
      : "ws";
  const url = `${wsProtocol}://${conn.host}/ws/terminal/${nid}?token=${conn.token}`;

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let started = false;
  let pendingResize: { cols: number; rows: number } | null = null;

  function connect() {
    if (closed) return;

    ws = new WebSocket(url);

    ws.onopen = () => {
      onConnect?.();
      if (started) {
        ws!.send(JSON.stringify({ type: "start" }));
      }
      // Send pending resize immediately on connect
      if (pendingResize) {
        ws!.send(JSON.stringify({ type: "resize", ...pendingResize }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as TerminalFrame | TerminalCursorMessage;
        if (msg.type === "terminated") {
          onTerminated?.();
        } else if (msg.type === "cursor") {
          onCursor?.(msg.cursor ?? null);
        } else if (msg.type === "frame" || msg.type === "append") {
          onFrame(msg);
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = (event) => {
      onDisconnect?.();
      if (closed) return;
      // Signed out by a token rotation: the credential is dead, so stop. The
      // control channel owns telling the app; a pane just goes quiet until
      // its screen hands it a new `conn`.
      if (isSignedOutClose(event.code)) {
        closed = true;
        return;
      }
      reconnectTimer = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  function start() {
    started = true;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "start" }));
    }
  }

  function stop() {
    started = false;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    }
  }

  function resize(cols: number, rows: number) {
    pendingResize = { cols, rows };
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }

  /**
   * `repeat` asks tmux to deliver the same key that many times (`send-keys
   * -N`), which is how a tap turns into a run of arrows without becoming a
   * run of round trips.
   */
  function sendKeys(keys: string, repeat?: number) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "keys", keys, ...(repeat && repeat > 1 ? { repeat } : {}) }));
    }
  }

  /**
   * Send pasted text. Deliberately not sendKeys: the daemon routes this through
   * a tmux buffer so the receiving application sees a bracketed paste rather
   * than a burst of typing (and forty newlines don't become forty submits).
   */
  function sendPaste(text: string) {
    if (!text) return;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "paste", text }));
    }
  }

  function sendMouse(x: number, y: number, button = 0, action = "click") {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "mouse", x, y, button, action }));
    }
  }

  function refresh() {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "refresh" }));
    }
  }

  function close() {
    closed = true;
    started = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  }

  connect();

  return { start, stop, resize, sendKeys, sendPaste, sendMouse, close, refresh };
}

/**
 * When each ^C of an interrupt lands, in ms from the first.
 *
 * One SIGINT often isn't enough — a program may be mid-prompt, ignore the
 * first, or spawn a child that needs its own interrupt — so we give it a
 * couple more chances with a beat between each.
 */
const INTERRUPT_DELAYS_MS = [0, 150, 300];

/** Fire the interrupt sequence down an already-open channel's `sendKeys`. */
export function sendInterrupt(sendKeys: (keys: string) => void): void {
  for (const delay of INTERRUPT_DELAYS_MS) {
    if (delay === 0) sendKeys("C-c");
    else setTimeout(() => sendKeys("C-c"), delay);
  }
}

/** How long a one-shot interrupt channel may spend trying to connect before it
 *  gives up. The channel reconnects every 2s on its own, so without a deadline
 *  an unreachable daemon or a rejected token would have it retrying forever
 *  with nobody holding a handle to stop it. */
const INTERRUPT_CONNECT_DEADLINE_MS = 10_000;

/**
 * Interrupt a session from a screen that has no terminal pane mounted — the
 * narrative list's status menu. Opens the channel purely to write to it: it is
 * never `start()`ed, so the daemon streams no frames, and because it never
 * sends a `resize` either, `fitWindowToViewers` skips it — a one-shot writer
 * cannot shrink the tmux window out from under the agent's real viewers.
 *
 * Keys can only go out once the socket is open, so the sequence is fired from
 * `onConnect` rather than immediately; the channel closes a beat after the last
 * one. `fired` guards the reconnect path from re-sending the interrupt if the
 * socket flaps mid-sequence, and the deadline covers the case where it never
 * opens at all.
 */
export function interruptSession(conn: ConnectionParams, nid: string): void {
  let fired = false;
  const channel = createTerminalChannel({
    conn,
    nid,
    onFrame: () => {},
    onConnect: () => {
      if (fired) return;
      fired = true;
      clearTimeout(deadline);
      sendInterrupt(channel.sendKeys);
      setTimeout(() => channel.close(), INTERRUPT_DELAYS_MS[INTERRUPT_DELAYS_MS.length - 1] + 200);
    },
  });
  const deadline = setTimeout(() => {
    if (!fired) channel.close();
  }, INTERRUPT_CONNECT_DEADLINE_MS);
}
