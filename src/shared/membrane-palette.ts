/**
 * The 膜 film's color schemes: which colors, in what order.
 *
 * The first palette (#465) was a cosine gradient whose three channel phases
 * sat a third of a turn apart, so every scheme it could produce was the same
 * rainbow — all hues, always in the same order — and the noise that walked it
 * had a standard deviation of 0.097, too small to leave the rainbow. Across
 * sixteen taps it read as about four schemes (claude-1cwe8u9p:22).
 *
 * A scheme here is two things, deliberately separate:
 *
 * - **Lightness** is today's banding, unchanged in character: a cosine in
 *   film thickness at 2.4–3.7 cycles per unit, swinging L from about 0.35 to
 *   0.95. It is what gives the film its detail density and contrast, and the
 *   operator asked that those stay exactly as they were (claude-1cwe8u9p:28).
 * - **Hue** comes from 3–5 anchor colors, randomly permuted — the same colors
 *   in another order are another film (claude-1cwe8u9p:23) — cycled through
 *   at their own rate, incommensurate with the lightness bands so the two
 *   never lock. Transitions between anchors are eased so a color holds and
 *   then turns, rather than smearing into its neighbor (claude-1cwe8u9p:29).
 *
 * No two anchors of one scheme may look alike (claude-1cwe8u9p:31–33). Hue
 * angle alone does not guarantee that: where sRGB is narrow — the cyans — two
 * hues 30° apart fit to nearly the same displayable color. So anchors are
 * compared as they will render: gamut-fitted, in OKLab, at the lightnesses
 * the bands pass through.
 *
 * Window-free, and every draw takes its random source as an argument, so
 * `src/test/membrane-palette.test.ts` can pin all of this with a seeded one.
 */

export type Rng = () => number;

export type MembraneScheme = {
  family: string;
  /** Anchor hues in radians, in the order the film passes through them. */
  hues: number[];
  /** Anchor chromas (OKLCH C), before gamut fitting. */
  chromas: number[];
  /** Lightness banding: cycles per unit thickness, phase (turns), mid, amplitude. */
  light: [cL: number, phL: number, Lmid: number, Lamp: number];
  /** Hue cycling: passes through the anchors per unit thickness, phase (turns),
   *  and the half-width of each anchor-to-anchor transition (0.5 = linear-ish). */
  hue: [cH: number, phH: number, w: number];
};

export const MIN_ANCHORS = 3;
export const MAX_ANCHORS = 5;
/** Minimum hue separation between any two anchors, degrees. */
export const MIN_HUE_SEP_DEG = 28;
/** Minimum OKLab distance between any two anchors once fitted to sRGB. */
export const MIN_ANCHOR_DE = 0.09;
/** The lightnesses at which anchors are compared: the band's middle range. */
export const DISTINCT_AT_L = [0.5, 0.65, 0.8];
/** How far a keyframe must be from the one it replaces (mean OKLab a/b distance). */
export const MIN_SCHEME_DISTANCE = 0.12;

/**
 * No color from the band between amber and green. The band from about 60°
 * (amber) through yellow to about 130° (lime) reads as snot green and
 * mustard at the lightnesses the film's bands pass through, and the
 * operator wants it out of every scheme (claude-u6qlei0j:8, :17). Three
 * measures:
 *
 * - No anchor in EXCLUDED_HUE_DEG. A draw that lands there is redrawn, not
 *   remapped, so no hue on either side is over-represented and the families
 *   keep their shape.
 * - Anchors are joined by a straight line through OKLab a/b, not around the
 *   hue wheel (abAt, the shader's anchorAB). Around the wheel, green to
 *   magenta swept through yellow, orange and red — a small rainbow whose
 *   yellow strip was a mustard band with hard edges. Along the line the two
 *   fade through gray and pass through no hue they do not share. Neighboring
 *   hues (30–45°) look the same either way.
 * - What still lands in the band — two anchors that straddle it closely,
 *   orange and green, say — is shown neutral: chroma fades to zero across
 *   BAND_FADE_DEG (ramped inside the band, so an anchor just outside keeps
 *   its color), and the film goes silvery there at the banding's lightness.
 *   (Before this the shader *lifted* lightness through the band so amber
 *   would glow, per claude-1cwe8u9p:38 — the opposite instinct.)
 */
export const EXCLUDED_HUE_DEG: [number, number] = [60, 130];
/** Chroma is faded to nothing between the inner two, ramping over the outer pairs. */
export const BAND_FADE_DEG: [number, number, number, number] = [60, 75, 115, 130];

/** Whether a hue (degrees, 0–360) is one no anchor may take. */
export function hueExcluded(hDeg: number): boolean {
  return hDeg >= EXCLUDED_HUE_DEG[0] && hDeg <= EXCLUDED_HUE_DEG[1];
}

/** How much of a hue's chroma the band takes away, 0 outside it, 1 in its middle. */
export function bandFade(hDeg: number): number {
  const [b0, b1, b2, b3] = BAND_FADE_DEG;
  return smoothstep(b0, b1, hDeg) * (1 - smoothstep(b2, b3, hDeg));
}

/** An OKLab a/b offset with the band's chroma taken out of it. */
export function neutralizeBand(a: number, b: number): [number, number] {
  const hDeg = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const k = 1 - bandFade(hDeg);
  return [a * k, b * k];
}

// ---- OKLab (Björn Ottosson) ----

export function oklabToLinearSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const EPS = 1e-4;
export function inSrgbGamut(L: number, a: number, b: number): boolean {
  return oklabToLinearSrgb(L, a, b).every((v) => v >= -EPS && v <= 1 + EPS);
}

/** OKLab of (L, C, h) with C reduced as far as needed to be displayable. The
 *  shader does the same fit per pixel, with fewer bisection steps. */
export function fitToGamut(L: number, C: number, h: number): [number, number, number] {
  const at = (c: number): [number, number, number] => [L, c * Math.cos(h), c * Math.sin(h)];
  if (inSrgbGamut(...at(C))) return at(C);
  let lo = 0, hi = C;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inSrgbGamut(...at(mid))) lo = mid; else hi = mid;
  }
  return at(lo);
}

// ---- anchors ----

const DEG = Math.PI / 180;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function hueSeparationDeg(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

/** Whether no two of these hues (degrees) would render alike. */
export function anchorsDistinct(huesDeg: number[]): boolean {
  for (let i = 0; i < huesDeg.length; i++) {
    for (let j = i + 1; j < huesDeg.length; j++) {
      if (hueSeparationDeg(huesDeg[i], huesDeg[j]) < MIN_HUE_SEP_DEG) return false;
      for (const L of DISTINCT_AT_L) {
        const [, a1, b1] = fitToGamut(L, 0.3, huesDeg[i] * DEG);
        const [, a2, b2] = fitToGamut(L, 0.3, huesDeg[j] * DEG);
        if (Math.hypot(a1 - a2, b1 - b2) < MIN_ANCHOR_DE) return false;
      }
    }
  }
  return true;
}

const range = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];

/** Harmony families, each a base hue (degrees) → anchor hues (degrees). */
const FAMILIES: Record<string, (h: number, rng: Rng) => number[]> = {
  analogous: (h, rng) => {
    const n = pick(rng, [3, 4]), s = range(rng, 30, 45);
    return Array.from({ length: n }, (_, i) => h + s * (i - (n - 1) / 2));
  },
  complementary: (h, rng) => {
    const s = range(rng, 35, 60);
    return pick(rng, [[h, h + 180, h + s], [h, h + 180, h + 180 + s], [h, h + s, h + 180, h + 180 + s]]);
  },
  split: (h, rng) => { const s = range(rng, 25, 45); return [h, h + 180 - s, h + 180 + s]; },
  triadic: (h) => [h, h + 120, h + 240],
  tetradic: (h, rng) => { const w = pick(rng, [60, 90]); return [h, h + w, h + 180, h + 180 + w]; },
  accent: (h, rng) => { const s = range(rng, 30, 45); return [h, h + s, h + pick(rng, [150, 180, 210]) + s / 2]; },
  wild: (_h, rng) => Array.from({ length: pick(rng, [3, 4, 5]) }, () => range(rng, 0, 360)),
};
export const SCHEME_FAMILIES = Object.keys(FAMILIES);

function shuffle<T>(xs: T[], rng: Rng): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/** One scheme: a family's hues, jittered, redrawn until all are distinct and
 *  none is in the excluded band, then permuted. */
export function sampleScheme(rng: Rng): MembraneScheme {
  let family: string, degs: number[];
  do {
    family = pick(rng, SCHEME_FAMILIES);
    degs = FAMILIES[family](range(rng, 0, 360), rng)
      .map((h) => (((h + range(rng, -8, 8)) % 360) + 360) % 360);
  } while (degs.length < MIN_ANCHORS || degs.length > MAX_ANCHORS || degs.some(hueExcluded) || !anchorsDistinct(degs));
  const hues = shuffle(degs, rng).map((d) => d * DEG);
  return {
    family,
    hues,
    chromas: hues.map(() => range(rng, 0.15, 0.32)),
    light: [range(rng, 2.4, 3.7), rng(), range(rng, 0.62, 0.68), range(rng, 0.27, 0.32)],
    // At least one full pass through the anchors per unit thickness, so the
    // glyph's range of thicknesses shows every one of them.
    hue: [range(rng, 1.0, 1.5), rng(), range(rng, 0.18, 0.45)],
  };
}

/** The scheme's color at position `x` through one pass of the anchors,
 *  0 ≤ x < 1, as an OKLab a/b offset — the shader's anchor lookup (anchorAB),
 *  for tests and tooling: each anchor holds, then turns into the next along
 *  a straight line, and the band is neutralized. */
export function abAt(s: MembraneScheme, x: number, w = s.hue[2]): [number, number] {
  const n = s.hues.length;
  const pos = ((((x % 1) + 1) % 1) * n);
  const i = Math.floor(pos) % n, j = (i + 1) % n;
  const f = smoothstep(0.5 - w, 0.5 + w, pos - Math.floor(pos));
  const ai = s.chromas[i] * Math.cos(s.hues[i]), bi = s.chromas[i] * Math.sin(s.hues[i]);
  const aj = s.chromas[j] * Math.cos(s.hues[j]), bj = s.chromas[j] * Math.sin(s.hues[j]);
  return neutralizeBand(ai + (aj - ai) * f, bi + (bj - bi) * f);
}

/** Hue (radians) and chroma at position `x`: abAt in polar form. */
export function hueChromaAt(s: MembraneScheme, x: number, w = s.hue[2]): [number, number] {
  const [a, b] = abAt(s, x, w);
  return [Math.atan2(b, a), Math.hypot(a, b)];
}

/** Mean a/b distance between two schemes' hue cycles, pass for pass. Order
 *  matters: a permutation of the same anchors is far from the original. */
export function schemeDistance(p: MembraneScheme, q: MembraneScheme): number {
  const N = 32;
  let t = 0;
  for (let i = 0; i < N; i++) {
    const [h1, c1] = hueChromaAt(p, i / N, 0.5);
    const [h2, c2] = hueChromaAt(q, i / N, 0.5);
    t += Math.hypot(c1 * Math.cos(h1) - c2 * Math.cos(h2), c1 * Math.sin(h1) - c2 * Math.sin(h2));
  }
  return t / N;
}

/** The keyframe after `prev`: a fresh scheme far enough from it — from each
 *  of them, when there are several, as a terrain cell's neighbors are — to
 *  read as a different film rather than a nudge. */
export function nextScheme(prev: MembraneScheme | readonly MembraneScheme[] | null, rng: Rng): MembraneScheme {
  const prevs = prev === null ? [] : Array.isArray(prev) ? prev : [prev as MembraneScheme];
  for (let tries = 0; tries < 200; tries++) {
    const s = sampleScheme(rng);
    if (prevs.every((p) => schemeDistance(s, p) >= MIN_SCHEME_DISTANCE)) return s;
  }
  return sampleScheme(rng);
}

/** Texels per scheme row in the shader's table (see packScheme). */
export const SCHEME_TEXELS = 5;

/**
 * One scheme as a row of the shader's scheme table, SCHEME_TEXELS RGBA texels:
 *   (anchor count, hue rate, hue phase, transition half-width),
 *   (banding cycles, banding phase, L mid, L amplitude),
 *   then the anchors as packAnchors lays them out, two per texel.
 */
export function packScheme(s: MembraneScheme): Float32Array {
  const out = new Float32Array(SCHEME_TEXELS * 4);
  out.set([s.hues.length, ...s.hue, ...s.light]);
  out.set(packAnchors(s), 8);
  return out;
}

/** Anchors packed for the shader: (hue, chroma) pairs, with the first repeated
 *  after the last so the lookup never needs a modulo, padded to MAX_ANCHORS + 1. */
export function packAnchors(s: MembraneScheme): Float32Array {
  const out = new Float32Array((MAX_ANCHORS + 1) * 2);
  for (let k = 0; k <= MAX_ANCHORS; k++) {
    const j = k % s.hues.length;
    out[2 * k] = s.hues[j];
    out[2 * k + 1] = s.chromas[j];
  }
  return out;
}
