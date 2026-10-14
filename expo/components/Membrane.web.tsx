import React, { useCallback, useEffect, useRef, useState } from "react";
import { MO_GLYPH_BOX, MO_GLYPH_PATH } from "@shared/mo-glyph";
import {
  type MembraneMotion,
  type MotionState,
  NOISE_SCALE,
  dragMotion,
  initialMotionState,
  membraneMotion,
  stepMotion,
} from "@shared/membrane-motion";
import {
  type MembraneScheme,
  BAND_FADE_DEG,
  SCHEME_TEXELS,
  nextScheme,
  packScheme,
  schemeDistance,
} from "@shared/membrane-palette";
import {
  type Terrain,
  BLOCK,
  CELL,
  SEAM,
  TERRAIN_ROWS,
  TERRAIN_TEXELS,
  WARP,
  WARP_FREQ,
  blockRows,
  cellsInView,
  centreCell,
  createTerrain,
  packCell,
  paintCells,
  schemesInView,
} from "@shared/membrane-terrain";
import {
  type Film,
  type Group,
  MAX_SPLOTCHES,
  SPLOTCH_TEXELS,
  adopt,
  autoDue,
  covers,
  emptyFilm,
  invade,
  packSplotches,
  shift,
  step,
  tap,
  washing,
} from "@shared/membrane-invasion";
import type { MembraneProps } from "./Membrane";

/**
 * 膜 (mó, membrane) cut out of the ground, revealing a slowly moving
 * thin-film surface behind it. `MembraneEmpty` sets it as the list screen's
 * floor; this is the glyph alone, so it can be placed wherever it is needed
 * and told how to move.
 *
 * The glyph is the outline in `src/shared/mo-glyph.ts`, rasterized with
 * `Path2D` into an alpha texture — no web font, so the offline PWA and the
 * checked-in `mo-membrane.svg` show the identical shape. The surface is a
 * fragment shader: 3D Perlin noise (its third axis is a time phase, so it
 * never cycles) read as film thickness, then colored by a scheme from
 * `src/shared/membrane-palette.ts` — the thin film's lightness banding,
 * through 3–5 distinct anchor hues in a permuted order — so the swirl is
 * always the same swirl and never the same colors. Which scheme is a
 * matter of *where*: glyph space is divided into irregular cells by
 * `src/shared/membrane-terrain.ts`, each with a scheme of its own, fixed
 * once seen, and the base film wears the cell it is over. A tap adds a
 * splotch of new color where it lands: alone it heals; a tap on it recolors
 * it; a tap beside it joins it, and splotches that touch prevail and then
 * wash upward through the film, which becomes their colors — painted onto
 * the cells the wash covered (src/shared/membrane-invasion.ts). Every minute
 * or so a new scheme washes in on its own the same way. Press, and the film
 * stops rising under the hand; drag, and it comes along at once, map and
 * paint included, so a drag scrolls the film through color space and a drag
 * back returns to the colors it left (the gesture is sorted out in `the
 * hand` below). How the film
 * moves — how fast it rises, sways, and churns — is the `voice` / `lift` /
 * `sway` / `churn` props, integrated on the CPU by
 * `src/shared/membrane-motion.ts` so a change eases in rather than jumping.
 * The edge is the mask alone; nothing is shaded or shadowed.
 *
 * Motion runs only while the tab is visible and the glyph is on screen, and
 * freezes (still colored) under `prefers-reduced-motion`. The backing store
 * follows pinch-zoom, so a zoomed glyph is re-rendered sharp rather than
 * upscaled. Tilt parallax was
 * here once (branch history up to e6bed31) and is parked for now.
 */

const GROUND = "#121214"; // the list screen's contentStyle background
/** Rows in the scheme table: the terrain block, and one per possible group. */
const MAX_SCHEMES = TERRAIN_ROWS + MAX_SPLOTCHES;

const VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FS = `
precision highp float;
uniform vec2  u_res;      // drawing buffer size, px
uniform vec4  u_glyph;    // x, y (top-left, px from top-left), w, h  (w == h)
uniform vec2  u_offset;   // the noise window's integrated drift: x sway, y lift
uniform float u_phase;    // the noise's integrated time phase (churn)
uniform sampler2D u_mask;
uniform vec3  u_bg;
// Two tables, as float textures read by index, so neither has a size a hand
// will meet (claude-1cwe8u9p:61). Schemes (src/shared/membrane-palette.ts,
// packScheme): one row each, the first TERRAIN_ROWS the terrain block
// (src/shared/membrane-terrain.ts, blockRows / packCell, which adds the
// cell's seed point as a last texel), the rest the groups'. Splotches
// (src/shared/membrane-invasion.ts, packSplotches): one row each, oldest
// first, naming the scheme row they paint in.
uniform sampler2D u_schemes;
uniform sampler2D u_splotchTable;
uniform float u_splotchCount;
uniform float u_clock;    // seconds; animates the dithering of the fronts
uniform vec2  u_drag;     // accumulated drag, glyph widths: world = p - u_drag
uniform vec2  u_cell0;    // the block's centre cell (integer coordinates)

// Classic 3D Perlin (gradient) noise; the third axis is time, so the field
// evolves continuously and never cycles back on itself.
vec3 grad3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float perlin(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(mix(dot(grad3(i + vec3(0,0,0)), f - vec3(0,0,0)), dot(grad3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
        mix(dot(grad3(i + vec3(0,1,0)), f - vec3(0,1,0)), dot(grad3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
    mix(mix(dot(grad3(i + vec3(0,0,1)), f - vec3(0,0,1)), dot(grad3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
        mix(dot(grad3(i + vec3(0,1,1)), f - vec3(0,1,1)), dot(grad3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y),
    u.z);
}
float fbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * perlin(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return 0.5 + 0.5 * (v * 1.4);
}

// OKLab → linear sRGB (Björn Ottosson), as in membrane-palette.ts.
vec3 oklabToLinear(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  float l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return vec3( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
              -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
              -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
bool inGamut(vec3 lin) { return all(greaterThanEqual(lin, vec3(-1e-4))) && all(lessThanEqual(lin, vec3(1.0001))); }

vec4 schemeTexel(float row, float col) {
  return texture2D(u_schemes, vec2((col + 0.5) / ${TERRAIN_TEXELS}.0, (row + 0.5) / ${MAX_SCHEMES}.0));
}
vec2 anchorOf(float row, float k) {
  vec4 t = schemeTexel(row, 2.0 + floor(k * 0.5));
  return mod(k, 2.0) < 0.5 ? t.xy : t.zw;
}
// Lightness banding from its parameters (cycles, phase, mid, amplitude) —
// a scheme's own, or the terrain's blend of several.
float bandingOf(vec4 l, float d) {
  return l.z + l.w * cos(6.28318 * (l.x * d + l.y));
}
float banding(float row, float d) {
  return bandingOf(schemeTexel(row, 1.0), d);
}
// A scheme's anchor color at position u through one pass of its anchors, as
// an OKLab a/b offset. Each anchor holds, then turns into the next over a
// window of half-width h.w — along a straight line through a/b, not around
// the hue wheel, so the turn passes through no hue the two do not share
// (abAt in membrane-palette.ts).
vec2 anchorAt(float row, float u) {
  vec4 h = schemeTexel(row, 0.0);   // count, passes per unit thickness, phase, half-width
  float x = fract(u) * h.x;
  float fi = floor(x);
  float f = smoothstep(0.5 - h.w, 0.5 + h.w, x - fi);
  vec2 a = anchorOf(row, fi), b = anchorOf(row, fi + 1.0);
  return mix(a.y * vec2(cos(a.x), sin(a.x)), b.y * vec2(cos(b.x), sin(b.x)), f);
}
// The same at thickness d, at the scheme's own cycling rate and phase.
vec2 anchorAB(float row, float d) {
  vec4 h = schemeTexel(row, 0.0);
  return anchorAt(row, h.y * d + h.z);
}

// The scheme terrain: the base film's scheme is the cell it is over, in
// world coordinates (glyph space carried by the drag, so the map scrolls with
// the film and the lift never moves it). Cells are irregular: each grid cell
// has a seed point jittered within it (its last texel), and a point wears
// the nearest seed's scheme — a Voronoi partition, so no wall is axis-aligned
// and no two are alike (claude-xaj5pb9b:16). The block's rows are the
// BLOCK×BLOCK cells around u_cell0, row-major; a point's nearest seeds are
// in its own cell or the eight around it. Every cell whose seed is within
// SEAM of the nearest gets a share, falling smoothly with the excess, so
// nothing is discontinuous (a nearest-two blend jumped wherever the
// runner-up changed — claude-xaj5pb9b:21); and the lookup position is
// displaced by a static fbm, whose large octaves bend the walls and small
// ones dither them. All of it in world coordinates and out of time, so the
// map it draws is as fixed as the cells.
//
// What the shares blend is the *scheme*, not its colors (claude-xaj5pb9b:27):
// the banding parameters into one cosine and the hue cycle into one
// position, and the thickness is then rendered through that single local
// scheme at full contrast. Averaging each cell's rendered banding instead
// cancelled two cosines against each other and washed the texture out of
// every seam (claude-xaj5pb9b:26). The anchors, which come in different
// counts, are looked up per cell at the shared position and blended.
float terrainRow(vec2 ij) {
  const float R = ${((BLOCK - 1) / 2).toFixed(1)};
  vec2 d = clamp(ij - u_cell0, -R, R);
  return (d.y + R) * ${BLOCK}.0 + (d.x + R);
}
float shareOf(float row, vec2 q, float d1) {
  float excess = distance(q, schemeTexel(row, ${SCHEME_TEXELS}.0).xy) - d1;
  return 1.0 - smoothstep(0.0, ${SEAM.toFixed(4)}, excess);
}
void terrain(vec2 p, float d, out float L, out vec2 ab) {
  vec2 w = p - u_drag;
  vec2 q = w + ${(2 * WARP).toFixed(3)} * (vec2(fbm(vec3(w * ${WARP_FREQ.toFixed(3)} + 60.0, 7.0)),
                                              fbm(vec3(w * ${WARP_FREQ.toFixed(3)} + 90.0, 11.0))) - 0.5);
  vec2 c = floor(q / ${CELL.toFixed(4)});
  float d1 = 1e9;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      d1 = min(d1, distance(q, schemeTexel(terrainRow(c + vec2(float(i), float(j))), ${SCHEME_TEXELS}.0).xy));
    }
  }
  // The local scheme: banding and hue-cycle parameters blended by share.
  float total = 0.0;
  vec4 light = vec4(0.0);
  vec2 cycle = vec2(0.0);   // passes per unit thickness, phase
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      float row = terrainRow(c + vec2(float(i), float(j)));
      float share = shareOf(row, q, d1);
      if (share > 0.0) {
        light += share * schemeTexel(row, 1.0);
        cycle += share * schemeTexel(row, 0.0).yz;
        total += share;
      }
    }
  }
  light /= total;
  cycle /= total;
  L = bandingOf(light, d);
  // The anchors at the shared cycle position, blended by the same shares.
  float u = cycle.x * d + cycle.y;
  ab = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      float row = terrainRow(c + vec2(float(i), float(j)));
      float share = shareOf(row, q, d1);
      if (share > 0.0) ab += share * anchorAt(row, u);
    }
  }
  ab /= total;
}

vec4 splotchTexel(float i, float col) {
  return texture2D(u_splotchTable, vec2((col + 0.5) / ${SPLOTCH_TEXELS}.0, (i + 0.5) / ${MAX_SPLOTCHES}.0));
}
// Signed distance-like measure to splotch i's outline, negative inside — the
// same outline as sdAt in membrane-invasion.ts (upward reach multiplied by
// its rise, then a stretch along its axis and 2-, 3- and 5-lobed bulges),
// plus the shared noise dithering. row: its scheme.
float splotchSD(float i, vec2 p, float dither, out float row) {
  vec4 a = splotchTexel(i, 0.0);    // x, y, r, scheme row
  row = a.w;
  vec2 q = p - a.xy;
  if (a.z <= 0.0) return 10.0;
  float rise = splotchTexel(i, 3.0).x;
  if (q.y < 0.0) q.y /= rise;       // y is down: upward, the outline reaches farther
  if (length(q) > a.z * 2.5 + 0.1) return 10.0;   // nowhere near: skip the rest
  vec4 b = splotchTexel(i, 1.0);    // angle, aspect, a2, a3
  vec4 c = splotchTexel(i, 2.0);    // a5, p2, p3, p5
  float cs = cos(b.x), sn = sin(b.x);
  vec2 l = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
  float k = sqrt(b.y);
  float th = atan(l.y, l.x + 1e-6);
  float bulge = 1.0 + b.z * cos(2.0 * th + c.y) + b.w * cos(3.0 * th + c.z) + c.x * cos(5.0 * th + c.w);
  return length(vec2(l.x / k, l.y * k)) - a.z * bulge + dither * 0.16 * min(1.0, a.z * 5.0);
}
float dithering(vec2 p) { return fbm(vec3(p * 3.5 + 30.0, u_clock * 0.15)) - 0.5; }

// Lightness is the thin film's banding; hue is the scheme's. The terrain,
// then each splotch over it in order, newest on top. Chroma is cut
// back only as far as sRGB needs at that lightness, so the palest and darkest
// bands keep their hue instead of clipping to white or black.
vec3 paint(float d, vec2 p, float dither) {
  float L;
  vec2 ab;
  terrain(p, d, L, ab);
  for (int i = 0; i < ${MAX_SPLOTCHES}; i++) {
    if (float(i) >= u_splotchCount) break;
    float row;
    float claim = 1.0 - smoothstep(-0.012, 0.012, splotchSD(float(i), p, dither, row));
    if (claim > 0.0) { L = mix(L, banding(row, d), claim); ab = mix(ab, anchorAB(row, d), claim); }
  }
  float C = length(ab);
  // The band no scheme may use (BAND_FADE_DEG, membrane-palette.ts): what a
  // turn between anchors on either side of it still passes through is shown
  // neutral, at the banding's lightness, rather than as mustard or olive.
  if (C > 1e-4) {   // below that, hue is noise (and atan(0, 0) is undefined)
    float hd = mod(degrees(atan(ab.y, ab.x)), 360.0);
    float fade = smoothstep(${BAND_FADE_DEG[0].toFixed(1)}, ${BAND_FADE_DEG[1].toFixed(1)}, hd)
               * (1.0 - smoothstep(${BAND_FADE_DEG[2].toFixed(1)}, ${BAND_FADE_DEG[3].toFixed(1)}, hd));
    ab *= 1.0 - fade;
    C = length(ab);
  }
  vec2 dir = C > 1e-5 ? ab / C : vec2(1.0, 0.0);
  float lo = C;
  if (!inGamut(oklabToLinear(vec3(L, ab)))) {
    float hi = C; lo = 0.0;
    for (int k = 0; k < 8; k++) {
      float mid = 0.5 * (lo + hi);
      if (inGamut(oklabToLinear(vec3(L, dir * mid)))) lo = mid; else hi = mid;
    }
  }
  vec3 lin = clamp(oklabToLinear(vec3(L, dir * lo)), 0.0, 1.0);
  return mix(12.92 * lin, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, lin));
}

// A slowly draining soap film: the swirl as merged in #464, carried by the
// integrated drift (u_offset; lifting, the structure forms below and
// dissolves above) and colored by the terrain and any splotches (paint).
vec3 film(vec2 p, float c) {
  vec2 q = p * ${NOISE_SCALE.toFixed(2)} + u_offset;
  float d = fbm(vec3(q, c * 0.06));
  d += 0.35 * fbm(vec3(q * 2.7 + 10.0, c * 0.09 + 5.0));
  d += 0.30 * (p.y + 0.5);                          // thinner toward the top, as a real film drains
  // Where a splotch's front is, the film is disturbed: a thin seam of
  // shifted thickness marks the line being fought over. The edge itself is
  // crisp — the struggle is in its shape and its motion, not in a blur.
  //
  // The seam follows the nearest *visible* front, which is not the nearest
  // outline. Splotches composite oldest first, so walking them in order: one
  // that covers this point is the paint here and hides every older front
  // beneath it; an older front outside it stays a candidate; and a front is
  // no front where the paint on both sides is the same scheme — a sibling of
  // its own group already covers the point — so a group's union grows no
  // seams inside it (its inside distance is to the farthest covering
  // sibling's outline). A signed min over every outline got the one case
  // that matters most wrong: a tap landing inside an expanding wash sat deep
  // inside the wash's outline, and its own front, at distance zero, lost the
  // min to the wash's −0.3 and drew no seam until the wash was adopted, when
  // the seam appeared all at once (claude-m1ofa51d:16).
  float dither = 0.0, in2 = 100.0, out2 = 100.0, row;
  float over = -1.0;   // scheme row of the paint at p; -1 is the terrain
  if (u_splotchCount > 0.5) {
    dither = dithering(p);
    for (int i = 0; i < ${MAX_SPLOTCHES}; i++) {
      if (float(i) >= u_splotchCount) break;
      float sd = splotchSD(float(i), p, dither, row);
      if (sd >= 10.0) continue;                     // nowhere near
      if (sd < 0.0) {
        if (over != row) { in2 = sd * sd; out2 = 100.0; }   // new paint on top: older fronts are hidden
        else in2 = max(in2, sd * sd);                        // a sibling: the union reaches farther
        over = row;
      } else if (over != row) {
        out2 = min(out2, sd * sd);
      }
    }
  }
  d += 0.12 * exp(-min(in2, out2) / 0.0004);
  vec3 col = paint(d, p, dither);
  vec2 lightAt = vec2(-0.22, -0.28);
  float sheen = pow(max(0.0, 1.0 - length(p - lightAt) * 1.5), 2.2);
  col = mix(col, vec3(1.0), sheen * 0.30);
  col *= 0.88 + 0.12 * fbm(vec3(q * 3.0, c * 0.2 + 20.0));
  return col;
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 gs = u_glyph.zw;
  vec2 gc = u_glyph.xy + gs * 0.5;
  vec2 muv = (frag - u_glyph.xy) / gs;
  float m = 0.0;
  if (muv.x >= 0.0 && muv.x <= 1.0 && muv.y >= 0.0 && muv.y <= 1.0) m = texture2D(u_mask, muv).a;
  if (m <= 0.001) { gl_FragColor = vec4(u_bg, 1.0); return; }
  // Glyph-normalized coordinates: the glyph spans -0.5..0.5.
  vec2 p = (frag - gc) / gs.x;
  gl_FragColor = vec4(mix(u_bg, film(p, u_phase), m), 1.0);
}
`;

type Engine = {
  /** A touch at glyph-normalized (x, y): a splotch of new color there, or
   *  another color for the splotch it lands on, or more of the one beside it. */
  touch(x: number, y: number): void;
  /** A hand on the film: the drift stops while `on`, and eases back after. */
  hold(on: boolean): void;
  /** The hand moved by (dx, dy) glyph widths: the film, its map and its
   *  paint come with it. */
  drag(dx: number, dy: number): void;
  /** Ease toward new rates; position and phase carry on from where they are. */
  setMotion(motion: MembraneMotion): void;
  destroy(): void;
};

// ---- color arriving ----
// A scheme holds for HOLD_S, then a new one washes in from a random point in
// the glyph; a tap adds a splotch of new color where it lands, which heals
// alone and washes through the film if it connects (membrane-invasion.ts).
// Under prefers-reduced-motion nothing grows or heals: a tap swaps the
// scheme, and nothing changes on its own.
const HOLD_S: [number, number] = [60, 90];
/** Groups whose schemes are this close (schemeDistance) connect as if one. */
const SIMILAR_SCHEMES = 0.06;

/** Every point of the glyph, glyph-normalized, sampled on a grid fine enough
 *  (with COVER_MARGIN) that a wash covering all of them covers every pixel
 *  it can show — and where an automatic change may start. */
function sampleGlyph(path: Path2D, n = 64): [number, number][] {
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const ctx = c.getContext("2d");
  if (!ctx) return [[0, 0]];
  ctx.setTransform(n / MO_GLYPH_BOX, 0, 0, n / MO_GLYPH_BOX, 0, 0);
  ctx.fillStyle = "#fff";
  ctx.fill(path);
  const alpha = ctx.getImageData(0, 0, n, n).data;
  const out: [number, number][] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (alpha[(j * n + i) * 4 + 3] > 0) out.push([(i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5]);
    }
  }
  return out.length ? out : [[0, 0]];
}

/**
 * The film's state, at module scope so that it outlives any one Membrane:
 * the glyph moves between the list's empty state and its footer, a lost
 * WebGL context is rebuilt, a screen is left and returned to — and each of
 * those used to start a new film, a global reset (claude-1cwe8u9p:81). Now a
 * new engine picks up the same incumbent, splotches, swirl and timers.
 */
type FilmState = {
  /** The base film's schemes, by cell; and where the film has been dragged
   *  to, which is which cells are under the glyph. */
  terrain: Terrain;
  drag: [number, number];
  film: Film;
  /** Live groups' schemes, and the scheme-table row each holds. */
  schemes: Map<number, MembraneScheme>;
  rows: Map<number, number>;
  motion: MotionState;
  /** Wall-clock origin of the palette clock, and when the next automatic
   *  change is due on it. */
  t0: number;
  holdUntil: number;
  /** The palette clock where reduced motion froze it. */
  frozenAt: number;
};
let shared: FilmState | null = null;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Everything imperative: GL setup, the mask texture, and the frame loop.
 * Returns null when WebGL is unavailable or the shader will not build, in
 * which case the caller shows the static outline instead. `onTap` hears each
 * tap after the film has taken it — never a hold or a drag.
 */
function createEngine(canvas: HTMLCanvasElement, host: HTMLElement, motion: MembraneMotion, onTap: () => void): Engine | null {
  const ctx = canvas.getContext("webgl", { antialias: false, alpha: false, premultipliedAlpha: false });
  if (!ctx) return null;
  const gl: WebGLRenderingContext = ctx; // narrowed once, so the closures below see it non-null
  // The scheme and splotch tables are float textures (every WebGL 1 browser
  // brane targets has this; without it, the static outline).
  if (!gl.getExtension("OES_texture_float")) return null;

  const compile = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("Membrane shader:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VS);
  const fs = compile(gl.FRAGMENT_SHADER, FS);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("Membrane link:", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = (name: string) => gl.getUniformLocation(prog, name);
  const uRes = u("u_res"), uGlyph = u("u_glyph"), uOffset = u("u_offset"), uPhase = u("u_phase");
  const uClock = u("u_clock"), uSplotchCount = u("u_splotchCount");
  const uDrag = u("u_drag"), uCell0 = u("u_cell0");
  /** A float RGBA table on its own texture unit, read texel by texel. */
  function table(unit: number, uniform: string, width: number, height: number) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
    ]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.uniform1i(u(uniform), unit);
    const data = new Float32Array(width * height * 4);
    return {
      tex,
      data,
      upload() {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, data);
      },
    };
  }
  const schemeTable = table(1, "u_schemes", TERRAIN_TEXELS, MAX_SCHEMES);
  const splotchTable = table(2, "u_splotchTable", SPLOTCH_TEXELS, MAX_SPLOTCHES);
  // Row 0 is the incumbent; each group of splotches holds a row of its own
  // for as long as any of its splotches lives.
  const holdFor = () => HOLD_S[0] + (HOLD_S[1] - HOLD_S[0]) * Math.random();
  const st: FilmState = shared ??= {
    terrain: createTerrain(Math.floor(Math.random() * 2 ** 31)),
    drag: [0, 0],
    film: emptyFilm(),
    schemes: new Map(),
    rows: new Map(),
    // The film opens already moving at the rates it was given — no ease up
    // from rest — and eases only when they change afterwards.
    motion: initialMotionState(motion),
    t0: performance.now(),
    holdUntil: holdFor(),
    frozenAt: 0,
  };
  function writeRow(row: number, s: MembraneScheme) {
    schemeTable.data.set(packScheme(s), row * TERRAIN_TEXELS * 4);
    schemeTable.upload();
  }
  function adoptRow(g: Group) {
    const held = new Set(st.rows.values());
    let row = TERRAIN_ROWS;
    while (held.has(row)) row++;
    st.rows.set(g.id, row);
    // A new color is far from every scheme the glyph is showing.
    const s = nextScheme(schemesInView(st.terrain, st.drag), Math.random);
    st.schemes.set(g.id, s);
    writeRow(row, s);
  }
  // The terrain block: rewritten when the drag has moved the glyph onto
  // another centre cell, or a wash has painted the map (blockDirty).
  let blockCentre: [number, number] | null = null;
  let blockDirty = true;
  function writeBlock() {
    const centre = centreCell(st.drag);
    if (!blockDirty && blockCentre && centre[0] === blockCentre[0] && centre[1] === blockCentre[1]) return;
    blockRows(st.terrain, st.drag).forEach((c, row) => schemeTable.data.set(packCell(c), row * TERRAIN_TEXELS * 4));
    schemeTable.upload();
    gl.uniform2f(uCell0, centre[0], centre[1]);
    blockCentre = centre;
    blockDirty = false;
  }
  /** Paint a scheme onto every cell the glyph can show: what a wash that
   *  won leaves behind, geographically. */
  function paintView(s: MembraneScheme) {
    paintCells(st.terrain, cellsInView(st.terrain, st.drag), s);
    blockDirty = true;
  }
  /** Forget the rows of groups that are gone. */
  function releaseRows() {
    const alive = new Set(st.film.groups.map((g) => g.id));
    for (const id of [...st.rows.keys()]) if (!alive.has(id)) { st.rows.delete(id); st.schemes.delete(id); }
  }
  // The terrain and the splotches over it. The clock, the swirl and
  // the lift run on untouched throughout, so the film never jumps; color only
  // arrives where a splotch or the automatic change takes ground, or where
  // the hand drags the film to.
  const glyphPoints = sampleGlyph(new Path2D(MO_GLYPH_PATH));
  // A new engine over an existing film: restore every scheme it shows.
  for (const [id, row] of st.rows) { const sc = st.schemes.get(id); if (sc) writeRow(row, sc); }
  /** Splotches of two groups connect when their schemes are near-identical. */
  const similar = (a: Group, b: Group) => {
    const p = st.schemes.get(a.id), q = st.schemes.get(b.id);
    return !!p && !!q && schemeDistance(p, q) < SIMILAR_SCHEMES;
  };
  function touch(x: number, y: number) {
    if (reduceMotion.matches) {
      // Nothing grows or heals under reduced motion, so a tap simply turns
      // the whole film to a new scheme.
      paintView(nextScheme(schemesInView(st.terrain, st.drag), Math.random));
      return;
    }
    const r = tap(st.film, x, y, Math.random);
    st.film = r.film;
    if (r.started) adoptRow(r.started);
    if (r.recolored) {
      // Another scheme for the same splotches: far from the one it had, so
      // "not that color" visibly is not.
      const row = st.rows.get(r.recolored.id);
      const was = st.schemes.get(r.recolored.id) ?? null;
      if (row !== undefined) {
        const sc = nextScheme(was, Math.random);
        st.schemes.set(r.recolored.id, sc);
        writeRow(row, sc);
      }
    }
    releaseRows();
  }
  let targetMotion = motion;
  function setMotion(next: MembraneMotion) {
    targetMotion = next;
  }
  let held = false;
  function hold(on: boolean) {
    held = on;
  }
  function drag(dx: number, dy: number) {
    st.motion = dragMotion(st.motion, dx, dy);
    st.film = shift(st.film, dx, dy);   // the paint comes with the film
    st.drag = [st.drag[0] + dx, st.drag[1] + dy];   // and so does the map
  }
  const [r, g, b] = hexToRgb(GROUND);
  gl.uniform3f(u("u_bg"), r, g, b);
  gl.uniform1i(u("u_mask"), 0);

  const maskTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  // ---- mask: the outline, filled at device resolution ----
  const maskCanvas = document.createElement("canvas");
  const path = new Path2D(MO_GLYPH_PATH);
  function rasterize(sidePx: number) {
    const S = Math.max(2, Math.round(sidePx));
    maskCanvas.width = S;
    maskCanvas.height = S;
    const ctx2d = maskCanvas.getContext("2d");
    if (!ctx2d) return;
    ctx2d.clearRect(0, 0, S, S);
    ctx2d.setTransform(S / MO_GLYPH_BOX, 0, 0, S / MO_GLYPH_BOX, 0, 0);
    ctx2d.fillStyle = "#fff";
    ctx2d.fill(path);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
  }

  // The backing store follows the zoom: device pixels per CSS pixel times the
  // visual viewport's scale, so a pinch-zoomed glyph is re-rendered sharp at
  // the size it is actually being looked at instead of upscaled from a raster
  // made for 1x. The element's CSS size never changes; only the pixels behind
  // it multiply, and only while zoomed.
  const MAX_DPR = 5;
  function resize() {
    const zoom = window.visualViewport?.scale ?? 1;
    const dpr = Math.min(MAX_DPR, (window.devicePixelRatio || 1) * zoom);
    const rect = host.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width * dpr));
    const H = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.uniform2f(uRes, W, H);
    const s = Math.min(W, H);
    gl.uniform4f(uGlyph, (W - s) / 2, (H - s) / 2, s, s);
    rasterize(s);
  }

  // ---- loop ----
  // Two clocks. Schemes turn over on wall time since load, so the colors a
  // minute apart differ whether or not the glyph was on screen. The film's
  // motion advances only by the frames actually drawn (start() restarts the
  // step clock, and stepMotion clamps a long frame), so a glyph scrolled back
  // into view resumes where it was left.
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let lastFrame = 0;
  let raf = 0;
  let running = false;
  function frame(now: number) {
    raf = 0;
    if (!running) return;
    const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
    lastFrame = now;
    let t = (now - st.t0) / 1000;
    if (reduceMotion.matches) t = st.frozenAt;
    else {
      st.frozenAt = t;
      st.motion = stepMotion(st.motion, targetMotion, dt, held);
      // The automatic change: an invasion planted somewhere in the glyph. On
      // the wall clock, so that a return after an absence longer than the
      // hold plants it on this very frame (autoDue, claude-xaj5pb9b:18).
      if (autoDue(st.film, st.holdUntil, t)) {
        const [x, y] = glyphPoints[Math.floor(Math.random() * glyphPoints.length)];
        const r = invade(st.film, x, y, Math.random);
        if (r) { st.film = r.film; adoptRow(r.started); }
        st.holdUntil = t + holdFor();
      }
      st.film = step(st.film, dt, similar);
      // A wash that covers every glyph pixel, beyond its dithering, is the
      // film now, in its colors: adopting it changes nothing visible.
      const won = st.film.groups.find((g) => washing(g, st.film.clock) && covers(st.film, g.id, glyphPoints));
      if (won) {
        const s = st.schemes.get(won.id);
        if (s) paintView(s);
        st.film = adopt(st.film, won.id);
        st.holdUntil = t + holdFor();
      }
      releaseRows();
    }
    gl.uniform2f(uOffset, st.motion.offset[0], st.motion.offset[1]);
    gl.uniform1f(uPhase, st.motion.phase);
    gl.uniform2f(uDrag, st.drag[0], st.drag[1]);
    writeBlock();
    splotchTable.data.set(packSplotches(st.film, (id) => st.rows.get(id) ?? 0));
    splotchTable.upload();
    gl.uniform1f(uSplotchCount, Math.min(st.film.splotches.length, MAX_SPLOTCHES));
    // Film time, not wall time: it advances only with frames drawn, so the
    // fronts' dithering never jumps after the tab was hidden.
    gl.uniform1f(uClock, st.film.clock);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (running) return;
    running = true;
    lastFrame = 0; // the first frame back steps by zero, not by the absence
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  // Run only while both the tab is visible and the glyph is on screen: as a
  // list footer it spends most of its life scrolled away, and a shader loop
  // for something nobody can see is the one cost this must not have.
  let inView = true;
  const settle = () => { if (!document.hidden && inView) start(); else stop(); };
  const onVisibility = settle;
  document.addEventListener("visibilitychange", onVisibility);
  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        inView = entries.some((e) => e.isIntersecting);
        settle();
      }, { threshold: 0 })
    : null;
  io?.observe(host);

  // ---- the hand ----
  // A press holds the film at once: the drift stops under the hand, movement
  // past the slop drags the film from the press point, and a release within
  // TAP_MS without that movement is a tap. Longer is a hold, farther is a
  // drag, and neither plants anything — a scroll must never splotch
  // (claude-xaj5pb9b:40). The same for a finger as for a mouse
  // (claude-xaj5pb9b:34, :36). #478 had a finger wait 220 ms before holding,
  // so that a swipe starting on the glyph could still be the list scrolling
  // (claude-u6qlei0j:6); the operator gave that up for a terrain that
  // scrolls the moment it is touched. `touch-action: none` on the host is
  // what makes it hold: the browser never begins a pan from the glyph, so it
  // never cancels the pointer stream, and the list still scrolls from
  // anywhere else. The touchmove preventDefault is belt to those braces.
  //
  // The press ends on any evidence that the hand has let go, and every move
  // is checked before it is applied, so the film can never keep following a
  // button that is up (claude-xaj5pb9b:39): a release on the host or seen at
  // the window, a cancel, a lost capture, the window losing focus, the page
  // going hidden, or a non-touch move that reports no button down.
  const SLOP_PX = 8;
  const TAP_MS = 250;
  let press: { id: number; at: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;
  const glyphAt = (px: number, py: number): [number, number] => {
    const r = host.getBoundingClientRect();
    return [(px - r.left) / r.width - 0.5, (py - r.top) / r.height - 0.5];
  };
  const endPress = () => {
    if (!press) return;
    hold(false);
    try { host.releasePointerCapture(press.id); } catch { /* already released */ }
    press = null;
  };
  const onPointerDown = (e: PointerEvent) => {
    if (press || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    press = { id: e.pointerId, at: performance.now(), x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
    hold(true);
    try { host.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.id) return;
    // A mouse or pen that moves with no button down was released somewhere
    // the release never reached us — outside the window, over the browser's
    // own chrome, in a browser that dropped the capture (claude-xaj5pb9b:32).
    // The press is over; the film must not follow a hand that has let go.
    if (e.pointerType !== "touch" && e.buttons === 0) { endPress(); return; }
    // The film drags only once past the slop, so a tap stays a tap; the
    // first move past it catches the film up from the press point.
    if (!press.moved) {
      if (Math.hypot(e.clientX - press.startX, e.clientY - press.startY) <= SLOP_PX) return;
      press.moved = true;
      press.x = press.startX;
      press.y = press.startY;
    }
    const r = host.getBoundingClientRect();
    drag((e.clientX - press.x) / r.width, (e.clientY - press.y) / r.height);
    press.x = e.clientX;
    press.y = e.clientY;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.id) return;
    const isTap = !press.moved && performance.now() - press.at < TAP_MS;
    endPress();
    if (isTap) { touch(...glyphAt(e.clientX, e.clientY)); onTap(); }
  };
  const onPointerCancel = (e: PointerEvent) => {
    if (press && e.pointerId === press.id) endPress();
  };
  // The release can arrive without the capture that was meant to route it
  // here: listen on the window too, and end the press when the capture is
  // lost or the window loses focus. onPointerUp is idempotent, so a release
  // the host already handled is a no-op here.
  const onWindowBlur = () => endPress();
  const onHidden = () => { if (document.hidden) endPress(); };
  const onTouchMove = (e: TouchEvent) => {
    if (press) e.preventDefault();
  };
  const onContextMenu = (e: Event) => e.preventDefault();
  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
  host.addEventListener("pointercancel", onPointerCancel);
  host.addEventListener("lostpointercapture", onPointerCancel);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("visibilitychange", onHidden);
  host.addEventListener("touchmove", onTouchMove, { passive: false });
  host.addEventListener("contextmenu", onContextMenu);

  let resizeTimer = 0;
  const scheduleResize = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 60);
  };
  const ro = new ResizeObserver(scheduleResize);
  ro.observe(host);
  // A pinch-zoom changes the visual viewport's scale without resizing the host.
  window.visualViewport?.addEventListener("resize", scheduleResize);

  resize();
  settle();

  return {
    touch,
    hold,
    drag,
    setMotion,
    destroy() {
      stop();
      endPress();
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerCancel);
      host.removeEventListener("lostpointercapture", onPointerCancel);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onHidden);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("contextmenu", onContextMenu);
      ro.disconnect();
      io?.disconnect();
      window.visualViewport?.removeEventListener("resize", scheduleResize);
      window.clearTimeout(resizeTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteTexture(maskTex);
      gl.deleteTexture(schemeTable.tex);
      gl.deleteTexture(splotchTable.tex);
      gl.deleteBuffer(quad);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

/** The glyph's side: a square, as large as it can be without crowding a
 *  phone (60vw), a short window (38vh), or a desktop (360px). */
export const MEMBRANE_SIDE = "min(60vw, 38vh, 360px)";

export default function Membrane({ voice, lift, sway, churn, onTap }: MembraneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [glOk, setGlOk] = useState(true);

  // The engine outlives renders; it reads the current motion from here when it
  // is built (and rebuilt after a lost context) and is told when it changes.
  const motion = membraneMotion(voice, { lift, sway, churn });
  const motionRef = useRef(motion);
  motionRef.current = motion;
  // Read at tap time, so a new callback never rebuilds the engine.
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  useEffect(() => {
    const host = hostRef.current, canvas = canvasRef.current;
    if (!host || !canvas) return;
    const tapped = () => onTapRef.current?.();
    let engine = createEngine(canvas, host, motionRef.current, tapped);
    if (!engine) { setGlOk(false); return; }
    engineRef.current = engine;

    // A lost context (GPU reset, backgrounded iOS tab) is rebuilt on restore.
    const onLost = (e: Event) => { e.preventDefault(); engine?.destroy(); engine = null; engineRef.current = null; };
    const onRestored = () => { engine = createEngine(canvas, host, motionRef.current, tapped); engineRef.current = engine; };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      engine?.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setMotion(motionRef.current);
  }, [motion.lift, motion.sway, motion.churn]);

  // Pointer handling is the engine's (it needs the hold and the drag as well
  // as the tap); the keyboard touches the glyph's middle. Without WebGL there
  // is no engine and nothing to drag, so a click on the outline is the tap.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      engineRef.current?.touch(0, 0);
      onTapRef.current?.();
    }
  }, []);
  const onOutlineClick = useCallback(() => onTapRef.current?.(), []);

  return (
    <div
      ref={hostRef}
      role="button"
      tabIndex={0}
      aria-label="Change the colors"
      onKeyDown={onKeyDown}
      style={{
        width: MEMBRANE_SIDE,
        aspectRatio: "1 / 1",
        maxWidth: "100%",
        position: "relative",
        cursor: "pointer",
        outline: "none",
        // Nothing here is text, and a hold must not select, magnify, or call out.
        // A touch here is the film's, never the list's (see `the hand`).
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        WebkitTapHighlightColor: "transparent",
      } as React.CSSProperties}
    >
      {glOk ? (
        <canvas
          ref={canvasRef}
          aria-hidden
          style={{ width: "100%", height: "100%", display: "block", background: GROUND }}
        />
      ) : (
        <svg viewBox={`0 0 ${MO_GLYPH_BOX} ${MO_GLYPH_BOX}`} width="100%" height="100%" aria-hidden onClick={onOutlineClick}>
          <path d={MO_GLYPH_PATH} fill="#3a3a42" />
        </svg>
      )}
    </div>
  );
}
