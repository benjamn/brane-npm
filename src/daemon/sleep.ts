/**
 * Sleep — the daemon putting its own host to sleep (docs/sleep.md).
 *
 * "Hosts sleep, narratives don't." Sleep is a verb the daemon performs on
 * itself: it says goodbye to the live narratives, writes down which they
 * were, and exits. Nothing outside stops the machine in the normal path;
 * on Fly the daemon is the machine's main process, so its exit is the
 * machine stopping. There are exactly two requests for it:
 *
 * - **The idle rule**, the one automatic sleep: no tmux session exists for
 *   any narrative, and `sleep.idle_minutes` have passed since the last
 *   control-socket client disconnected. Never a judgement about content: a
 *   working agent looks like one that isn't listening, so any session at
 *   all keeps the host awake. Unset, zero or invalid means never.
 * - **The operator's Sleep act**, `POST /api/sleep`.
 *
 * Both are *elective* and run the routine with no time budget. A *signal*
 * (SIGTERM from `fly machine stop`, from `brane daemon stop`, or Ctrl-C
 * on a foreground daemon) runs the same routine, bounded so it finishes well
 * inside Fly's `kill_timeout`.
 *
 * The routine: (1) which narratives are live, (2) a `sleeping` note into
 * each, (3) `~/.brane/sleep-manifest.json`, (4) `~/.brane/exit-record.json`,
 * (5) on Fly, every tmux session ended, (6) `tailscale down` where that
 * is wanted, (7) the daemon's ordinary shutdown.
 *
 * **A stop is not a sleep.** A signal cannot say who sent it, and on a
 * Mac `brane daemon stop` is a SIGTERM whose tmux sessions all outlive
 * the daemon. (An in-place restart is no signal: it is a handoff,
 * `doShutdown({ port })`, which writes an exit record of its own, reason
 * `restart`, and none of the rest.) So on a signal, the note and the manifest happen only where
 * boot revive is on (a Fly machine, or `sleep.boot_revive`) and something
 * is live, and `tailscale down` only on Fly — a Mac that ran it on restart
 * would drop off its own tailnet with nothing to bring it back. Boot revive
 * is a second guard: it skips a narrative whose tmux session is still
 * alive, so even a manifest written across a restart types nothing into a
 * running agent and starts no second process. Elective sleeps always write
 * the manifest; on the idle path its `narratives` is empty by construction.
 *
 * Every shell-out (`tmux`, `tailscale`) is behind an injected function, so
 * the suite never spawns one (`src/test/sleep.test.ts`).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { SleepStatus, WakeRecipe } from "../shared/sleep.js";

export type SleepReason = "idle" | "operator" | "signal";

/** What `~/.brane/sleep-manifest.json` holds: which narratives were live
 *  when the host slept, read back by boot revive. Times are epoch ms. */
export interface SleepManifest {
  slept_at: number;
  reason: SleepReason;
  narratives: string[];
  host: string;
}

/** What `~/.brane/exit-record.json` holds, written just before the daemon
 *  hands off to its shutdown. A boot that finds none means the last run
 *  crashed, was killed, or ran out of its budget. */
/** Why a run ended cleanly: one of the sleeps, or an in-place restart. */
export type ExitReason = SleepReason | "restart";

export interface ExitRecord {
  exited_at: number;
  reason: ExitReason;
  clean: true;
  pid: number;
}

/** `wake` and `sleep` in `GET /api/status`: one definition, the app's, so
 *  the daemon and the app cannot disagree on the contract. */
export type { WakeRecipe, SleepStatus };

export const SLEEP_MANIFEST = "sleep-manifest.json";
export const SLEEP_MANIFEST_LAST = "sleep-manifest.last.json";
export const EXIT_RECORD = "exit-record.json";
export const EXIT_RECORD_LAST = "exit-record.last.json";

/** How often the idle rule is evaluated. Minutes are its unit, so a minute's
 *  granularity costs at most one minute of extra wake. */
export const IDLE_TICK_MS = 60_000;
/** How long `GET /api/status` reuses a session count. The app probes status
 *  on every daemon switch and foreground, and a `tmux list-sessions` per
 *  probe would be cheap but blocking. */
export const SESSIONS_CACHE_MS = 5_000;
/** The whole signalled routine, after which the process exits regardless.
 *  Fly's `kill_timeout` is 120 s; this leaves a margin for the kernel. */
export const SIGNAL_BUDGET_MS = 90_000;
/** An elective sleep's last step: once the routine has handed off to the
 *  daemon's shutdown, the process exits by this deadline whatever is still
 *  open. Shutdown waits for every listener to close, so for every
 *  connection; with the tailnet already down a client's can't finish
 *  (measured: a phone's WebSocket held a sleep 31 s, `ws`'s close timeout),
 *  and an HTTP response in flight has no timeout at all, which would leave
 *  the machine running, off the tailnet, unwakeable (claude-46sy2xmw:8). */
export const SHUTDOWN_BACKSTOP_MS = 10_000;
/** `tailscale down` gets this long; an error or a timeout is logged and the
 *  routine goes on. */
export const TAILSCALE_DOWN_TIMEOUT_MS = 10_000;
/** After the sleeping notes, how long the bridges get to hand them to their
 *  agents before the sockets close. */
export const ANNOUNCE_SETTLE_MS = 1_000;
/** After `tmux kill-server`, how long the panes' processes get to exit
 *  before the daemon does: on Fly the daemon's exit unmounts the volume,
 *  and an agent still writing to it leaves it busy (measured on a Fly
 *  machine: `error umounting /home/brane: EBUSY`, then a reboot). */
export const END_SESSIONS_SETTLE_MS = 2_000;
/** Between boot revives: each one launches an agent, and Claude's resume
 *  check (`claude agents --json`) runs synchronously. */
export const BOOT_REVIVE_GAP_MS = 2_000;

/** `sleep.idle_minutes`, else `BRANE_SLEEP_IDLE_MINUTES`, as minutes; null
 *  for never. A config value that is set wins even when it says `0`, so an
 *  operator can switch off what the image's environment switched on. */
export function parseIdleMinutes(config: string | undefined, env: string | undefined): number | null {
  const raw = config !== undefined && config.trim() !== "" ? config : env;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A boolean config value: true, false, or null for unset or unreadable. */
export function parseFlag(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  return null;
}

/** Whether the idle rule says sleep now. Pure: `sessions` must be a fresh
 *  count, read at fire time, and null (tmux could not be asked) never
 *  sleeps. A connected client never sleeps, and neither does a daemon that
 *  has never recorded a disconnect. */
export function idleSleepDue(input: {
  idleMinutes: number | null;
  clients: number;
  sessions: number | null;
  lastClientDisconnect: number | null;
  now: number;
}): boolean {
  const { idleMinutes, clients, sessions, lastClientDisconnect, now } = input;
  if (idleMinutes === null || idleMinutes <= 0) return false;
  if (clients > 0) return false;
  if (sessions === null || sessions > 0) return false;
  if (lastClientDisconnect === null) return false;
  return now - lastClientDisconnect >= idleMinutes * 60_000;
}

/** How a sleeping host is woken. A Fly machine wakes through its app's
 *  public hostname, which the image answers with 204 on `/wake` so Fly
 *  Proxy has a service to start the machine for. Anything else is always
 *  up, or unreachable until someone opens it. */
export function wakeRecipe(env: NodeJS.ProcessEnv = process.env): WakeRecipe {
  const app = env.FLY_APP_NAME?.trim();
  if (app) return { kind: "url", url: `https://${app}.fly.dev/wake` };
  return { kind: "none", reason: "not a Fly machine" };
}

/** Boot revive runs on a Fly machine, or where `sleep.boot_revive` says so;
 *  `sleep.boot_revive false` switches it off on Fly too. */
export function bootReviveEnabled(env: NodeJS.ProcessEnv, config: string | undefined): boolean {
  return parseFlag(config) ?? Boolean(env.FLY_APP_NAME?.trim());
}

/** Whether this sleep ends with `tailscale down`. Stale WireGuard state
 *  for a peer that vanished without saying so breaks iOS peers, so a host
 *  that is going away says so. On a signal only on Fly, whatever the
 *  config says otherwise: a signal may be `brane daemon stop`, and a Mac
 *  that downed its tailnet on a stop would drop off it until someone at
 *  the machine started the daemon again.
 *  `sleep.tailscale_down false` switches it off on Fly as well. */
export function tailscaleDownWanted(reason: SleepReason, env: NodeJS.ProcessEnv, config: string | undefined): boolean {
  const fly = Boolean(env.FLY_APP_NAME?.trim());
  const configured = parseFlag(config);
  if (reason === "signal") return fly && configured !== false;
  return configured ?? fly;
}

/** Whether a sleep for `reason` writes the manifest (and announces): always
 *  when elective, and on a signal only where boot revive would read it and
 *  there is something in it. See the module comment: a restart is not a
 *  sleep. */
export function writesManifest(reason: SleepReason, narratives: readonly string[], bootRevive: boolean): boolean {
  if (reason !== "signal") return true;
  return bootRevive && narratives.length > 0;
}

/** The note each live narrative gets before its bridge drops. */
export function sleepingNote(reason: SleepReason, bootRevive: boolean): string {
  const why =
    reason === "operator"
      ? "the operator put it to sleep"
      : reason === "idle"
        ? "it had no sessions and no clients"
        : "its machine is stopping";
  const after = bootRevive
    ? "When the host has been woken and the operator connects to it, the daemon revives this session with a note saying so."
    : "Revive this session when the host is back.";
  return `This host is going to sleep: ${why}. Your MCP bridge is about to drop; nothing in this narrative is lost. ${after}`;
}

/** The prompt a narrative is revived with after the host wakes. */
export function wakePrompt(manifest: Pick<SleepManifest, "slept_at" | "reason">, resumedAt: number): string {
  return (
    `This host slept at ${new Date(manifest.slept_at).toISOString()} (${manifest.reason}) ` +
    `and resumed at ${new Date(resumedAt).toISOString()}. ` +
    "Re-enter the LIVE loop and read your narrative; nothing was lost."
  );
}

/** Write JSON through a temporary file and a rename, so a reader never
 *  sees half of one. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const REASONS: readonly SleepReason[] = ["idle", "operator", "signal"];
const EXIT_REASONS: readonly ExitReason[] = [...REASONS, "restart"];

export function writeSleepManifest(dir: string, manifest: SleepManifest): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, SLEEP_MANIFEST);
  writeJsonAtomic(path, manifest);
  return path;
}

/** The manifest, or null when there is none or it is not one. */
export function readSleepManifest(dir: string): SleepManifest | null {
  const v = readJson(join(dir, SLEEP_MANIFEST)) as Partial<SleepManifest> | null;
  if (!v || typeof v !== "object") return null;
  if (typeof v.slept_at !== "number" || !REASONS.includes(v.reason as SleepReason)) return null;
  const narratives = Array.isArray(v.narratives) ? v.narratives.filter((n): n is string => typeof n === "string") : [];
  return { slept_at: v.slept_at, reason: v.reason as SleepReason, narratives, host: typeof v.host === "string" ? v.host : "" };
}

/** Move the manifest aside as `sleep-manifest.last.json`, overwriting the
 *  last one. Never deleted: it is the record of the last sleep. */
export function retireSleepManifest(dir: string): boolean {
  const path = join(dir, SLEEP_MANIFEST);
  if (!existsSync(path)) return false;
  renameSync(path, join(dir, SLEEP_MANIFEST_LAST));
  return true;
}

export function writeExitRecord(dir: string, record: ExitRecord): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, EXIT_RECORD);
  writeJsonAtomic(path, record);
  return path;
}

export function readExitRecord(dir: string): ExitRecord | null {
  const v = readJson(join(dir, EXIT_RECORD)) as Partial<ExitRecord> | null;
  if (!v || typeof v !== "object" || typeof v.exited_at !== "number") return null;
  if (!EXIT_REASONS.includes(v.reason as ExitReason)) return null;
  return { exited_at: v.exited_at, reason: v.reason as ExitReason, clean: true, pid: typeof v.pid === "number" ? v.pid : 0 };
}

/** At boot: what the last run's exit record says, logged, and moved aside
 *  as `exit-record.last.json`, so the next boot finds one only if this run
 *  exits cleanly. Returns the record, or null for none (a crash, a kill, a
 *  budget run out, or the first boot). */
export function takeExitRecord(dir: string, log: (m: string) => void = () => {}): ExitRecord | null {
  const record = readExitRecord(dir);
  if (record) {
    log(`last exit: clean, ${record.reason}, at ${new Date(record.exited_at).toISOString()} (pid ${record.pid})`);
  } else {
    log("no exit record from the last run: it crashed, was killed, or ran out of its shutdown budget (or this is the first boot)");
  }
  try {
    if (existsSync(join(dir, EXIT_RECORD))) renameSync(join(dir, EXIT_RECORD), join(dir, EXIT_RECORD_LAST));
  } catch (err) {
    log(`could not move the exit record aside: ${(err as Error).message}`);
  }
  return record;
}

/** Runs `tmux` with these args and returns its stdout; throws as
 *  `execFileSync` does, with `stderr` on the error. */
export type TmuxRunner = (args: string[]) => string;

/** The tmux session names that exist now, or null when tmux could not be
 *  asked. No server running is an empty set, not an error: that is what a
 *  host with nothing on it looks like. Anything else (a timeout, no tmux
 *  binary) is unknown, and the idle rule never sleeps on unknown. */
export function listTmuxSessions(run: TmuxRunner): Set<string> | null {
  try {
    const out = run(["list-sessions", "-F", "#{session_name}"]);
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "") + String((err as Error).message ?? "");
    if (/no server running|error connecting to/i.test(stderr)) return new Set();
    return null;
  }
}

/** Whether a sleep ends every tmux session before the daemon exits: on a
 *  Fly machine only, where the machine stops with the daemon and every
 *  process dies with it anyway, and where a process still holding the
 *  volume makes its unmount fail. Never on a Mac, where a signal is
 *  `brane daemon stop` and the sessions outlive the daemon by design.
 *  Revive reads the agent's own session files, not its process, so
 *  ending them loses nothing a stop wouldn't. */
export function endsSessions(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.FLY_APP_NAME?.trim());
}

/** Runs `tmux kill-server`, bounded, then gives the panes' processes
 *  `settleMs` to exit; resolves either way. No server is not an error. */
export function runEndSessions(
  tmux: string,
  log: (m: string) => void,
  settleMs = END_SESSIONS_SETTLE_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const settle = () => setTimeout(resolve, settleMs);
    try {
      execFile(tmux, ["kill-server"], { timeout: 5_000 }, (err, _stdout, stderr) => {
        const why = String(stderr || err?.message || "").trim();
        if (err && !/no server running|error connecting to/i.test(why)) log(`tmux kill-server failed (ignored): ${why}`);
        else log("sessions ended (tmux kill-server)");
        settle();
      });
    } catch (err) {
      log(`tmux kill-server failed (ignored): ${(err as Error).message}`);
      resolve();
    }
  });
}

/** Runs `tailscale down`, bounded; resolves either way. */
export function runTailscaleDown(log: (m: string) => void, timeoutMs = TAILSCALE_DOWN_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    try {
      execFile("tailscale", ["down"], { timeout: timeoutMs }, (err, _stdout, stderr) => {
        if (err) log(`tailscale down failed (ignored): ${String(stderr || err.message).trim()}`);
        else log("tailscale down");
        resolve();
      });
    } catch (err) {
      log(`tailscale down failed (ignored): ${(err as Error).message}`);
      resolve();
    }
  });
}

/** A narrative with a live tmux session. */
export interface LiveNarrative {
  id: string;
  role: string;
}

export interface SleeperDeps {
  /** Where the manifest and the exit record go: `~/.brane`. */
  braneDir: string;
  /** Narratives with a tmux session right now, read fresh each call; null
   *  when tmux could not be asked. */
  liveNarratives: () => LiveNarrative[] | null;
  /** `sleep.idle_minutes` / `BRANE_SLEEP_IDLE_MINUTES`, re-read per tick. */
  idleMinutes: () => number | null;
  bootRevive: () => boolean;
  tailscaleDown: (reason: SleepReason) => boolean;
  /** Append a note to a narrative and wake its listeners
   *  (`announceEvent`). */
  announce: (nid: string, content: string) => void;
  /** The daemon's ordinary shutdown, which exits the process. */
  shutdown: () => void;
  runTailscaleDown?: () => Promise<void>;
  /** Whether this sleep ends every tmux session first (`endsSessions`);
   *  absent means never. */
  endSessions?: () => boolean;
  runEndSessions?: () => Promise<void>;
  /** Exit now: the backstop, for a signalled routine from its start, for
   *  an elective one from the hand-off to shutdown. */
  forceExit?: () => void;
  signalBudgetMs?: number;
  shutdownBackstopMs?: number;
  now?: () => number;
  log?: (m: string) => void;
  host?: string;
  pid?: number;
  settleMs?: number;
}

/** What the routine did, for the log and the suite. */
export interface SleepOutcome {
  reason: SleepReason;
  narratives: string[];
  manifest: boolean;
  tailscaleDown: boolean;
}

/** Which live narratives a sleep records and tells: the agents. A utility
 *  session (`POST /api/run`) keeps the host awake like any session, but it
 *  has no agent to tell, and reviving one replays its command unasked. */
export function sleepingNarratives(live: readonly LiveNarrative[]): string[] {
  return live.filter((n) => n.role !== "utility").map((n) => n.id);
}

/** The daemon's sleep: the idle rule's clock and timer, the routine, and
 *  what `GET /api/status` reports. Mirrors `KeepAwake`: start, stop, a
 *  status getter. */
export class Sleeper {
  private timer: NodeJS.Timeout | null = null;
  private lastDisconnect: number | null;
  private clients = 0;
  private sessionsCache: { at: number; count: number } | null = null;
  private entered: SleepReason | null = null;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: SleeperDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    // A host nobody has connected to yet counts from its start: a stray wake
    // with nobody following it goes back to sleep after N minutes, which is
    // what bounds what a stranger's wake can cost.
    this.lastDisconnect = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), IDLE_TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    const n = this.deps.idleMinutes();
    this.log(n === null ? "idle rule off (sleep.idle_minutes unset)" : `idle rule on: sleep after ${n} min with no sessions and no clients`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The control socket's client count changed. Zero starts the clock;
   *  any client clears it. */
  clientsChanged(count: number): void {
    this.clients = count;
    if (count > 0) this.lastDisconnect = null;
    else if (this.lastDisconnect === null) this.lastDisconnect = this.now();
  }

  /** Whether the routine has begun, and why. */
  get sleeping(): SleepReason | null {
    return this.entered;
  }

  /** The agents a sleep now would record. */
  plannedNarratives(): string[] {
    return sleepingNarratives(this.deps.liveNarratives() ?? []);
  }

  /** One evaluation of the idle rule, with tmux asked now. True when it
   *  began a sleep. */
  tick(): boolean {
    if (this.entered) return false;
    const idleMinutes = this.deps.idleMinutes();
    const pre = { idleMinutes, clients: this.clients, lastClientDisconnect: this.lastDisconnect, now: this.now() };
    // Ask tmux only once everything else says yes: it is the one input that
    // costs a process.
    if (!idleSleepDue({ ...pre, sessions: 0 })) return false;
    const live = this.deps.liveNarratives();
    if (live) this.sessionsCache = { at: this.now(), count: live.length };
    if (!idleSleepDue({ ...pre, sessions: live === null ? null : live.length })) return false;
    this.log(`idle: no sessions, and no client for ${idleMinutes} min; going to sleep`);
    void this.sleep("idle");
    return true;
  }

  status(): SleepStatus {
    const t = this.now();
    if (!this.sessionsCache || t - this.sessionsCache.at >= SESSIONS_CACHE_MS) {
      const live = this.deps.liveNarratives();
      // Unknown keeps the last count rather than reporting a guess of zero.
      this.sessionsCache = { at: t, count: live ? live.length : this.sessionsCache?.count ?? 0 };
    }
    return {
      idle_minutes: this.deps.idleMinutes(),
      last_client_disconnect: this.clients > 0 ? null : this.lastDisconnect,
      sessions: this.sessionsCache.count,
    };
  }

  /** Exit after `ms` if the process is still here. Unref'd: it must never be
   *  what keeps a daemon alive. */
  private armBackstop(ms: number, what: string): void {
    if (!this.deps.forceExit) return;
    const backstop = setTimeout(() => {
      this.log(`${what} still running after ${ms / 1000} s; exiting`);
      this.deps.forceExit?.();
    }, ms);
    if (typeof backstop.unref === "function") backstop.unref();
  }

  /** The routine. Resolves null when one is already under way (a SIGTERM
   *  during an elective sleep changes nothing). The daemon's shutdown exits
   *  the process, so in production this never resolves past step 6. */
  async sleep(reason: SleepReason): Promise<SleepOutcome | null> {
    if (this.entered) return null;
    this.entered = reason;
    this.stop();
    if (reason === "signal") this.armBackstop(this.deps.signalBudgetMs ?? SIGNAL_BUDGET_MS, "signalled sleep");
    const now = this.now();
    const bootRevive = this.deps.bootRevive();

    // 1. Who is live. A tmux that cannot be asked records nobody.
    let narratives: string[] = [];
    try {
      narratives = sleepingNarratives(this.deps.liveNarratives() ?? []);
    } catch (err) {
      this.log(`could not list live narratives: ${(err as Error).message}`);
    }
    const manifest = writesManifest(reason, narratives, bootRevive);

    // 2. Tell them, when this is a sleep and not a restart.
    if (manifest && narratives.length > 0) {
      const note = sleepingNote(reason, bootRevive);
      for (const nid of narratives) {
        try {
          this.deps.announce(nid, note);
        } catch (err) {
          this.log(`could not tell ${nid}: ${(err as Error).message}`);
        }
      }
    }

    // 3. The manifest, carrying over one still waiting for an operator: a
    //    wake nobody followed sleeps again on the idle rule, and must not
    //    leave the earlier sleep's agents behind.
    if (manifest) {
      try {
        const written = carryManifest(readSleepManifest(this.deps.braneDir), {
          slept_at: now,
          reason,
          narratives,
          host: this.deps.host ?? hostname(),
        });
        writeSleepManifest(this.deps.braneDir, written);
        this.log(`manifest: ${written.reason}, ${written.narratives.length} narrative(s)`);
      } catch (err) {
        this.log(`could not write the sleep manifest: ${(err as Error).message}`);
      }
    }

    // 4. The exit record, on every exit this routine runs.
    try {
      writeExitRecord(this.deps.braneDir, { exited_at: this.now(), reason, clean: true, pid: this.deps.pid ?? process.pid });
    } catch (err) {
      this.log(`could not write the exit record: ${(err as Error).message}`);
    }

    // Let the bridges hand the notes on before their sockets close.
    if (manifest && narratives.length > 0) {
      await new Promise((r) => setTimeout(r, this.deps.settleMs ?? ANNOUNCE_SETTLE_MS));
    }

    // 5. End the sessions, where the machine is going with the daemon, so
    //    nothing holds the volume when it unmounts.
    if (this.deps.endSessions?.() && this.deps.runEndSessions) await this.deps.runEndSessions();

    // 6. Leave the tailnet, where that is wanted.
    const down = this.deps.tailscaleDown(reason);
    if (down) await (this.deps.runTailscaleDown ?? (() => runTailscaleDown(this.log)))();

    // 7. The ordinary shutdown, which for an elective sleep now has a
    //    deadline too: it waits on every open connection.
    if (reason !== "signal") this.armBackstop(this.deps.shutdownBackstopMs ?? SHUTDOWN_BACKSTOP_MS, "shutdown after sleep");
    this.deps.shutdown();
    return { reason, narratives, manifest, tailscaleDown: down };
  }
}

/** Boot revive: the manifest's narratives, revived one at a time with a
 *  note saying when the host slept and woke. The manifest is moved aside
 *  *before* the first revive, not after: a revive that brings the daemon
 *  down must not be retried on every boot after it. A narrative whose tmux
 *  session is still alive never died (a restart, not a sleep) and is
 *  skipped, so nothing is typed into a running agent. Off, a manifest is
 *  still moved aside, so a stale one cannot fire the day boot revive is
 *  switched on. Returns the narratives it revived. */
export async function bootRevive(deps: {
  braneDir: string;
  enabled: boolean;
  /** Whether a narrative's tmux session exists now. */
  alive: (nid: string) => boolean;
  revive: (nid: string, prompt: string) => Promise<unknown> | unknown;
  now?: () => number;
  log?: (m: string) => void;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string[]> {
  const log = deps.log ?? (() => {});
  const manifest = readSleepManifest(deps.braneDir);
  if (!manifest) {
    // An unreadable one is still moved aside, so it is looked at once.
    if (existsSync(join(deps.braneDir, SLEEP_MANIFEST))) {
      log("sleep manifest unreadable; moved aside");
      retireSleepManifest(deps.braneDir);
    }
    return [];
  }
  retireSleepManifest(deps.braneDir);
  if (!deps.enabled) {
    log(`boot revive off; a manifest from ${new Date(manifest.slept_at).toISOString()} (${manifest.narratives.length} narrative(s)) moved aside unread`);
    return [];
  }
  const now = deps.now ?? Date.now;
  const pause = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const prompt = wakePrompt(manifest, now());
  const revived: string[] = [];
  for (const nid of manifest.narratives) {
    if (deps.alive(nid)) {
      log(`${nid} is still running; not revived`);
      continue;
    }
    if (revived.length > 0) await pause(deps.gapMs ?? BOOT_REVIVE_GAP_MS);
    try {
      await deps.revive(nid, prompt);
      revived.push(nid);
      log(`revived ${nid}`);
    } catch (err) {
      log(`could not revive ${nid}: ${(err as Error).message}`);
    }
  }
  return revived;
}

/** The manifest a sleep writes, given one still on disk: that one was never
 *  restored (no operator connected since the wake), so its agents carry
 *  over, with its time and reason, which the wake prompt reports; anything
 *  live now joins them. Without a waiting one, `next` as it is. */
export function carryManifest(waiting: SleepManifest | null, next: SleepManifest): SleepManifest {
  if (!waiting || waiting.narratives.length === 0) return next;
  const narratives = [...waiting.narratives, ...next.narratives.filter((n) => !waiting.narratives.includes(n))];
  return { slept_at: waiting.slept_at, reason: waiting.reason, narratives, host: next.host };
}

/** Whether a control-socket connection made with a token of this kind
 *  restores the last sleep's manifest: an operator's (a melded device, or
 *  this machine's own client), never an agent's. A wake alone restores
 *  nothing (claude-qdjo1yqn:65, :67): a stranger who knows the wake URL
 *  starts a bare daemon, which the idle rule puts back to sleep, and only
 *  the operator actually connecting brings the agents back. */
export function restoresOnConnect(kind: string): boolean {
  return kind === "device" || kind === "local";
}

/** Boot revive, deferred to the first operator connection and run at most
 *  once per daemon run (`bootRevive` also moves the manifest aside before
 *  its first revive). `run` is the revive; `sleeping` stops a connection
 *  that lands while the host is going back to sleep from reviving into it. */
export class ManifestRestorer {
  private started = false;
  constructor(
    private readonly run: () => Promise<unknown>,
    private readonly sleeping: () => boolean = () => false,
  ) {}

  /** A control socket connected with a token of `kind`. True when this
   *  connection is the one that started the restore. */
  onConnect(kind: string): boolean {
    if (this.started || !restoresOnConnect(kind) || this.sleeping()) return false;
    this.started = true;
    void this.run();
    return true;
  }
}

/** What `POST /api/sleep` answers, before anything runs: 202 with the
 *  narratives the routine will record, or 409 once a sleep is under way.
 *  The route runs the routine itself, after the 202 is sent, since the
 *  routine closes the connection the answer would go out on. */
export function sleepActAnswer(
  sleeper: Pick<Sleeper, "sleeping" | "plannedNarratives">,
): { status: 202; body: { ok: true; narratives: string[] } } | { status: 409; body: { error: string } } {
  if (sleeper.sleeping) return { status: 409, body: { error: "This host is already going to sleep" } };
  return { status: 202, body: { ok: true, narratives: sleeper.plannedNarratives() } };
}
