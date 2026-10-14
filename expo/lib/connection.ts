/**
 * WebSocket control channel for real-time event hints.
 *
 * Connects to ws://{host}/ws/control?token={token} and receives
 * lightweight hints when new events appear on subscribed narratives.
 * Actual event data is fetched via HTTP.
 */

import type { ConnectionParams, ToolUse } from "./api";
import { isSignedOutClose } from "@shared/token-rotation";

export type ControlMessage =
  | { type: "state"; narratives: Array<{ id: string; status: string; agent_type: string; role: string; fold_path: string; created_at: number; mcp_connected: boolean; awaiting?: boolean; title?: string | null; summary?: string | null }> }
  | { type: "new_events"; narrative: string; head_seq: number; count: number }
  // Tool rows push inline (coalesced) — unlike events, which hint-then-fetch.
  // `tool_uses_resync` is the slow-client overflow valve: refetch from rev.
  | { type: "tool_uses"; narrative: string; rows: ToolUse[]; rev: number }
  | { type: "tool_uses_resync"; narrative: string; rev: number }
  | { type: "activity"; narrative: string; seq: number; time: number }
  | { type: "status"; narrative: string; status: string }
  // Parked in a blocking listen (or a waiting narrate) — OPEN — or not.
  | { type: "awaiting"; narrative: string; awaiting: boolean }
  | { type: "meta"; narrative: string; title?: string; summary?: string; cost_amount?: number; cost_unit?: string }
  | { type: "heartbeat"; timestamp_ms: number };

interface ControlChannelOptions {
  conn: ConnectionParams;
  onMessage: (msg: ControlMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** The daemon closed this socket because the token it holds was rotated
   *  out. The channel stops reconnecting on its own; this is where the app
   *  learns the credential is dead. */
  onSignedOut?: () => void;
}

export function createControlChannel(opts: ControlChannelOptions) {
  const { conn, onMessage, onConnect, onDisconnect, onSignedOut } = opts;
  const wsProtocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${wsProtocol}://${conn.host}/ws/control?token=${conn.token}`;

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  // Track active subscriptions so they survive reconnects
  const activeSubscriptions = new Map<string, number>();
  // How many mounted screens hold each subscription. The stack keeps a screen
  // mounted under the one pushed over it, and the two can be the same
  // narrative (a `nid:seq` link into the one you're reading, or A → B → A), so
  // the top one's unmount must not unsubscribe the one Back is returning to.
  const subscriberCounts = new Map<string, number>();
  // How many mounted screens are on the brane-wide activity stream (one
  // subscription, not one per card), re-sent on reconnect alongside the
  // per-narrative subscriptions. A count, not a flag, for the same reason as
  // subscriberCounts: dismissing or archiving a narrative pushes a list over a
  // narrative that may already have one beneath it, and the top list's
  // unmount must not silence the one Back returns to.
  let activitySubscribers = 0;

  function connect() {
    if (closed) return;

    ws = new WebSocket(url);

    ws.onopen = () => {
      // Restore all subscriptions after reconnect
      for (const [nid, after] of activeSubscriptions) {
        ws!.send(JSON.stringify({ type: "subscribe", narrative: nid, after }));
      }
      if (activitySubscribers > 0) {
        ws!.send(JSON.stringify({ type: "subscribe_activity" }));
      }
      onConnect?.();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ControlMessage;
        onMessage(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = (event) => {
      onDisconnect?.();
      if (closed) return;
      if (isSignedOutClose(event.code)) {
        // Not a blip: the token this channel dials with is retired, and every
        // retry would be refused. Stop here rather than loop silently.
        closed = true;
        onSignedOut?.();
        return;
      }
      reconnectTimer = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  function subscribe(nid: string, after: number = 0) {
    const count = subscriberCounts.get(nid) ?? 0;
    subscriberCounts.set(nid, count + 1);
    // Hints are per narrative, not per subscriber: one is enough.
    if (count > 0) return;
    activeSubscriptions.set(nid, after);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe", narrative: nid, after }));
    }
  }

  function unsubscribe(nid: string) {
    const count = subscriberCounts.get(nid) ?? 0;
    if (count > 1) {
      subscriberCounts.set(nid, count - 1);
      return;
    }
    subscriberCounts.delete(nid);
    activeSubscriptions.delete(nid);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "unsubscribe", narrative: nid }));
    }
  }

  function subscribeActivity() {
    activitySubscribers += 1;
    if (activitySubscribers > 1) return;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe_activity" }));
    }
  }

  function unsubscribeActivity() {
    if (activitySubscribers > 1) {
      activitySubscribers -= 1;
      return;
    }
    activitySubscribers = 0;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "unsubscribe_activity" }));
    }
  }

  function send(nid: string, content: string, source: string = "web") {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", narrative: nid, content, source }));
    }
  }

  function close() {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  }

  connect();

  return { subscribe, unsubscribe, subscribeActivity, unsubscribeActivity, send, close };
}
