// The hex view's page arithmetic, window-free so it can be tested without a
// browser. A file is shown as whichever of its 16 KB pages have been loaded,
// in place, with a gap row standing for each unloaded run between them; a
// search hit names bytes, and these say which pages and rows those bytes are
// on.

import { HEX_PAGE_BYTES } from "./hex-dump.js";

export interface LoadedPage {
  offset: number;
  /** Bytes the page holds: HEX_PAGE_BYTES except for the file's last page. */
  length: number;
  /** No bytes follow it. */
  eof: boolean;
}

export type HexSegment =
  | { kind: "page"; offset: number }
  /** Bytes [from, to) are not loaded; `to` is null when the file's end is not
   *  known yet (a `.gz` body read no further than this). */
  | { kind: "gap"; from: number; to: number | null };

/** The page that byte `offset` is on. Pages sit on multiples of the page
 *  size, so two loaded neighbours always join without a seam. */
export function pageOf(offset: number, pageBytes = HEX_PAGE_BYTES): number {
  return offset - (offset % pageBytes);
}

/** Every page a hit of `length` bytes at `at` touches. */
export function pagesOfHit(at: number, length: number, pageBytes = HEX_PAGE_BYTES): number[] {
  const out: number[] = [];
  for (let p = pageOf(at, pageBytes); p < at + Math.max(1, length); p += pageBytes) out.push(p);
  return out;
}

/** The file as it will be drawn: loaded pages in order, a gap wherever the
 *  next page doesn't start where the last one ended, and a trailing gap
 *  until the page holding the end has been read. `size` is the file's size
 *  when known. */
export function hexSegments(pages: readonly LoadedPage[], size: number | null): HexSegment[] {
  const sorted = [...pages].sort((a, b) => a.offset - b.offset);
  const out: HexSegment[] = [];
  let at = 0;
  let end: number | null = size;
  for (const p of sorted) {
    if (p.offset > at) out.push({ kind: "gap", from: at, to: p.offset });
    out.push({ kind: "page", offset: p.offset });
    at = p.offset + p.length;
    if (p.eof) end = at;
  }
  if (end === null || at < end) out.push({ kind: "gap", from: at, to: end });
  return out;
}

/** A hit's bytes, row by row: for each row it touches, the row's start and
 *  the first and last byte of the hit within it (inclusive, 0-based in the
 *  row). A hit that wraps a row is two spans, which is how it is painted in
 *  both columns. */
export function rowSpans(at: number, length: number, rowBytes: number): Array<{ row: number; first: number; last: number }> {
  const out: Array<{ row: number; first: number; last: number }> = [];
  const end = at + Math.max(1, length);
  for (let row = at - (at % rowBytes); row < end; row += rowBytes) {
    out.push({ row, first: Math.max(at, row) - row, last: Math.min(end, row + rowBytes) - 1 - row });
  }
  return out;
}
