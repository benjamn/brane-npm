import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clampIndex } from "@shared/hit-drum";
import { hexColumnOf } from "@shared/hex-dump";
import { pageOf, pagesOfHit, rowSpans } from "@shared/hex-pages";
import { applyTarget, highlightApi, registerNames, repaint, targetOf, type FindState } from "@/lib/findInFile";
import type { HexDoc } from "@/lib/hexDoc";

/** 🔎 on a hex file: the daemon searches every byte (`/api/files/find`), and
 *  this paints what it found over whatever pages are on screen.
 *
 *  The drum rolls over every hit in the window, loaded or not, and never
 *  fetches while it rolls: a flick across three thousand spaces costs
 *  nothing. Where it comes to rest, the page under that hit is loaded and the
 *  hit brought to the middle. A hit on a page not loaded yet puts its gap row
 *  there instead, so the page still says where the reader is.
 *
 *  Same shape as `useFindInFile`, so the Files view hands either to the same
 *  search bar. */

const noSubscribe = () => () => {};
const zero = () => 0;

/** Row elements of each page drawn, by page offset. */
function pageElements(root: HTMLElement): Map<number, HTMLElement> {
  const out = new Map<number, HTMLElement>();
  // NodeList isn't iterable under the expo tsconfig's libs.
  root.querySelectorAll<HTMLElement>("[data-hex-page]").forEach((el) => {
    out.set(Number(el.dataset.hexPage), el);
  });
  return out;
}

/** The ranges that paint one hit: in the hex column and in the gutter, once
 *  per row it spans. Null while any of its pages isn't drawn. */
function hitRanges(doc: HexDoc, pages: Map<number, HTMLElement>, at: number, len: number): Range[] | null {
  const rowBytes = doc.rowBytes;
  const ranges: Range[] = [];
  for (const span of rowSpans(at, len, rowBytes)) {
    const pageOffset = pageOf(span.row, doc.pageBytes);
    const pageEl = pages.get(pageOffset);
    const rowEl = pageEl?.children[(span.row - pageOffset) / rowBytes];
    const hexText = rowEl?.children[1]?.firstChild;
    const asciiText = rowEl?.children[2]?.firstChild;
    if (!hexText || !asciiText) return null;
    const hex = document.createRange();
    hex.setStart(hexText, hexColumnOf(span.first, rowBytes));
    hex.setEnd(hexText, hexColumnOf(span.last, rowBytes) + 2);
    const ascii = document.createRange();
    ascii.setStart(asciiText, span.first);
    ascii.setEnd(asciiText, span.last + 1);
    ranges.push(hex, ascii);
  }
  return ranges;
}

/** The gap row standing for byte `at`, when its page isn't loaded. */
function gapElement(root: HTMLElement, at: number): HTMLElement | null {
  let found: HTMLElement | null = null;
  root.querySelectorAll<HTMLElement>("[data-hex-gap-from]").forEach((el) => {
    const from = Number(el.dataset.hexGapFrom);
    const to = el.dataset.hexGapTo ? Number(el.dataset.hexGapTo) : Infinity;
    if (!found && at >= from && at < to) found = el;
  });
  return found;
}

export function useHexFind({
  doc,
  query,
  enabled,
}: {
  doc: HexDoc | null;
  query: string;
  enabled: boolean;
}): FindState & {
  next: () => void;
  prev: () => void;
  seek: (pos: number, settled: boolean) => void;
  currentLine: () => number | undefined;
} {
  useSyncExternalStore(doc?.subscribe ?? noSubscribe, doc?.getVersion ?? zero);
  const version = doc?.version ?? 0;
  const layout = doc?.layout ?? 0;
  const search = doc?.search ?? null;
  const count = search?.starts.length ?? 0;

  const [current, setCurrentState] = useState(-1);
  const currentRef = useRef(-1);
  // Where the current hit starts, so a refined query stays near it.
  const anchorRef = useRef<number | null>(null);
  // A hit to bring to the middle once its page is drawn.
  const pendingRevealRef = useRef<number | null>(null);
  const snappedRef = useRef(-1);
  const searchRef = useRef<typeof search>(null);
  // Each drawn hit's ranges, from the last paint, so rolling the drum only
  // re-registers the current one.
  const rangesRef = useRef(new Map<number, Range[]>());
  const namesRef = useRef<{ all: string; current: string } | null>(null);
  const names = () => (namesRef.current ??= registerNames());

  useEffect(() => {
    doc?.setQuery(enabled ? query : "");
    // Closing 🔎 ends the search; the next one starts from the top, as the
    // text find's does.
    if (!enabled || !query) anchorRef.current = null;
  }, [doc, query, enabled]);

  useEffect(() => {
    anchorRef.current = null;
  }, [doc]);

  const paintCurrent = useCallback((i: number) => {
    const api = highlightApi();
    if (!api) return;
    const r = rangesRef.current.get(i);
    if (r) api.registry.set(names().current, new api.Highlight(...r));
    else api.registry.delete(names().current);
    repaint(doc?.root ?? null);
  }, [doc]);

  /** Make hit `i` current. React hears of it only when `commit`: while the
   *  drum rolls, the highlight moves and nothing re-renders. */
  const setCurrent = useCallback((i: number, commit: boolean) => {
    const s = doc?.search;
    if (i !== currentRef.current) {
      currentRef.current = i;
      if (i >= 0 && s) anchorRef.current = s.starts[i];
      paintCurrent(i);
    }
    if (commit) setCurrentState(i);
  }, [doc, paintCurrent]);

  /** Load the pages under hit `i` and bring it to the middle once they draw. */
  const land = useCallback((i: number) => {
    const s = doc?.search;
    if (!doc || !s || i < 0 || i >= s.starts.length) return;
    pendingRevealRef.current = i;
    for (const p of pagesOfHit(s.starts[i], s.lengths[i], doc.pageBytes)) void doc.ensure(p);
  }, [doc]);

  // A new search, or a new window of one, starts over at its first hit at or
  // after the anchor — once one has arrived, or the search has finished.
  useEffect(() => {
    if (searchRef.current !== search) {
      searchRef.current = search;
      currentRef.current = -1;
      setCurrentState(-1);
      pendingRevealRef.current = null;
      if (search && search.from > 0) anchorRef.current = search.from;
    }
    if (!search || currentRef.current >= 0 || count === 0) return;
    const anchor = anchorRef.current ?? 0;
    let i = search.starts.findIndex((s) => s >= anchor);
    if (i < 0) {
      if (search.running) return;
      i = 0;
    }
    setCurrent(i, true);
    land(i);
  }, [search, count, version, setCurrent, land]);

  // Paint every hit whose pages are drawn, then the current one over them.
  // Runs when hits arrive, a page loads, or the rows are re-laid.
  useEffect(() => {
    const api = highlightApi();
    const root = doc?.root ?? null;
    if (!api) return;
    const n = names();
    rangesRef.current = new Map();
    if (!doc || !root || !search || count === 0) {
      api.registry.delete(n.all);
      api.registry.delete(n.current);
      repaint(root);
      return;
    }
    const pages = pageElements(root);
    const all: Range[] = [];
    for (let i = 0; i < count; i++) {
      const at = search.starts[i];
      const len = search.lengths[i];
      if (!pagesOfHit(at, len, doc.pageBytes).every((p) => pages.has(p))) continue;
      const r = hitRanges(doc, pages, at, len);
      if (!r) continue;
      rangesRef.current.set(i, r);
      all.push(...r);
    }
    if (all.length) api.registry.set(n.all, new api.Highlight(...all));
    else api.registry.delete(n.all);
    paintCurrent(currentRef.current);
    const pending = pendingRevealRef.current;
    const landed = pending !== null ? rangesRef.current.get(pending) : undefined;
    if (landed && pending === currentRef.current) {
      pendingRevealRef.current = null;
      applyTarget(targetOf(landed[0]));
    }
  }, [doc, search, count, layout, paintCurrent]);

  useEffect(() => () => {
    const api = highlightApi();
    if (api && namesRef.current) {
      api.registry.delete(namesRef.current.all);
      api.registry.delete(namesRef.current.current);
    }
  }, []);

  /** Put hit `i` on the middle line if it's drawn, or its gap row if not. */
  const scrollTo = useCallback((i: number) => {
    const s = doc?.search;
    const root = doc?.root;
    if (!doc || !s || !root) return;
    const at = s.starts[i];
    const ranges = rangesRef.current.get(i);
    if (ranges) {
      applyTarget(targetOf(ranges[0]));
      return;
    }
    const gap = gapElement(root, at);
    if (gap) {
      const r = document.createRange();
      r.selectNodeContents(gap);
      applyTarget(targetOf(r));
    }
  }, [doc]);

  const step = useCallback((dir: 1 | -1) => {
    if (!count) return;
    const cur = currentRef.current;
    const i = cur < 0 ? (dir > 0 ? 0 : count - 1) : clampIndex(cur + dir, count);
    setCurrent(i, true);
    scrollTo(i);
    land(i);
  }, [count, setCurrent, scrollTo, land]);

  /** The drum, in hit units. Rolling only moves the highlight and the page;
   *  resting is what loads. */
  const seek = useCallback((pos: number, settled: boolean) => {
    if (!count) return;
    const nearest = clampIndex(pos, count);
    setCurrent(nearest, settled);
    if (nearest !== snappedRef.current || settled) {
      snappedRef.current = nearest;
      scrollTo(nearest);
    }
    if (settled) {
      snappedRef.current = -1;
      land(nearest);
    }
  }, [count, setCurrent, scrollTo, land]);

  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);
  // A hex dump has no numbered lines to carry into the URL.
  const currentLine = useCallback((): number | undefined => undefined, []);

  // Anything short of the end means more may follow: a window's limit, the
  // time budget, or an interruption (another viewer's search took the slot).
  const more = !!search && search.next !== null && search.stop !== null && search.stop !== "eof" && search.stop !== "reach";
  return {
    count,
    current: current < count ? current : -1,
    capped: more,
    lineJump: null,
    lineFound: false,
    next,
    prev,
    seek,
    currentLine,
  };
}
