/**
 * The 膜 film's scheme terrain: which colors the base film wears *where*.
 *
 * Until this, the unblotched film had one scheme, the incumbent, and only a
 * wash could change it. Now the scheme is a property of place: glyph space —
 * the frame the splotches live in, the one a held drag shifts — is divided
 * into cells, each with a scheme of its own. A hold-and-drag therefore
 * scrolls the film through color space (claude-xaj5pb9b:3, :4): the base
 * noise itself turns as it comes across a seam, and turns back when dragged
 * back, because the map is fixed (claude-xaj5pb9b:5). The lift never scrolls
 * it; splotches don't ride the lift either, so what is painted and what is
 * found stay in one frame.
 *
 * **The cells are irregular** (claude-xaj5pb9b:16). The first cut tiled a
 * square grid, and its axis-aligned seams were plain to see while scrolling
 * — the eye locks onto straight lines moving together. Now each cell of the
 * underlying grid has a *seed point* jittered within it, and a point of the
 * film wears the scheme of the nearest seed (a Voronoi partition): walls at
 * every angle, three-way corners, no two alike. Every cell whose seed is
 * within SEAM of the nearest gets a share of the point, falling smoothly
 * with the excess (`blend`), so the color is continuous everywhere — a
 * nearest-two blend was not: it jumped wherever the runner-up changed,
 * along a straight line inside every three-way corner. What the shares
 * blend is the scheme's *parameters*, and the film's noise is rendered
 * through the blended scheme (claude-xaj5pb9b:27) — blending the rendered
 * colors instead averaged two bandings against each other and washed the
 * texture out of every seam (claude-xaj5pb9b:26). And the point is
 * looked up at a position displaced by a static multi-octave noise, so the
 * walls bend on the scale of the glyph and are dithered on every smaller
 * one (claude-xaj5pb9b:21). The grid is still there underneath as the key
 * space — it is what makes a cell findable and its scheme stable — but
 * nothing of it is visible.
 *
 * Three properties, each pinned by `src/test/membrane-terrain.test.ts`:
 *
 * - **Stable.** A cell's seed point and scheme are drawn from a generator
 *   seeded by (terrain seed, i, j) the first time the cell comes into reach,
 *   and kept. Returning to a cell shows what it showed before, for the life
 *   of the terrain (module scope in Membrane.web.tsx, so a rebuilt engine
 *   keeps it).
 * - **Very different.** A cell's scheme is drawn with rejection until it is
 *   MIN_SCHEME_DISTANCE from every neighbor already drawn (the eight around
 *   it, since a jittered cell can share a wall with a diagonal one), the
 *   same rule `nextScheme` applies to one keyframe after another. Neighbors
 *   drawn later are far from it by the same rule, so any wall is a real
 *   change.
 * - **Bounded.** The shader reads a BLOCK×BLOCK block of cells around the
 *   one under the glyph's centre (`blockRows`, row-major). A point's nearest
 *   seed lies in its own cell or one of the eight around it (JITTER keeps
 *   every seed well inside its cell), and every point the window, its seams
 *   and the seam warp can show lies within a cell of the centre, so a 5×5
 *   block always holds every row a pixel can ask for.
 *
 * A wash that wins paints its scheme onto the cells it covered
 * (`paintCells`, `cellsInView`): the paint sticks to the map, so a wash is
 * a place you can drag away from and back to. Seed points ride to the
 * shader in the scheme table (`packCell`), so the CPU's idea of which cell
 * a point is in and the shader's come from one set of numbers. Window-free.
 */

import { type MembraneScheme, type Rng, SCHEME_TEXELS, nextScheme, packScheme } from "./membrane-palette.js";

// ---- TUNING ----
/** Cell side, glyph widths: a drag of about this far shows a new scheme. */
export const CELL = 0.75;
/** How far a cell's seed point sits from its centre, at most, in cells,
 *  per axis. Below 0.5 it stays in its cell; the smaller, the squarer. */
export const JITTER = 0.35;
/** Blend across a wall: a cell whose seed is this much farther than the
 *  nearest, glyph widths, gets no share; nearer, a share falling smoothly
 *  from equal. A pixel a distance e from a wall differs by about 2e, so the
 *  visible seam is about SEAM wide. */
export const SEAM = 0.25;
/** How far the lookup point is displaced, glyph widths, by a multi-octave
 *  noise at this base frequency: the large octaves bend the walls, the
 *  small ones dither them. Typical, not maximum — see VIEW_MARGIN. */
export const WARP = 0.14;
export const WARP_FREQ = 1.5;
// ---- end TUNING ----

/** Cells on a side of the block the shader reads, and its row count. */
export const BLOCK = 5;
export const TERRAIN_ROWS = BLOCK * BLOCK;
/** Texels per row of the shader's scheme table: a scheme, then its cell's
 *  seed point (x, y, 0, 0) in world coordinates — zero for a group's row. */
export const TERRAIN_TEXELS = SCHEME_TEXELS + 1;

/** Beyond the window's edge, the farthest the warp can carry a lookup: which
 *  cells a point blends is decided at its warped position. The shader's fbm
 *  runs to about ±0.7 of its half-range, so ±1.4 × WARP at the extreme. */
export const VIEW_MARGIN = 1.5 * WARP;

export type Cell = {
  /** The seed point, world coordinates (glyph widths). */
  seed: [number, number];
  scheme: MembraneScheme;
};

export type Terrain = {
  seed: number;
  /** Materialized cells, keyed `${i},${j}`. */
  cells: Map<string, Cell>;
};

export const createTerrain = (seed: number): Terrain => ({ seed, cells: new Map() });

const key = (i: number, j: number) => `${i},${j}`;

/** mulberry32: a small seeded generator, the one the tests use. */
export function seededRng(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The generator for one cell: seed and coordinates hashed together. */
export function cellRng(seed: number, i: number, j: number): Rng {
  let h = (seed | 0) ^ Math.imul(i | 0, 0x9e3779b1) ^ Math.imul(j | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return seededRng(h ^ (h >>> 16));
}

/** The grid cell along one axis of a world coordinate (glyph widths). */
export const cellAt = (w: number): number => Math.floor(w / CELL);

/** A screen point's world coordinate: the glyph centre is at world `-drag`,
 *  since a drag of `d` carried the film (and its map) by `d`. */
export const toWorld = (p: number, drag: number): number => p - drag;

/** The grid cell under the glyph's centre after `drag` — the block's middle. */
export function centreCell(drag: readonly [number, number]): [number, number] {
  return [cellAt(toWorld(0, drag[0])), cellAt(toWorld(0, drag[1]))];
}

const NEIGHBORS: readonly [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** The cell, drawn on first reach: its seed point jittered from the grid
 *  cell's centre, its scheme far from every neighbor already drawn. */
export function cell(t: Terrain, i: number, j: number): Cell {
  const k = key(i, j);
  const have = t.cells.get(k);
  if (have) return have;
  const rng = cellRng(t.seed, i, j);
  const seed: [number, number] = [(i + 0.5 + (2 * rng() - 1) * JITTER) * CELL, (j + 0.5 + (2 * rng() - 1) * JITTER) * CELL];
  const neighbors = NEIGHBORS.map(([di, dj]) => t.cells.get(key(i + di, j + dj))?.scheme)
    .filter((s): s is MembraneScheme => !!s);
  const c: Cell = { seed, scheme: nextScheme(neighbors, rng) };
  t.cells.set(k, c);
  return c;
}

export const cellScheme = (t: Terrain, i: number, j: number): MembraneScheme => cell(t, i, j).scheme;

/** A cell's share of a world point, before normalizing: 1 for the nearest
 *  seed, falling smoothly to 0 for a seed SEAM farther than it. */
const share = (excess: number): number => {
  const t = Math.min(1, Math.max(0, excess / SEAM));
  return 1 - t * t * (3 - 2 * t);
};

/** The cells a world point blends, by seed distance: every cell of the nine
 *  around its own whose seed is within SEAM of the nearest, with its share
 *  of the color, normalized — the shader's lookup, less its warp. The
 *  nearest always shares; at a wall two share equally; nothing jumps as the
 *  point moves, since every share is continuous in the distances. */
export function blend(t: Terrain, w: readonly [number, number]): { cell: [number, number]; weight: number }[] {
  const ci = cellAt(w[0]), cj = cellAt(w[1]);
  const dists: { cell: [number, number]; d: number }[] = [];
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const seed = cell(t, ci + di, cj + dj).seed;
      dists.push({ cell: [ci + di, cj + dj], d: Math.hypot(w[0] - seed[0], w[1] - seed[1]) });
    }
  }
  const d1 = Math.min(...dists.map((x) => x.d));
  const shares = dists.map((x) => ({ cell: x.cell, weight: share(x.d - d1) })).filter((x) => x.weight > 0);
  const total = shares.reduce((a, x) => a + x.weight, 0);
  return shares.map((x) => ({ cell: x.cell, weight: x.weight / total })).sort((a, b) => b.weight - a.weight);
}

/** The block's cells around `centre`, row-major (y outer, x inner), as the
 *  shader's row order: row = (dj + R) * BLOCK + (di + R), R = (BLOCK - 1) / 2. */
export function blockCells(centre: readonly [number, number]): [number, number][] {
  const out: [number, number][] = [];
  const r = (BLOCK - 1) / 2;
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) out.push([centre[0] + di, centre[1] + dj]);
  return out;
}

/** The block's cells after `drag`, materializing what is new, in row order. */
export function blockRows(t: Terrain, drag: readonly [number, number]): Cell[] {
  return blockCells(centreCell(drag)).map(([i, j]) => cell(t, i, j));
}

/** Points of the window (glyph-normalized, -0.5..0.5) widened by VIEW_MARGIN,
 *  on a grid fine beside the seam, as world coordinates after `drag`. */
const VIEW_SAMPLES = 32;
function viewPoints(drag: readonly [number, number]): [number, number][] {
  const out: [number, number][] = [];
  const lo = -0.5 - VIEW_MARGIN, hi = 0.5 + VIEW_MARGIN;
  for (let j = 0; j <= VIEW_SAMPLES; j++) {
    for (let i = 0; i <= VIEW_SAMPLES; i++) {
      out.push([toWorld(lo + ((hi - lo) * i) / VIEW_SAMPLES, drag[0]), toWorld(lo + ((hi - lo) * j) / VIEW_SAMPLES, drag[1])]);
    }
  }
  return out;
}

/** Every cell the window can show after `drag`: with a share of some point
 *  of the window widened by VIEW_MARGIN. Sorted, row-major. */
export function cellsInView(t: Terrain, drag: readonly [number, number]): [number, number][] {
  const seen = new Map<string, [number, number]>();
  for (const w of viewPoints(drag)) for (const { cell: c } of blend(t, w)) seen.set(key(...c), c);
  return [...seen.values()].sort((p, q) => p[1] - q[1] || p[0] - q[0]);
}

/** The schemes the window can show after `drag` — what a new color must be far from. */
export function schemesInView(t: Terrain, drag: readonly [number, number]): MembraneScheme[] {
  return cellsInView(t, drag).map(([i, j]) => cellScheme(t, i, j));
}

/** Paint `scheme` onto these cells, seed points kept: what a wash that won
 *  leaves on the map. */
export function paintCells(t: Terrain, cells: readonly (readonly [number, number])[], scheme: MembraneScheme): void {
  for (const [i, j] of cells) t.cells.set(key(i, j), { seed: cell(t, i, j).seed, scheme });
}

/** One cell as a row of the shader's scheme table: packScheme's texels, then
 *  the seed point. */
export function packCell(c: Cell): Float32Array {
  const out = new Float32Array(TERRAIN_TEXELS * 4);
  out.set(packScheme(c.scheme));
  out.set([c.seed[0], c.seed[1], 0, 0], SCHEME_TEXELS * 4);
  return out;
}
