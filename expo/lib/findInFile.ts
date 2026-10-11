import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Platform } from "react-native";
import {
  findMatches,
  firstAtOrAfter,
  locateSpan,
  parseLineJump,
  type NodeSlot,
  type TextSpan,
} from "@shared/find-in-text";
import { clampIndex } from "@shared/hit-drum";

/** Find-in-file over whatever the Files tab rendered, painted with the CSS
 *  Custom Highlight API.
 *
 *  Highlights are Ranges registered with `CSS.highlights`, not wrapper
 *  elements, so a search touches no DOM and no React state per hit, and a hit
 *  that crosses Shiki's token spans (or markdown's inline markup) is one
 *  Range like any other. The rules — smart-case, `:N`, which hit is current —
 *  live in `@shared/find-in-text`; this is only the DOM half. */

export interface FindState {
  /** Hits found (0 while the query is empty or is a line jump). */
  count: number;
  /** Index of the current hit, -1 when there is none. */
  current: number;
  /** More hits exist than were collected. */
  capped: boolean;
  /** The query is `:N` and the file has numbered lines. */
  lineJump: number | null;
  /** …and line N exists. */
  lineFound: boolean;
}

const EMPTY: FindState = { count: 0, current: -1, capped: false, lineJump: null, lineFound: false };

// HighlightRegistry is maplike, but its set/delete are typed only under the
// DOM.Iterable lib, which the expo tsconfig doesn't load.
interface Registry {
  set(name: string, highlight: Highlight): unknown;
  delete(name: string): boolean;
}

export function highlightApi(): { registry: Registry; Highlight: typeof Highlight } | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return null;
  return { registry: CSS.highlights as unknown as Registry, Highlight };
}

/** Whether this browser can paint find-in-file hits at all. Where it can't,
 *  the Files tab simply never offers 🔎. */
export function findInFileSupported(): boolean {
  return highlightApi() !== null;
}

// Each hook instance paints under its own names, so two Files panes on screen
// at once (split tabs, stacked routes) can't overwrite each other's hits.
let nextInstance = 0;
let styleEl: HTMLStyleElement | null = null;
export function registerNames(): { all: string; current: string } {
  const id = nextInstance++;
  const names = { all: `brane-find-${id}`, current: `brane-find-${id}-current` };
  if (typeof document !== "undefined") {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "brane-find-in-file";
      document.head.appendChild(styleEl);
    }
    // Background only: a highlight that set `color` would fight Shiki's token
    // colors, and one that didn't set a background would be invisible on them.
    styleEl.textContent +=
      `::highlight(${names.all}){background-color:rgba(255,215,0,0.28)}` +
      `::highlight(${names.current}){background-color:rgba(255,140,0,0.75);color:#000}`;
  }
  return names;
}

/** Elements whose text is not part of the file as read: CodeView's line
 *  numbers, and KaTeX's visually hidden MathML twin of every equation. */
const SKIP_SELECTOR = "[data-find-skip], .katex-mathml, script, style";

interface TextIndex {
  text: string;
  nodes: Text[];
  slots: NodeSlot[];
}

/** Flatten the container's visible text. A newline goes between text nodes
 *  that sit in different block elements, so a query can never match the end
 *  of one line glued to the start of the next — while "use" + "Memo" in two
 *  token spans of one line still reads as `useMemo`. */
function buildIndex(root: HTMLElement): TextIndex {
  const blockCache = new Map<Element, Element>();
  const blockOf = (el: Element): Element => {
    const hit = blockCache.get(el);
    if (hit) return hit;
    let block: Element;
    if (el === root || !root.contains(el)) block = root;
    else {
      const display = getComputedStyle(el).display;
      block = display === "inline" || display === "contents" ? blockOf(el.parentElement ?? root) : el;
    }
    blockCache.set(el, block);
    return block;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return node.parentElement?.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts: string[] = [];
  const nodes: Text[] = [];
  const slots: NodeSlot[] = [];
  let pos = 0;
  let lastBlock: Element | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const block = blockOf(t.parentElement ?? root);
    if (lastBlock && block !== lastBlock) {
      parts.push("\n");
      pos += 1;
    }
    lastBlock = block;
    const v = t.nodeValue ?? "";
    nodes.push(t);
    slots.push({ start: pos, length: v.length });
    parts.push(v);
    pos += v.length;
  }
  return { text: parts.join(""), nodes, slots };
}

function toRange(index: TextIndex, span: TextSpan): Range | null {
  const loc = locateSpan(index.slots, span);
  if (!loc) return null;
  const r = document.createRange();
  r.setStart(index.nodes[loc.start.node], loc.start.offset);
  r.setEnd(index.nodes[loc.end.node], loc.end.offset);
  return r;
}

/** Redraw `el` from scratch on the next frame. iOS Safari does not
 *  invalidate what a replaced or deleted highlight used to cover: typing
 *  `p`, `pa`, `pat` left each prefix's tint painted into cached tiles after
 *  the search was cleared (claude-3j4583pl:132). Holding a paint-only
 *  property off its value for one frame makes the engine repaint the whole
 *  box. Chosen on device over keeping one Highlight and mutating it, which
 *  painted a stairstep (claude-3j4583pl:138). Coalesced to one per frame. */
const pendingRepaint = new Set<HTMLElement>();
export function repaint(el: HTMLElement | null): void {
  if (!el || pendingRepaint.has(el)) return;
  pendingRepaint.add(el);
  const prev = el.style.opacity;
  el.style.opacity = "0.999";
  requestAnimationFrame(() => {
    el.style.opacity = prev;
    pendingRepaint.delete(el);
  });
}

function lineElement(root: HTMLElement, n: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[id="L${n}"]`);
}

/** The first hit at or below the top of whatever is scrolling the file, so a
 *  fresh search starts where the reader is looking rather than at line 1.
 *  Hits are in document order, so their tops are (near enough) monotonic and
 *  a binary search over a few rects does it. */
function firstVisible(root: HTMLElement, ranges: Range[]): number {
  let scroller: HTMLElement | null = root.parentElement;
  while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
  const top = scroller ? scroller.getBoundingClientRect().top : 0;
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].getBoundingClientRect().bottom < top) lo = mid + 1;
    else hi = mid;
  }
  return lo < ranges.length ? lo : 0;
}

function scrollerOf(start: Element | null, axis: "x" | "y"): HTMLElement | null {
  for (let el = start; el; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const overflow = getComputedStyle(el)[axis === "x" ? "overflowX" : "overflowY"];
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (axis === "x" ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

/** Where the file's scroller must stand for a hit to be centered on its
 *  middle line: an absolute offset, so it can be measured once per drum
 *  gesture and re-applied as the drum passes each hit. Vertical only —
 *  search never touches a code block's horizontal scroll, which is the
 *  reader's to set. */
export interface ScrollTarget {
  vs: HTMLElement | null;
  top: number;
}

export function targetOf(range: Range): ScrollTarget {
  const rect = range.getBoundingClientRect();
  const vs = scrollerOf(range.startContainer.parentElement, "y");
  if (!vs) return { vs: null, top: 0 };
  const box = vs.getBoundingClientRect();
  const top = vs.scrollTop + rect.top + rect.height / 2 - (box.top + box.height / 2);
  return { vs, top: Math.max(0, Math.min(top, vs.scrollHeight - vs.clientHeight)) };
}

export function applyTarget(t: ScrollTarget): void {
  if (t.vs) t.vs.scrollTop = t.top;
}

/** Bring a hit into view. By hand, because `scrollIntoView` also scrolls
 *  every ancestor, the document included (and horizontally), which on iOS
 *  drags the page out from under the keyboard. */
function reveal(range: Range): void {
  applyTarget(targetOf(range));
}

export function useFindInFile({
  container,
  query,
  enabled,
  contentKey,
}: {
  /** The element holding the rendered file. */
  container: RefObject<HTMLElement | null>;
  query: string;
  enabled: boolean;
  /** Changes when a different file is shown — resets the anchor so the new
   *  file's search starts at its visible top. */
  contentKey: unknown;
}): FindState & {
  next: () => void;
  prev: () => void;
  seek: (pos: number, settled: boolean) => void;
  currentLine: () => number | undefined;
} {
  const [state, setState] = useState<FindState>(EMPTY);
  const namesRef = useRef<{ all: string; current: string } | null>(null);
  const rangesRef = useRef<Range[]>([]);
  const spansRef = useRef<TextSpan[]>([]);
  const lineRangeRef = useRef<Range | null>(null);
  // Where the current hit starts in the flattened text: what the next
  // recompute re-anchors on. null = start from the visible top.
  const anchorRef = useRef<number | null>(null);
  const currentRef = useRef(-1);
  const [domVersion, setDomVersion] = useState(0);
  // Scroll targets by hit, computed as a drum gesture first needs them and
  // kept until the hits or the layout they were measured in change.
  const targetsRef = useRef(new Map<number, ScrollTarget>());

  const names = () => (namesRef.current ??= registerNames());

  const paintCurrent = useCallback((range: Range | null, scroll: boolean) => {
    const api = highlightApi();
    if (!api) return;
    const n = names();
    if (range) api.registry.set(n.current, new api.Highlight(range));
    else api.registry.delete(n.current);
    repaint(container.current);
    if (range && scroll) reveal(range);
  }, [container]);

  const clear = useCallback(() => {
    const api = highlightApi();
    if (api && namesRef.current) {
      api.registry.delete(namesRef.current.all);
      api.registry.delete(namesRef.current.current);
      repaint(container.current);
    }
    rangesRef.current = [];
    spansRef.current = [];
    targetsRef.current.clear();
    lineRangeRef.current = null;
  }, [container]);

  useEffect(() => {
    anchorRef.current = null;
  }, [contentKey]);

  // The file body re-renders under us — Shiki's tokens replace the plain text
  // a beat after the file opens, a markdown image loads and reflows — and
  // every Range into the replaced nodes goes dead. Re-run the search when
  // that happens, batched to one pass per frame.
  const active = enabled && query.length > 0;
  useEffect(() => {
    const root = container.current;
    if (!active || !root || typeof MutationObserver === "undefined") return;
    let raf = 0;
    const obs = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setDomVersion((v) => v + 1);
      });
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      obs.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, container, contentKey]);

  const lastScrollKey = useRef<string>("");

  useEffect(() => {
    const api = highlightApi();
    const root = container.current;
    if (!api || !root || !active) {
      clear();
      anchorRef.current = null;
      currentRef.current = -1;
      lastScrollKey.current = "";
      setState(EMPTY);
      return;
    }
    const n = names();

    const jump = parseLineJump(query);
    if (jump !== null && root.querySelector('[id^="L"]')) {
      api.registry.delete(n.all);
      rangesRef.current = [];
      spansRef.current = [];
      const el = lineElement(root, jump);
      let range: Range | null = null;
      if (el) {
        range = document.createRange();
        range.selectNodeContents(el.lastElementChild ?? el);
      }
      lineRangeRef.current = range;
      const key = `line:${jump}`;
      paintCurrent(range, key !== lastScrollKey.current);
      lastScrollKey.current = key;
      currentRef.current = -1;
      setState({ count: 0, current: -1, capped: false, lineJump: jump, lineFound: !!el });
      return;
    }
    lineRangeRef.current = null;

    const index = buildIndex(root);
    const { matches, capped } = findMatches(index.text, query);
    const ranges: Range[] = [];
    const spans: TextSpan[] = [];
    for (const m of matches) {
      const r = toRange(index, m);
      if (r) {
        ranges.push(r);
        spans.push(m);
      }
    }
    rangesRef.current = ranges;
    spansRef.current = spans;
    targetsRef.current.clear();
    if (ranges.length) api.registry.set(n.all, new api.Highlight(...ranges));
    else api.registry.delete(n.all);
    repaint(root);

    const current = anchorRef.current === null ? (ranges.length ? firstVisible(root, ranges) : -1) : firstAtOrAfter(spans, anchorRef.current);
    anchorRef.current = current >= 0 ? spans[current].start : anchorRef.current;
    // Scroll when the hit the reader is on changed — not when a re-render
    // rebuilt the same hit, which would yank a reader who scrolled away, and
    // not when typing only lengthened it: keyed on where the hit starts, so
    // `u`, `us`, `use` on one hit stay put instead of nudging per letter.
    const key = current >= 0 ? `${spans[current].start}` : "";
    paintCurrent(current >= 0 ? ranges[current] : null, key !== "" && key !== lastScrollKey.current);
    lastScrollKey.current = key;
    currentRef.current = current;
    setState({ count: ranges.length, current, capped, lineJump: null, lineFound: false });
    // domVersion is the MutationObserver's nudge; contentKey a new file.
  }, [active, query, container, contentKey, domVersion, clear, paintCurrent]);

  useEffect(() => clear, [clear]);

  const step = useCallback((dir: 1 | -1) => {
    const ranges = rangesRef.current;
    if (!ranges.length) {
      // On a line jump, ˄ ˅ re-center the line — the one thing to go back to.
      if (lineRangeRef.current) reveal(lineRangeRef.current);
      return;
    }
    // Like the drum, stop at the ends rather than wrapping round.
    const current = currentRef.current < 0 ? (dir > 0 ? 0 : ranges.length - 1) : clampIndex(currentRef.current + dir, ranges.length);
    const span = spansRef.current[current];
    currentRef.current = current;
    anchorRef.current = span.start;
    lastScrollKey.current = `${span.start}`;
    paintCurrent(ranges[current], true);
    setState((s) => ({ ...s, current }));
  }, [paintCurrent, query]);

  /** Make hit `i` current without scrolling to it — the drum is doing the
   *  scrolling. */
  const setCurrent = useCallback((i: number) => {
    if (i === currentRef.current) return;
    const span = spansRef.current[i];
    currentRef.current = i;
    anchorRef.current = span.start;
    lastScrollKey.current = `${span.start}`;
    paintCurrent(rangesRef.current[i], false);
  }, [paintCurrent, query]);

  const targetFor = useCallback((i: number): ScrollTarget => {
    let t = targetsRef.current.get(i);
    if (!t) {
      t = targetOf(rangesRef.current[i]);
      targetsRef.current.set(i, t);
    }
    return t;
  }, []);

  // The hit the page was last snapped to by the drum.
  const snappedRef = useRef(-1);

  /** The hit drum's position, in hit units (2.5 = halfway from #3 to #4).
   *  The page does not follow the fraction: it snaps, the moment the drum
   *  crosses a detent's midpoint, to put that hit on the scroller's middle
   *  line, and holds still between detents. Gliding tied the page's speed to
   *  how far apart hits happen to be — rushing through sparse stretches,
   *  crawling through dense ones — which reads badly; a snap puts every hit
   *  in the same place, where the eye already is. */
  const seek = useCallback((pos: number, settled: boolean) => {
    const n = rangesRef.current.length;
    if (!n) return;
    const nearest = clampIndex(pos, n);
    setCurrent(nearest);
    if (nearest !== snappedRef.current || settled) {
      snappedRef.current = nearest;
      applyTarget(targetFor(nearest));
    }
    if (settled) {
      // Measured against the layout this gesture ran in; the next one may
      // run with the keyboard up, or down.
      targetsRef.current.clear();
      snappedRef.current = -1;
      setState((s) => (s.current === nearest ? s : { ...s, current: nearest }));
    }
  }, [setCurrent, targetFor]);

  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  /** The numbered line the current hit (or line jump) sits on, for carrying
   *  the position into the URL. undefined for files without line numbers. */
  const currentLine = useCallback((): number | undefined => {
    const range = lineRangeRef.current ?? rangesRef.current[currentRef.current] ?? null;
    const el = range?.startContainer.parentElement?.closest('[id^="L"]');
    const m = el ? /^L(\d+)$/.exec(el.id) : null;
    return m ? Number(m[1]) : undefined;
  }, []);

  return { ...state, next, prev, seek, currentLine };
}
