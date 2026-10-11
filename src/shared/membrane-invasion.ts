/**
 * New color on the 膜 film: splotches that a touch adds, and the invasion
 * that changes the whole scheme every minute or so.
 *
 * **A tap adds a splotch, never a new film** (claude-1cwe8u9p:56). The spot
 * turns at once, then its front advances slowly and against resistance
 * (:49). Every splotch of a group shares one `pressure`; each tap adds to it
 * and it drains over seconds. Above CRITICAL_PRESSURE fronts advance, below
 * it the incumbent reclaims ground (more slowly than it was lost), and a
 * wobble on each front makes it surge, stall and give way, so it reads as a
 * struggle rather than a wipe.
 *
 * **One splotch dies out; two that touch prevail** (:58, :62). The game is
 * "tap to preview a color; if you like it, tap a few more times to see it
 * take over" (:86), and where the next tap lands decides what it means
 * (claude-u6qlei0j:4, :7):
 *
 * - **On a splotch** (inside its outline as drawn): the caller recolors its
 *   whole group — same splotches, same size, another scheme. A tap on the
 *   spot you just tapped adds no area, so it means "not that color".
 * - **Beside a splotch**, close enough that the new spot's outline would
 *   touch it: the tap joins its group. Same shades (:49), and now two that
 *   touch, so the color is committed. At any pace.
 * - Otherwise, taps in a quick burst (within BURST_S of each other) form
 *   one group, and a tap on bare film after that is a new color to preview.
 *
 * A splotch whose outline reaches another of its group — or of a group
 * whose scheme the caller judges similar — is anchored and keeps the ground
 * it has held. An isolated splotch heals and is gone.
 *
 * **A wash is closed** (claude-u6qlei0j:3). Its splotches cover most of the
 * glyph while it runs, so a tap during one used to land "on" it and join
 * it: a splotch in the wash's own color, invisible, and pressure a wash
 * ignores. Now a washing group is neither recolored nor joined; a tap on it
 * starts a new group, which paints over the wash (born later) and outlives
 * its adoption, so the glyph answers a tap at every moment.
 *
 * **What prevails washes back into the flow, in its colors** (:73, :74,
 * :77). A stain that stayed put left a patchwork of frozen borders. So
 * WASH_DELAY_S after a group anchors it starts to wash: its pressure is held
 * up, its splotches lose their size cap, and they rise — an outline reaches
 * up to RISE times farther upward than down or sideways, so the new colors
 * climb with the film's lift, in the stain's own shape. When the group
 * covers the glyph its scheme becomes the incumbent and its splotches go.
 * The film is the default flow again, in the colors that were painted.
 *
 * **Splotches are not circles** (:61). Each has its own outline: stretched
 * along a random axis (area-preserving), with 2-, 3- and 5-lobed bulges of
 * random size and phase. `sdAt` and `reach` here are the same outline the
 * shader draws, less its fine noise dithering, so what counts as touching
 * is what looks like touching.
 *
 * **No limits a hand will meet** (:61). Every splotch either heals or
 * washes into the film within seconds, so few are ever alive at once;
 * MAX_SPLOTCHES bounds that, and at it a tap still lands — it evicts the
 * smallest splotch not anchored, or failing that the smallest of all.
 *
 * **The automatic change** is the same wash, from one round splotch planted
 * somewhere in the glyph.
 *
 * The TUNING block is where "how easily does a splotch live" is decided
 * (:63). Positions are glyph-normalized (the glyph spans -0.5..0.5, y down),
 * the space the shader's `p` lives in. Window-free and deterministic given
 * its random source, so `src/test/membrane-invasion.test.ts` can pin it.
 */

export type Shape = {
  /** Axis of the stretch, radians. */
  angle: number;
  /** Stretch along `angle` (and squeeze across it), ≥ 1; area-preserving. */
  aspect: number;
  /** Amplitudes of the 2-, 3- and 5-lobed bulges, and their phases. */
  lobes: [a2: number, a3: number, a5: number];
  phases: [p2: number, p3: number, p5: number];
};

export type Splotch = {
  x: number;
  y: number;
  /** Size of the front, glyph widths: the radius before stretch and lobes. */
  r: number;
  /** Seeds this front's wobble, so fronts don't surge in unison. */
  phase: number;
  group: number;
  shape: Shape;
  /** The size an anchored splotch holds — it never shrinks below it; null
   *  if not anchored. */
  anchoredAt: number | null;
  /** How much farther the outline reaches upward than down: 1 until the
   *  splotch's group washes, then easing up to RISE. */
  rise: number;
};

export type Group = {
  id: number;
  pressure: number;
  /** Film clock at this group's birth and at its latest tap. */
  born: number;
  lastTap: number;
  auto: boolean;
  /** Film clock at which this group washes into the film; null until it
   *  prevails. The automatic change washes from the start. */
  washAt: number | null;
};

export type Film = {
  splotches: Splotch[];
  groups: Group[];
  /** Seconds of film time. */
  clock: number;
  nextId: number;
};

/** Whether two groups' schemes are close enough for their splotches to connect. */
export type Similar = (a: Group, b: Group) => boolean;

// ---- TUNING ----
/** The spot a tap turns at once. */
export const TAP_RADIUS = 0.09;
/** Largest a tap's splotch grows (before stretch and lobes). */
export const MAX_SPLOTCH_RADIUS = 0.22;
/** Taps this close together in time are one burst: one group, one scheme. */
export const BURST_S = 2.5;
/** A tap this far *inside* a splotch's outline is on it (recolors it); nearer
 *  the edge than this, it is beside it (joins it), since a finger meaning
 *  "more of this" lands on the edge as often as just outside it. */
export const TAP_EDGE = 0.02;
export const PRESSURE_PER_TAP = 1;
export const PRESSURE_DRAIN_S = 30;
/** Pressure at which a front neither advances nor retreats. */
export const CRITICAL_PRESSURE = 0.8;
/** Pressure above critical at which a front reaches MAX_SPEED. */
export const PRESSURE_SPAN = 1.5;
/** Fastest a front ever moves, glyph widths per second. */
export const MAX_SPEED = 0.032;
/** The incumbent reclaims at this fraction of the speed it loses ground. */
export const RECLAIM = 0.35;
/** Per-front surge and stall, glyph widths per second. */
export const WOBBLE = 0.015;
/** How irregular a splotch is: stretch range, and the largest bulge per lobe count. */
export const ASPECT: [number, number] = [1.2, 2.4];
export const LOBE_MAX: [number, number, number] = [0.25, 0.2, 0.12];
/** How long a group that prevails struggles before it washes into the film. */
export const WASH_DELAY_S = 2;
/** How fast a wash's fronts advance, glyph widths per second. */
export const WASH_SPEED = 0.05;
/** How much farther upward than down a washing outline reaches, and how
 *  long it takes to get there. */
export const RISE = 3;
export const RISE_IN_S = 2;
// ---- end TUNING ----

/**
 * How far inside a wash's outline every glyph point must be before the wash
 * is adopted as the film. It has to exceed everything that can make the
 * rendered front differ from `sdAt`: the shader's noise dithering (0.16 of
 * a fbm offset of at most ±0.4, so ±0.064), the half-width of its edge
 * (0.012), and the gap between sample points. Adopting a wash that covers
 * the glyph by this much changes no pixel (claude-1cwe8u9p:81).
 */
export const COVER_MARGIN = 0.1;

/** Room in the shader's splotch table. */
export const MAX_SPLOTCHES = 64;
/** Texels per splotch row in the shader's table. */
export const SPLOTCH_TEXELS = 4;

export const emptyFilm = (): Film => ({ splotches: [], groups: [], clock: 0, nextId: 1 });

const ROUND: Shape = { angle: 0, aspect: 1, lobes: [0, 0, 0], phases: [0, 0, 0] };

/** A random irregular outline. */
export function randomShape(rng: () => number): Shape {
  const range = (lo: number, hi: number) => lo + (hi - lo) * rng();
  return {
    angle: rng() * Math.PI,
    aspect: range(ASPECT[0], ASPECT[1]),
    lobes: [rng() * LOBE_MAX[0], rng() * LOBE_MAX[1], rng() * LOBE_MAX[2]],
    phases: [rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2],
  };
}

/** The outline's bulge at local angle `th`: 1 for a circle. */
function bulge(shape: Shape, th: number): number {
  const [a2, a3, a5] = shape.lobes, [p2, p3, p5] = shape.phases;
  return 1 + a2 * Math.cos(2 * th + p2) + a3 * Math.cos(3 * th + p3) + a5 * Math.cos(5 * th + p5);
}

/** Into the splotch's own frame: upward distances shrunk by its rise (y is
 *  down, so up is negative), then rotated to its axis. */
function local(s: Splotch, x: number, y: number): [number, number] {
  const dx = x - s.x, dy0 = y - s.y, dy = dy0 < 0 ? dy0 / s.rise : dy0;
  const c = Math.cos(s.shape.angle), n = Math.sin(s.shape.angle);
  return [c * dx + n * dy, -n * dx + c * dy];
}

/** Signed distance-like measure from (x, y) to the splotch's outline:
 *  negative inside. The shader's, less its noise dithering. */
export function sdAt(s: Splotch, x: number, y: number): number {
  const [lx, ly] = local(s, x, y), k = Math.sqrt(s.shape.aspect);
  return Math.hypot(lx / k, ly * k) - s.r * bulge(s.shape, Math.atan2(ly, lx));
}

/** How far the outline reaches from the centre toward (x, y). */
export function reach(s: Splotch, x: number, y: number): number {
  const d = Math.hypot(x - s.x, y - s.y);
  if (d === 0) return 0;
  // Along a ray from the centre the frame change is linear, so the measure
  // grows in proportion to distance: find it for a unit step, and scale.
  const ux = s.x + (x - s.x) / d, uy = s.y + (y - s.y) / d;
  const [lx, ly] = local(s, ux, uy), k = Math.sqrt(s.shape.aspect);
  const perUnit = Math.hypot(lx / k, ly * k);
  return Math.max(0, (s.r * bulge(s.shape, Math.atan2(ly, lx))) / perUnit);
}

/** Whether two outlines touch, along the line between their centres. */
export function touching(a: Splotch, b: Splotch): boolean {
  return a.r > 0 && b.r > 0 && Math.hypot(a.x - b.x, a.y - b.y) < reach(a, b.x, b.y) + reach(b, a.x, a.y);
}

/** 1D gradient noise in [-0.5, 0.5], smooth in x. */
function noise1(x: number): number {
  const i = Math.floor(x), f = x - i;
  const g = (n: number) => {
    const h = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return 2 * (h - Math.floor(h)) - 1;
  };
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return (g(i) * f) * (1 - u) + (g(i + 1) * (f - 1)) * u;
}

/** Make room for one more splotch: drop the smallest that isn't anchored, or
 *  failing that the smallest of all. */
function makeRoom(splotches: Splotch[]): Splotch[] {
  if (splotches.length < MAX_SPLOTCHES) return splotches;
  const pool = splotches.some((s) => s.anchoredAt === null) ? splotches.filter((s) => s.anchoredAt === null) : splotches;
  const victim = pool.reduce((a, s) => (s.r < a.r ? s : a));
  return splotches.filter((s) => s !== victim);
}

/** What a touch did: the film after it, and — when it started a new group,
 *  or recolored one — that group, for which the caller must draw a scheme. */
export type Touched = { film: Film; started: Group | null; recolored: Group | null };

/**
 * A touch at (x, y). On a splotch, it recolors that splotch's group; beside
 * one, it joins it; otherwise it starts a group, or joins the latest burst.
 * The topmost splotch under the finger decides, and a washing group counts
 * as film, not as a splotch (see the header).
 */
export function tap(film: Film, x: number, y: number, rng: () => number): Touched {
  const byId = new Map(film.groups.map((g) => [g.id, g]));
  const open = (s: Splotch) => !washing(byId.get(s.group)!, film.clock);
  const live = layered(film).filter(open);
  const on = live.filter((s) => sdAt(s, x, y) <= -TAP_EDGE).at(-1);
  if (on) {
    const groups = film.groups.map((g) => (g.id === on.group ? { ...g, lastTap: film.clock } : g));
    return { film: { ...film, groups }, started: null, recolored: groups.find((g) => g.id === on.group)! };
  }
  // Beside: the spot this tap would turn reaches an outline (its edge counts
  // as beside, see TAP_EDGE). Otherwise, quick taps anywhere are one burst.
  const spot: Splotch = { x, y, r: TAP_RADIUS, phase: 0, group: 0, shape: ROUND, anchoredAt: null, rise: 1 };
  const beside = live.filter((s) => touching(spot, s)).at(-1);
  const onto = beside ? byId.get(beside.group)! : null;
  const latest = film.groups
    .filter((g) => !g.auto && !washing(g, film.clock))
    .reduce<Group | null>((a, g) => (!a || g.lastTap > a.lastTap ? g : a), null);
  const joins = onto ?? (latest && film.clock - latest.lastTap <= BURST_S ? latest : null);
  const started: Group | null = joins ? null : { id: film.nextId, pressure: 0, born: film.clock, lastTap: film.clock, auto: false, washAt: null };
  const id = (joins ?? started)!.id;
  const groups = (started ? [...film.groups, started] : film.groups)
    .map((g) => (g.id === id ? { ...g, pressure: g.pressure + PRESSURE_PER_TAP, lastTap: film.clock } : g));
  const splotch: Splotch = { ...spot, phase: rng() * 1000, group: id, shape: randomShape(rng) };
  const splotches = [...makeRoom(film.splotches), splotch];
  const alive = new Set(splotches.map((s) => s.group));
  return {
    film: { ...film, groups: groups.filter((g) => alive.has(g.id)), splotches, nextId: started ? film.nextId + 1 : film.nextId },
    started: started ? groups.find((g) => g.id === id)! : null,
    recolored: null,
  };
}

/** The film dragged by (dx, dy) glyph widths: every splotch comes along, so
 *  what has been painted stays on the film it was painted on rather than
 *  parked on the glyph while the film moves under it (claude-u6qlei0j:23). */
export function shift(film: Film, dx: number, dy: number): Film {
  if (dx === 0 && dy === 0) return film;
  return { ...film, splotches: film.splotches.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy })) };
}

/** Plant the automatic change at (x, y). Null when one is already under way. */
export function invade(film: Film, x: number, y: number, rng: () => number): { film: Film; started: Group } | null {
  if (film.groups.some((g) => g.auto)) return null;
  const started: Group = { id: film.nextId, pressure: 0, born: film.clock, lastTap: film.clock, auto: true, washAt: film.clock };
  // No tap to explain it, so it grows from nothing rather than appearing.
  const splotch: Splotch = { x, y, r: 0.005, phase: rng() * 1000, group: started.id, shape: ROUND, anchoredAt: null, rise: 1 };
  const splotches = [...makeRoom(film.splotches), splotch];
  const alive = new Set(splotches.map((s) => s.group));
  return {
    film: { ...film, groups: [...film.groups, started].filter((g) => alive.has(g.id)), splotches, nextId: film.nextId + 1 },
    started,
  };
}

/**
 * Whether the automatic change is due: `wall` seconds since load have passed
 * `holdUntil`, and none is under way. `wall` is **wall time**, not the film's
 * clock, on purpose. The frame loop stops while the tab is hidden or the
 * glyph is off screen, so the film's clock stands still through an absence
 * while the hold runs on — and a return after longer than the hold plants
 * the invasion on the very first frame back, a drama the operator asked to
 * keep (claude-xaj5pb9b:18). Measure the hold on the film's clock instead
 * and that moment goes away. `src/test/membrane-invasion.test.ts` pins it.
 */
export function autoDue(film: Film, holdUntil: number, wall: number): boolean {
  return wall >= holdUntil && !film.groups.some((g) => g.auto);
}

/** Whether a group is washing into the film at `clock`. */
export function washing(g: Group, clock: number): boolean {
  return g.washAt !== null && clock >= g.washAt;
}

/** How fast every front of a group moves at this pressure, before its wobble. */
export function frontSpeed(pressure: number): number {
  const k = Math.max(-1, Math.min(1, (pressure - CRITICAL_PRESSURE) / PRESSURE_SPAN));
  return MAX_SPEED * (k >= 0 ? k : k * RECLAIM);
}

export function step(film: Film, dt: number, similar: Similar = () => false): Film {
  const h = Math.max(0, Math.min(dt, 0.1));
  const clock = film.clock + h;
  const byIdBefore = new Map(film.groups.map((g) => [g.id, g]));
  const kin = (a: Splotch, b: Splotch) => {
    const ga = byIdBefore.get(a.group)!, gb = byIdBefore.get(b.group)!;
    if (ga.auto || gb.auto) return false;
    return ga.id === gb.id || similar(ga, gb);
  };
  const anchoredNow = new Set(film.splotches.filter((s) =>
    s.anchoredAt !== null || film.splotches.some((o) => o !== s && kin(s, o) && touching(s, o))));
  const groups = film.groups.map((g) => {
    // A group prevails when any of its splotches anchors; it washes shortly after.
    const prevailed = g.washAt === null && film.splotches.some((s) => s.group === g.id && anchoredNow.has(s));
    return {
      ...g,
      washAt: prevailed ? clock + WASH_DELAY_S : g.washAt,
      pressure: g.pressure * Math.exp(-h / PRESSURE_DRAIN_S),
    };
  });
  const byId = new Map(groups.map((g) => [g.id, g]));
  const splotches = film.splotches
    .map((s) => {
      const g = byId.get(s.group)!;
      const washes = washing(g, clock);
      const anchored = anchoredNow.has(s);
      const v = washes ? WASH_SPEED : frontSpeed(g.pressure);
      let r = s.r + (v + WOBBLE * 2 * noise1(clock * 0.5 + s.phase)) * h;
      if (!washes) r = Math.min(MAX_SPLOTCH_RADIUS, r);
      // Anchored ground is kept: the front may still advance, never retreat.
      if (anchored || washes) r = Math.max(s.r, r);
      const rise = washes ? Math.min(RISE, s.rise + (h * (RISE - 1)) / RISE_IN_S) : s.rise;
      return { ...s, r: Math.max(0, r), anchoredAt: anchored ? r : null, rise };
    })
    .filter((s) => s.r > 0);
  const alive = new Set(splotches.map((s) => s.group));
  return { ...film, clock, groups: groups.filter((g) => alive.has(g.id)), splotches };
}

/** Whether a group's splotches hold every one of these points, by `margin`. */
export function covers(film: Film, groupId: number, points: readonly [number, number][], margin = COVER_MARGIN): boolean {
  const mine = film.splotches.filter((s) => s.group === groupId);
  return mine.length > 0 && points.every(([x, y]) => mine.some((s) => sdAt(s, x, y) <= -margin));
}

/** Groups composite oldest first, each group's splotches together, so a
 *  newer group always paints over an older one. */
function layered(film: Film): Splotch[] {
  const born = new Map(film.groups.map((g) => [g.id, g.born]));
  return film.splotches
    .map((s, i) => ({ s, i, b: born.get(s.group) ?? 0 }))
    .sort((a, b) => a.b - b.b || a.i - b.i)
    .map(({ s }) => s);
}

/**
 * The film after a group has won: its scheme is now the incumbent, so its
 * splotches go — and so does every group born before it, which composited
 * beneath it and so is already hidden everywhere it covers, which is
 * everywhere. Dropping them changes nothing visible; keeping them would let
 * them resurface over the new incumbent (claude-1cwe8u9p:81).
 */
export function adopt(film: Film, groupId: number): Film {
  const winner = film.groups.find((g) => g.id === groupId);
  if (!winner) return film;
  const stays = new Set(film.groups.filter((g) => g.id !== groupId && g.born > winner.born).map((g) => g.id));
  return { ...film, splotches: film.splotches.filter((s) => stays.has(s.group)), groups: film.groups.filter((g) => stays.has(g.id)) };
}

/**
 * The shader's splotch table, oldest group first so newer paint over older: per
 * splotch SPLOTCH_TEXELS RGBA texels —
 *   (x, y, r, scheme row), (angle, aspect, a2, a3), (a5, p2, p3, p5), (rise, 0, 0, 0)
 * — with `row(group)` naming where the caller keeps that group's scheme.
 */
export function packSplotches(film: Film, row: (groupId: number) => number): Float32Array {
  const out = new Float32Array(MAX_SPLOTCHES * SPLOTCH_TEXELS * 4);
  layered(film).slice(0, MAX_SPLOTCHES).forEach((s, i) => {
    const { angle, aspect, lobes: [a2, a3, a5], phases: [p2, p3, p5] } = s.shape;
    out.set([s.x, s.y, s.r, row(s.group), angle, aspect, a2, a3, a5, p2, p3, p5, s.rise, 0, 0, 0], i * SPLOTCH_TEXELS * 4);
  });
  return out;
}
