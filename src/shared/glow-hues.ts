/**
 * Which hue a narrative's awaiting glow wears on this device.
 *
 * The glow used to be the narrative's speaker hash (`speakerHue`), which knows
 * nothing about what else is on screen: two agents parked side by side could
 * glow the same purple, and 🎨 Recolor's `salt + 1` was a fresh random draw
 * that could land on another. The glow's job is to let the operator tell
 * sessions apart at a glance, so the hue is *allocated* instead:
 *
 * - **Chosen once, then sticky.** The first time a narrative glows here it
 *   takes the middle of the widest empty arc among the hues of the other
 *   narratives that glowed recently, and keeps that hue on every later listen.
 *   Nothing moves it automatically — an operator learns sessions by color, and
 *   a hue that shifted whenever a neighbour lit up would be unlearnable.
 * - **Recolor rolls within the clear arcs.** A random hue at least half as far
 *   from the others as the best spot on the wheel, a visible step from the
 *   current one, and clear of the hues this narrative was just recolored away
 *   from. Always taking the widest gap's middle made it a toggle: with one
 *   other session glowing there is one such middle, and alone on the wheel
 *   the fallback flipped to the opposite hue and back again.
 *
 * "Recently" rather than "glowing right now": a session between replies will
 * glow again in a minute, so its hue is still spoken for. Rather than ask
 * every screen for a list of live narratives (the header has none), the store
 * keeps when each hue last glowed and treats the {@link RECENT_LIMIT} most
 * recent within {@link RECENT_MS} as taken. A dead session drops out on its
 * own by never glowing again.
 *
 * Client-side only, like the Recolor salt: a preference of this device's
 * eyes, never sent to the daemon. Window-free so `src/test/glow-hues.test.ts`
 * can pin it; `expo/lib/glow-hues.ts` binds it to `localStorage`.
 */

import { speakerHue } from "./speaker-color.js";

export const GLOW_HUES_STORAGE_KEY = "brane:glow-hues";

/** How long a hue stays spoken for after it last glowed. */
export const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many hues count as taken — the most recently glowing. Past a
 *  dozen, every gap is under 30° anyway, and the sessions that matter are the
 *  ones the operator saw last. */
export const RECENT_LIMIT = 12;
/** `seen` is refreshed on render, so writes are coalesced to one per minute. */
const SEEN_RESOLUTION_MS = 60 * 1000;
/** A Recolor must change the color, not shade it: nothing nearer the current
 *  hue than this. At 45° a fifth of presses moved under 70°, pink to rose or
 *  sky to blue, and read as no change at all; 100° crosses a color family. */
export const MIN_RECOLOR_STEP = 100;
/** A Recolor keeps at least this fraction of the best clearance from the
 *  others that any hue on the wheel could have… */
export const RECOLOR_CLEARANCE = 0.5;
/** …or, when that leaves nowhere a full step away, this fraction. The step
 *  outranks the clearance: with one other session opposite, the arc at half
 *  the best clearance is 180° wide and a 100° step can't be taken inside it. */
export const RECOLOR_CLEARANCE_MIN = 0.25;
/** Hues this narrative was recolored away from are rejected for this long… */
export const REJECTED_MS = 60 * 60 * 1000;
/** …at most this many of them… */
export const REJECTED_LIMIT = 4;
/** …and a Recolor keeps this far from each, so a second press can't undo the
 *  first by stepping back to where it started. */
export const REJECTED_CLEARANCE = 60;

export interface RejectedHue {
  hue: number;
  /** When Recolor moved away from it (ms since epoch). */
  at: number;
}

export interface GlowAssignment {
  hue: number;
  /** When this narrative last glowed (ms since epoch). */
  seen: number;
  /** Hues 🎨 Recolor moved this narrative away from, newest first. */
  rejected?: RejectedHue[];
}

export type GlowAssignments = Record<string, GlowAssignment>;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Shortest distance between two hues around the wheel, in degrees. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

const norm = (h: number) => ((Math.round(h) % 360) + 360) % 360;

/**
 * Midpoints of the empty arcs between `taken` hues, widest first. Ties keep
 * wheel order, so the answer is deterministic. Empty when nothing is taken —
 * the caller decides what a free wheel means.
 */
export function gapMidpoints(taken: number[]): number[] {
  const hues = [...new Set(taken.map(norm))].sort((a, b) => a - b);
  if (hues.length === 0) return [];
  const gaps = hues.map((h, i) => {
    const next = i + 1 < hues.length ? hues[i + 1] : hues[0] + 360;
    const width = next - h;
    return { width, mid: norm(h + width / 2) };
  });
  return gaps
    .map((g, i) => ({ ...g, i }))
    .sort((a, b) => b.width - a.width || a.i - b.i)
    .map((g) => g.mid);
}

export function parseGlowAssignments(raw: string | null | undefined): GlowAssignments {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: GlowAssignments = {};
    for (const [nid, v] of Object.entries(parsed)) {
      const a = v as Partial<GlowAssignment> | null;
      if (a && Number.isFinite(a.hue) && Number.isFinite(a.seen)) {
        out[nid] = { hue: norm(a.hue as number), seen: a.seen as number };
        const rejected = Array.isArray(a.rejected)
          ? a.rejected.filter((r) => r && Number.isFinite(r.hue) && Number.isFinite(r.at))
          : [];
        if (rejected.length) out[nid].rejected = rejected.map((r) => ({ hue: norm(r.hue), at: r.at }));
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Hues spoken for by narratives other than `self`: the most recently glowing
 *  {@link RECENT_LIMIT}, within {@link RECENT_MS}. */
export function takenHues(assignments: GlowAssignments, self: string, now: number): number[] {
  return Object.entries(assignments)
    .filter(([nid, a]) => nid !== self && now - a.seen <= RECENT_MS)
    .sort((a, b) => b[1].seen - a[1].seen)
    .slice(0, RECENT_LIMIT)
    .map(([, a]) => a.hue);
}

/** The hue a narrative gets the first time it glows. On a free wheel that is
 *  its speaker hash — the color it wore before this allocator existed. */
export function firstHue(nid: string, taken: number[]): number {
  return gapMidpoints(taken)[0] ?? speakerHue(nid);
}

export interface RecolorOptions {
  /** Hues to keep {@link REJECTED_CLEARANCE} from: where Recolor has just been. */
  rejected?: number[];
  /** Uniform in [0, 1). Injected so the suite can pin the choice. */
  random?: () => number;
}

/** Nearest distance from `hue` to any of `hues`; a half turn when there are none. */
function clearance(hue: number, hues: number[]): number {
  return hues.reduce((m, h) => Math.min(m, hueDistance(hue, h)), 180);
}

/** Where 🎨 Recolor moves a hue: a random whole degree at least
 *  {@link MIN_RECOLOR_STEP} from the current hue, clear of the `rejected` ones,
 *  and at least {@link RECOLOR_CLEARANCE} of the best available clearance from
 *  the others. On a wheel too crowded for all three, the clearance drops to
 *  {@link RECOLOR_CLEARANCE_MIN} first, then the rejected hues give way oldest
 *  first, and only then the step; with nothing left, the widest gap's middle, with the current
 *  hue counted as taken so it still moves. */
export function recolorHue(current: number, taken: number[], opts: RecolorOptions = {}): number {
  const { rejected = [], random = Math.random } = opts;
  const others = [...new Set(taken.map(norm))];
  const left = rejected.map(norm);
  const best = others.length ? gapMidpoints(others).reduce((m, mid) => Math.max(m, clearance(mid, others)), 0) : 180;
  const clearAt = (fraction: number) => {
    const out: number[] = [];
    for (let h = 0; h < 360; h++) if (clearance(h, others) >= best * fraction) out.push(h);
    return out;
  };
  const clear = clearAt(RECOLOR_CLEARANCE);
  const looser = clearAt(RECOLOR_CLEARANCE_MIN);
  const stepped = (hues: number[]) => hues.filter((h) => hueDistance(h, current) >= MIN_RECOLOR_STEP);
  // `rejected` is newest first, so the hues it lets go of are the oldest: the
  // one this press is about to leave, and the one before, are kept longest.
  const fresh = (hues: number[], n: number) => hues.filter((h) => clearance(h, left.slice(0, n)) >= REJECTED_CLEARANCE);
  const tiers: number[][] = [];
  for (let n = left.length; n > 0; n--) tiers.push(fresh(stepped(clear), n), fresh(stepped(looser), n));
  tiers.push(stepped(clear), stepped(looser), clear.filter((h) => h !== norm(current)));
  const pool = tiers.find((t) => t.length > 0);
  if (!pool) return gapMidpoints([...others, current])[0];
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

/** The allocator over a key-value store — `localStorage` in the app. Every
 *  store access is guarded: an unreadable store is an empty one, and a failed
 *  write still returns the hue it computed. */
export class GlowHues {
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  private read(): GlowAssignments {
    try {
      return parseGlowAssignments(this.store.getItem(GLOW_HUES_STORAGE_KEY));
    } catch {
      return {};
    }
  }

  private write(assignments: GlowAssignments): void {
    try {
      this.store.setItem(GLOW_HUES_STORAGE_KEY, JSON.stringify(assignments));
    } catch {}
  }

  /** The hue `nid` glows in, assigning one the first time. Call it only for a
   *  narrative that is glowing: that call is what marks the hue as in use. */
  hueFor(nid: string): number {
    const assignments = this.read();
    const now = this.now();
    const existing = assignments[nid];
    if (existing) {
      if (now - existing.seen >= SEEN_RESOLUTION_MS) {
        assignments[nid] = { ...existing, seen: now };
        this.write(assignments);
      }
      return existing.hue;
    }
    const hue = firstHue(nid, takenHues(assignments, nid, now));
    assignments[nid] = { hue, seen: now };
    this.write(assignments);
    return hue;
  }

  /** 🎨 Recolor: move `nid` somewhere new and clear of the others, and
   *  remember the hue it left so the next few presses don't go back to it. */
  recolor(nid: string): number {
    const assignments = this.read();
    const now = this.now();
    const current = assignments[nid]?.hue ?? speakerHue(nid);
    const rejected = [{ hue: current, at: now }, ...(assignments[nid]?.rejected ?? [])]
      .filter((r) => now - r.at <= REJECTED_MS)
      .slice(0, REJECTED_LIMIT);
    const hue = recolorHue(current, takenHues(assignments, nid, now), {
      rejected: rejected.map((r) => r.hue),
      random: this.random,
    });
    assignments[nid] = { hue, seen: now, rejected };
    this.write(assignments);
    return hue;
  }
}
