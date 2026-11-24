/** Sleep and wake, the rules the app follows (docs/sleep.md), kept away from
 *  `fetch` and React so they can be tested without a browser — the same
 *  arrangement as `api-request.ts`.
 *
 *  "Hosts sleep, narratives don't." A host that is stopped has no tailnet
 *  address, so the switcher's probe (`GET /api/status`) can only time out on
 *  it, and it cannot tell asleep from broken. What tells them apart is the
 *  wake recipe the daemon reported the last time it *was* reachable, stored
 *  on the device's registry entry: a host with a URL to wake it that does
 *  not answer is *probably asleep*; one without is *unreachable*. */

/** How to wake a host, as `GET /api/status` reports it. `none` is a recipe
 *  too, with the reason the app shows instead of a Wake that does nothing
 *  ("not a Fly machine", "always up"). */
export type WakeRecipe = { kind: "url"; url: string } | { kind: "none"; reason: string };

/** The daemon's own sleep posture, from `GET /api/status`. `idle_minutes` is
 *  null when the host never sleeps by itself; `sessions` counts the tmux
 *  sessions that keep it awake. */
export interface SleepStatus {
  idle_minutes: number | null;
  last_client_disconnect: number | null;
  sessions: number;
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

/** After a Wake tap, the tailnet address is re-probed this often… */
export const WAKE_REPROBE_INTERVAL_MS = 5_000;
/** …for this long, then the row says "still asleep" and offers Wake again.
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

/** The one request that wakes a host: an opaque fetch to the Fly Proxy URL.
 *  Every field is load-bearing:
 *  - `no-cors`: Fly sends no CORS headers, and the app needs no answer —
 *    the machine starts because the request arrived. The response is opaque.
 *  - `redirect: "follow"`: Chromium refuses a `no-cors` request whose
 *    redirect mode is `error` before sending it at all.
 *  - `cache: "no-store"`: an HTTP cache that answered would wake nothing.
 *  No headers, no body, no credentials beyond the browser's default.
 *  A fresh object each call, so no caller can mutate the next one's. */
export function wakeFetchInit(): { mode: "no-cors"; redirect: "follow"; cache: "no-store" } {
  return { mode: "no-cors", redirect: "follow", cache: "no-store" };
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
    return { kind: "url", url: v.url };
  }
  if (v.kind === "none") {
    return { kind: "none", reason: typeof v.reason === "string" && v.reason ? v.reason : "no way to wake it" };
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

/** What the switcher says about a daemon:
 *  - `awake`: it answered (or the control socket is up).
 *  - `checking`: no answer yet, either way.
 *  - `asleep`: it did not answer and has a URL to wake it, or this device
 *    put it to sleep.
 *  - `unreachable`: it did not answer and there is no way to wake it, or no
 *    recipe has been recorded yet.
 *  - `waking`: the operator tapped Wake and the tailnet is being re-probed.
 *  - `still-asleep`: the waking ceiling passed with no answer; Wake again.
 *  - `sleeping`: this device just put it to sleep. */
export type Reach = "awake" | "checking" | "asleep" | "unreachable" | "waking" | "still-asleep" | "sleeping";

export interface ReachInput {
  /** The recipe on the registry entry, from its last good probe. */
  recipe: WakeRecipe | null | undefined;
  /** The latest switcher probe: in flight, answered, or not. */
  probe: "pending" | "ok" | "failed" | undefined;
  /** When the operator last tapped Wake, if the waking loop is running or
   *  ran out. Cleared by a probe that answers. */
  wakeSentAt?: number | null;
  /** When this device put the host to sleep (`POST /api/sleep` → 202).
   *  Cleared by a probe that answers after the grace. */
  sleptAt?: number | null;
  now: number;
}

export function daemonReach({ recipe, probe, wakeSentAt, sleptAt, now }: ReachInput): Reach {
  if (sleptAt != null && now - sleptAt < SLEEPING_GRACE_MS) return "sleeping";
  if (probe === "ok") return "awake";
  if (wakeSentAt != null) return now - wakeSentAt < WAKE_CEILING_MS ? "waking" : "still-asleep";
  if (sleptAt != null) return "asleep";
  if (probe === "failed") return recipe?.kind === "url" ? "asleep" : "unreachable";
  return "checking";
}

/** The word the row shows, or null for an awake host. */
export function reachLabel(reach: Reach, recipe: WakeRecipe | null | undefined): string | null {
  switch (reach) {
    case "awake":
      return null;
    case "checking":
      return "checking…";
    case "sleeping":
      return "going to sleep…";
    case "asleep":
      return "probably asleep";
    case "unreachable":
      return recipe?.kind === "none" ? `unreachable: ${recipe.reason}` : "unreachable";
    case "waking":
      return "waking…";
    case "still-asleep":
      return "still asleep; tap Wake again";
  }
}

/** Whether the row offers Wake: only with a URL to send it to, and not while
 *  a wake is already being waited on, so a second tap can't double it. */
export function canWake(reach: Reach, recipe: WakeRecipe | null | undefined): boolean {
  return recipe?.kind === "url" && (reach === "asleep" || reach === "still-asleep");
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
      return { kind: "wake" };
    case "checking":
      return { kind: "pending", label: "Checking…" };
    case "waking":
      return { kind: "pending", label: "Waking…" };
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
