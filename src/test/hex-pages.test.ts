import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hexColumnOf, hexDumpRows, hexRows } from "../shared/hex-dump.js";
import { hexSegments, pageOf, pagesOfHit, rowSpans } from "../shared/hex-pages.js";

// The hex view draws whichever pages are loaded, in place, and 🔎 paints a
// hit by row and column. Each rule here is one a highlight or a gap row would
// be visibly wrong without.

describe("hexSegments", () => {
  it("is one page for a file that fits in one", () => {
    assert.deepEqual(hexSegments([{ offset: 0, length: 100, eof: true }], 100), [{ kind: "page", offset: 0 }]);
  });

  it("puts a gap between pages that don't touch, and after the last until the end", () => {
    const segs = hexSegments(
      [{ offset: 32, length: 16, eof: false }, { offset: 0, length: 16, eof: false }],
      100,
    );
    assert.deepEqual(segs, [
      { kind: "page", offset: 0 },
      { kind: "gap", from: 16, to: 32 },
      { kind: "page", offset: 32 },
      { kind: "gap", from: 48, to: 100 },
    ]);
  });

  it("joins adjacent pages with no gap", () => {
    const segs = hexSegments([{ offset: 0, length: 16, eof: false }, { offset: 16, length: 4, eof: true }], 20);
    assert.deepEqual(segs, [{ kind: "page", offset: 0 }, { kind: "page", offset: 16 }]);
  });

  it("leaves the end open while the size is unknown, and closes it at eof", () => {
    assert.deepEqual(hexSegments([{ offset: 0, length: 16, eof: false }], null).at(-1), { kind: "gap", from: 16, to: null });
    assert.deepEqual(hexSegments([{ offset: 0, length: 16, eof: false }, { offset: 48, length: 3, eof: true }], null).at(-1), { kind: "page", offset: 48 });
  });

  it("opens with a gap when the first page isn't loaded", () => {
    assert.deepEqual(hexSegments([{ offset: 64, length: 16, eof: false }], 200)[0], { kind: "gap", from: 0, to: 64 });
  });
});

describe("page and row arithmetic", () => {
  it("places a byte on its page, and a hit on every page it touches", () => {
    assert.equal(pageOf(0, 16), 0);
    assert.equal(pageOf(31, 16), 16);
    assert.deepEqual(pagesOfHit(14, 4, 16), [0, 16]);
    assert.deepEqual(pagesOfHit(16, 16, 16), [16]);
    assert.deepEqual(pagesOfHit(5, 0, 16), [0]);
  });

  it("splits a hit that wraps a row into one span per row", () => {
    assert.deepEqual(rowSpans(14, 4, 16), [{ row: 0, first: 14, last: 15 }, { row: 16, first: 0, last: 1 }]);
    assert.deepEqual(rowSpans(3, 2, 8), [{ row: 0, first: 3, last: 4 }]);
    assert.deepEqual(rowSpans(6, 20, 8), [
      { row: 0, first: 6, last: 7 },
      { row: 8, first: 0, last: 7 },
      { row: 16, first: 0, last: 7 },
      { row: 24, first: 0, last: 1 },
    ]);
  });

  it("finds every byte's digits where hexColumnOf says, at both widths", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
    for (const rowBytes of [16, 8]) {
      const [row] = hexRows(bytes, 0, rowBytes);
      for (let j = 0; j < rowBytes; j++) {
        const at = hexColumnOf(j, rowBytes);
        assert.equal(row.hex.slice(at, at + 2), (0xa0 + j).toString(16), `byte ${j} at ${rowBytes}/row`);
      }
      assert.equal(row.ascii.length, rowBytes);
    }
  });

  it("composes to the same row hexDumpRows always drew", () => {
    const bytes = Buffer.from("Hello, world!\n\x00\x01ABC");
    const composed = hexRows(bytes, 0x20).map((r) => `${r.offset}  ${r.hex} ${r.ascii}`);
    assert.deepEqual(composed, hexDumpRows(bytes, 0x20));
  });
});
