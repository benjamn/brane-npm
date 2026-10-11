import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  blockGlyphClass,
  blockGlyphStylesheet,
  paintBlockGlyphs,
} from "../shared/block-glyphs.js";

// The terminal mirror paints block elements rather than typesetting them, so
// `brane meld`'s QR code has no gap between rows. These pin the two halves
// that have to agree: every glyph the painter wraps has a rule that paints it,
// and the painter leaves everything else — nearly every line — alone.

const ALL_BLOCKS = Array.from({ length: 0x20 }, (_, i) => 0x2580 + i);

describe("paintBlockGlyphs", () => {
  it("returns a line with no block element unchanged", () => {
    const html = '<span style="color:rgb(0,187,0)">$ ls -la</span> ─│ ●';
    assert.equal(paintBlockGlyphs(html), html);
  });

  it("wraps each block element in its own span, keeping the character", () => {
    assert.equal(
      paintBlockGlyphs("a▀▄b"),
      'a<span class="tb tb-2580">▀</span><span class="tb tb-2584">▄</span>b',
    );
  });

  it("paints inside ansi_up's color spans, so currentColor is the SGR color", () => {
    const html = '<span style="color:rgb(255,0,0)">█</span>';
    assert.equal(
      paintBlockGlyphs(html),
      '<span style="color:rgb(255,0,0)"><span class="tb tb-2588">█</span></span>',
    );
  });

  it("keeps the text content identical, so copy yields the real characters", () => {
    const line = "▄▄▄▄▄▄▄ ▄ ▄▄ ░▒▓ ▙▟";
    const stripped = paintBlockGlyphs(line).replace(/<[^>]*>/g, "");
    assert.equal(stripped, line);
  });

  it("covers every codepoint in U+2580–U+259F", () => {
    const line = String.fromCharCode(...ALL_BLOCKS);
    const classes = [...paintBlockGlyphs(line).matchAll(/class="tb (tb-[0-9a-f]+)"/g)].map((m) => m[1]);
    assert.deepEqual(classes, ALL_BLOCKS.map(blockGlyphClass));
  });

  it("leaves the neighbors of the range alone", () => {
    const line = "╿■"; // ╿ and ■, just outside the block
    assert.equal(paintBlockGlyphs(line), line);
  });
});

describe("blockGlyphStylesheet", () => {
  const css = blockGlyphStylesheet(1.4);

  it("gives every class the painter emits a background rule", () => {
    for (const cp of ALL_BLOCKS) {
      assert.match(css, new RegExp(`\\.${blockGlyphClass(cp)}\\{background:`), `U+${cp.toString(16)}`);
    }
  });

  it("makes the cell exactly one line box tall and one cell wide", () => {
    assert.match(css, /\.tb\{[^}]*height:1\.4em/);
    assert.match(css, /\.tb\{[^}]*width:1ch/);
    assert.match(css, /\.tb\{[^}]*vertical-align:top/);
  });

  it("hides the glyph without touching color, which the paint is drawn in", () => {
    assert.match(css, /-webkit-text-fill-color:transparent/);
    assert.doesNotMatch(css, /[{;]color:/);
  });

  it("paints half blocks as one full-tile gradient with a hard stop", () => {
    assert.match(css, /\.tb-2580\{background:linear-gradient\(to bottom,currentColor 50%,transparent 50%\)\}/);
    assert.match(css, /\.tb-2584\{background:linear-gradient\(to top,currentColor 50%,transparent 50%\)\}/);
    assert.match(css, /\.tb-2590\{background:linear-gradient\(to left,currentColor 50%,transparent 50%\)\}/);
    assert.match(css, /\.tb-2588\{background:currentColor\}/);
  });

  it("paints quadrants as one conic sweep: ▚ is upper-left and lower-right", () => {
    assert.match(
      css,
      /\.tb-259a\{background:conic-gradient\(at 50% 50%,transparent 0 25%,currentColor 0 50%,transparent 0 75%,currentColor 0\)\}/,
    );
  });

  // A layer sized and positioned inside the cell anti-aliases its own edges on
  // the fractional pixels a 16.8px row lands on, leaving a hairline between
  // lit rows. Full-tile images take the box's snapped edges instead.
  it("never sizes or positions a layer", () => {
    assert.doesNotMatch(css, /no-repeat|\s\/\s/);
  });
});
