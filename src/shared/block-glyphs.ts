// Block elements (U+2580–U+259F), painted instead of typeset.
//
// A real terminal draws `▀ ▄ █` edge to edge in the cell. The mirror draws
// them as text in a line box pinned at `line-height: 1.4`, and a font's block
// glyph spans only its own ascent + descent — about 14px of a 16.8px row. So
// every row of block art is striped with a dark gap, which is what turned
// `brane meld`'s QR code into something that looked like a barcode and
// scanned badly. The same gap runs through progress bars and htop meters.
//
// The fix is the one xterm.js calls "custom glyphs": wrap each block
// character in a span exactly one cell wide and one line box tall, and paint
// it as a background in `currentColor`. The glyph itself stays in the DOM,
// hidden with `-webkit-text-fill-color: transparent` rather than `color`
// (which would take `currentColor` with it), so selection and copy still
// yield the real characters.
//
// Every paint is ONE full-tile image with hard stops — a linear gradient for
// a bar, a conic one for quadrants — never a sized, positioned layer. A 16.8px
// row puts cell edges on fractional pixels, and a layer sized to the cell
// anti-aliases its own edges there, so two lit cells meeting across a row
// each half-cover the boundary pixel and leave a faint hairline between them
// (measured in headless Chromium at 1× and 3×: visible on every row of the
// QR). A full-tile image's edges are the box's, which the browser snaps.
//
// Pure and window-free so `src/test/block-glyphs.test.ts` can pin the table.

const C = "currentColor";
const T = "transparent";

/** A bar: lit for `fraction` of the cell, measured from the side `to` points away from. */
function bar(to: "top" | "bottom" | "left" | "right", fraction: number): string {
  const p = `${+(fraction * 100).toFixed(4)}%`;
  return `linear-gradient(to ${to},${C} ${p},${T} ${p})`;
}

/**
 * Quadrants by conic sweep from 12 o'clock, clockwise: upper-right, then
 * lower-right, lower-left, upper-left.
 */
function quadrants(ur: boolean, lr: boolean, ll: boolean, ul: boolean): string {
  const q = (lit: boolean) => (lit ? C : T);
  return (
    `conic-gradient(at 50% 50%,${q(ur)} 0 25%,${q(lr)} 0 50%,` +
    `${q(ll)} 0 75%,${q(ul)} 0)`
  );
}

/** The background each block element paints, keyed by codepoint. */
const PAINT: Record<number, string> = {
  0x2580: bar("bottom", 1 / 2), // ▀ upper half
  0x2581: bar("top", 1 / 8), // ▁ lower eighths …
  0x2582: bar("top", 2 / 8), // ▂
  0x2583: bar("top", 3 / 8), // ▃
  0x2584: bar("top", 4 / 8), // ▄
  0x2585: bar("top", 5 / 8), // ▅
  0x2586: bar("top", 6 / 8), // ▆
  0x2587: bar("top", 7 / 8), // ▇
  0x2588: C, // █ full
  0x2589: bar("right", 7 / 8), // ▉ left eighths …
  0x258a: bar("right", 6 / 8), // ▊
  0x258b: bar("right", 5 / 8), // ▋
  0x258c: bar("right", 4 / 8), // ▌
  0x258d: bar("right", 3 / 8), // ▍
  0x258e: bar("right", 2 / 8), // ▎
  0x258f: bar("right", 1 / 8), // ▏
  0x2590: bar("left", 1 / 2), // ▐ right half
  // ░ ▒ ▓ — a flat tint rather than a dither, which fills the cell the same way.
  0x2591: `color-mix(in srgb,${C} 25%,${T})`,
  0x2592: `color-mix(in srgb,${C} 50%,${T})`,
  0x2593: `color-mix(in srgb,${C} 75%,${T})`,
  0x2594: bar("bottom", 1 / 8), // ▔ upper eighth
  0x2595: bar("left", 1 / 8), // ▕ right eighth
  0x2596: quadrants(false, false, true, false), // ▖
  0x2597: quadrants(false, true, false, false), // ▗
  0x2598: quadrants(false, false, false, true), // ▘
  0x2599: quadrants(false, true, true, true), // ▙
  0x259a: quadrants(false, true, false, true), // ▚
  0x259b: quadrants(true, false, true, true), // ▛
  0x259c: quadrants(true, true, false, true), // ▜
  0x259d: quadrants(true, false, false, false), // ▝
  0x259e: quadrants(true, false, true, false), // ▞
  0x259f: quadrants(true, true, true, false), // ▟
};

/** Every block element, U+2580–U+259F. */
export const BLOCK_GLYPH_RE = /[▀-▟]/g;
const HAS_BLOCK_GLYPH = /[▀-▟]/;

/** The class a block glyph's span carries: `tb-2580` for `▀`. */
export function blockGlyphClass(cp: number): string {
  return `tb-${cp.toString(16)}`;
}

/**
 * Wrap each block element in `html` in its painted span. Lines without one
 * — nearly all of them — cost a single regex test and come back unchanged.
 *
 * Safe on ansi_up output: block characters only ever appear there as text,
 * never inside a tag or attribute.
 */
export function paintBlockGlyphs(html: string): string {
  if (!HAS_BLOCK_GLYPH.test(html)) return html;
  return html.replace(
    BLOCK_GLYPH_RE,
    (ch) => `<span class="tb ${blockGlyphClass(ch.charCodeAt(0))}">${ch}</span>`,
  );
}

/**
 * The stylesheet behind `paintBlockGlyphs`, injected once per pane.
 * `lineHeight` is the pane's unitless line-height, so `height: <n>em` is
 * exactly the line box the rest of the mirror's row math divides by.
 */
export function blockGlyphStylesheet(lineHeight: number): string {
  const rules = [
    // `width: 1ch` pins the cell to the font's advance even if a glyph falls
    // back to a wider face; the glyph is invisible, so clipping it costs nothing.
    `.tb{display:inline-block;width:1ch;height:${lineHeight}em;overflow:hidden;` +
      `vertical-align:top;-webkit-text-fill-color:transparent}`,
  ];
  for (const [cp, paint] of Object.entries(PAINT)) {
    rules.push(`.${blockGlyphClass(+cp)}{background:${paint}}`);
  }
  return rules.join("\n");
}
