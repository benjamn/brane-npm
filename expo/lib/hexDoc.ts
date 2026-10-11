import { fetchFiles, streamFileFind, type ConnectionParams, type FileFindEvent, type FilesHexPage } from "@/lib/api";
import { HEX_PAGE_BYTES, HEX_ROW_BYTES } from "@shared/hex-dump";
import { hexSegments, type HexSegment, type LoadedPage } from "@shared/hex-pages";

/** How long typing must pause before a search goes to the daemon. */
const FIND_DEBOUNCE_MS = 200;

export type FindStop = Extract<FileFindEvent, { type: "done" }>["stop"];

/** A search of the whole file, as far as the daemon has answered it. Hits are
 *  in offset order, and only ever from the current window: the first 64
 *  pages with any, from `from` on (src/files/find.ts). */
export interface HexSearch {
  query: string;
  /** Where this window of the search began. */
  from: number;
  starts: number[];
  lengths: number[];
  /** Bytes read so far. */
  scanned: number;
  running: boolean;
  /** Why it stopped, once it has. */
  stop: FindStop | null;
  /** Where the next window would start, when there is one. */
  next: number | null;
  error: string | null;
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One hex file on screen: which of its pages are loaded, and its search.
 *
 *  A store rather than component state, because two things drive it that are
 *  not one component: the HexView draws the pages and the gaps between them,
 *  and 🔎 (`useHexFind`) asks for the page under the hit the drum settled on.
 *  Both subscribe; `version` moves on every change, for useSyncExternalStore. */
export class HexDoc {
  readonly pages = new Map<number, { bytes: Uint8Array; eof: boolean }>();
  readonly pageBytes = HEX_PAGE_BYTES;
  private readonly loading = new Map<number, Promise<void>>();
  version = 0;
  /** Moves only when what is drawn changes (a page, the row width), not on a
   *  search's progress: what the painter keys on. */
  layout = 0;
  notice: string | null;
  /** Bytes per row, which the view picks by width and the painter needs. */
  rowBytes = HEX_ROW_BYTES;
  /** The element the pages are drawn in (web only). */
  root: HTMLElement | null = null;
  search: HexSearch | null = null;
  private listeners = new Set<() => void>();
  private findAbort: AbortController | null = null;
  private findTimer: ReturnType<typeof setTimeout> | null = null;
  private segmentsCache: { version: number; segments: HexSegment[] } | null = null;

  constructor(
    readonly conn: ConnectionParams,
    readonly nid: string,
    readonly path: string,
    readonly size: number | null,
    first: FilesHexPage,
    notice?: string,
  ) {
    this.notice = notice ?? null;
    this.pages.set(first.offset, { bytes: decodeBase64(first.data), eof: first.eof });
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }

  /** The file as drawn: pages and the gaps between them. */
  segments(): HexSegment[] {
    if (this.segmentsCache?.version !== this.version) {
      const loaded: LoadedPage[] = [...this.pages].map(([offset, p]) => ({ offset, length: p.bytes.length, eof: p.eof }));
      this.segmentsCache = { version: this.version, segments: hexSegments(loaded, this.size) };
    }
    return this.segmentsCache.segments;
  }

  /** Bytes loaded, for the header's "16,384 of 161,896 shown". */
  loadedBytes(): number {
    let n = 0;
    for (const p of this.pages.values()) n += p.bytes.length;
    return n;
  }

  isLoaded(page: number): boolean {
    return this.pages.has(page);
  }

  setRowBytes(n: number): void {
    if (n === this.rowBytes) return;
    this.rowBytes = n;
    this.layout++;
    this.changed();
  }

  setRoot(el: HTMLElement | null): void {
    this.root = el;
  }

  /** Load the page at `offset` (a page boundary), once. */
  ensure(offset: number): Promise<void> {
    if (this.pages.has(offset)) return Promise.resolve();
    let p = this.loading.get(offset);
    if (!p) {
      p = fetchFiles(this.conn, this.nid, this.path, offset)
        .then((res) => {
          if (res.type !== "file" || !res.hex) throw new Error("No bytes there");
          this.pages.set(offset, { bytes: decodeBase64(res.hex.data), eof: res.hex.eof });
          if (res.notice) this.notice = res.notice;
        })
        .catch((err) => {
          this.notice = String(err?.message ?? err);
        })
        .finally(() => {
          this.loading.delete(offset);
          this.layout++;
          this.changed();
        });
      this.loading.set(offset, p);
      this.changed();
    }
    return p;
  }

  isLoading(offset: number): boolean {
    return this.loading.has(offset);
  }

  /** Search the file for `query`, from its start. Debounced, and each new
   *  query cancels the last, which is what tells the daemon to stop reading
   *  for it. An empty query clears the search. */
  setQuery(query: string): void {
    if ((this.search?.query ?? "") === query) return;
    this.cancelFind();
    if (!query) {
      this.search = null;
      this.changed();
      return;
    }
    this.search = { query, from: 0, starts: [], lengths: [], scanned: 0, running: true, stop: null, next: null, error: null };
    this.changed();
    this.findTimer = setTimeout(() => this.runFind(query, 0), FIND_DEBOUNCE_MS);
  }

  /** Go on from where the search stopped. After a window's limit that is
   *  the next window, replacing this one's hits; after an interruption it
   *  is the rest of this one, added to the hits already found, so the
   *  result becomes the one the interruption cut short. */
  searchOn(): void {
    const s = this.search;
    if (!s || s.running || s.next === null) return;
    const from = s.next;
    this.cancelFind();
    if (s.stop === "cancelled") {
      Object.assign(s, { scanned: from, running: true, stop: null, next: null, error: null });
    } else {
      this.search = { query: s.query, from, starts: [], lengths: [], scanned: from, running: true, stop: null, next: null, error: null };
    }
    this.changed();
    this.runFind(s.query, from);
  }

  private runFind(query: string, from: number): void {
    this.findTimer = null;
    const abort = new AbortController();
    this.findAbort = abort;
    // Hits arrive in batches per chunk read; one notification per frame is
    // plenty for a counter and a highlight.
    let pending = false;
    const flush = () => {
      pending = false;
      if (this.findAbort === abort) this.changed();
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
      else setTimeout(flush, 16);
    };
    const onEvent = (e: FileFindEvent) => {
      const s = this.search;
      if (this.findAbort !== abort || !s) return;
      if (e.type === "hits") {
        for (const [at, len] of e.hits) {
          s.starts.push(at);
          s.lengths.push(len);
        }
        schedule();
      } else if (e.type === "progress") {
        s.scanned = e.scanned;
        schedule();
      } else if (e.type === "done") {
        s.scanned = e.scanned;
        s.stop = e.stop;
        s.next = e.next;
      } else if (e.type === "error") {
        s.error = e.error;
      }
    };
    streamFileFind(this.conn, this.nid, this.path, query, from, onEvent, abort.signal)
      .catch((err) => {
        if (abort.signal.aborted || !this.search) return;
        this.search.error = String(err?.message ?? err);
      })
      .finally(() => {
        if (this.findAbort !== abort) return;
        this.findAbort = null;
        const s = this.search;
        if (s) {
          s.running = false;
          // An answer that ended without saying why was cut off, not
          // finished. Every hit before the last one reported is in, so the
          // search can resume just past it.
          if (s.stop === null && !s.error) {
            s.stop = "cancelled";
            const last = s.starts.length - 1;
            s.next = last >= 0 ? s.starts[last] + s.lengths[last] : s.from;
          }
        }
        this.changed();
      });
  }

  private cancelFind(): void {
    if (this.findTimer) clearTimeout(this.findTimer);
    this.findTimer = null;
    this.findAbort?.abort();
    this.findAbort = null;
  }

  /** Stop reading for a view that is going away. The search is dropped with
   *  it, so a view that comes back (a StrictMode re-mount) searches afresh. */
  dispose(): void {
    this.cancelFind();
    this.search = null;
  }
}
