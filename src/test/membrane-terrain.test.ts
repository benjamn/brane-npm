import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK,
  CELL,
  JITTER,
  SEAM,
  TERRAIN_ROWS,
  TERRAIN_TEXELS,
  VIEW_MARGIN,
  blend,
  blockCells,
  blockRows,
  cell,
  cellAt,
  cellScheme,
  cellsInView,
  centreCell,
  createTerrain,
  packCell,
  paintCells,
  schemesInView,
  seededRng,
  toWorld,
} from "../shared/membrane-terrain.js";
import { MIN_SCHEME_DISTANCE, SCHEME_TEXELS, nextScheme, packScheme, schemeDistance } from "../shared/membrane-palette.js";

// The terrain exists so that a hold-and-drag scrolls the base film through
// color space and a drag back finds the same colors (claude-xaj5pb9b:3–5),
// and its cells are irregular so the eye finds no grid in it
// (claude-xaj5pb9b:16). These pin the three properties the module header
// promises — stable, very different, bounded — not the look of any one cell.

const same = (a: unknown, b: unknown) => assert.deepEqual(a, b);
const k = ([i, j]: readonly [number, number]) => `${i},${j}`;

/** A random walk of drags, materializing blocks as the engine would. */
function walk(seed: number, steps = 40): ReturnType<typeof createTerrain> {
  const t = createTerrain(seed);
  const rng = seededRng(seed + 100);
  let drag: [number, number] = [0, 0];
  for (let n = 0; n < steps; n++) {
    blockRows(t, drag);
    drag = [drag[0] + (rng() - 0.5) * 1.5, drag[1] + (rng() - 0.5) * 1.5];
  }
  return t;
}

describe("cell", () => {
  it("is the same cell every time, within a terrain and across terrains of one seed", () => {
    const t1 = createTerrain(7), t2 = createTerrain(7);
    same(cell(t1, 3, -2), cell(t1, 3, -2));
    same(cell(t1, 3, -2), cell(t2, 3, -2));
    // Once shown, a cell never changes, whatever is drawn around it after.
    const before = cell(t1, 0, 0);
    for (const [i, j] of blockCells([0, 0])) cell(t1, i, j);
    same(cell(t1, 0, 0), before);
  });

  it("differs by seed, and by cell", () => {
    const a = cellScheme(createTerrain(1), 0, 0), b = cellScheme(createTerrain(2), 0, 0);
    assert.ok(schemeDistance(a, b) > 0);
    const t = createTerrain(1);
    assert.ok(schemeDistance(cellScheme(t, 0, 0), cellScheme(t, 5, 5)) > 0);
  });

  it("puts its seed point inside its own grid cell, JITTER from the centre at most", () => {
    const t = walk(3);
    for (const [key, c] of t.cells) {
      const [i, j] = key.split(",").map(Number);
      assert.ok(Math.abs(c.seed[0] / CELL - (i + 0.5)) <= JITTER + 1e-9, `${key}: x ${c.seed[0]}`);
      assert.ok(Math.abs(c.seed[1] / CELL - (j + 0.5)) <= JITTER + 1e-9, `${key}: y ${c.seed[1]}`);
      assert.equal(cellAt(c.seed[0]), i);
      assert.equal(cellAt(c.seed[1]), j);
    }
    assert.ok(JITTER < 0.5);
  });

  it("is far from every one of its eight neighbors, whichever order they were drawn in", () => {
    for (let seed = 0; seed < 8; seed++) {
      const t = walk(seed);
      for (const [key, c] of t.cells) {
        const [i, j] = key.split(",").map(Number);
        for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
          const n = t.cells.get(`${i + di},${j + dj}`);
          if (n) assert.ok(schemeDistance(c.scheme, n.scheme) >= MIN_SCHEME_DISTANCE, `seed ${seed}: ${key} vs ${i + di},${j + dj}`);
        }
      }
    }
  });
});

describe("blend", () => {
  it("gives the nearest cell the largest share, shares to every cell within SEAM of it, none beyond, summing to one", () => {
    const t = createTerrain(4);
    const rng = seededRng(5);
    for (let n = 0; n < 300; n++) {
      const w: [number, number] = [(rng() - 0.5) * 10, (rng() - 0.5) * 10];
      const shares = blend(t, w);
      const dist = (c: [number, number]) => Math.hypot(w[0] - cell(t, ...c).seed[0], w[1] - cell(t, ...c).seed[1]);
      const d1 = dist(shares[0].cell);
      for (const c of t.cells.values()) assert.ok(Math.hypot(w[0] - c.seed[0], w[1] - c.seed[1]) >= d1 - 1e-12);
      assert.ok(Math.abs(shares.reduce((a, x) => a + x.weight, 0) - 1) < 1e-9);
      for (const { cell: c, weight } of shares) {
        assert.ok(weight > 0 && weight <= shares[0].weight + 1e-12);
        assert.ok(dist(c) - d1 < SEAM);
      }
      // Every cell within SEAM of the nearest is in.
      const ci = cellAt(w[0]), cj = cellAt(w[1]);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (dist([ci + di, cj + dj]) - d1 < SEAM) assert.ok(shares.some(({ cell: c }) => c[0] === ci + di && c[1] === cj + dj));
      }
    }
  });

  it("is continuous: a small step never changes the color's weights by more than a little", () => {
    // The failure this replaces: blending only the two nearest jumped
    // wherever the runner-up changed (claude-xaj5pb9b:21).
    const t = createTerrain(6);
    const rng = seededRng(7);
    const weightsOf = (w: [number, number]) => new Map(blend(t, w).map(({ cell: c, weight }) => [`${c[0]},${c[1]}`, weight]));
    for (let n = 0; n < 2000; n++) {
      const w: [number, number] = [(rng() - 0.5) * 6, (rng() - 0.5) * 6];
      const step = 0.002;
      const a = weightsOf(w), b = weightsOf([w[0] + step, w[1] + step * 0.3]);
      for (const key of new Set([...a.keys(), ...b.keys()])) {
        assert.ok(Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0)) < 0.05, `at ${w}: ${key} jumps`);
      }
    }
  });
});

describe("the block", () => {
  it("is BLOCK² rows, row-major around the centre cell", () => {
    assert.equal(TERRAIN_ROWS, BLOCK * BLOCK);
    const cells = blockCells([4, -1]);
    assert.equal(cells.length, TERRAIN_ROWS);
    const r = (BLOCK - 1) / 2;
    same(cells[0], [4 - r, -1 - r]);
    same(cells[(TERRAIN_ROWS - 1) / 2], [4, -1]);
    same(cells[TERRAIN_ROWS - 1], [4 + r, -1 + r]);
    // The shader's row for (di, dj) is (dj + R) * BLOCK + (di + R).
    same(cells[(1 + r) * BLOCK + (-1 + r)], [3, 0]);
    assert.equal(blockRows(createTerrain(1), [0, 0]).length, TERRAIN_ROWS);
  });

  it("holds every cell the window can show, and every cell their lookups touch, at any drag", () => {
    const rng = seededRng(11);
    const t = createTerrain(12);
    for (let n = 0; n < 300; n++) {
      const drag: [number, number] = [(rng() - 0.5) * 20, (rng() - 0.5) * 20];
      const block = new Set(blockCells(centreCell(drag)).map(k));
      for (const c of cellsInView(t, drag)) assert.ok(block.has(k(c)), `drag ${drag}: cell ${k(c)}`);
      // The shader searches the nine cells around a point's own; the widened
      // window's corners are the farthest points it will ask about.
      for (const px of [-0.5, 0.5]) for (const py of [-0.5, 0.5]) {
        for (const m of [-VIEW_MARGIN, VIEW_MARGIN]) {
          const ci = cellAt(toWorld(px, drag[0]) + m), cj = cellAt(toWorld(py, drag[1]) + m);
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) assert.ok(block.has(`${ci + di},${cj + dj}`), `drag ${drag}: lookup ${ci + di},${cj + dj}`);
        }
      }
    }
  });

  it("scrolls with the drag: a drag of one cell moves the centre one cell, the other way", () => {
    same(centreCell([0, 0]), [cellAt(0), cellAt(0)]);
    same(centreCell([CELL, 0]), [centreCell([0, 0])[0] - 1, centreCell([0, 0])[1]]);
    same(centreCell([0, -2 * CELL]), [centreCell([0, 0])[0], centreCell([0, 0])[1] + 2]);
  });

  it("packs a cell as its scheme's texels and then its seed point", () => {
    assert.equal(TERRAIN_TEXELS, SCHEME_TEXELS + 1);
    const c = cell(createTerrain(2), 1, 1);
    const row = packCell(c);
    assert.equal(row.length, TERRAIN_TEXELS * 4);
    same([...row.slice(0, SCHEME_TEXELS * 4)], [...packScheme(c.scheme)]);
    same([...row.slice(SCHEME_TEXELS * 4)], [Math.fround(c.seed[0]), Math.fround(c.seed[1]), 0, 0]);
  });
});

describe("paintCells", () => {
  it("leaves a wash's scheme on the map, seeds kept, where a drag away and back finds it", () => {
    const t = createTerrain(5);
    const drag: [number, number] = [0.3, -0.2];
    const seeds = new Map([...t.cells].map(([key, c]) => [key, c.seed]));
    const won = nextScheme(schemesInView(t, drag), seededRng(9));
    paintCells(t, cellsInView(t, drag), won);
    for (const s of schemesInView(t, drag)) same(s, won);
    for (const [key, seed] of seeds) same(t.cells.get(key)?.seed, seed);
    blockRows(t, [drag[0] + 5, drag[1] + 5]);   // away
    for (const s of schemesInView(t, drag)) same(s, won);   // and back
  });
});
