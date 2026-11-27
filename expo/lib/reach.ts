/**
 * Whether each melded daemon is awake, asleep or unreachable, for the
 * switcher (docs/sleep.md, "Two addresses"), and the Wake and Sleep acts.
 *
 * Two addresses, never confused: the probe goes to the daemon's tailnet
 * address (`GET /api/status`, on the switcher's short budget) and may go as
 * often as it likes; the wake URL (Fly Proxy, public) is fetched once per
 * Wake tap and by nothing else, because every request that reaches it starts
 * a machine. After a tap the tailnet is re-probed on a lengthening interval
 * (`wakeReprobeDelayMs`) until it answers or `WAKE_CEILING_MS` passes; then
 * the row offers Wake again and waits for the operator. The wake door's
 * answer, when it can be read, says which machine the wake reached: the one
 * thing here that is the host's word and not this tab's guess.
 *
 * Probes are sparing. A host that is not there costs the device's Tailscale
 * a relay dial and handshake retries per probe, so an answer is reused for
 * `PROBE_FRESH_MS`, a silent host is re-asked on a doubling backoff, and
 * only a Wake tap or a connect asks regardless (`probeDue`). A probe that
 * misses changes nothing but its own row, and a host that was answering is
 * asked once more before its row stops saying so.
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
import { fetchTailnet, probeDaemon, probeDaemonQuick, type DaemonStatus } from "./api";
import { loadDaemons, updateDaemon, type DaemonEntry } from "./registry";
import { DEFAULT_TIMEOUT_MS, MAX_ATTEMPTS } from "@shared/api-request";
import {
  PROBE_CONFIRM_DELAY_MS,
  PROBE_DEADLINE_SLACK_MS,
  PROBE_NOT_READY_RETRIES,
  PROBE_NOT_READY_RETRY_MS,
  PROBE_REFUSED_UNDER_MS,
  SLEEPING_GRACE_MS,
  SWITCHER_PROBE_TIMEOUT_MS,
  WAKE_CEILING_MS,
  daemonReach,
  parseAwaitingNids,
  parseTailnetReport,
  parseWakeAnswer,
  parseWakeRecipe,
  probeAfterMiss,
  probeDue,
  probeHeardHost,
  tailnetHost,
  tailnetTrusted,
  tailnetVerdict,
  TAILNET_WORD_FRESH_MS,
  wakeConfirmed,
  wakeFetchInit,
  wakeReachedOther,
  wakeReprobeDelayMs,
  type Reach,
  type TailnetPeerInfo,
  type TailnetReport,
  type TailnetVerdict,
  type WakeAnswer,
} from "@shared/sleep";

export interface ReachRecord {
  /** The latest probe. A re-probe keeps showing the previous answer. */
  probe?: "pending" | "ok" | "failed";
  /** When that probe settled, and how many in a row got no answer: what
   *  decides whether the switcher asks again (`probeDue`). */
  probedAt?: number;
  misses?: number;
  /** When Wake was tapped, while its loop runs or after it ran out. */
  wakeSentAt?: number | null;
  /** What the wake door answered, once it has: which machine is running. */
  wakeAnswer?: WakeAnswer | null;
  /** The last status that answered, for the row's sleep line. */
  status?: DaemonStatus | null;
  /** When `status` arrived: what its `sleep.sleeps_in_ms` counts down
   *  from. Set only with a status (`noteAwake`); `probedAt` also moves on a
   *  401/5xx or a first miss, which bring no new status, and counting from
   *  it would show more time than is left. */
  statusAt?: number;
  /** The narratives parked awaiting direction there, the undead: from the
   *  last status that answered, and for the active daemon kept current by
   *  the control socket's `awaiting` edges (`noteAwaiting`). The switcher
   *  lights the row with their glows and counts them. */
  awaiting?: string[];
  /** What a connected daemon's Tailscale last said about this host, and
   *  when it said it: online or offline on the tailnet (`askTailnet`). */
  tailnet?: { online: boolean; lastSeen: string | null; at: number } | null;
  /** For the daemon that was asked: its view of the path to this device,
   *  and its Tailscale's own health warnings. */
  path?: TailnetPeerInfo | null;
  health?: string[];
}

let records: Readonly<Record<string, ReachRecord>> = {};
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<boolean>>();
const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const confirmTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Quick retries spent on a host that refuses (up, daemon not listening). */
const notReady = new Map<string, number>();

/** A wake outlives a reload: "waking" used to live only in this module's
 *  memory, so reloading the page mid-wake dropped the row back to "no
 *  answer" with the machine already starting. Session storage, so it ends
 *  with the tab and never travels. */
const WAKES_KEY = "brane_wakes";

function saveWakes(): void {
  try {
    const out: Record<string, { sentAt: number; answer: WakeAnswer | null }> = {};
    for (const [id, r] of Object.entries(records)) {
      if (r.wakeSentAt != null) out[id] = { sentAt: r.wakeSentAt, answer: r.wakeAnswer ?? null };
    }
    sessionStorage.setItem(WAKES_KEY, JSON.stringify(out));
  } catch {
    // No storage: the wake still runs, it just won't survive a reload.
  }
}

function restoreWakes(): void {
  let stored: Record<string, { sentAt?: unknown; answer?: unknown }>;
  try {
    stored = JSON.parse(sessionStorage.getItem(WAKES_KEY) ?? "{}");
  } catch {
    return;
  }
  if (!stored || typeof stored !== "object") return;
  const now = Date.now();
  for (const [id, w] of Object.entries(stored)) {
    const sentAt = typeof w?.sentAt === "number" ? w.sentAt : null;
    if (sentAt == null || now - sentAt < 0 || now - sentAt >= WAKE_CEILING_MS) continue;
    const a = w.answer as Partial<WakeAnswer> | null | undefined;
    const answer = a && typeof a.at === "number" ? parseWakeAnswer(a, a.at) : null;
    records = { ...records, [id]: { ...records[id], wakeSentAt: sentAt, wakeAnswer: answer, probe: "failed" } };
    scheduleReprobe(id, sentAt, 0);
  }
}
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

function stopConfirming(id: string): void {
  const t = confirmTimers.get(id);
  if (t) clearTimeout(t);
  confirmTimers.delete(id);
}

/** Settle `p` or reject after `ms`, whichever is first: a probe must end. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe deadline")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** The host answered, though not with a status this device may read. */
function noteAnswered(id: string): void {
  const entry = loadDaemons().find((d) => d.id === id);
  if (!entry) return;
  if (entry.sleptAt != null && Date.now() - entry.sleptAt < SLEEPING_GRACE_MS) return;
  stopWaking(id);
  stopConfirming(id);
  notReady.delete(id);
  patch(id, { probe: "ok", probedAt: Date.now(), misses: 0, wakeSentAt: null, wakeAnswer: null, awaiting: [] });
  saveWakes();
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
  stopConfirming(id);
  notReady.delete(id);
  patch(id, {
    probe: "ok",
    probedAt: now,
    misses: 0,
    wakeSentAt: null,
    wakeAnswer: null,
    tailnet: null,
    status,
    statusAt: now,
    awaiting: parseAwaitingNids(status.awaiting),
  });
  saveWakes();
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

/** A probe got no answer. Nothing follows from that but what this row
 *  says: no socket is closed, no list is cleared, no other daemon is
 *  touched. A host that was answering is asked once more before its row
 *  changes; one that refused (it is up, its daemon is not listening yet) is
 *  asked again shortly without being counted as a miss at all. */
function noteMissed(id: string, tookMs: number): void {
  const rec = records[id];
  const spent = notReady.get(id) ?? 0;
  if (tookMs < PROBE_REFUSED_UNDER_MS && spent < PROBE_NOT_READY_RETRIES) {
    notReady.set(id, spent + 1);
    scheduleConfirm(id, PROBE_NOT_READY_RETRY_MS);
    return;
  }
  const misses = (rec?.misses ?? 0) + 1;
  const probe = probeAfterMiss(rec?.probe, misses);
  // No answer, no undead: a parked call cannot outlive its daemon.
  patch(id, { probe, probedAt: Date.now(), misses, ...(probe === "failed" ? { awaiting: [] } : {}) });
  if (probe === "ok") scheduleConfirm(id, PROBE_CONFIRM_DELAY_MS);
}

function scheduleConfirm(id: string, delayMs: number): void {
  stopConfirming(id);
  confirmTimers.set(
    id,
    setTimeout(() => {
      confirmTimers.delete(id);
      const entry = loadDaemons().find((d) => d.id === id);
      if (entry) void probeReach(entry, { force: true });
    }, delayMs),
  );
}

// ── Asking a connected daemon instead of dialing ─────────────────────────

/** The daemon whose control socket is up, if any: the one that can be asked
 *  about the others (`GET /api/tailnet`). Set by the root layout as the
 *  socket connects and drops. */
let tailnetHelper: DaemonEntry | null = null;

export function setTailnetHelper(entry: DaemonEntry | null): void {
  tailnetHelper = entry;
  if (entry) void askTailnet([]);
}

/** Ask the helper what its Tailscale says about `about`, and about this
 *  device. Null when there is no helper, it did not answer, or it is too
 *  old to know the route: the caller then probes as it always did. Records
 *  the helper's view of the path to this device on the helper's own row. */
async function askTailnet(about: DaemonEntry[]): Promise<TailnetReport | null> {
  const helper = tailnetHelper;
  if (!helper) return null;
  try {
    const report = parseTailnetReport(await fetchTailnet(helper.host, helper.token, about.map((d) => d.host)));
    if (!report) return null;
    // The path to this device is the helper's Tailscale's word too, and is
    // shown only when that word can be taken (`tailnetTrusted`).
    patch(helper.id, { path: tailnetTrusted(report) ? report.client : null, health: report.health });
    return report;
  } catch {
    return null;
  }
}

/** The tailnet has `entry` offline: nothing would answer a dial, so none is
 *  made. The row reads "off the tailnet" on the daemon's word. A wake in
 *  flight is left running; its loop asks again. */
function noteOffline(entry: DaemonEntry, peer: TailnetPeerInfo | undefined): void {
  stopConfirming(entry.id);
  notReady.delete(entry.id);
  const rec = records[entry.id];
  patch(entry.id, {
    tailnet: { online: false, lastSeen: peer?.lastSeen ?? null, at: Date.now() },
    probe: "failed",
    probedAt: Date.now(),
    misses: Math.max(1, rec?.misses ?? 0),
    awaiting: [],
  });
}

/** What the switcher does when it opens: learn which of `entries` are up.
 *  With a connected daemon to ask, the ones its Tailscale has offline are
 *  marked without a dial, and only the rest are probed. With none, each is
 *  probed on the sparing rules (`probeDue`). */
export async function probeAllReach(entries: DaemonEntry[]): Promise<void> {
  const helper = tailnetHelper;
  const targets = entries.filter((d) => !d.archived && !d.revoked && d.id !== helper?.id);
  if (targets.length === 0) {
    if (helper) void askTailnet([]);
    return;
  }
  const report = await askTailnet(targets);
  for (const d of targets) {
    const verdict = tailnetVerdict(report, d.host);
    if (verdict === "offline") {
      noteOffline(d, report?.peers.find((p) => p.host === tailnetHostOf(d)));
      continue;
    }
    if (verdict === "online") {
      const was = records[d.id];
      patch(d.id, { tailnet: { online: true, lastSeen: null, at: Date.now() } });
      // It was silent and the tailnet now has it: worth asking at once
      // rather than waiting out the backoff a miss earned.
      void probeReach(d, { force: was?.probe === "failed" });
      continue;
    }
    if (records[d.id]?.tailnet) patch(d.id, { tailnet: null });
    void probeReach(d);
  }
}

function tailnetHostOf(entry: DaemonEntry): string {
  return tailnetHost(entry.host);
}

/** The helper's recent word on `record`'s host, for the row's label. */
export function tailnetWord(record: ReachRecord | undefined, now: number = Date.now()): TailnetVerdict {
  const t = record?.tailnet;
  if (!t || now - t.at > TAILNET_WORD_FRESH_MS) return "unknown";
  return t.online ? "online" : "offline";
}

/** Probe one daemon's tailnet address: `quick` (the default) on the
 *  switcher's budget, else the full request budget (on connect, where a
 *  slow link should not read as asleep). Resolves whether it answered. One
 *  probe per daemon at a time; a second caller shares it. Unless `force`d
 *  (a Wake's loop, a connect), a daemon asked recently is not asked again
 *  and the last answer stands (`probeDue`). Never touches the wake URL. */
export function probeReach(
  entry: DaemonEntry,
  { quick = true, force = false }: { quick?: boolean; force?: boolean } = {},
): Promise<boolean> {
  if (entry.archived || entry.revoked) return Promise.resolve(false);
  const pending = inFlight.get(entry.id);
  if (pending) return pending;
  const rec = records[entry.id];
  if (!force && !probeDue({ probedAt: rec?.probedAt, misses: rec?.misses }, Date.now())) {
    return Promise.resolve(rec?.probe === "ok");
  }
  if (rec?.probe === undefined) patch(entry.id, { probe: "pending" });
  const probe = quick ? probeDaemonQuick : probeDaemon;
  const budget = quick ? SWITCHER_PROBE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS * MAX_ATTEMPTS;
  const startedAt = Date.now();
  const p = withDeadline(probe(entry.host, entry.token), budget + PROBE_DEADLINE_SLACK_MS)
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
        noteMissed(entry.id, Date.now() - startedAt);
        return false;
      },
    )
    .finally(() => inFlight.delete(entry.id));
  inFlight.set(entry.id, p);
  return p;
}

/** The Wake tap: one fetch to the entry's wake URL, then re-probes of its
 *  tailnet address until it answers or the ceiling passes. The fetch is
 *  never retried. Its answer, when the wake door gives a readable one,
 *  names the machine that took the request: the same one, and the row says
 *  the machine is up; another, and it says so at once and stops probing a
 *  machine nobody started. No readable answer (an older door, a network
 *  error) says nothing either way, and the probes find out. */
export function wakeDaemon(entry: DaemonEntry): void {
  const recipe = entry.wake;
  if (recipe?.kind !== "url") return;
  const sentAt = Date.now();
  const rec = records[entry.id];
  const running = rec?.wakeSentAt;
  if (running != null && sentAt - running < WAKE_CEILING_MS && !wakeReachedOther(recipe, rec?.wakeAnswer)) return;
  stopWaking(entry.id);
  stopConfirming(entry.id);
  notReady.delete(entry.id);
  patch(entry.id, { wakeSentAt: sentAt, wakeAnswer: null, probe: "failed", misses: 0 });
  saveWakes();
  if (entry.sleptAt != null) writeRegistry(entry.id, { sleptAt: undefined });
  try {
    fetch(recipe.url, wakeFetchInit())
      .then((res) => res.json())
      .then((body) => noteWakeAnswer(entry.id, sentAt, body))
      .catch(() => {});
  } catch {
    // A URL fetch refuses outright (malformed after all): the probes and the
    // ceiling still run, and the row ends on "no answer".
  }
  scheduleReprobe(entry.id, sentAt, 0);
}

/** The wake door said which machine it is. */
function noteWakeAnswer(id: string, sentAt: number, body: unknown): void {
  if (records[id]?.wakeSentAt !== sentAt) return; // answered since, or superseded
  const answer = parseWakeAnswer(body, Date.now());
  if (!answer) return;
  patch(id, { wakeAnswer: answer });
  saveWakes();
  const entry = loadDaemons().find((d) => d.id === id);
  // Another machine took the wake: this one was not started, and probing it
  // would only make the device's Tailscale chase a peer that is not there.
  if (wakeReachedOther(entry?.wake, answer)) stopWaking(id);
  // This machine took it: it is booting, so start asking at the tight
  // cadence now rather than after whatever wait was already running.
  else if (wakeConfirmed(entry?.wake, answer) && records[id]?.wakeSentAt === sentAt) {
    stopWaking(id);
    scheduleReprobe(id, sentAt, 0);
  }
}

/** How long ago the wake door said this very machine is running, or null:
 *  what lets the loop ask every 2 s instead of sparingly. */
function confirmedForMs(id: string): number | null {
  const answer = records[id]?.wakeAnswer;
  const entry = loadDaemons().find((d) => d.id === id);
  return answer && wakeConfirmed(entry?.wake, answer) ? Date.now() - answer.at : null;
}

function scheduleReprobe(id: string, sentAt: number, attempt: number): void {
  const timer = setTimeout(async () => {
    wakeTimers.delete(id);
    if (records[id]?.wakeSentAt !== sentAt) return; // answered, or superseded
    const entry = loadDaemons().find((d) => d.id === id);
    if (!entry || entry.archived || entry.revoked) return;
    // With another daemon to ask, a machine the tailnet still has offline
    // is not dialed: the dial would only make this device's Tailscale chase
    // a peer that has not joined yet.
    let answered = false;
    const report = tailnetHelper && tailnetHelper.id !== id ? await askTailnet([entry]) : null;
    if (records[id]?.wakeSentAt !== sentAt) return;
    if (tailnetVerdict(report, entry.host) === "offline") {
      patch(id, { tailnet: { online: false, lastSeen: null, at: Date.now() } });
    } else {
      if (report) patch(id, { tailnet: tailnetVerdict(report, entry.host) === "online" ? { online: true, lastSeen: null, at: Date.now() } : null });
      answered = await probeReach(entry, { force: true });
    }
    if (answered || records[id]?.wakeSentAt !== sentAt) return;
    if (wakeReachedOther(entry.wake, records[id]?.wakeAnswer)) return;
    if (Date.now() - sentAt >= WAKE_CEILING_MS) {
      touch(); // "no answer · tap Wake again" — and no second wake
      return;
    }
    scheduleReprobe(id, sentAt, attempt + 1);
  }, wakeReprobeDelayMs(attempt, confirmedForMs(id)));
  wakeTimers.set(id, timer);
}

/** `POST /api/sleep` answered 202: the switcher says "going to sleep…"
 *  through the grace, then "no answer" (a 202 is a request accepted, not a
 *  sleep seen), without waiting for a probe to time out. */
export function markSlept(id: string): void {
  stopWaking(id);
  stopConfirming(id);
  writeRegistry(id, { sleptAt: Date.now() });
  patch(id, { probe: "failed", probedAt: Date.now(), misses: 1, wakeSentAt: null, wakeAnswer: null, awaiting: [] });
  saveWakes();
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
    wakeAnswer: record?.wakeAnswer,
    sleptAt: entry.sleptAt,
    now: Date.now(),
  });
}

if (typeof window !== "undefined") restoreWakes();
