import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BURST_S,
  COVER_MARGIN,
  TAP_EDGE,
  CRITICAL_PRESSURE,
  MAX_SPEED,
  MAX_SPLOTCHES,
  MAX_SPLOTCH_RADIUS,
  RISE,
  SPLOTCH_TEXELS,
  TAP_RADIUS,
  WASH_DELAY_S,
  WASH_SPEED,
  WOBBLE,
  adopt,
  autoDue,
  covers,
  emptyFilm,
  frontSpeed,
  invade,
  packSplotches,
  reach,
  sdAt,
  shift,
  step,
  tap,
  touching,
  washing,
  type Film,
  type Similar,
  type Splotch,
} from "../shared/membrane-invasion.js";

// What the operator asked for: a tap's color spreads "much more slowly and
// (seemingly) with struggle" (claude-1cwe8u9p:49); "one splotch should die
// out, and two that touch should prevail" (:58, :62); splotches oblong and
// irregular, with no limit a hand runs into (:61); and what prevails washes
// back into the slow upward flow, in its colors, rather than freezing into
// a patchwork (:73, :74, :77). These pin outcomes — who heals, who washes
// in, what never happens — not the exact curves, which are tuning (:63).

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOX: [number, number][] = [];
for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) BOX.push([-0.45 + (0.9 * i) / 19, -0.45 + (0.9 * j) / 19]);

const DT = 1 / 30;

type Outcome = { film: Film; washedIn: number | null; healedAt: number | null };
type Where = (film: Film) => [number, number];
type Tap = [time: number, x: number, y: number] | [time: number, where: Where];

/** Just beside the latest splotch, in direction (dx, dy): outside its outline
 *  by a little, and near enough that the tap's own spot overlaps it. A tap
 *  inside the outline would recolor it instead (claude-u6qlei0j:4). */
const beside = (dx: number, dy: number, s?: Splotch): Where => (film) => {
  const at = s ?? film.splotches.at(-1)!;
  const n = Math.hypot(dx, dy), d = reach(at, at.x + dx, at.y + dy) + 0.04;
  return [at.x + (dx / n) * d, at.y + (dy / n) * d];
};

/** Run taps [time, x, y] (or [time, where]) at 30 fps for up to `seconds`,
 *  the way the engine does — adopting a wash once it covers the glyph — and
 *  check every step that no front jumps and no splotch outgrows its cap
 *  until it washes. */
function run(taps: Tap[], seconds: number, seed = 1, similar?: Similar): Outcome {
  const rng = mulberry32(seed);
  let film = emptyFilm(), next = 0, washedIn: number | null = null, healedAt: number | null = null;
  for (let t = 0; t < seconds; t += DT) {
    while (next < taps.length && taps[next][0] <= t) {
      const spec = taps[next];
      const [x, y] = spec.length === 3 ? [spec[1], spec[2]] : spec[1](film);
      film = tap(film, x, y, rng).film;
      next++;
    }
    const prev = film;
    film = step(film, DT, similar);
    for (const s of film.splotches) {
      const was = prev.splotches.find((p) => p.phase === s.phase)!;
      const g = film.groups.find((g) => g.id === s.group)!;
      assert.ok(Math.abs(s.r - was.r) <= (Math.max(MAX_SPEED, WASH_SPEED) + WOBBLE) * DT + 1e-12, "a front never jumps");
      if (!washing(g, film.clock)) assert.ok(s.r <= MAX_SPLOTCH_RADIUS + 1e-12, "a splotch outgrows its cap only by washing");
    }
    const won = film.groups.find((g) => washing(g, film.clock) && covers(film, g.id, BOX));
    if (won) { washedIn ??= t; film = adopt(film, won.id); }
    if (next >= taps.length && film.splotches.length === 0 && healedAt === null && washedIn === null) healedAt = t;
  }
  return { film, washedIn, healedAt };
}

/** Over several seeds, since every splotch's outline is random. */
const SEEDS = [1, 2, 3, 4, 5];

describe("a single tap", () => {
  it("turns a spot at once where it lands", () => {
    const { film, started } = tap(emptyFilm(), 0.1, -0.2, mulberry32(1));
    assert.ok(started, "a first tap starts a group, for which the caller draws a scheme");
    assert.deepEqual([film.splotches[0].x, film.splotches[0].y, film.splotches[0].r], [0.1, -0.2, TAP_RADIUS]);
    assert.ok(sdAt(film.splotches[0], 0.1, -0.2) < 0, "its own centre is inside it");
  });

  it("dies out when it touches nothing, and never washes in", () => {
    for (const seed of SEEDS) {
      const o = run([[0, 0, 0]], 150, seed);
      assert.equal(o.washedIn, null, `seed ${seed}`);
      assert.ok(o.healedAt !== null && o.healedAt < 90, `seed ${seed}: healed at ${o.healedAt}`);
    }
  });
});

describe("two that touch prevail, and wash in", () => {
  it("when a burst's taps overlap: the film becomes their colors in tens of seconds", () => {
    for (const seed of SEEDS) {
      const o = run([[0, 0, 0], [0.5, beside(1, 0)]], 120, seed);
      assert.ok(o.washedIn !== null && o.washedIn > WASH_DELAY_S && o.washedIn < 30, `seed ${seed}: ${o.washedIn}`);
      assert.equal(o.film.splotches.length, 0, "and then it is just the film again");
    }
  });

  it("from anywhere in the glyph, top or bottom", () => {
    for (const y of [-0.35, 0.35]) {
      const o = run([[0, -0.05, y], [0.5, beside(1, 0)]], 120);
      assert.ok(o.washedIn !== null && o.washedIn < 40, `from y ${y}: ${o.washedIn}`);
    }
  });

  it("but not when a burst's taps are too far apart ever to meet", () => {
    for (const seed of SEEDS) {
      const o = run([[0, -0.4, -0.4], [0.5, 0.4, 0.4]], 300, seed);
      assert.equal(o.washedIn, null, `seed ${seed}`);
      assert.equal(o.film.splotches.length, 0);
    }
  });

  it("nor when they overlap but came from bursts with different colors", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      let film = tap(emptyFilm(), 0, 0, rng).film;
      for (let t = 0; t < BURST_S + 2; t += DT) film = step(film, DT);
      // A second color, tapped elsewhere and then moved onto the first: no
      // tap can put two colors together (beside joins), but a front can grow
      // into a neighbor's ground.
      const b = tap(film, 0.4, 0.4, rng);
      film = { ...b.film, splotches: b.film.splotches.map((s) => (s.group === b.started!.id ? { ...s, x: 0.06, y: 0 } : s)) };
      assert.equal(film.groups.length, 2, `seed ${seed}: a second color`);
      assert.ok(touching(film.splotches[0], film.splotches[1]), `seed ${seed}: they overlap`);
      let washed = false;
      for (let t = 0; t < 300; t += DT) { film = step(film, DT); washed ||= film.groups.some((g) => washing(g, film.clock)); }
      assert.equal(washed, false, `seed ${seed}`);
      assert.equal(film.splotches.length, 0);
    }
  });

  it("across bursts, when their colors are similar", () => {
    assert.notEqual(run([[0, 0, 0], [BURST_S + 2, 0.1, 0]], 120, 1, () => true).washedIn, null);
  });

  it("struggles first: the wash starts WASH_DELAY_S after the splotches connect", () => {
    const rng = mulberry32(1);
    let film = tap(emptyFilm(), 0, 0, rng).film;
    film = tap(film, 0.1, 0, rng).film;
    film = step(film, DT);
    const g = film.groups[0];
    assert.ok(g.washAt !== null);
    assert.ok(Math.abs(g.washAt! - (DT + WASH_DELAY_S)) < 1e-9);
    assert.equal(washing(g, film.clock), false);
    assert.equal(washing(g, g.washAt!), true);
  });

  it("rises: a washing outline reaches farther up than down", () => {
    const rng = mulberry32(3);
    let film = tap(emptyFilm(), 0, 0, rng).film;
    film = tap(film, ...beside(1, 0)(film), rng).film;
    for (let t = 0; t < WASH_DELAY_S + 3; t += DT) film = step(film, DT);
    const s = film.splotches[0];
    assert.equal(s.rise, RISE);
    const round = { ...s, shape: { angle: 0, aspect: 1, lobes: [0, 0, 0] as [number, number, number], phases: [0, 0, 0] as [number, number, number] } };
    assert.ok(Math.abs(reach(round, 0, -1) / reach(round, 0, 1) - RISE) < 1e-9, "y is down: up is -y");
  });
});

describe("preview, then commit (claude-1cwe8u9p:86)", () => {
  it("a tap beside a splotch, however much later, adds to its color and washes it in", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      let r = tap(emptyFilm(), 0, 0, rng);
      let film = r.film;
      const liked = r.film.groups[0].id;
      for (let t = 0; t < 8; t += DT) film = step(film, DT);          // look at it a while
      const s = film.splotches[0];
      r = tap(film, s.x + reach(s, 1, 0) + 0.04, s.y, rng);            // like it: tap just beside it
      assert.equal(r.started, null, `seed ${seed}: no new color`);
      assert.equal(r.recolored, null, `seed ${seed}: not a recolor`);
      film = r.film;
      assert.equal(film.splotches.length, 2, `seed ${seed}: a second splotch`);
      assert.equal(film.splotches.at(-1)!.group, liked);
      let washedIn: number | null = null;
      for (let t = 0; t < 60 && washedIn === null; t += DT) {
        film = step(film, DT);
        if (film.groups.some((g) => g.id === liked && washing(g, film.clock) && covers(film, g.id, BOX))) washedIn = t;
      }
      assert.ok(washedIn !== null && washedIn < 40, `seed ${seed}: ${washedIn}`);
    }
  });

  it("a later tap on bare film is a new color to preview", () => {
    const rng = mulberry32(1);
    let film = tap(emptyFilm(), -0.3, -0.3, rng).film;
    for (let t = 0; t < BURST_S + 1; t += DT) film = step(film, DT);
    assert.ok(tap(film, 0.35, 0.35, rng).started);
  });

  it("the topmost splotch under the finger decides", () => {
    const rng = mulberry32(2);
    let film = tap(emptyFilm(), 0, 0, rng).film;                        // A, beneath
    for (let t = 0; t < BURST_S + 1; t += DT) film = step(film, DT);
    const b = tap(film, 0.4, 0.4, rng);                                  // B, elsewhere
    film = b.film;
    film = { ...film, splotches: film.splotches.map((s) => (s.group === b.started!.id ? { ...s, x: 0, y: 0 } : s)) };
    for (let t = 0; t < BURST_S + 1; t += DT) film = step(film, DT);
    const r = tap(film, 0, 0, rng);
    assert.equal(r.recolored?.id, b.started!.id, "B paints over A there, so the tap is B's");
    assert.equal(r.started, null);
  });
});

describe("on a splotch recolors it; beside it joins it (claude-u6qlei0j:4, :7)", () => {
  it("a tap on the spot just tapped: the same splotches, another color, no new area or pressure", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      let film = tap(emptyFilm(), 0.1, 0.1, rng).film;
      const id = film.groups[0].id;
      film = step(film, 1);
      const r = tap(film, 0.1, 0.1, rng);
      assert.equal(r.recolored?.id, id, `seed ${seed}`);
      assert.equal(r.started, null);
      assert.equal(r.film.splotches.length, 1);
      assert.equal(r.film.groups[0].pressure, film.groups[0].pressure);
    }
  });

  it("can be repeated at any pace, and the splotch still heals alone", () => {
    for (const seed of SEEDS) {
      const o = run([[0, 0, 0], [0.5, 0, 0], [3, 0, 0], [7, 0, 0]], 150, seed);
      assert.equal(o.washedIn, null, `seed ${seed}`);
      assert.ok(o.healedAt !== null, `seed ${seed}`);
    }
  });

  it("a tap on the edge is beside, not on: a finger meaning more of this lands there too", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      let film = tap(emptyFilm(), 0, 0, rng).film;
      film = step(film, 1);
      const s = film.splotches[0];
      const edge = reach(s, 1, 0);
      const inside = tap(film, edge - TAP_EDGE / 2, 0, rng);
      assert.equal(inside.recolored, null, `seed ${seed}`);
      assert.equal(inside.started, null);
      assert.equal(inside.film.splotches.length, 2, "joined");
      const deeper = tap(film, edge - TAP_EDGE * 2, 0, rng);
      assert.equal(deeper.recolored?.id, s.group, `seed ${seed}: recolored`);
    }
  });
});

describe("a wash is closed (claude-u6qlei0j:3)", () => {
  /** Tap, then commit beside it, then step until the wash is under way and big. */
  function midWash(rng: () => number): Film {
    let film = tap(emptyFilm(), 0, 0, rng).film;
    film = step(film, 1);
    const s = film.splotches[0];
    film = tap(film, s.x + reach(s, 1, 0) + 0.04, s.y, rng).film;
    for (let t = 0; t < 60 && !film.groups.some((g) => washing(g, film.clock)); t += DT) film = step(film, DT);
    for (let t = 0; t < 3; t += DT) film = step(film, DT);
    assert.ok(film.groups.some((g) => washing(g, film.clock)), "washing");
    assert.ok(film.splotches.some((s) => sdAt(s, 0, 0) < -TAP_EDGE), "and the tap point is well inside it");
    return film;
  }

  it("a tap during a wash is a new color over it, not a recolor or a join, and outlives the wash", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      let film = midWash(rng);
      const wash = film.groups.find((g) => washing(g, film.clock))!;
      const r = tap(film, 0, 0, rng);
      assert.ok(r.started, `seed ${seed}: a new color`);
      assert.equal(r.recolored, null);
      assert.notEqual(r.started!.id, wash.id);
      film = r.film;
      let t = 0;
      for (; t < 60 && !covers(film, wash.id, BOX); t += DT) film = step(film, DT);
      assert.ok(t < 60, `seed ${seed}: the wash still finishes`);
      assert.ok(film.groups.some((g) => g.id === r.started!.id), `seed ${seed}: the new color is still there when it does`);
      film = adopt(film, wash.id);
      assert.ok(film.groups.some((g) => g.id === r.started!.id), `seed ${seed}: and after`);
    }
  });

  it("a quick tap after the one that committed does not join the wash either", () => {
    const rng = mulberry32(3);
    const film = midWash(rng);
    // The committing tap was seconds ago, but make sure the burst rule alone
    // would have joined: pretend it was just now.
    const wash = film.groups.find((g) => washing(g, film.clock))!;
    const recent = { ...film, groups: film.groups.map((g) => (g.id === wash.id ? { ...g, lastTap: film.clock } : g)) };
    assert.ok(tap(recent, 0.4, 0.4, rng).started, "a new group, not the wash's");
  });

  it("the automatic change is closed too", () => {
    const rng = mulberry32(1);
    let film = invade(emptyFilm(), 0, 0, rng)!.film;
    for (let t = 0; t < 5; t += DT) film = step(film, DT);
    assert.ok(sdAt(film.splotches[0], 0, 0) < -TAP_EDGE, "the tap lands inside it");
    const r = tap(film, 0, 0, rng);
    assert.ok(r.started, "a new color over it");
    assert.equal(r.film.groups.length, 2);
  });
});

describe("splotches are not circles", () => {
  it("each has its own stretched, lobed outline", () => {
    const rng = mulberry32(4);
    let film = emptyFilm();
    for (let i = 0; i < 6; i++) film = tap(film, 0, 0, rng).film;
    const shapes = film.splotches.map((s) => s.shape);
    assert.ok(shapes.every((sh) => sh.aspect >= 1.2 && sh.aspect <= 2.4));
    assert.equal(new Set(shapes.map((sh) => sh.angle)).size, shapes.length, "no two alike");
    // Reach differs by direction: long one way, short the other.
    const s = film.splotches[0];
    const reaches = Array.from({ length: 36 }, (_, k) => reach(s, s.x + Math.cos(k / 36 * 2 * Math.PI), s.y + Math.sin(k / 36 * 2 * Math.PI)));
    assert.ok(Math.max(...reaches) > 1.3 * Math.min(...reaches), `${Math.min(...reaches)}..${Math.max(...reaches)}`);
  });

  it("reach and sdAt agree: the boundary point in any direction is on the outline, risen or not", () => {
    const rng = mulberry32(8);
    const flat: Splotch = tap(emptyFilm(), 0.1, 0.05, rng).film.splotches[0];
    for (const s of [flat, { ...flat, rise: 2.4 }]) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI, dx = Math.cos(a), dy = Math.sin(a);
      const rr = reach(s, s.x + dx, s.y + dy);
      assert.ok(Math.abs(sdAt(s, s.x + dx * rr, s.y + dy * rr)) < 1e-9);
    }
    }
  });

  it("touching follows the outlines, not the centres' distance alone", () => {
    const rng = mulberry32(2);
    const base = tap(emptyFilm(), 0, 0, rng).film.splotches[0];
    const long: Splotch = { ...base, r: 0.15, shape: { angle: 0, aspect: 2.4, lobes: [0, 0, 0], phases: [0, 0, 0] } };
    const other: Splotch = { ...long, phase: 7 };
    // Along the long axis they reach ~0.23 each; across it, ~0.10.
    assert.equal(touching(long, { ...other, x: 0.4, y: 0 }), true);
    assert.equal(touching(long, { ...other, x: 0, y: 0.4 }), false);
  });
});

describe("no patchwork", () => {
  it("bursts that prevail one after another each become the film in turn, leaving nothing behind", () => {
    const o = run([[0, -0.2, 0], [0.4, -0.1, 0], [8, 0.2, 0.2], [8.4, 0.3, 0.2]], 200);
    assert.notEqual(o.washedIn, null);
    assert.equal(o.film.splotches.length, 0, "no stain outlives its wash");
  });
});

describe("no limits a hand will meet", () => {
  it("a tap always lands, even at the table's limit", () => {
    const rng = mulberry32(1);
    let film = emptyFilm();
    for (let i = 0; i < MAX_SPLOTCHES + 10; i++) {
      film = tap(film, (i % 8) * 0.1 - 0.4, Math.floor(i / 8) * 0.1 - 0.4, rng).film;
      assert.equal(film.splotches.at(-1)!.x, (i % 8) * 0.1 - 0.4, `tap ${i} landed`);
      // Shrunk, so the next tap on the grid is never on one of these.
      film = { ...film, splotches: film.splotches.map((s) => ({ ...s, r: 0.001 })) };
    }
    assert.equal(film.splotches.length, MAX_SPLOTCHES);
  });

  it("at the limit, the smallest unanchored splotch gives way", () => {
    const rng = mulberry32(1);
    let film = emptyFilm();
    for (let i = 0; i < MAX_SPLOTCHES; i++) {
      film = tap(film, 0, 0, rng).film;
      film = { ...film, splotches: film.splotches.map((s) => ({ ...s, r: 0.001 })) };   // never on the last
    }
    film = { ...film, splotches: film.splotches.map((s, i) => ({ ...s, r: 0.1 + i * 0.001, anchoredAt: i === 0 ? 0.1 : null })) };
    const anchored = film.splotches[0], smallestFree = film.splotches[1];
    film = tap(film, 0.45, -0.45, rng).film;   // far from all of them
    assert.ok(film.splotches.some((s) => s.phase === anchored.phase), "the anchored one, though smallest, stays");
    assert.ok(!film.splotches.some((s) => s.phase === smallestFree.phase), "the smallest unanchored one gave way");
  });

  it("taps within BURST_S join one group, one scheme; a later tap starts another", () => {
    const rng = mulberry32(1);
    let r = tap(emptyFilm(), 0, 0, rng);
    let film = step(r.film, 1);
    r = tap(film, 0.1, 0.1, rng);
    assert.equal(r.started, null);
    assert.equal(r.film.groups.length, 1);
    film = r.film;
    for (let t = 0; t < BURST_S + 0.5; t += DT) film = step(film, DT);
    assert.ok(tap(film, 0.3, 0.3, rng).started);
  });
});

describe("no global discontinuities (claude-1cwe8u9p:81)", () => {
  it("adopting a wash drops the groups beneath it, which it hides, and keeps those above", () => {
    const rng = mulberry32(1);
    let film = tap(emptyFilm(), -0.3, 0, rng).film;                 // older: beneath
    for (let t = 0; t < BURST_S + 0.5; t += DT) film = step(film, DT);
    const r = invade(film, 0, 0, rng)!;                              // the wash
    film = r.film;
    for (let t = 0; t < BURST_S + 0.5; t += DT) film = step(film, DT);
    film = tap(film, 0.3, 0, rng).film;                              // newer: above
    const [older, , newer] = film.groups;
    const after = adopt(film, r.started.id);
    assert.deepEqual(after.groups.map((g) => g.id), [newer.id]);
    assert.ok(after.splotches.every((s) => s.group === newer.id));
    assert.ok(!after.groups.some((g) => g.id === older.id));
  });

  it("composites by group, oldest at the bottom, whatever order the splotches came in", () => {
    const rng = mulberry32(2);
    let film = tap(emptyFilm(), 0, 0, rng).film;                     // group A
    for (let t = 0; t < BURST_S + 0.5; t += DT) film = step(film, DT);
    film = tap(film, 0.2, 0, rng).film;                              // group B
    const [a] = film.groups;
    // A later tap joining the older group A (as a similar-scheme burst might).
    film = { ...film, splotches: [...film.splotches, { ...film.splotches[0], x: 0.4, phase: 99 }] };
    const out = packSplotches(film, (id) => (id === a.id ? 1 : 2));
    const rowsInOrder = [0, 1, 2].map((i) => out[i * SPLOTCH_TEXELS * 4 + 3]);
    assert.deepEqual(rowsInOrder, [1, 1, 2], "both of A's splotches beneath B's");
  });

  it("a wash is only adopted once it covers the glyph by more than its fronts can wander", () => {
    assert.ok(COVER_MARGIN >= 0.16 * 0.4 + 0.012, "dithering plus edge");
  });

  it("the automatic change grows from nothing, with no tap to explain a spot", () => {
    const r = invade(emptyFilm(), 0.1, 0.1, mulberry32(3))!;
    assert.ok(r.film.splotches[0].r <= 0.01);
  });
});

describe("the automatic change", () => {
  it("wins from anywhere in the glyph, in tens of seconds, and then leaves the film", () => {
    for (const [x, y] of [[0, 0], [0.4, 0.4], [-0.4, 0.3]] as [number, number][]) {
      const rng = mulberry32(7);
      let film = invade(emptyFilm(), x, y, rng)!.film;
      const id = film.groups[0].id;
      let t = 0;
      for (; t < 90 && !covers(film, id, BOX); t += DT) film = step(film, DT);
      assert.ok(t > 5 && t < 45, `from (${x}, ${y}): ${t.toFixed(1)} s`);
      assert.equal(adopt(film, id).splotches.length, 0);
    }
  });

  it("happens once at a time", () => {
    const rng = mulberry32(1);
    const film = invade(emptyFilm(), 0, 0, rng)!.film;
    assert.equal(invade(film, 0.2, 0.2, rng), null);
  });
});

describe("returning after an absence (claude-xaj5pb9b:18)", () => {
  it("the automatic change is due on the first frame back, however still the film's clock stood", () => {
    // Ten seconds of frames, then the tab is hidden: no frames are drawn, so
    // the film's clock stands at ten while the wall clock runs on past the
    // hold. What the operator sees on return is the invasion planting at once.
    let film = emptyFilm();
    for (let t = 0; t < 10; t += DT) film = step(film, DT);
    const holdUntil = 60;
    assert.ok(film.clock < holdUntil);
    assert.ok(!autoDue(film, holdUntil, 10));
    assert.ok(autoDue(film, holdUntil, 95));
    // Planted, it is under way, and no second one is due until it is done.
    const r = invade(film, 0, 0, mulberry32(1));
    assert.ok(r);
    assert.ok(!autoDue(r.film, holdUntil, 95));
    assert.ok(!autoDue(r.film, holdUntil, 1e6));
  });
});

describe("frontSpeed", () => {
  it("holds still at critical pressure, advances above it, retreats more slowly below", () => {
    assert.equal(frontSpeed(CRITICAL_PRESSURE), 0);
    assert.equal(frontSpeed(10), MAX_SPEED);
    assert.ok(frontSpeed(0) < 0 && -frontSpeed(0) < MAX_SPEED);
  });
});

describe("packSplotches", () => {
  it("lays each splotch out as the shader reads it, padded with zero radius", () => {
    const { film } = tap(emptyFilm(), 0.25, -0.125, mulberry32(3));
    const s = film.splotches[0];
    const out = packSplotches(film, () => 5);
    assert.equal(out.length, MAX_SPLOTCHES * SPLOTCH_TEXELS * 4);
    const f = Math.fround;
    assert.deepEqual([...out.slice(0, 16)], [
      0.25, -0.125, f(TAP_RADIUS), 5,
      f(s.shape.angle), f(s.shape.aspect), f(s.shape.lobes[0]), f(s.shape.lobes[1]),
      f(s.shape.lobes[2]), f(s.shape.phases[0]), f(s.shape.phases[1]), f(s.shape.phases[2]),
      1, 0, 0, 0,
    ]);
    assert.ok(out.slice(16).every((v) => v === 0));
  });
});


describe("a drag (claude-u6qlei0j:23)", () => {
  it("moves every splotch by the same distance and changes nothing else", () => {
    const rng = mulberry32(1);
    let film = tap(emptyFilm(), 0, 0, rng).film;
    film = step(film, 1);
    film = tap(film, 0.3, -0.2, rng).film;
    const moved = shift(film, 0.1, -0.05);
    assert.deepEqual(moved.splotches.map((s) => [s.x, s.y]), film.splotches.map((s) => [s.x + 0.1, s.y - 0.05]));
    assert.deepEqual(moved.splotches.map(({ x, y, ...rest }) => rest), film.splotches.map(({ x, y, ...rest }) => rest));
    assert.deepEqual({ ...moved, splotches: [] }, { ...film, splotches: [] });
    assert.equal(shift(film, 0, 0), film);
  });
});
