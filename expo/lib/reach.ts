/**
 * Whether each melded daemon is awake, asleep or unreachable, for the
 * switcher (docs/sleep.md, "Two addresses"), and the Wake and Sleep acts.
 *
 * Two addresses, never confused: the probe goes to the daemon's tailnet
 * address (`GET /api/status`, on the switcher's short budget) and may go as
 * often as it likes; the wake URL (Fly Proxy, public) is fetched once per
 * Wake tap and by nothing else, because every request that reaches it starts
 * a machine. After a tap the tailnet is re-probed every
 * `WAKE_REPROBE_INTERVAL_MS` until it answers or `WAKE_CEILING_MS` passes;
 * then the row offers Wake again and waits for the operator.
 *
 * Every probe that answers saves the daemon's wake recipe onto its registry
 * entry (and `lastSeenAt`), so a device melded before recipes existed learns
 * one the first time it sees the daemon awake. The root layout is told, to
 * re-read the registry (`setReachRegistryListener`).
 *
 * Outside React, like the lock sheet's store: the waking loop outlives the
 * switcher's modal, and only the rows that read it re-render.
 */

import { useSyncExternalStore } from "react";
import { probeDaemon, probeDaemonQuick, type DaemonStatus } from "./api";
import { loadDaemons, updateDaemon, type DaemonEntry } from "./registry";
import {
  SLEEPING_GRACE_MS,
  WAKE_CEILING_MS,
  WAKE_REPROBE_INTERVAL_MS,
  daemonReach,
  parseAwaitingNids,
  parseWakeRecipe,
  probeHeardHost,
  wakeFetchInit,
  type Reach,
} from "@shared/sleep";

export interface ReachRecord {
  /** The latest probe. A re-probe keeps showing the previous answer. */
  probe?: "pending" | "ok" | "failed";
  /** When Wake was tapped, while its loop runs or after it ran out. */
  wakeSentAt?: number | null;
  /** The last status that answered, for the row's sleep line. */
  status?: DaemonStatus | null;
  /** The narratives parked awaiting direction there, the undead: from the
   *  last status that answered, and for the active daemon kept current by
   *  the control socket's `awaiting` edges (`noteAwaiting`). The switcher
   *  lights the row with their glows and counts them. */
  awaiting?: string[];
}

let records: Readonly<Record<string, ReachRecord>> = {};
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<boolean>>();
const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
let registryListener: ((daemons: DaemonEntry[]) => void) | null = null;

/** Told whenever this store writes the registry, so the root layout's copy
 *  of it follows. */
export function setReachRegistryListener(cb: typeof registryListener): void {
  registryListener = cb;
}

function emit(): void {
  for (const l of listeners) l();
}

function patch(id: string, p: Partial<ReachRecord>): void {
  records = { ...records, [id]: { ...records[id], ...p } };
  emit();
}

/** A new snapshot with nothing changed: a state that turns over with the
 *  clock (sleeping → asleep, waking → still asleep) re-renders. */
function touch(): void {
  records = { ...records };
  emit();
}

function writeRegistry(id: string, p: Partial<DaemonEntry>): void {
  const daemons = updateDaemon(id, p);
  registryListener?.(daemons);
}

function stopWaking(id: string): void {
  const t = wakeTimers.get(id);
  if (t) clearTimeout(t);
  wakeTimers.delete(id);
}

/** The host answered, though not with a status this device may read. */
function noteAnswered(id: string): void {
  const entry = loadDaemons().find((d) => d.id === id);
  if (!entry) return;
  if (entry.sleptAt != null && Date.now() - entry.sleptAt < SLEEPING_GRACE_MS) return;
  stopWaking(id);
  patch(id, { probe: "ok", wakeSentAt: null, awaiting: [] });
}

/** A status answered for `id`: it is awake. Saves the recipe and the time
 *  onto the entry, and ends any waking or sleeping state — except in the
 *  moments after a Sleep, when an answer is the daemon still shutting down. */
function noteAwake(id: string, status: DaemonStatus): void {
  const entry = loadDaemons().find((d) => d.id === id);
  if (!entry) return;
  const now = Date.now();
  if (entry.sleptAt != null && now - entry.sleptAt < SLEEPING_GRACE_MS) return;
  stopWaking(id);
  patch(id, { probe: "ok", wakeSentAt: null, status, awaiting: parseAwaitingNids(status.awaiting) });
  // A different daemon answering at this host (a port reused) is not this
  // entry's to describe.
  if (status.brane_id && status.brane_id !== entry.brane_id) return;
  const wake = parseWakeRecipe(status.wake);
  writeRegistry(id, {
    ...(wake ? { wake } : {}),
    lastSeenAt: now,
    sleptAt: undefined,
  });
}

/** Probe one daemon's tailnet address: `quick` (the default) on the
 *  switcher's budget, else the full request budget (on connect, where a
 *  slow link should not read as asleep). Resolves whether it answered. One
 *  probe per daemon at a time; a second caller shares it. Never touches the
 *  wake URL. */
export function probeReach(entry: DaemonEntry, { quick = true }: { quick?: boolean } = {}): Promise<boolean> {
  if (entry.archived || entry.revoked) return Promise.resolve(false);
  const pending = inFlight.get(entry.id);
  if (pending) return pending;
  if (records[entry.id]?.probe === undefined) patch(entry.id, { probe: "pending" });
  const probe = quick ? probeDaemonQuick : probeDaemon;
  const p = probe(entry.host, entry.token)
    .then(
      (status) => {
        noteAwake(entry.id, status);
        return true;
      },
      (err) => {
        // An answer that isn't a status (a 401, a 5xx) is still the host
        // answering: up, not asleep, with nothing to say about its undead.
        if (probeHeardHost(err)) {
          noteAnswered(entry.id);
          return true;
        }
        // No answer, no undead: a parked call cannot outlive its daemon.
        patch(entry.id, { probe: "failed", awaiting: [] });
        return false;
      },
    )
    .finally(() => inFlight.delete(entry.id));
  inFlight.set(entry.id, p);
  return p;
}

/** The Wake tap: one opaque `no-cors` fetch to the entry's wake URL, then
 *  re-probes of its tailnet address until it answers or the ceiling passes.
 *  The fetch is never retried and never awaited for an answer: an opaque
 *  response resolves, a network error rejects, and neither says whether the
 *  machine started — the probe is what finds out. */
export function wakeDaemon(entry: DaemonEntry): void {
  const recipe = entry.wake;
  if (recipe?.kind !== "url") return;
  const sentAt = Date.now();
  const running = records[entry.id]?.wakeSentAt;
  if (running != null && sentAt - running < WAKE_CEILING_MS) return;
  stopWaking(entry.id);
  patch(entry.id, { wakeSentAt: sentAt, probe: "failed" });
  if (entry.sleptAt != null) writeRegistry(entry.id, { sleptAt: undefined });
  try {
    fetch(recipe.url, wakeFetchInit()).catch(() => {});
  } catch {
    // A URL fetch refuses outright (malformed after all): the probes and the
    // ceiling still run, and the row ends on "still asleep".
  }
  scheduleReprobe(entry.id, sentAt);
}

function scheduleReprobe(id: string, sentAt: number): void {
  const timer = setTimeout(async () => {
    wakeTimers.delete(id);
    if (records[id]?.wakeSentAt !== sentAt) return; // answered, or superseded
    const entry = loadDaemons().find((d) => d.id === id);
    if (!entry || entry.archived || entry.revoked) return;
    const answered = await probeReach(entry);
    if (answered || records[id]?.wakeSentAt !== sentAt) return;
    if (Date.now() - sentAt >= WAKE_CEILING_MS) {
      touch(); // "still asleep; tap Wake again" — and no second wake
      return;
    }
    scheduleReprobe(id, sentAt);
  }, WAKE_REPROBE_INTERVAL_MS);
  wakeTimers.set(id, timer);
}

/** `POST /api/sleep` answered 202: the switcher says the host is going to
 *  sleep, then asleep, without waiting for a probe to time out. */
export function markSlept(id: string): void {
  stopWaking(id);
  writeRegistry(id, { sleptAt: Date.now() });
  patch(id, { probe: "failed", wakeSentAt: null, awaiting: [] });
  setTimeout(touch, SLEEPING_GRACE_MS + 50);
}

/** The active daemon's control socket said a narrative parked awaiting
 *  direction, or stopped: keep that daemon's undead current between
 *  probes, so its row in the switcher is live rather than as of the last
 *  status. The same edge the list cards follow (`AWAITING_STATUS`). */
export function noteAwaiting(id: string, nid: string, awaiting: boolean): void {
  const current = records[id]?.awaiting ?? [];
  if (awaiting === current.includes(nid)) return;
  patch(id, { awaiting: awaiting ? [...current, nid] : current.filter((n) => n !== nid) });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Every daemon's record, re-rendering when any changes. */
export function useReachRecords(): Readonly<Record<string, ReachRecord>> {
  return useSyncExternalStore(subscribe, () => records, () => records);
}

/** What a row says about `entry`. `socketUp` is the active daemon's control
 *  channel: a live socket is as good an answer as a probe. */
export function reachOf(entry: DaemonEntry, record: ReachRecord | undefined, socketUp = false): Reach {
  return daemonReach({
    recipe: entry.wake,
    probe: socketUp ? "ok" : record?.probe,
    wakeSentAt: record?.wakeSentAt,
    sleptAt: entry.sleptAt,
    now: Date.now(),
  });
}
