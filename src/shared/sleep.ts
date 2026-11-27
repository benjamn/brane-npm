import { formatMinutes, relAhead, relPart } from "./narrative-format.js";

/** Sleep and wake, the rules the app follows (docs/sleep.md), kept away from
 *  `fetch` and React so they can be tested without a browser — the same
 *  arrangement as `api-request.ts`.
 *
 *  "Hosts sleep, narratives don't." A host that is stopped has no tailnet
 *  address, so the switcher's probe (`GET /api/status`) can only time out on
 *  it, and it cannot tell asleep from broken, so the row doesn't pretend to:
 *  what it says about a host that doesn't answer is the same for every kind
 *  of host (`reachWords`). The wake recipe the daemon reported the last time
 *  it *was* reachable, stored on the device's registry entry, decides only
 *  whether the row offers Wake. */

/** How to wake a host, as `GET /api/status` reports it. `none` is a recipe
 *  too, with a reason ("no way to wake it"). The row does not show the
 *  reason: what a row says about a host that doesn't answer is the same
 *  whatever kind of host it is (`reachWords`), and the recipe only decides
 *  whether its ⋯ offers Wake. */
/** How a sleeping host is woken. A Fly machine's recipe also says which
 *  machine and region it is: the machine so a wake's answer can be checked
 *  against it, the region so the switcher can say where the host is, awake
 *  or asleep, from what the registry kept. */
export type WakeRecipe = { kind: "url"; url: string; machine?: string; region?: string } | { kind: "none"; reason: string };

/** The reason a host with no way to wake it gives, and the one the app
 *  shows when a daemon gives none. */
export const NO_WAKE_REASON = "no way to wake it";

/** What the wake door answers (`src/fly/wake-listener.ts`): which machine
 *  the request reached. Fly Proxy, not the app, chooses that machine, so the
 *  answer is the only way to know a Wake reached the host it was meant for
 *  rather than a sibling that was already up. */
export interface WakeAnswer {
  /** The answering machine's id, when it gave one. */
  machine: string | null;
  region: string | null;
  /** When the answer arrived, on this device's clock. */
  at: number;
}

const MACHINE_ID = /^[0-9a-z]{6,32}$/;

/** A machine id as Fly writes them, or null: it is shown and compared, so
 *  nothing else passes. */
export function parseMachineId(value: unknown): string | null {
  return typeof value === "string" && MACHINE_ID.test(value) ? value : null;
}

const REGION = /^[a-z]{3}$/;

/** A Fly region code (`nrt`, `ewr`), or null: it is shown, so nothing else
 *  passes. */
export function parseRegion(value: unknown): string | null {
  return typeof value === "string" && REGION.test(value) ? value : null;
}

/** The wake door's JSON body as an answer, or null when it isn't one (a
 *  listener from before it answered, a proxy's error page). */
export function parseWakeAnswer(value: unknown, now: number): WakeAnswer | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const machine = parseMachineId(v.machine);
  const region = parseRegion(v.region);
  if (!machine && !region) return null;
  return { machine, region, at: now };
}

/** Whether a wake that was answered reached some *other* machine: both ids
 *  known, and different. Unknown on either side is not a mismatch. */
export function wakeReachedOther(recipe: WakeRecipe | null | undefined, answer: WakeAnswer | null | undefined): boolean {
  return recipe?.kind === "url" && !!recipe.machine && !!answer?.machine && recipe.machine !== answer.machine;
}

/** The daemon's own sleep posture, from `GET /api/status`. `idle_minutes` is
 *  null when the host never sleeps by itself; `sessions` counts the tmux
 *  sessions that keep it awake. `sleeps_in_ms` is how long the idle rule's
 *  countdown has left as the daemon answers, and only while it is running
 *  (a rule set, no session, no device connected, tmux answering); null
 *  otherwise, and absent from a daemon before 0.3.17. It is relative, not
 *  a time, so the app needs no agreement between its clock and the
 *  daemon's: it subtracts the time since the answer. */
/** How often a daemon checks its idle rule (`IDLE_TICK_MS` in
 *  src/daemon/sleep.ts, which a test keeps equal): a countdown that has
 *  ended may take this long more to become a sleep. */
export const IDLE_CHECK_MS = 60_000;

export interface SleepStatus {
  idle_minutes: number | null;
  last_client_disconnect: number | null;
  sessions: number;
  sleeps_in_ms: number | null;
}

/** The switcher's reachability probe, for its status display only: a stopped
 *  machine's tailnet peer is offline, which times out rather than refusing,
 *  so the request layer's 60 s ceiling (with retries) would leave a row on
 *  "checking…" for minutes. 5 s fits a cold TCP + TLS + request at 741 ms
 *  RTT (~3 s, docs/request-layer.md) with room, and it is one attempt: a
 *  probe that missed is re-sent when the switcher is next opened, or by the
 *  waking loop. Melding and adding a daemon keep the full budget. */
export const SWITCHER_PROBE_TIMEOUT_MS = 5_000;
export const SWITCHER_PROBE_ATTEMPTS = 1;

/** After a Wake tap, the tailnet address is re-probed after each of these
 *  waits in turn (the last one repeating): six probes in three minutes
 *  where one every 5 s was eighteen. A probe of a host that is not there is
 *  not free: the device's Tailscale dials the peer's home relay and retries
 *  the handshake every 5 s for each one (measured 2026-11-25: 11 to 12
 *  relay misses a minute per stopped machine while a tab re-probed three).
 *  The first waits are short because a woken machine answers in seconds. */
export const WAKE_REPROBE_DELAYS_MS: readonly number[] = [4_000, 8_000, 15_000, 30_000, 45_000, 60_000];

/** …unless the wake door has said this machine is running. Then the peer
 *  is not absent, it is booting, and a dial is aimed at something that is
 *  about to be there: ask every 2 s for the first half minute. Measured
 *  2026-11-26 on nrt: proxy start to daemon listening is 8 s, and the app
 *  connected 7 s after that, all of it waiting for its next 5 s tick. */
export const WAKE_CONFIRMED_REPROBE_MS = 2_000;
export const WAKE_CONFIRMED_WINDOW_MS = 30_000;

/** The wait before re-probe number `attempt`. `confirmedForMs` is how long
 *  ago the wake door answered for this very machine, when it has. */
export function wakeReprobeDelayMs(attempt: number, confirmedForMs?: number | null): number {
  if (confirmedForMs != null && confirmedForMs >= 0 && confirmedForMs < WAKE_CONFIRMED_WINDOW_MS) {
    return WAKE_CONFIRMED_REPROBE_MS;
  }
  const i = Math.max(0, Math.min(Math.floor(attempt), WAKE_REPROBE_DELAYS_MS.length - 1));
  return WAKE_REPROBE_DELAYS_MS[i];
}

/** Whether the wake door's answer is from the machine the recipe names:
 *  the one case where "it is coming up" is known rather than hoped. */
export function wakeConfirmed(recipe: WakeRecipe | null | undefined, answer: WakeAnswer | null | undefined): boolean {
  return recipe?.kind === "url" && !!recipe.machine && !!answer?.machine && recipe.machine === answer.machine;
}

/** A probe that fails faster than this was refused or reset, not timed out:
 *  the host is on the tailnet and its daemon is not listening yet, which is
 *  the second or two after a wake (measured: tailnet up at +5 s, daemon
 *  listening at +7 s, and four connections refused in between). Such a miss
 *  is asked again after `PROBE_NOT_READY_RETRY_MS`, a few times, rather
 *  than counted as "still asleep". */
export const PROBE_REFUSED_UNDER_MS = 1_500;
export const PROBE_NOT_READY_RETRY_MS = 1_500;
export const PROBE_NOT_READY_RETRIES = 4;

/** How long an answer stays fresh: opening the switcher again within it
 *  re-asks nobody. */
export const PROBE_FRESH_MS = 30_000;
/** A host that did not answer is asked again no sooner than this, doubling
 *  per consecutive miss up to the cap: the switcher is opened often, and a
 *  sleeping machine has nothing new to say. A Wake tap asks regardless. */
export const PROBE_MISS_BACKOFF_MS = 60_000;
export const PROBE_MISS_BACKOFF_MAX_MS = 5 * 60_000;
/** A first miss from a host that was answering is checked once more, this
 *  much later, before the row stops saying it is up: one dropped probe on a
 *  tailnet path that is being renegotiated is normal operation. */
export const PROBE_CONFIRM_DELAY_MS = 3_000;
/** A probe is abandoned this long after its own timeout, whatever state it
 *  is in, so one that stalls can never pin its row. */
export const PROBE_DEADLINE_SLACK_MS = 2_000;

/** Whether the switcher should ask a daemon again now, given when it last
 *  asked and how many times in a row it got no answer. */
export function probeDue(last: { probedAt?: number | null; misses?: number }, now: number): boolean {
  if (last.probedAt == null) return true;
  const misses = last.misses ?? 0;
  const wait = misses <= 0 ? PROBE_FRESH_MS : Math.min(PROBE_MISS_BACKOFF_MS * 2 ** (misses - 1), PROBE_MISS_BACKOFF_MAX_MS);
  return now - last.probedAt >= wait;
}

/** What a probe that got no answer makes of the row: a host that was
 *  answering keeps saying so through its first miss (and is asked once
 *  more); anything else is a miss. */
export function probeAfterMiss(previous: "pending" | "ok" | "failed" | undefined, misses: number): "ok" | "failed" {
  return previous === "ok" && misses <= 1 ? "ok" : "failed";
}

/** …and the waking state lasts this long, then the row says "still asleep"
 *  and offers Wake again.
 *  Boot-to-first-narration on a stopped machine is not yet measured
 *  (docs/sleep.md, Steps 1); this is the knob that number will set. The
 *  re-probes go to the tailnet, never to the wake URL, and nothing here ever
 *  sends a second wake: every request to Fly Proxy is a start that costs
 *  machine-minutes, so only the operator's tap sends one. */
export const WAKE_CEILING_MS = 180_000;

/** How long after a 202 from `POST /api/sleep` the row says "going to
 *  sleep…" before it says "asleep". A probe that answers in this window is
 *  the daemon still shutting down, not a host that woke up. */
export const SLEEPING_GRACE_MS = 10_000;

/** The one request that wakes a host: a fetch to the Fly Proxy URL.
 *  Every field is load-bearing:
 *  - `cors`: the machine starts because the request arrived, whatever the
 *    answer, and a GET with no headers is sent without a preflight in either
 *    mode. What `cors` adds is that the answer can be *read* when the wake
 *    door allows it (`Access-Control-Allow-Origin: *`), and it says which
 *    machine answered. Against a door from before it did, the fetch rejects
 *    after the request has already gone, and the app knows no more than it
 *    did under `no-cors`. It was `no-cors`, which hid the one fact that
 *    made "waking" more than a guess.
 *  - `redirect: "follow"`: the default, kept explicit; the URL is https and
 *    nothing redirects it.
 *  - `cache: "no-store"`: an HTTP cache that answered would wake nothing.
 *  No headers, no body, no credentials.
 *  A fresh object each call, so no caller can mutate the next one's. */
export function wakeFetchInit(): { mode: "cors"; redirect: "follow"; cache: "no-store" } {
  return { mode: "cors", redirect: "follow", cache: "no-store" };
}

/** The recipe in a status response, or null when the field is absent (a
 *  daemon from before it) or malformed. A URL recipe must be http(s): the
 *  app fetches it, and nothing else is a request Fly Proxy could answer. */
export function parseWakeRecipe(value: unknown): WakeRecipe | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "url" && typeof v.url === "string") {
    let parsed: URL;
    try {
      parsed = new URL(v.url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const machine = parseMachineId(v.machine);
    const region = parseRegion(v.region);
    return { kind: "url", url: v.url, ...(machine ? { machine } : {}), ...(region ? { region } : {}) };
  }
  if (v.kind === "none") {
    return { kind: "none", reason: typeof v.reason === "string" && v.reason ? v.reason : NO_WAKE_REASON };
  }
  return null;
}

/** The sleep posture in a status response, or null when absent. */
export function parseSleepStatus(value: unknown): SleepStatus | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    idle_minutes: num(v.idle_minutes),
    last_client_disconnect: num(v.last_client_disconnect),
    sessions: num(v.sessions) ?? 0,
    sleeps_in_ms: (() => {
      const n = num(v.sleeps_in_ms);
      return n !== null && n >= 0 ? n : null;
    })(),
  };
}

/** The narratives a status lists as parked awaiting direction (`awaiting`):
 *  the undead. Untrusted shape; anything but an array of strings is none,
 *  as from a daemon before the field. */
export function parseAwaitingNids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

/** "2 undead": the agents parked awaiting input. Not running, not dead,
 *  and each a tmux session holding the host awake (docs/sleep.md, "The
 *  undead count"). */
export function undeadLine(undead: number): string {
  return `${undead} undead`;
}

/** One short line for a daemon's row: "sleeps after 15 min idle ·
 *  2 sessions", or "never sleeps on its own · 0 sessions", and with any
 *  undead, "· 3 sessions, 2 undead". Idle means no sessions and no client
 *  connected (docs/sleep.md, Decisions), so a host with sessions running is
 *  not counting down, and the undead are the sessions that will not end on
 *  their own. */
export function sleepLine(s: SleepStatus, undead = 0): string {
  const rule = s.idle_minutes === null ? "never sleeps on its own" : `sleeps after ${s.idle_minutes} min idle`;
  const sessions = `${s.sessions} session${s.sessions === 1 ? "" : "s"}`;
  return `${rule} · ${sessions}${undead > 0 ? `, ${undeadLine(undead)}` : ""}`;
}

/** What a daemon row says under its name about its posture: the sleep line
 *  when the status carried one, else the undead alone when there are any,
 *  else nothing. */
export function postureLine(s: SleepStatus | null, undead: number): string | null {
  if (s) return sleepLine(s, undead);
  return undead > 0 ? undeadLine(undead) : null;
}

/** What the switcher knows about a daemon. These decide what a row offers
 *  (`canWake`, `sleepWakeSlot`) and its dot; the words are `reachWords`',
 *  which say the same of `asleep` and `unreachable` ("no answer", or "off
 *  the tailnet"): the names differ only in whether a Wake could follow.
 *  - `awake`: it answered (or the control socket is up).
 *  - `checking`: no answer yet, either way.
 *  - `asleep`: it did not answer and has a URL to wake it, or this device
 *    put it to sleep.
 *  - `unreachable`: it did not answer and there is no way to wake it, or no
 *    recipe has been recorded yet.
 *  - `waking`: the operator tapped Wake and nothing has answered yet.
 *  - `connecting`: the wake door answered, so the machine is running; its
 *    tailnet address has not answered yet.
 *  - `woke-other`: the wake door answered from a different machine. Wake is
 *    offered again.
 *  - `still-asleep`: the waking ceiling passed with no answer; Wake again.
 *  - `sleeping`: this device just put it to sleep. */
export type Reach =
  | "awake"
  | "checking"
  | "asleep"
  | "unreachable"
  | "waking"
  | "connecting"
  | "woke-other"
  | "still-asleep"
  | "sleeping";

export interface ReachInput {
  /** The recipe on the registry entry, from its last good probe. */
  recipe: WakeRecipe | null | undefined;
  /** The latest switcher probe: in flight, answered, or not. */
  probe: "pending" | "ok" | "failed" | undefined;
  /** When the operator last tapped Wake, if the waking loop is running or
   *  ran out. Cleared by a probe that answers. */
  wakeSentAt?: number | null;
  /** What the wake door said, once it has: the machine is running. */
  wakeAnswer?: WakeAnswer | null;
  /** When this device put the host to sleep (`POST /api/sleep` → 202).
   *  Cleared by a probe that answers after the grace. */
  sleptAt?: number | null;
  now: number;
}

export function daemonReach({ recipe, probe, wakeSentAt, wakeAnswer, sleptAt, now }: ReachInput): Reach {
  if (sleptAt != null && now - sleptAt < SLEEPING_GRACE_MS) return "sleeping";
  if (probe === "ok") return "awake";
  if (wakeSentAt != null) {
    if (wakeReachedOther(recipe, wakeAnswer)) return "woke-other";
    if (now - wakeSentAt >= WAKE_CEILING_MS) return "still-asleep";
    return wakeAnswer ? "connecting" : "waking";
  }
  if (sleptAt != null) return "asleep";
  if (probe === "failed") return recipe?.kind === "url" ? "asleep" : "unreachable";
  return "checking";
}

/** Where a daemon is, for its status line ("awake in nrt"): the region a
 *  cloud host's recipe kept from its last status, so it shows asleep or
 *  awake. Null for a host that reports none. */
export function daemonRegion(recipe: WakeRecipe | null | undefined): string | null {
  return recipe?.kind === "url" ? recipe.region ?? null : null;
}

/** The row's state for a daemon that is not simply awake, split in two:
 *  a short `word` for the line that opens with the dot, which is one line
 *  and must not be cut, and `why`, for the detail line under it.
 *
 *  Each says only what the app observed, as tersely as the row's space
 *  needs, and the same for every kind of host. A probe with no reply is
 *  "no answer", not "asleep": a laptop with its lid shut, a stopped cloud
 *  machine and a broken path look alike from here. A Sleep the daemon
 *  accepted (202) is not a sleep seen; a wake sent is not a machine
 *  started; and a wake another machine answered says only who answered.
 *  The recipe decides what the row offers (Wake, in the ⋯), never what it
 *  claims. */
export function reachWords(
  reach: Reach,
  // Unused on purpose: what a row says doesn't depend on the kind of host.
  // Kept so every caller passes the recipe, which decides only what the
  // row offers (`canWake`, `sleepWakeSlot`), and the tests can show the
  // words are the same for every recipe.
  _recipe: WakeRecipe | null | undefined,
  answer?: WakeAnswer | null,
  tailnet?: TailnetVerdict,
): { word: string; why: string | null } {
  switch (reach) {
    case "awake":
      return { word: "awake", why: null };
    case "checking":
      return { word: "checking…", why: null };
    case "sleeping":
      return { word: "going to sleep…", why: null };
    case "asleep":
    case "unreachable":
      // "off the tailnet", not "offline": what is known is the tailnet's
      // listing, from a daemon whose Tailscale is running and healthy
      // (`tailnetTrusted`), not whether the machine itself is off.
      if (tailnet === "online") return { word: "no answer", why: "on the tailnet" };
      return { word: tailnet === "offline" ? "off the tailnet" : "no answer", why: null };
    case "waking":
      return { word: "wake sent", why: null };
    case "connecting":
      return { word: "machine is up", why: "connecting…" };
    case "woke-other":
      return { word: `${answer?.region ?? "another"} answered`, why: "not this machine" };
    case "still-asleep":
      return { word: "no answer", why: "tap Wake again" };
  }
}

/** A daemon row's third line, what its state word does not say. Awake:
 *  how many sessions keep it up and its sleep rule (when the status carried
 *  them), and the path it sees to this device (the current daemon only).
 *  The undead are not counted here: each is already one of the sessions,
 *  and the row's glow shows them, in their own hues. Not awake: why
 *  (`reachWords`), else
 *  when this device last heard from it. Null when there is nothing to add.
 *  The address is not here: it is long, rarely wanted, and its row's ⋯
 *  copies it. */
export function daemonDetailText(
  awake: boolean,
  sleep: SleepStatus | null,
  path: string | null,
  lastSeenAt: number | null | undefined,
  now: number = Date.now(),
  why: string | null = null,
  /** When this device got `sleep` (the record's `statusAt`), to count its
   *  `sleeps_in_ms` down from. */
  statusAt: number | null = null,
): string | null {
  if (!awake) {
    if (why) return why;
    if (lastSeenAt == null) return null;
    const seen = relPart(lastSeenAt, now);
    return `last seen ${seen.ago ? `${seen.val} ago` : seen.val}`;
  }
  const running = sleep ? `${sleep.sessions} session${sleep.sessions === 1 ? "" : "s"}` : null;
  // Only a rule the daemon has: no rule is not a promise to stay up (a
  // laptop sleeps with its lid), so nothing is said in its place.
  return [running, sleepPhrase(sleep, statusAt, now), path].filter(Boolean).join(" · ") || null;
}

/** When the countdown on `sleep` ends, on this device's clock: its answer's
 *  `sleeps_in_ms` from when the answer arrived. Null with no countdown. */
function countdownEnd(sleep: SleepStatus | null, statusAt: number | null): number | null {
  return sleep?.sleeps_in_ms != null && statusAt != null ? statusAt + sleep.sleeps_in_ms : null;
}

/** The sleep part of an awake row's detail line. While the countdown runs,
 *  what is left of it (`relAhead`: minutes ticking down, then the last
 *  minute in seconds). At its end the daemon may take one check more to
 *  act, so for that long "sleep due". Past that the status no longer says
 *  anything about now (the host has likely slept, and nothing has asked it
 *  since), so the row stops claiming a time and gives the rule, as it does
 *  while the countdown is held. */
function sleepPhrase(sleep: SleepStatus | null, statusAt: number | null, clock: number): string | null {
  const end = countdownEnd(sleep, statusAt);
  // A clock set back since the answer counts from the answer, never adding
  // time the daemon didn't report.
  const now = statusAt != null ? Math.max(clock, statusAt) : clock;
  if (end !== null) {
    const ahead = relAhead(end, now);
    if (ahead) return ahead.ahead ? `sleeps in ${ahead.val}` : `sleeps ${ahead.val}`;
    if (now - end < IDLE_CHECK_MS) return "sleep due";
  }
  return sleep?.idle_minutes != null ? `sleeps after ${formatMinutes(sleep.idle_minutes)} idle` : null;
}

/** How long until `sleepPhrase` would say something else, so the switcher
 *  redraws exactly then (each second in the last minute, each minute
 *  before) and not at all with no countdown showing. */
export function sleepPhraseChangesInMs(sleep: SleepStatus | null, statusAt: number | null, clock: number = Date.now()): number | null {
  const end = countdownEnd(sleep, statusAt);
  if (end === null) return null;
  const now = statusAt != null ? Math.max(clock, statusAt) : clock;
  const ahead = relAhead(end, now);
  if (ahead) return ahead.changesInMs;
  const past = now - end;
  return past < IDLE_CHECK_MS ? IDLE_CHECK_MS - past : null;
}

/** The row's state as one line, or null for an awake host: `reachWords`
 *  joined, for wherever the word and its reason share a line. */
export function reachLabel(
  reach: Reach,
  recipe: WakeRecipe | null | undefined,
  answer?: WakeAnswer | null,
  tailnet?: TailnetVerdict,
): string | null {
  if (reach === "awake") return null;
  const { word, why } = reachWords(reach, recipe, answer, tailnet);
  return why ? `${word}; ${why}` : word;
}

// ── What an awake daemon's Tailscale says about the others ───────────────
//
// `GET /api/tailnet` (src/tailscale.ts): the daemon the app is connected to
// reads its own `tailscale status` and answers for the hosts asked. The app
// cannot ask its own device's Tailscale anything, and dialing a peer that
// is offline is the expensive way to learn it (the device's Tailscale
// chases the peer through its home relay for as long as something asks).
// So a peer the tailnet says is offline is shown asleep with no dial at
// all, and only one it says is online is probed.

export interface TailnetPeerInfo {
  host: string;
  online: boolean;
  /** When control last saw it, if it is offline. */
  lastSeen: string | null;
  /** The answering daemon's own path to it. */
  direct: boolean;
  relay: string | null;
}

export interface TailnetReport {
  /** False when the daemon's Tailscale did not answer: nothing is known. */
  available: boolean;
  /** The daemon's Tailscale `BackendState` ("Running", "Stopped",
   *  "NeedsLogin", …); null from a daemon that didn't say. */
  state: string | null;
  health: string[];
  peers: TailnetPeerInfo[];
  /** The device that asked, as the daemon sees it; null when it can't tell. */
  client: TailnetPeerInfo | null;
}

/** Lowercase, no port, no trailing dot: how tailnet hosts are compared. */
export function tailnetHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

function parseTailnetPeer(value: unknown): TailnetPeerInfo | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.host !== "string" || v.host === "" || typeof v.online !== "boolean") return null;
  return {
    host: tailnetHost(v.host),
    online: v.online,
    lastSeen: typeof v.last_seen === "string" ? v.last_seen : null,
    direct: v.direct === true,
    relay: typeof v.relay === "string" && v.relay !== "" ? v.relay : null,
  };
}

/** The route's answer, or null when it is not one (an older daemon's 404
 *  body, a proxy's page): the caller then probes as if it had not asked. */
export function parseTailnetReport(value: unknown): TailnetReport | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.available !== "boolean") return null;
  const peers = Array.isArray(v.peers) ? v.peers.map(parseTailnetPeer).filter((p): p is TailnetPeerInfo => p !== null) : [];
  return {
    available: v.available,
    state: typeof v.state === "string" && v.state ? v.state : null,
    health: Array.isArray(v.health) ? v.health.filter((h): h is string => typeof h === "string") : [],
    peers,
    client: parseTailnetPeer(v.client),
  };
}

/** `offline`: control has the peer disconnected, so nothing would answer a
 *  dial and none is made. `online`: worth one probe. `unknown`: the daemon
 *  had no Tailscale to ask or does not have this host as a peer; probe as
 *  if nobody had been asked. */
export type TailnetVerdict = "offline" | "online" | "unknown";

/** Whether a daemon's word on the tailnet can be taken at all: its
 *  Tailscale answered, is `Running`, and reports no health warnings. A
 *  stopped or logged-out Tailscale still prints its last peer list, and one
 *  that has lost the coordination server (a health warning) has an
 *  `Online` per peer that is only as fresh as its last contact; either
 *  would make "off the tailnet" a claim nobody checked. Untrusted is
 *  unknown, and the app probes as if it had not asked. */
export function tailnetTrusted(report: TailnetReport | null | undefined): report is TailnetReport {
  return !!report?.available && report.state === "Running" && report.health.length === 0;
}

export function tailnetVerdict(report: TailnetReport | null | undefined, host: string): TailnetVerdict {
  if (!tailnetTrusted(report)) return "unknown";
  const peer = report.peers.find((p) => p.host === tailnetHost(host));
  if (!peer) return "unknown";
  return peer.online ? "online" : "offline";
}

/** How long a daemon's word about a peer colours that peer's row. */
export const TAILNET_WORD_FRESH_MS = 90_000;

/** The path between the device and the daemon it is connected to, in the
 *  daemon's words: what a slow or stuck connection is usually about. */
export function pathLabel(client: TailnetPeerInfo | null | undefined): string | null {
  if (!client) return null;
  if (client.direct) return "direct";
  return client.relay ? `relayed via ${client.relay}` : "relayed";
}

/** Whether the row offers Wake: only with a URL to send it to, and not while
 *  a wake is already being waited on, so a second tap can't double it. */
export function canWake(reach: Reach, recipe: WakeRecipe | null | undefined): boolean {
  return recipe?.kind === "url" && (reach === "asleep" || reach === "still-asleep" || reach === "woke-other");
}

/** Whether the daemon can be put to sleep from the app: a host the app can
 *  also wake. A Mac (`none`) can't be woken from here, so it isn't offered. */
export function canSleep(recipe: WakeRecipe | null | undefined): boolean {
  return recipe?.kind === "url";
}

/** The Wake/Sleep slot in a daemon row's ⋯ menu. A host the app can wake
 *  (a URL recipe) always has one, so the operator finds the same control in
 *  the same place on every remote machine: Sleep while it answers, Wake
 *  while it doesn't, and in between a disabled item naming the state, so a
 *  second tap can't double a wake or a sleep. A host with no URL recipe (a
 *  Mac) has none: nothing here could bring it back.
 *
 *  `offer` is that row's own `sleepOffer`: whether *this page* is served by
 *  *that* host, which is not the same as whether it is the connected
 *  daemon. On A's bundle, switched to B, it is A's row whose Sleep would
 *  take the page down, so A's Sleep hops (`hop` names the shared app) and
 *  B's doesn't. With nowhere to hop to (`offer` null), an awake host
 *  serving this page has no slot.
 *
 *  `unreachable` can't happen with a URL recipe (`daemonReach` calls that
 *  *asleep*); it gets no slot all the same. */
export type SleepWakeSlot =
  | { kind: "wake" }
  | { kind: "sleep"; hop?: string }
  | { kind: "pending"; label: string }
  | null;

export function sleepWakeSlot(reach: Reach, recipe: WakeRecipe | null | undefined, offer: SleepOffer): SleepWakeSlot {
  if (!canSleep(recipe)) return null;
  switch (reach) {
    case "awake":
      if (!offer) return null;
      return offer.kind === "hop" ? { kind: "sleep", hop: offer.appHost } : { kind: "sleep" };
    case "asleep":
    case "still-asleep":
    case "woke-other":
      return { kind: "wake" };
    case "checking":
      return { kind: "pending", label: "Checking…" };
    case "waking":
      return { kind: "pending", label: "Waking…" };
    case "connecting":
      return { kind: "pending", label: "Connecting…" };
    case "sleeping":
      return { kind: "pending", label: "Going to sleep…" };
    case "unreachable":
      return null;
  }
}

/** Where the switcher offers Sleep for a daemon's row.
 *  `here`: on this page. `hop`: this page is that daemon's own bundle
 *  (isolated against that row's host, whether or not it is the connected
 *  daemon), which goes away with the daemon, leaving nothing to tap
 *  Wake on; so Sleep moves to the shared app (`appHost`), whose switcher
 *  outlives the host. `null`: isolated with no shared app to go to. */
export type SleepOffer = { kind: "here" } | { kind: "hop"; appHost: string } | null;

export function sleepOffer(isolated: boolean, appHost: string | null | undefined): SleepOffer {
  if (!isolated) return { kind: "here" };
  return appHost ? { kind: "hop", appHost } : null;
}

/** The fragment param that carries a hop's Sleep: the brane id of the
 *  daemon to offer Sleep for once the shared app has it connected. It only
 *  ever *opens the confirm*: a link cannot put a daemon to sleep. */
export const SLEEP_INTENT_PARAM = "sleep";

/** How long a carried intent stays good: long enough for the shared app to
 *  load, connect and (for a daemon new to it) be melded; short enough that
 *  one declined never surprises the operator later in the tab. */
export const SLEEP_INTENT_TTL_MS = 5 * 60_000;

/** `url` with `sleep=<braneId>` set in its fragment, beside what is there. */
export function withSleepIntent(url: string, braneId: string): string {
  const at = url.indexOf("#");
  const base = at === -1 ? url : url.slice(0, at);
  const params = new URLSearchParams(at === -1 ? "" : url.slice(at + 1));
  params.set(SLEEP_INTENT_PARAM, braneId);
  return `${base}#${params.toString()}`;
}

/** The intent in a location hash (with or without `#`), or null. */
export function sleepIntentFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(raw).get(SLEEP_INTENT_PARAM) || null;
}

/** The hash without the intent; `""` or a string with a leading `#`. */
export function withoutSleepIntent(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return "";
  const params = new URLSearchParams(raw);
  params.delete(SLEEP_INTENT_PARAM);
  const rest = params.toString();
  return rest ? `#${rest}` : "";
}

/** A stored intent as `{ braneId, at }`, or null when unreadable. */
export interface SleepIntent {
  braneId: string;
  at: number;
}

export function parseSleepIntent(value: unknown): SleepIntent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<SleepIntent>;
  return typeof v.braneId === "string" && v.braneId && typeof v.at === "number" ? { braneId: v.braneId, at: v.at } : null;
}

/** Whether a stored intent asks for `braneId`'s Sleep now. */
export function sleepIntentDue(intent: SleepIntent | null, braneId: string | null | undefined, now: number): boolean {
  return !!intent && !!braneId && intent.braneId === braneId && now - intent.at >= 0 && now - intent.at < SLEEP_INTENT_TTL_MS;
}

/** Whether a failed status probe still heard from the host: an HTTP answer
 *  of any status (a 401 for a revoked token, a 5xx) means it is up, and
 *  only no answer at all (a timeout, a refused connection) can mean it is
 *  asleep. The probes put the status on the error they throw. */
export function probeHeardHost(err: unknown): boolean {
  return typeof (err as { status?: unknown } | null | undefined)?.status === "number";
}
