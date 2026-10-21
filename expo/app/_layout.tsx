import { Stack } from "expo-router";
import Head from "expo-router/head";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState, useCallback, useMemo, useRef, createContext, useContext } from "react";
import {
  parseConnectionParams,
  probeDaemon,
  clearStoredConnection,
  listProtocols,
  rotateToken,
  forgetDeviceToken,
  setUnauthorizedListener,
  type ConnectionParams,
  type ToolUse,
} from "@/lib/api";
import {
  createControlChannel,
  type ControlMessage,
} from "@/lib/connection";
import { withoutConnectionHash, withoutConnectionParams } from "@shared/view-url";
import { AWAITING_STATUS, NOT_AWAITING_STATUS } from "@shared/narrative-status";
import {
  loadDaemons,
  addDaemon as registryAddDaemon,
  removeDaemon as registryRemoveDaemon,
  updateDaemon as registryUpdateDaemon,
  setDaemonArchived as registrySetDaemonArchived,
  usableDaemons,
  DAEMONS_KEY,
  getActiveDaemonId,
  setActiveDaemonId,
  setDefaultDaemonId,
  type DaemonEntry,
} from "@/lib/registry";
import MeldConfirmModal, {
  MeldRefusedModal,
  type MeldConfirmInfo,
  type MeldRefusal,
} from "@/components/MeldConfirmModal";
import { checkMeldHost, isFirstMeld, meldRefusalMessage } from "@shared/tailnet";
import { installNoPan } from "@/lib/noPan";
import { installVerification, noteVerified, refreshStatus, requireVerification } from "@/lib/verification";
import LockSheet from "@/components/LockSheet";

// Before the first tap: iOS must never move the page under the app, whether
// to reveal a focused field or on a drag nothing else takes.
installNoPan();

interface BraneContextValue {
  conn: ConnectionParams | null;
  connected: boolean;
  daemons: DaemonEntry[];
  activeDaemon: DaemonEntry | null;
  activeBraneId: string | null;
  switchDaemon: (id: string) => void;
  switchBrane: (braneId: string | null) => void;
  addDaemon: (host: string, token: string) => Promise<DaemonEntry>;
  removeDaemon: (id: string) => void;
  /** Put a daemon away (or bring it back): it keeps its token, but this
   *  browser stops connecting to it. Archiving the active one switches to
   *  the next usable daemon, or to none. */
  archiveDaemon: (id: string) => void;
  /** Unarchive a daemon and switch to it. */
  reconnectDaemon: (id: string) => void;
  /** "Delete permanently": sign this device out of the daemon (its token is
   *  revoked there), then forget it. Rejects, forgetting nothing, when the
   *  daemon could not be told; `revoke: false` forgets it regardless. */
  forgetDaemon: (id: string, opts: { revoke: boolean }) => Promise<void>;
  /** Rotate the active daemon's token, keeping this device signed in and
   *  signing every other one out. Resolves once the new token is stored and
   *  the control channel is back on it; rejects — with the old credentials
   *  still working — if the daemon never confirmed the new one. */
  rotateActiveToken: () => Promise<void>;
  subscribe: (nid: string, after?: number) => void;
  unsubscribe: (nid: string) => void;
  // Brane-wide activity stream: a single subscription (not per-narrative) that
  // pings whenever any narrative gets a new event. The list uses it to keep
  // recency timestamps fresh without a control-WS subscription per card.
  subscribeActivity: () => void;
  unsubscribeActivity: () => void;
  onActivity: (cb: (nid: string, seq: number, time: number) => void) => () => void;
  onHint: (cb: (nid: string, headSeq: number) => void) => () => void;
  onStatus: (cb: (nid: string, status: string) => void) => () => void;
  onMeta: (cb: MetaListener) => () => void;
  onToolUses: (cb: ToolUsesListener) => () => void;
  /** Names of the protocols this daemon serves. Chat and the wiki reader
   *  linkify a `/command` only when it's in here, so the set has to be loaded
   *  before anything can light up — it arrives empty and fills in. */
  protocols: Set<string>;
  /** Every narrative id the daemon knows, from the control channel's `state`
   *  frame. Sent unprompted on connect, covers archived narratives too, and
   *  rides the socket a screen already needs — so it is the cheapest and most
   *  reliable source for `narrativeIdLinks`, which links only ids that exist.
   *  Screens union it with what they fetch (`collectKnownNids`) rather than
   *  depending on a request that can fail. */
  narrativeIds: Set<string>;
}

/** Inline tool-row delivery. `rows` carries the coalesced batch; a null rows
 *  is the resync signal (server dropped inline delivery for this client —
 *  refetch from your rev watermark). */
export type ToolUsesListener = (nid: string, rows: ToolUse[] | null, rev: number) => void;

/** Meta updates carry any subset of {title, summary, cost}. Cost is a single
 *  {amount, unit} so one meta frame (and one listener) covers all cost
 *  components — no per-field subscription. */
export type MetaListener = (
  nid: string,
  title?: string,
  summary?: string,
  cost?: { amount: number; unit: string } | null,
) => void;

const BraneContext = createContext<BraneContextValue>({
  conn: null,
  connected: false,
  daemons: [],
  activeDaemon: null,
  activeBraneId: null,
  switchDaemon: () => {},
  switchBrane: () => {},
  addDaemon: () => Promise.reject(new Error("no context")),
  removeDaemon: () => {},
  archiveDaemon: () => {},
  reconnectDaemon: () => {},
  forgetDaemon: () => Promise.reject(new Error("no context")),
  rotateActiveToken: () => Promise.reject(new Error("no context")),
  subscribe: () => {},
  unsubscribe: () => {},
  subscribeActivity: () => {},
  unsubscribeActivity: () => {},
  onActivity: () => () => {},
  onHint: () => () => {},
  onStatus: () => () => {},
  onMeta: () => () => {},
  onToolUses: () => () => {},
  protocols: new Set<string>(),
  narrativeIds: new Set<string>(),
});

export function useBrane() {
  return useContext(BraneContext);
}

export default function RootLayout() {
  const [daemons, setDaemons] = useState<DaemonEntry[]>([]);
  const [activeDaemonId, setActiveId] = useState<string | null>(null);
  const [activeBraneId, setActiveBraneId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [hintListeners] = useState(
    () => new Set<(nid: string, headSeq: number) => void>(),
  );
  const [activityListeners] = useState(
    () => new Set<(nid: string, seq: number, time: number) => void>(),
  );
  const [statusListeners] = useState(
    () => new Set<(nid: string, status: string) => void>(),
  );
  const [metaListeners] = useState(() => new Set<MetaListener>());
  const [toolUsesListeners] = useState(() => new Set<ToolUsesListener>());
  // Filled by the control channel's `state` frame, below.
  const [narrativeIds, setNarrativeIds] = useState<Set<string>>(() => new Set());

  const channelRef = useRef<ReturnType<typeof createControlChannel> | null>(null);

  const activeDaemon = daemons.find((d) => d.id === activeDaemonId) ?? null;
  const conn: ConnectionParams | null = useMemo(
    () => activeDaemon ? { host: activeDaemon.host, token: activeDaemon.token } : null,
    [activeDaemon?.host, activeDaemon?.token],
  );

  // The daemon refused the credentials this device holds for it: its token
  // was rotated from another device (or `brane token rotate`). Flag the
  // entry rather than removing it — the banner names what you were signed out
  // of, and a fresh meld of the same brane replaces the entry and clears it.
  // Keyed on the refused {host, token} rather than "the active daemon" so a
  // wrong token typed into the add-daemon form cannot sign out the one you
  // are connected to.
  const channelParamsRef = useRef<ConnectionParams | null>(null);
  const markSignedOut = useCallback((refused: ConnectionParams) => {
    const hit = loadDaemons().find((d) => d.host === refused.host && d.token === refused.token);
    if (!hit) return;
    if (!hit.revoked) setDaemons(registryUpdateDaemon(hit.id, { revoked: true }));
    const dialing = channelParamsRef.current;
    if (channelRef.current && dialing?.host === refused.host && dialing.token === refused.token) {
      channelRef.current.close();
      channelRef.current = null;
      channelParamsRef.current = null;
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedListener(markSignedOut);
    return () => setUnauthorizedListener(null);
  }, [markSignedOut]);

  // The verification gate's lock sheet: requests and sockets refused for a
  // proof open it (expo/lib/verification.ts).
  useEffect(() => installVerification(), []);

  // Connect control WebSocket to active daemon
  const connectChannel = useCallback(
    (params: ConnectionParams) => {
      channelRef.current?.close();
      channelRef.current = null;
      channelParamsRef.current = null;
      setConnected(false);
      // A credential the daemon has already refused is not worth dialing: the
      // upgrade would 401 (which the browser reports as a bare 1006) every
      // 2 s until the operator re-melds. The banner is the whole response.
      const known = loadDaemons().find((d) => d.host === params.host && d.token === params.token);
      if (known?.revoked) return;

      const ch = createControlChannel({
        conn: params,
        onMessage: (msg: ControlMessage) => {
          if (msg.type === "state") {
            // Was received and dropped. It is the full narrative list, archived
            // included, pushed on connect — so keeping it costs nothing and
            // gives every screen a linkification source that cannot fail
            // separately from the socket it is already using.
            setNarrativeIds(new Set(msg.narratives.map((n) => n.id)));
          } else if (msg.type === "new_events") {
            for (const cb of hintListeners) cb(msg.narrative, msg.head_seq);
          } else if (msg.type === "activity") {
            for (const cb of activityListeners) cb(msg.narrative, msg.seq, msg.time);
          } else if (msg.type === "status") {
            for (const cb of statusListeners) cb(msg.narrative, msg.status);
          } else if (msg.type === "awaiting") {
            const word = msg.awaiting ? AWAITING_STATUS : NOT_AWAITING_STATUS;
            for (const cb of statusListeners) cb(msg.narrative, word);
          } else if (msg.type === "meta") {
            const cost =
              msg.cost_amount != null && msg.cost_unit
                ? { amount: msg.cost_amount, unit: msg.cost_unit }
                : undefined;
            for (const cb of metaListeners) cb(msg.narrative, msg.title, msg.summary, cost);
          } else if (msg.type === "tool_uses") {
            for (const cb of toolUsesListeners) cb(msg.narrative, msg.rows, msg.rev);
          } else if (msg.type === "tool_uses_resync") {
            for (const cb of toolUsesListeners) cb(msg.narrative, null, msg.rev);
          } else if (msg.type === "verify") {
            // A signal this device sent was dropped until it verifies.
            void requireVerification(params, msg.verification);
          } else if (msg.type === "verified") {
            noteVerified(params, msg.verified_until);
          }
        },
        onConnect: () => {
          setConnected(true);
          refreshStatus(params);
        },
        onDisconnect: () => setConnected(false),
        onSignedOut: () => markSignedOut(params),
      });
      channelRef.current = ch;
      channelParamsRef.current = params;
    },
    [hintListeners, activityListeners, statusListeners, metaListeners, toolUsesListeners, markSignedOut],
  );

  // Register service worker for offline PWA support
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  // Hold a meld URL until the user confirms. Keeping the host+token in this
  // ref (not just the modal info) keeps the confirm callback stable and lets
  // us drop the values cleanly on cancel.
  const pendingTokenRef = useRef<{ host: string; token: string } | null>(null);
  const [pendingMeld, setPendingMeld] = useState<MeldConfirmInfo | null>(null);
  const [meldRefusal, setMeldRefusal] = useState<MeldRefusal | null>(null);

  const activateStored = useCallback(() => {
    const stored = loadDaemons();
    const storedActiveId = getActiveDaemonId();
    if (stored.length === 0) return;
    setDaemons(stored);
    // An archived daemon is never connected to on its own: only Reconnect
    // brings one back. With nothing else, the switcher is where to go.
    const usable = usableDaemons(stored);
    if (usable.length === 0) return;
    const activeId = storedActiveId && usable.find((d) => d.id === storedActiveId)
      ? storedActiveId
      : usable[0].id;
    setActiveId(activeId);
    setActiveDaemonId(activeId);
    const daemon = usable.find((d) => d.id === activeId)!;
    connectChannel({ host: daemon.host, token: daemon.token });
  }, [connectChannel]);

  const clearMeldUrl = useCallback(() => {
    if (window.history.replaceState) {
      // Only the meld params go. Resetting to the bare pathname would also
      // discard the view — tab, pins, open file, scroll target — which is
      // exactly what an Isolate hop hands this origin on arrival. Normally
      // `api.ts` has already taken them out at bundle load (it must, before
      // the router reads the URL — see consumeConnectionFromLocation there);
      // this is the backstop for anything that path did not reach.
      const clean =
        window.location.pathname +
        withoutConnectionParams(window.location.search) +
        withoutConnectionHash(window.location.hash);
      window.history.replaceState({}, "", clean);
    }
    // Drop the sessionStorage cache too — without this, parseConnectionParams
    // re-reads the same {host, token} on reload and re-fires the meld flow
    // (re-prompting after a cancel, double-probing after a confirm).
    clearStoredConnection();
  }, []);

  // Initialize from localStorage + the meld URL, if this load had one
  useEffect(() => {
    // A meld URL (`#host=…&token=…`, or the legacy `?token=…`) triggers a
    // meld confirmation. By now the params live in sessionStorage: api.ts
    // consumed them off the address bar at bundle load.
    const urlParams = parseConnectionParams();
    if (urlParams) {
      // Connect any stored daemon immediately so the UI isn't empty while
      // the user decides. The meld will replace the active daemon on confirm.
      activateStored();
      // One tailnet per browser (src/shared/tailnet.ts): a link to a daemon
      // on another tailnet is refused before anything is sent to its host —
      // not even the probe, which would tell its owner the link was opened.
      const verdict = checkMeldHost(urlParams.host, loadDaemons().map((d) => d.host));
      if (!verdict.ok) {
        setMeldRefusal({ host: urlParams.host, message: meldRefusalMessage(urlParams.host, verdict) });
        clearMeldUrl();
        return;
      }
      probeDaemon(urlParams.host, urlParams.token)
        .then((status) => {
          const existing = loadDaemons().find((d) => d.brane_id === status.brane_id);
          if (existing && existing.token === urlParams.token) {
            // Same brane, same token — benign reconnect, no prompt. But the
            // daemon's port can shift across restarts (port-stability is best-
            // effort, not guaranteed), so the freshly-scanned URL host is more
            // authoritative than whatever we cached. Update the entry's host
            // before reconnecting; otherwise we attempt to connect to a port
            // the daemon has since moved off of.
            // Opening its link again is asking for it, so an archived
            // entry comes back.
            const entry: DaemonEntry = {
              ...existing,
              host: urlParams.host,
              addedAt: existing.addedAt,
              archived: false,
            };
            if (entry.host !== existing.host || existing.archived) {
              registryAddDaemon(entry);
              setDaemons(loadDaemons());
            }
            setActiveId(entry.id);
            setActiveDaemonId(entry.id);
            connectChannel({ host: entry.host, token: entry.token });
            clearMeldUrl();
            return;
          }
          pendingTokenRef.current = { host: urlParams.host, token: urlParams.token };
          setPendingMeld({
            status,
            host: urlParams.host,
            isUpdate: existing !== undefined,
            // The one meld the tailnet rule can't screen: nothing melded here
            // yet (archived included), or this link picks the tailnet.
            firstMeld: isFirstMeld(
              loadDaemons().map((d) => d.host),
              verdict,
              urlParams.host,
              window.location.host,
            ),
            domain: verdict.domain,
          });
        })
        .catch(() => {
          // Probe failed; we already activated stored daemons above. Drop
          // the bad URL so a refresh doesn't re-trigger the same failure.
          clearMeldUrl();
        });
      return;
    }

    activateStored();

    return () => {
      channelRef.current?.close();
    };
  }, [activateStored, connectChannel, clearMeldUrl]);

  const confirmMeld = useCallback(() => {
    const pending = pendingMeld;
    const creds = pendingTokenRef.current;
    if (!pending || !creds) return;
    const entry: DaemonEntry = {
      id: `${pending.status.username}@${pending.status.hostname}`,
      host: creds.host,
      token: creds.token,
      hostname: pending.status.hostname,
      username: pending.status.username,
      brane_id: pending.status.brane_id,
      addedAt: Date.now(),
    };
    const updated = registryAddDaemon(entry);
    setDaemons(updated);
    setActiveId(entry.id);
    setActiveDaemonId(entry.id);
    // Confirmed meld is an explicit user switch — promote to cross-tab default
    // and clear any brane filter inherited from the previous daemon (whose
    // brane_id won't exist on the new daemon, leaving the list empty).
    setDefaultDaemonId(entry.id);
    setActiveBraneId(null);
    connectChannel({ host: entry.host, token: entry.token });
    pendingTokenRef.current = null;
    setPendingMeld(null);
    clearMeldUrl();
  }, [pendingMeld, connectChannel, clearMeldUrl]);

  const cancelMeld = useCallback(() => {
    pendingTokenRef.current = null;
    setPendingMeld(null);
    clearMeldUrl();
  }, [clearMeldUrl]);

  const switchDaemon = useCallback(
    (id: string) => {
      const daemon = daemons.find((d) => d.id === id);
      if (!daemon) return;
      setActiveId(id);
      setActiveDaemonId(id);
      // Explicit user switch — also update the cross-tab default so new
      // tabs open here. URL probes and addDaemon do not update the default.
      setDefaultDaemonId(id);
      setActiveBraneId(null); // Reset brane filter on daemon switch
      connectChannel({ host: daemon.host, token: daemon.token });
    },
    [daemons, connectChannel],
  );

  const switchBrane = useCallback(
    (braneId: string | null) => {
      setActiveBraneId(braneId);
    },
    [],
  );

  const handleAddDaemon = useCallback(
    async (host: string, token: string): Promise<DaemonEntry> => {
      const verdict = checkMeldHost(host, loadDaemons().map((d) => d.host));
      if (!verdict.ok) throw new Error(meldRefusalMessage(host, verdict));
      const status = await probeDaemon(host, token);
      const entry: DaemonEntry = {
        id: `${status.username}@${status.hostname}`,
        host,
        token,
        hostname: status.hostname,
        username: status.username,
        brane_id: status.brane_id,
        addedAt: Date.now(),
      };
      const updated = registryAddDaemon(entry);
      setDaemons(updated);
      // Auto-switch to the newly added daemon
      setActiveId(entry.id);
      setActiveDaemonId(entry.id);
      connectChannel({ host: entry.host, token: entry.token });
      return entry;
    },
    [connectChannel],
  );

  /** Leave `id` if it is the active daemon: on to the next usable one, or
   *  disconnected when there is none. */
  const leaveDaemon = useCallback(
    (id: string, updated: DaemonEntry[]) => {
      if (activeDaemonId !== id) return;
      const next = usableDaemons(updated).find((d) => d.id !== id) ?? null;
      setActiveId(next?.id ?? null);
      setActiveDaemonId(next?.id ?? null);
      setActiveBraneId(null);
      if (next) {
        connectChannel({ host: next.host, token: next.token });
      } else {
        channelRef.current?.close();
        channelRef.current = null;
        channelParamsRef.current = null;
        setConnected(false);
      }
    },
    [activeDaemonId, connectChannel],
  );

  const handleRemoveDaemon = useCallback(
    (id: string) => {
      const updated = registryRemoveDaemon(id);
      setDaemons(updated);
      leaveDaemon(id, updated);
    },
    [leaveDaemon],
  );

  const handleArchiveDaemon = useCallback(
    (id: string) => {
      const updated = registrySetDaemonArchived(id, true);
      setDaemons(updated);
      leaveDaemon(id, updated);
    },
    [leaveDaemon],
  );

  const handleReconnectDaemon = useCallback(
    (id: string) => {
      const updated = registrySetDaemonArchived(id, false);
      setDaemons(updated);
      const daemon = updated.find((d) => d.id === id);
      if (!daemon) return;
      setActiveId(id);
      setActiveDaemonId(id);
      setDefaultDaemonId(id);
      setActiveBraneId(null);
      connectChannel({ host: daemon.host, token: daemon.token });
    },
    [connectChannel],
  );

  const handleForgetDaemon = useCallback(
    async (id: string, { revoke }: { revoke: boolean }) => {
      const daemon = loadDaemons().find((d) => d.id === id);
      if (!daemon) return;
      // A token the daemon already refused has nothing left to revoke.
      if (revoke && !daemon.revoked) {
        await forgetDeviceToken({ host: daemon.host, token: daemon.token });
      }
      handleRemoveDaemon(id);
    },
    [handleRemoveDaemon],
  );

  const handleRotateToken = useCallback(async () => {
    const daemon = activeDaemon;
    if (!daemon) throw new Error("No active daemon");
    const old: ConnectionParams = { host: daemon.host, token: daemon.token };
    // Mint. Nothing has changed on the daemon yet — it swaps on first use.
    const rotation = await rotateToken(old);
    // Close our old-token channel *before* the confirming request: retirement
    // closes every old-generation socket with 4401, and a channel still open
    // at that moment would read its own sign-out as someone else's.
    channelRef.current?.close();
    channelRef.current = null;
    channelParamsRef.current = null;
    setConnected(false);
    try {
      // The confirming use. From here the old token is dead everywhere else.
      await probeDaemon(daemon.host, rotation.token);
    } catch (err) {
      // Never confirmed: the pending token lapses and the old one still
      // works, so put the channel back on it and let the caller report. A
      // 401 here has one specific meaning — another rotate voided ours
      // before we could confirm — which is worth saying in those words: it
      // is either a double-tap or someone with the old token racing us.
      connectChannel(old);
      const raced = err instanceof Error && /\b401\b/.test(err.message);
      throw new Error(
        raced
          ? "The daemon did not accept the new token: another rotation replaced it before this one was confirmed. Your access is unchanged — try again, and if it keeps happening, rotate from the shell with `brane token rotate`."
          : `Could not confirm the new token; your access is unchanged. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const entry: DaemonEntry = { ...daemon, token: rotation.token, revoked: false };
    setDaemons(registryAddDaemon(entry));
    connectChannel({ host: entry.host, token: entry.token });
    clearStoredConnection();
  }, [activeDaemon, connectChannel]);

  // Sibling tabs share the registry. When one of them rotates the token (or
  // discovers a sign-out), this tab reads the change here and reconnects
  // instead of waiting to be refused with a 4401 of its own.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DAEMONS_KEY && e.key !== null) return;
      const stored = loadDaemons();
      setDaemons(stored);
      const active = stored.find((d) => d.id === activeDaemonId);
      if (!active || !conn) return;
      if (active.revoked) {
        channelRef.current?.close();
        channelRef.current = null;
        setConnected(false);
      } else if (active.token !== conn.token || active.host !== conn.host) {
        connectChannel({ host: active.host, token: active.token });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [activeDaemonId, conn, connectChannel]);

  const subscribe = useCallback((nid: string, after: number = 0) => {
    channelRef.current?.subscribe(nid, after);
  }, []);

  const unsubscribe = useCallback((nid: string) => {
    channelRef.current?.unsubscribe(nid);
  }, []);

  const subscribeActivity = useCallback(() => {
    channelRef.current?.subscribeActivity();
  }, []);

  const unsubscribeActivity = useCallback(() => {
    channelRef.current?.unsubscribeActivity();
  }, []);

  const onActivity = useCallback((cb: (nid: string, seq: number, time: number) => void) => {
    activityListeners.add(cb);
    return () => { activityListeners.delete(cb); };
  }, [activityListeners]);

  const onHint = useCallback((cb: (nid: string, headSeq: number) => void) => {
    hintListeners.add(cb);
    return () => { hintListeners.delete(cb); };
  }, [hintListeners]);

  const onStatus = useCallback((cb: (nid: string, status: string) => void) => {
    statusListeners.add(cb);
    return () => { statusListeners.delete(cb); };
  }, [statusListeners]);

  const onMeta = useCallback((cb: MetaListener) => {
    metaListeners.add(cb);
    return () => { metaListeners.delete(cb); };
  }, [metaListeners]);

  const onToolUses = useCallback((cb: ToolUsesListener) => {
    toolUsesListeners.add(cb);
    return () => { toolUsesListeners.delete(cb); };
  }, [toolUsesListeners]);

  // The protocol library changes only when the daemon's checkout does, so one
  // fetch per connection is plenty.
  const [protocols, setProtocols] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!conn) {
      setProtocols(new Set());
      return;
    }
    let cancelled = false;
    listProtocols(conn)
      .then((list) => {
        if (!cancelled) setProtocols(new Set(list.map((p) => p.name)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [conn]);

  const contextValue = useMemo(() => ({
    conn,
    connected,
    daemons,
    activeDaemon,
    activeBraneId,
    switchDaemon,
    switchBrane,
    addDaemon: handleAddDaemon,
    removeDaemon: handleRemoveDaemon,
    archiveDaemon: handleArchiveDaemon,
    reconnectDaemon: handleReconnectDaemon,
    forgetDaemon: handleForgetDaemon,
    rotateActiveToken: handleRotateToken,
    subscribe,
    unsubscribe,
    subscribeActivity,
    unsubscribeActivity,
    onActivity,
    onHint,
    onStatus,
    onMeta,
    onToolUses,
    protocols,
    narrativeIds,
  }), [conn, connected, daemons, activeDaemon, activeBraneId, switchDaemon, switchBrane, handleAddDaemon, handleRemoveDaemon, handleArchiveDaemon, handleReconnectDaemon, handleForgetDaemon, handleRotateToken, subscribe, unsubscribe, subscribeActivity, unsubscribeActivity, onActivity, onHint, onStatus, onMeta, onToolUses, protocols]);

  return (
    <BraneContext.Provider value={contextValue}>
      <Head>
        {/* The viewport and the html/body/#root rules are also in
            public/index.html, which is what lays out the first paint — kept
            identical, so this copy landing after the bundle changes nothing.
            See the comment there for the bug a difference caused. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, shrink-to-fit=no" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.json" />
        <style>{`html, body { background-color: #111 !important; height: 100%; overflow: hidden; overscroll-behavior: none; } #root { box-sizing: border-box; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); height: var(--brane-vvh, 100%); overflow: hidden; } .no-scrollbar::-webkit-scrollbar { display: none; }`}</style>
      </Head>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#1a1a1e" },
          headerTintColor: "#8fd4b4",
          headerTitleStyle: { fontSize: 17 },
          contentStyle: { backgroundColor: "#121214" },
        }}
      />
      <StatusBar style="light" />
      <LockSheet />
      <MeldConfirmModal
        pending={pendingMeld}
        onConfirm={confirmMeld}
        onCancel={cancelMeld}
      />
      <MeldRefusedModal refusal={meldRefusal} onClose={() => setMeldRefusal(null)} />
    </BraneContext.Provider>
  );
}
